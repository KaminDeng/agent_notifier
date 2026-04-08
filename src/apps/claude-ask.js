'use strict';

/**
 * Claude Code PreToolUse hook handler for AskUserQuestion
 *
 * Receives AskUserQuestion data via stdin and sends interactive Feishu cards
 * so the user can respond from their phone. Supports:
 *   - Single single-select question → orange card with option buttons + text input
 *   - Single multi-select question  → toggle-button card via buildMultiSelectCard
 *   - Multiple questions            → first question card only; listener sends the rest
 */

const fs = require('fs');
const path = require('path');
const Lark = require('@larksuiteoapi/node-sdk');
const { envConfig } = require('../lib/env-config');
const { sessionState } = require('../lib/session-state');
const { resolvePtsDevice } = require('../lib/terminal-inject');
const { buildMultiSelectCard, parseMarkdownToElements } = require('../lib/feishu-card-utils');

// ── Utility functions ─────────────────────────────────────

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        let resolved = false;
        const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => data += chunk);
        process.stdin.on('end', () => { try { done(JSON.parse(data)); } catch { done({}); } });
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

/**
 * Extract contextText from the last assistant message in the transcript.
 * Looks for text blocks preceding the AskUserQuestion tool_use block.
 */
function extractContextText(transcriptPath) {
    if (!transcriptPath) return '';
    try {
        const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            let d;
            try { d = JSON.parse(lines[i]); } catch { continue; }
            if (d.type !== 'assistant') continue;
            const content = d.message?.content || [];
            let contextText = '';
            let hasAskUserQuestion = false;
            for (const block of content) {
                if (block.type === 'text' && block.text) {
                    contextText += block.text + '\n';
                }
                if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
                    hasAskUserQuestion = true;
                }
            }
            if (hasAskUserQuestion) {
                return contextText.trim();
            }
            return '';
        }
    } catch {}
    return '';
}

// ── Feishu client ─────────────────────────────────────────

async function getFeishuAppClient() {
    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;
    if (!appId || !appSecret) return null;

    const client = new Lark.Client({ appId, appSecret });

    let chatId = process.env.FEISHU_CHAT_ID;
    if (!chatId) {
        try {
            const resp = await client.im.chat.list({ params: { page_size: 5 } });
            const chats = resp?.data?.items || [];
            if (chats.length === 0) return null;
            chatId = chats[0].chat_id;
        } catch { return null; }
    }

    return { client, chatId };
}

// ── Card senders ──────────────────────────────────────────

/** Case A: single multi-select question */
async function sendMultiSelectCard(app, q, stateKey, ptsDevice, sessionId, notificationType, noteParts) {
    const notif = {
        session_id: sessionId,
        notification_type: notificationType,
        pts_device: ptsDevice,
        created_at: Date.now(),
        responses: {},
        _multi_select: true,
        _selected: [],
        _ms_options: q.options.map(o => o.label),
        _ms_total: q.options.length,
        _question: q.question || '',
        _context_text: q._contextText || '',
        _note_parts: noteParts,
        _message_id: null,
    };

    const card = buildMultiSelectCard(notif, stateKey);

    try {
        const resp = await app.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
                receive_id: app.chatId,
                msg_type: 'interactive',
                content: JSON.stringify(card),
            },
        });
        notif._message_id = resp?.data?.message_id || null;
        sessionState.addNotification(stateKey, notif);
    } catch (err) {
        console.error('[ask-handler] 发送多选卡片失败:', err.message);
    }
}

/** Case B: single single-select question */
async function sendSingleSelectCard(app, q, stateKey, ptsDevice, sessionId, notificationType, noteParts) {
    const contextText = q._contextText || '';

    const elements = [];

    // Optional context block
    if (contextText) {
        elements.push(...parseMarkdownToElements(contextText));
        elements.push({ tag: 'hr' });
    }

    // Question text
    elements.push(...parseMarkdownToElements(q.question || ''));

    // Option buttons + "Other" button
    const optionButtons = q.options.map((opt, idx) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: opt.label },
        type: idx === 0 ? 'primary' : 'default',
        value: { action_type: `opt_${idx}`, session_state_key: stateKey },
    }));
    optionButtons.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '💬 Other' },
        type: 'default',
        value: { action_type: 'opt_other', session_state_key: stateKey },
    });
    elements.push({ tag: 'action', actions: optionButtons });

    // Text input for custom answer
    elements.push({ tag: 'action', actions: [{
        tag: 'input',
        name: 'user_input',
        placeholder: { tag: 'plain_text', content: '输入自定义回答...' },
        width: 'fill',
        value: { action_type: 'text_input', session_state_key: stateKey },
    }]});

    // Footer note
    elements.push({ tag: 'markdown', content: noteParts });

    const card = {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: `📋 ${q.header || '方案选择'}` },
            template: 'orange',
        },
        elements,
    };

    // Build responses map — Claude Code TUI 使用箭头键导航，不接受数字选择
    // opt_0 (第一个，默认高亮): 直接 Enter
    // opt_N: N 次 ↓ 再 Enter
    const ARROW_DOWN = '\x1b[B';
    const responses = {};
    q.options.forEach((opt, idx) => {
        responses[`opt_${idx}`] = { keys: ARROW_DOWN.repeat(idx) + '\r', label: opt.label };
    });
    const otherIdx = q.options.length; // Other 是最后一项
    responses['opt_other'] = { keys: ARROW_DOWN.repeat(otherIdx) + '\r', label: 'Other' };
    responses['_other_num'] = { keys: ARROW_DOWN.repeat(otherIdx) + '\r', label: '_meta' };
    responses['esc'] = { keys: '\x1b', label: 'Esc' };

    try {
        await app.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
                receive_id: app.chatId,
                msg_type: 'interactive',
                content: JSON.stringify(card),
            },
        });
        sessionState.addNotification(stateKey, {
            session_id: sessionId,
            notification_type: notificationType,
            pts_device: ptsDevice,
            created_at: Date.now(),
            responses,
        });
    } catch (err) {
        console.error('[ask-handler] 发送单选卡片失败:', err.message);
    }
}

/** Case C: multiple questions — send first, store all for listener */
async function sendMultiQuestionFirstCard(app, questions, stateKey, ptsDevice, sessionId, notificationType, noteParts) {
    const q = questions[0];
    const contextText = q._contextText || '';
    const ARROW_DOWN = '\x1b[B';
    const otherIdx = q.options.length;

    const qResponses = {};
    q.options.forEach((opt, optIdx) => {
        qResponses[`opt_${optIdx}`] = { keys: ARROW_DOWN.repeat(optIdx) + '\r', label: opt.label };
    });
    qResponses['opt_other'] = { keys: ARROW_DOWN.repeat(otherIdx) + '\r', label: 'Other' };
    qResponses['_other_num'] = { keys: ARROW_DOWN.repeat(otherIdx) + '\r', label: '_meta' };

    // Store all questions for listener
    sessionState.addNotification(stateKey, {
        session_id: sessionId,
        notification_type: notificationType,
        pts_device: ptsDevice,
        created_at: Date.now(),
        responses: qResponses,
        _all_questions: questions,
        _current_q: 0,
        _chat_id: app.chatId,
        _note_parts: noteParts,
    });

    const qElements = [];

    if (contextText) {
        qElements.push(...parseMarkdownToElements(contextText));
        qElements.push({ tag: 'hr' });
    }

    qElements.push(
        { tag: 'div', text: { tag: 'lark_md', content: q.question } },
        { tag: 'action', actions: [
            ...q.options.map((opt, optIdx) => ({
                tag: 'button',
                text: { tag: 'plain_text', content: opt.label },
                type: optIdx === 0 ? 'primary' : 'default',
                value: { action_type: `opt_${optIdx}`, session_state_key: stateKey },
            })),
            { tag: 'button', text: { tag: 'plain_text', content: '💬 Other' }, type: 'default',
              value: { action_type: 'opt_other', session_state_key: stateKey } },
        ]},
        { tag: 'action', actions: [{
            tag: 'input', name: 'user_input',
            placeholder: { tag: 'plain_text', content: '输入自定义回答...' },
            width: 'fill',
            value: { action_type: 'text_input', session_state_key: stateKey },
        }]},
        { tag: 'hr' },
        { tag: 'markdown', content: noteParts },
    );

    const qCard = {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: `📋 ${q.header || '选择'} (1/${questions.length})` },
            template: 'orange',
        },
        elements: qElements,
    };

    try {
        await app.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: app.chatId, msg_type: 'interactive', content: JSON.stringify(qCard) },
        });
    } catch (err) {
        console.error('[ask-handler] 发送 Q1 卡片失败:', err.message);
    }
}

// ── Main ─────────────────────────────────────────────────

async function main() {
    const data = await readStdin();

    // 诊断日志
    const logLine = JSON.stringify({
        ts: Date.now(),
        event: data.hook_event_name,
        tool: data.tool_name,
        hasQuestions: Array.isArray(data.tool_input?.questions),
        qCount: data.tool_input?.questions?.length,
        inputType: typeof data.tool_input,
        inputKeys: data.tool_input ? Object.keys(data.tool_input) : null,
    });
    fs.appendFileSync('/tmp/ask-handler-diag.log', logLine + '\n');

    // Guard: only handle PreToolUse / AskUserQuestion
    if (data.hook_event_name !== 'PreToolUse') return;
    if (data.tool_name !== 'AskUserQuestion') return;

    // Guard: need Feishu app credentials
    if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) return;

    const app = await getFeishuAppClient();
    if (!app) return;

    const questions = data.tool_input?.questions;
    if (!Array.isArray(questions) || questions.length === 0) return;

    const sessionId = data.session_id || '';
    const cwd = data.cwd || '';
    const transcriptPath = data.transcript_path || '';

    const stateKey = `feishu_ask_${sessionId.substring(0, 8)}_${Date.now()}`;
    const ptsDevice = resolvePtsDevice(process.ppid);
    const notificationType = 'AskUserQuestion';

    // Extract context text from transcript (text blocks before the AskUserQuestion tool_use)
    const contextText = extractContextText(transcriptPath);

    // Attach contextText to question objects for use in card builders
    questions.forEach(q => { q._contextText = contextText; });

    // Build note parts (footer)
    const projectName = getProjectName(cwd);
    const termLabel = ptsDevice?.startsWith('tmux:')
        ? `🖥 ${ptsDevice.substring(5)}`
        : (ptsDevice || '🖥 未知终端');
    const noteParts_arr = [];
    if (projectName) noteParts_arr.push(`📁 ${projectName}`);
    noteParts_arr.push(termLabel);
    noteParts_arr.push(`⏰ ${getTimestamp()}`);
    const noteParts = noteParts_arr.join('  ·  ');

    if (questions.length > 1) {
        // Case C: multiple questions
        await sendMultiQuestionFirstCard(app, questions, stateKey, ptsDevice, sessionId, notificationType, noteParts);
    } else {
        const q = questions[0];
        if (q.multiSelect) {
            // Case A: single multi-select
            await sendMultiSelectCard(app, q, stateKey, ptsDevice, sessionId, notificationType, noteParts);
        } else {
            // Case B: single single-select
            await sendSingleSelectCard(app, q, stateKey, ptsDevice, sessionId, notificationType, noteParts);
        }
    }
}

if (require.main === module) {
    main().catch(err => { console.error('[ask-handler]', err.message); process.exit(0); });
}

module.exports = {
    getFeishuAppClient,
    getProjectName,
    getTimestamp,
    sendSingleSelectCard,
    sendMultiSelectCard,
    sendMultiQuestionFirstCard,
    main,
};
