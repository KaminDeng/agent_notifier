'use strict';

require('../src/lib/env-config');
const fs = require('node:fs');
const path = require('node:path');
const { createFeishuClient } = require('../src/channels/feishu/feishu-client');
const { sessionState } = require('../src/lib/session-state');
const { buildCodexFooter } = require('../src/apps/codex-card-footer');
const { findLatestSessionFile, recoverStateFromContent } = require('../src/apps/codex-session-watcher');

function parseArg(name) {
    const idx = process.argv.indexOf(name);
    if (idx === -1) return null;
    return process.argv[idx + 1] || null;
}

function buildKey(tag) {
    return `feishu_codex_e2e_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildHeader(title) {
    return {
        title: { tag: 'plain_text', content: title },
        template: 'turquoise',
    };
}

function addCodexStateEntry(key, ptsDevice) {
    sessionState.addNotification(key, {
        host: 'codex',
        session_id: `codex_e2e_${Date.now()}`,
        notification_type: 'codex_e2e',
        pts_device: ptsDevice,
        created_at: Date.now(),
        responses: {},
    });
}

async function sendCard(client, chatId, card) {
    await client.sendCard({ chatId, card });
}

function readLatestSessionTokens() {
    const latest = findLatestSessionFile();
    if (!latest) return null;
    try {
        const stat = fs.statSync(latest);
        const readSize = Math.min(stat.size, 65536);
        if (readSize <= 0) return null;
        const fd = fs.openSync(latest, 'r');
        const buf = Buffer.alloc(readSize);
        fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
        fs.closeSync(fd);
        return recoverStateFromContent(buf.toString('utf8'));
    } catch {
        return null;
    }
}

async function main() {
    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;
    const chatId = process.env.FEISHU_CHAT_ID;
    const ptsDevice = parseArg('--pts') || process.env.CODEX_E2E_PTS;

    if (!appId || !appSecret || !chatId) {
        throw new Error('需要 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_CHAT_ID');
    }
    if (!ptsDevice) {
        throw new Error('需要 --pts /dev/pts/N 或设置 CODEX_E2E_PTS');
    }

    const client = createFeishuClient({ appId, appSecret });
    const projectName = path.basename(process.cwd());
    const sessionStateSnapshot = readLatestSessionTokens() || {};
    const footer = buildCodexFooter({
        ptsDevice,
        projectName,
        tokens: sessionStateSnapshot.tokens || null,
        startedAt: sessionStateSnapshot.turnStartedAt || null,
    });

    const keyText = buildKey('text');
    addCodexStateEntry(keyText, ptsDevice);
    await sendCard(client, chatId, {
        config: { wide_screen_mode: true },
        header: buildHeader('Codex E2E | 文本输入'),
        elements: [
            { tag: 'div', text: { tag: 'lark_md', content: `目标终端: ${ptsDevice}` } },
            { tag: 'div', text: { tag: 'lark_md', content: '在输入框输入任意文本并提交' } },
            { tag: 'action', actions: [
                {
                    tag: 'input',
                    name: 'codex_text_input',
                    placeholder: { tag: 'plain_text', content: '例如: continue with plan A' },
                    width: 'fill',
                    value: { action_type: 'text_input', session_state_key: keyText },
                },
            ]},
            footer,
        ],
    });

    const keyApproval = buildKey('approval');
    addCodexStateEntry(keyApproval, ptsDevice);
    await sendCard(client, chatId, {
        config: { wide_screen_mode: true },
        header: buildHeader('Codex E2E | 审批'),
        elements: [
            { tag: 'action', actions: [
                {
                    tag: 'button',
                    text: { tag: 'plain_text', content: '允许 (y)' },
                    type: 'primary',
                    value: { action_type: 'allow', session_state_key: keyApproval },
                },
                {
                    tag: 'button',
                    text: { tag: 'plain_text', content: '拒绝 (n)' },
                    type: 'danger',
                    value: { action_type: 'deny', session_state_key: keyApproval },
                },
            ]},
            footer,
        ],
    });

    const keySelect = buildKey('select');
    addCodexStateEntry(keySelect, ptsDevice);
    await sendCard(client, chatId, {
        config: { wide_screen_mode: true },
        header: buildHeader('Codex E2E | 单选'),
        elements: [
            { tag: 'action', actions: [
                {
                    tag: 'button',
                    text: { tag: 'plain_text', content: '选择 option-a' },
                    type: 'default',
                    value: { action_type: 'single_select', selected_value: 'option-a', session_state_key: keySelect },
                },
                {
                    tag: 'button',
                    text: { tag: 'plain_text', content: '选择 option-b' },
                    type: 'default',
                    value: { action_type: 'single_select', selected_value: 'option-b', session_state_key: keySelect },
                },
            ]},
            footer,
        ],
    });

    const keyMulti = buildKey('multi');
    addCodexStateEntry(keyMulti, ptsDevice);
    await sendCard(client, chatId, {
        config: { wide_screen_mode: true },
        header: buildHeader('Codex E2E | 多选'),
        elements: [
            { tag: 'div', text: { tag: 'lark_md', content: '在输入框输入编号，示例：`1 3` 或 `1 4:custom`' } },
            { tag: 'action', actions: [
                {
                    tag: 'input',
                    name: 'codex_multi_input',
                    placeholder: { tag: 'plain_text', content: '例如: 1 3 或 1 4:custom' },
                    width: 'fill',
                    value: { action_type: 'submit_multi', session_state_key: keyMulti },
                },
            ]},
            footer,
        ],
    });

    console.log(`[codex-e2e] 已发送 4 张测试卡，目标终端 ${ptsDevice}`);
}

if (require.main === module) {
    main().catch((err) => {
        console.error('[codex-e2e] 失败:', err.message);
        process.exit(1);
    });
}
