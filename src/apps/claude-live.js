/**
 * Claude Code PostToolUse Hook — 实时执行通知（debounce 聚合版）
 * 在关键工具调用后，将 entry 写入缓冲文件，3 秒无新调用后统一发一张聚合卡片。
 *
 * 配置（.env）:
 *   FEISHU_LIVE_CAPTURE=1          开启，默认捕获全部三项
 *   FEISHU_LIVE_CAPTURE=true       同上
 *   FEISHU_LIVE_CAPTURE=tools,output,results  精细控制
 *     tools   — 工具名 + 关键参数（命令、文件路径）
 *     output  — Claude 上一段助手文字
 *     results — 工具执行结果（前 5 行）
 *   FEISHU_LIVE_DEBOUNCE_MS=3000   debounce 延迟（毫秒，默认 3000）
 *
 * 触发工具（关键节点，只读操作不触发）:
 *   Bash / Write / Edit / NotebookEdit
 */

const fs = require('fs');
const path = require('path');
require('../lib/env-config'); // 加载 .env

const KEY_TOOLS = new Set(['Bash', 'Write', 'Edit', 'NotebookEdit']);

const TOOL_ICONS = {
    'Bash': '⚡',
    'Write': '📝',
    'Edit': '✏️',
    'NotebookEdit': '📓',
};

// ─── Flush 模式：在文件最开始检测，不走 main() ───────────────────────────────

if (process.argv[2] === '--flush') {
    flushBuffer(process.argv[3]).catch(err => {
        console.error('[live/flush] 错误:', err.message);
        process.exit(0);
    });
} else {
    main().catch(err => {
        console.error('[live] 错误:', err.message);
        process.exit(0);
    });
}

// ─── 辅助函数 ─────────────────────────────────────────────────────────────────

/** 解析 FEISHU_LIVE_CAPTURE 配置 */
function parseCaptureConfig() {
    const raw = (process.env.FEISHU_LIVE_CAPTURE || '').trim();
    if (!raw) return null;
    if (['true', '1', 'all', 'yes'].includes(raw.toLowerCase())) {
        return { tools: true, output: true, results: true };
    }
    const parts = raw.split(',').map(s => s.trim().toLowerCase());
    return {
        tools: parts.includes('tools'),
        output: parts.includes('output'),
        results: parts.includes('results'),
    };
}

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        let resolved = false;
        const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => data += chunk);
        process.stdin.on('end', () => {
            try { done(JSON.parse(data)); } catch { done({}); }
        });
        setTimeout(() => done({}), 3000);
    });
}

function getProjectName(cwd) {
    if (!cwd) return '';
    try {
        const pkgPath = path.join(cwd, 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (pkg.name) return pkg.name;
        }
    } catch {}
    return path.basename(cwd);
}

function getTimestamp() {
    return new Date().toLocaleString('zh-CN', {
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
}

/** 从 transcript 提取最后一条 assistant 文字（当前工具调用之前的输出） */
function extractLastAssistantText(transcriptPath) {
    if (!transcriptPath) return null;
    try {
        const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            let d;
            try { d = JSON.parse(lines[i]); } catch { continue; }
            if (d.type !== 'assistant') continue;
            const content = d.message?.content || [];
            const textBlocks = content.filter(b => b.type === 'text' && b.text?.trim());
            if (textBlocks.length > 0) {
                return textBlocks.map(b => b.text).join('\n').trim();
            }
        }
    } catch {}
    return null;
}

/** 格式化工具输入摘要 */
function formatToolInput(toolName, toolInput) {
    if (!toolInput) return '';
    switch (toolName) {
        case 'Bash':
            return (toolInput.command || '');
        case 'Write':
            return `写入 ${toolInput.file_path || ''}`;
        case 'Edit':
            return `编辑 ${toolInput.file_path || ''}`;
        case 'NotebookEdit':
            return `编辑 ${toolInput.notebook_path || ''}`;
        default:
            return JSON.stringify(toolInput);
    }
}

/** 格式化工具结果摘要（截断） */
function formatToolResult(toolResponse) {
    if (toolResponse == null) return null;
    let text = '';
    if (typeof toolResponse === 'string') {
        text = toolResponse;
    } else if (typeof toolResponse.output === 'string') {
        text = toolResponse.output;
    } else if (Array.isArray(toolResponse.content)) {
        text = toolResponse.content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n');
    } else if (typeof toolResponse.content === 'string') {
        text = toolResponse.content;
    } else {
        text = JSON.stringify(toolResponse);
    }
    if (!text) return null;
    return text.trim().split('\n').join('\n');
}

// ─── 模式 1：正常模式（PostToolUse hook 调用）────────────────────────────────

async function main() {
    const capture = parseCaptureConfig();
    if (!capture) return;

    const data = await readStdin();
    if (data.hook_event_name !== 'PostToolUse') return;

    const toolName = data.tool_name;
    if (!KEY_TOOLS.has(toolName)) return;

    const sessionId = data.session_id || 'unknown';
    const bufferPath = `/tmp/claude-live-${sessionId.slice(0, 8)}.jsonl`;

    const entry = {
        tool: toolName,
        icon: TOOL_ICONS[toolName] || '🔧',
        input: capture.tools ? formatToolInput(toolName, data.tool_input) : null,
        result: capture.results ? formatToolResult(data.tool_response) : null,
        output: capture.output ? extractLastAssistantText(data.transcript_path) : null,
        ts: Date.now(),
        projectName: getProjectName(data.cwd),
        // 始终记录 assistant 文字指纹，用于 flush 判断是否换了新任务
        assistantKey: (() => {
            const t = extractLastAssistantText(data.transcript_path);
            return t ? t.trim().slice(0, 80) : '';
        })(),
    };

    // 追加 entry 到缓冲文件
    fs.appendFileSync(bufferPath, JSON.stringify(entry) + '\n', 'utf8');

    // spawn 延迟 flush 子进程（detached，主进程无需等待）
    const child = require('child_process').spawn('node', [
        __filename, '--flush', bufferPath
    ], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
}

// ─── 模式 2：flush 模式（--flush <bufferPath>）───────────────────────────────

async function flushBuffer(bufferPath) {
    if (!bufferPath) return;

    const debounceMs = parseInt(process.env.FEISHU_LIVE_DEBOUNCE_MS || '3000', 10);

    await new Promise((resolve) => setTimeout(resolve, debounceMs));

    // 检查缓冲文件 mtime：还在写入则退出，让后续 flush 进程处理
    let stat;
    try {
        stat = fs.statSync(bufferPath);
    } catch {
        return; // 文件不存在（已被其他 flush 进程处理）
    }
    if (Date.now() - stat.mtimeMs < debounceMs - 500) return;

    // 读取所有行
    let raw;
    try {
        raw = fs.readFileSync(bufferPath, 'utf8');
    } catch {
        return;
    }

    const entries = raw.trim().split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    if (!entries.length) return;

    // 删除缓冲文件（防重复发送，竞争安全）
    try {
        fs.unlinkSync(bufferPath);
    } catch {
        // 另一个 flush 进程已删除，退出
        return;
    }

    // 从 bufferPath 派生 sessionKey，用于在 session-state 中存储 message_id
    const sessionKey = path.basename(bufferPath, '.jsonl').replace('claude-live-', '');

    // 加载 env-config（dotenv）获取飞书凭证
    const { envConfig } = require('../lib/env-config');
    void envConfig;

    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;
    if (!appId || !appSecret) return;

    const Lark = require('@larksuiteoapi/node-sdk');
    const client = new Lark.Client({ appId, appSecret });

    let chatId = process.env.FEISHU_CHAT_ID;
    if (!chatId) {
        try {
            const resp = await client.im.chat.list({ params: { page_size: 5 } });
            const chats = resp?.data?.items || [];
            if (!chats.length) return;
            chatId = chats[0].chat_id;
        } catch { return; }
    }

    // ── 加载 session state，合并已有 entries ──────────────────────────────────
    const { sessionState } = require('../lib/session-state');
    await sessionState.load();

    const stateKey = 'live_msg_' + sessionKey;
    const existing = sessionState.data[stateKey];

    // Claude 输出文字变了 → 新任务 → 重置 entries 并 create 新卡（触发通知）
    // 同一段 Claude 输出内的工具调用 → 静默 patch 同一张卡
    const currentKey = entries[0]?.assistantKey || '';
    const existingKey = existing?.assistantKey || '';
    const isNewTask = currentKey !== '' && existingKey !== '' && currentKey !== existingKey;

    // 合并已有 entries（新任务时重置），最多保留 40 条
    const allEntries = [...(isNewTask ? [] : (existing?.entries || [])), ...entries].slice(-40);

    // ── 构建聚合卡片 ──────────────────────────────────────────────────────────

    // 用 column_set 构建表格行：# | 工具 | 命令/文件 | 结果
    const MAX_CMD = 52;
    const MAX_RES = 36;

    const stepRows = allEntries.map((e, i) => {
        let cmd = '';
        if (e.input) {
            if (e.tool === 'Bash') {
                const line = e.input.split('\n')[0];
                const t = line.length > MAX_CMD ? line.slice(0, MAX_CMD) + '…' : line;
                cmd = '`' + t + '`';
            } else {
                const name = e.input.replace(/^(写入|编辑) /, '').split('/').pop();
                cmd = name.length > MAX_CMD ? name.slice(0, MAX_CMD) + '…' : name;
            }
        }
        let res = '';
        if (e.result) {
            const line = e.result.split('\n')[0].trim();
            res = line.length > MAX_RES ? line.slice(0, MAX_RES) + '…' : line;
        }
        return {
            tag: 'column_set',
            flex_mode: 'none',
            horizontal_spacing: 'small',
            columns: [
                {
                    tag: 'column', width: 'auto',
                    elements: [{ tag: 'div', text: { tag: 'plain_text', content: `${i + 1}` } }],
                },
                {
                    tag: 'column', width: 'auto',
                    elements: [{ tag: 'div', text: { tag: 'plain_text', content: `${e.icon} ${e.tool}` } }],
                },
                {
                    tag: 'column', width: 'weighted', weight: 3,
                    elements: [{ tag: 'div', text: { tag: 'lark_md', content: cmd || '—' } }],
                },
                {
                    tag: 'column', width: 'weighted', weight: 2,
                    elements: [{ tag: 'div', text: { tag: 'plain_text', content: res || '—' } }],
                },
            ],
        };
    });

    // 只取最后一个有 output 的 entry 的 Claude 文字
    const lastWithOutput = [...allEntries].reverse().find(e => e.output);
    const claudeOutput = lastWithOutput?.output || null;

    // footer
    const projectName = allEntries[0]?.projectName || '';
    const noteParts = [];
    if (projectName) noteParts.push(`📁 ${projectName}`);
    noteParts.push(`⏰ ${getTimestamp()}`);

    const cardElements = [];
    if (claudeOutput) {
        cardElements.push({ tag: 'div', text: { tag: 'lark_md', content: `💬 **Claude**:\n${claudeOutput}` } });
        cardElements.push({ tag: 'hr' });
    }
    // 表头行
    cardElements.push({
        tag: 'column_set',
        flex_mode: 'none',
        horizontal_spacing: 'small',
        columns: [
            { tag: 'column', width: 'auto',     elements: [{ tag: 'div', text: { tag: 'plain_text', content: '#' } }] },
            { tag: 'column', width: 'auto',     elements: [{ tag: 'div', text: { tag: 'plain_text', content: '工具' } }] },
            { tag: 'column', width: 'weighted', weight: 3, elements: [{ tag: 'div', text: { tag: 'plain_text', content: '命令 / 文件' } }] },
            { tag: 'column', width: 'weighted', weight: 2, elements: [{ tag: 'div', text: { tag: 'plain_text', content: '结果' } }] },
        ],
    });
    cardElements.push({ tag: 'hr' });
    cardElements.push(...stepRows);
    cardElements.push({ tag: 'div', text: { tag: 'lark_md', content: noteParts.join('  ·  ') } });

    const card = {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: `⚡ 执行摘要（${allEntries.length} 步）` },
            template: 'blue',
        },
        elements: cardElements,
    };

    // ── Patch-or-create：同一任务静默 patch，新任务 create 触发通知 ──────────────

    let patched = false;
    if (!isNewTask && existing?.message_id) {
        try {
            await client.im.message.patch({
                path: { message_id: existing.message_id },
                data: { content: JSON.stringify(card) },
            });
            patched = true;
            sessionState.data[stateKey] = { ...existing, entries: allEntries, assistantKey: currentKey || existingKey };
            sessionState.save();
        } catch (err) {
            console.error('[live/flush] patch 失败，改为 create:', err.message);
        }
    }

    if (!patched) {
        try {
            const result = await client.im.message.create({
                params: { receive_id_type: 'chat_id' },
                data: {
                    receive_id: chatId,
                    msg_type: 'interactive',
                    content: JSON.stringify(card),
                },
            });
            if (result?.data?.message_id) {
                sessionState.data[stateKey] = {
                    message_id: result.data.message_id,
                    entries: allEntries,
                    assistantKey: currentKey || existingKey,
                    created_at: Date.now(),
                };
                sessionState.save();
            }
        } catch (err) {
            console.error('[live/flush] 发送失败:', err.message);
        }
    }
}
