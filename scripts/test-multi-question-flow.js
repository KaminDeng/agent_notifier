'use strict';

/**
 * 多问题 AskUserQuestion 流程手动集成测试脚本
 *
 * 用法：
 *   node scripts/test-multi-question-flow.js
 *
 * 运行时会：
 *   1. 创建 FIFO /tmp/agent-inject-pts-test
 *   2. 发送 2 题飞书卡片（方案选择 → 是否确认）
 *   3. 实时打印注入到 FIFO 的按键内容（base64 解码 + 可读化）
 *   4. 120 秒后自动退出
 */

require('../src/lib/env-config');

const { execSync, spawn } = require('child_process');
const { getFeishuAppClient, getProjectName, getTimestamp, sendMultiQuestionFirstCard } = require('../src/apps/claude-ask');
const { buildCardFooter } = require('../src/lib/card-footer');
const { resolvePtsDevice } = require('../src/lib/terminal-inject');

const FIFO_PATH = '/tmp/agent-inject-pts-test';
const TIMEOUT_MS = 120_000;

// ── 将字节序列转为人类可读形式 ───────────────────────────────
function humanReadable(str) {
    return str
        .replace(/\x1b\[B/g, '↓')   // ANSI 光标下移
        .replace(/\x1b\[A/g, '↑')   // ANSI 光标上移
        .replace(/\x1b\[C/g, '→')   // ANSI 光标右移
        .replace(/\x1b\[D/g, '←')   // ANSI 光标左移
        .replace(/\r/g, '⏎')        // 回车
        .replace(/\n/g, '↵')        // 换行
        .replace(/\x1b/g, 'ESC')    // 其余 ESC
        .replace(/\x20/g, '␣');     // 空格
}

// ── 1. 创建 FIFO ─────────────────────────────────────────────
try {
    execSync(`mkfifo ${FIFO_PATH}`, { stdio: 'pipe' });
    console.log(`[集成测试] 已创建 FIFO: ${FIFO_PATH}`);
} catch (err) {
    if (err.message && err.message.includes('File exists')) {
        console.log(`[集成测试] FIFO 已存在，跳过创建: ${FIFO_PATH}`);
    } else {
        console.error(`[集成测试] 创建 FIFO 失败: ${err.message}`);
        process.exit(1);
    }
}

// ── 2. 启动后台 FIFO 读取器（用 cat 阻塞式读取，base64 解码后打印） ──
// cat 会在 FIFO 另一端打开时解除阻塞，持续读取直到写端关闭
const cat = spawn('cat', [FIFO_PATH]);

cat.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    for (const line of lines) {
        try {
            const decoded = Buffer.from(line, 'base64').toString();
            const human = humanReadable(decoded);
            const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
            console.log(`[注入 ${ts}] ${human}  (raw: ${JSON.stringify(decoded)})`);
        } catch {
            console.log(`[注入] 解码失败: ${line}`);
        }
    }
});

cat.stderr.on('data', (d) => console.error('[cat stderr]', d.toString().trim()));

cat.on('close', (code) => {
    if (code !== null && code !== 0) {
        console.log(`[集成测试] cat 退出，code=${code}`);
    }
});

// ── 3. 发送飞书卡片 ──────────────────────────────────────────
async function main() {
    const app = await getFeishuAppClient();
    if (!app) {
        console.error('[集成测试] 飞书配置缺失（请检查 .env 中的 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_CHAT_ID）');
        process.exit(1);
    }

    const ptsDevice = `fifo:${FIFO_PATH}`;
    const projectName = getProjectName(process.cwd());
    const footerEl = buildCardFooter({
        host: 'claude',
        ptsDevice,
        projectName,
    });
    const noteParts = footerEl.content;

    const questions = [
        {
            header: '选择测试方案',
            question: '**Q1:** 请选择本轮集成测试使用的方案',
            options: [
                { label: '方案 A', value: 'a' },
                { label: '方案 B', value: 'b' },
            ],
        },
        {
            header: '是否确认',
            question: '**Q2:** 请确认是否继续',
            options: [
                { label: '确认', value: 'yes' },
                { label: '取消', value: 'no' },
            ],
        },
    ];

    const stateKey = `feishu_ask_test_${Date.now()}`;
    const sessionId = `test-session-${process.pid}`;

    console.log('[集成测试] 正在发送多问题飞书卡片...');
    console.log(`[集成测试] stateKey: ${stateKey}`);
    console.log(`[集成测试] ptsDevice: ${ptsDevice}`);

    try {
        await sendMultiQuestionFirstCard(
            app,
            questions,
            stateKey,
            ptsDevice,
            sessionId,
            'AskUserQuestion',
            noteParts
        );
        console.log('[集成测试] Q1 卡片已发送至飞书。');
    } catch (err) {
        console.error('[集成测试] 发送卡片失败:', err.message);
        process.exit(1);
    }

    // ── 4. 打印用户操作指引 ──────────────────────────────────
    console.log('');
    console.log('━'.repeat(60));
    console.log('请在飞书中回答问题，注入内容将实时显示在此处');
    console.log('  - 点击 Q1 的任一选项 → 看到 ⏎ 或 ↓⏎ 注入');
    console.log('  - 飞书自动弹出 Q2 → 点击 Q2 的任一选项');
    console.log('  - 完成后看到绿色完成卡片（不应产生第 3 次注入）');
    console.log(`  - 脚本将在 ${TIMEOUT_MS / 1000} 秒后自动退出`);
    console.log('━'.repeat(60));
    console.log('');

    // ── 5. 120 秒超时退出 ────────────────────────────────────
    setTimeout(() => {
        console.log('[集成测试] 超时退出（120s）');
        cat.kill();
        process.exit(0);
    }, TIMEOUT_MS).unref();
}

main().catch(err => {
    console.error('[集成测试]', err.message);
    process.exit(1);
});
