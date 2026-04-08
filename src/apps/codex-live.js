'use strict';

const fs = require('node:fs');
const path = require('node:path');

require('../lib/env-config');
const { createFeishuClient } = require('../channels/feishu/feishu-client');
const { sessionState } = require('../lib/session-state');
const { buildCodexFooter, normalizeTokenUsage } = require('./codex-card-footer');

function parseCaptureConfig(raw = process.env.FEISHU_LIVE_CAPTURE || '') {
    const value = String(raw || '').trim();
    if (!value) return null;
    if (['true', '1', 'all', 'yes'].includes(value.toLowerCase())) {
        return { tools: true, output: true, results: true };
    }
    const parts = value.split(',').map((item) => item.trim().toLowerCase());
    return {
        tools: parts.includes('tools'),
        output: parts.includes('output'),
        results: parts.includes('results'),
    };
}

function getTimestamp() {
    return new Date().toLocaleString('zh-CN', {
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

function normalizeCodexLiveEntry(entry) {
    if (!entry) return null;
    return {
        tool: entry.tool || null,
        icon: entry.icon || (entry.tool ? '⚡' : '💬'),
        input: entry.input || null,
        result: entry.result || null,
        output: entry.text || entry.output || null,
        assistantKey: entry.assistant_key || entry.assistantKey || '',
        projectName: entry.project_name || entry.projectName || '',
        phase: entry.phase || null,
        ptsDevice: entry.pts_device || entry.ptsDevice || null,
        turnStartedAt: entry.turn_started_at || entry.turnStartedAt || null,
        tokens: normalizeTokenUsage(entry.tokens),
        ts: entry.ts || Date.now(),
    };
}

function shouldCreateNewCard(previous, next) {
    const prevKey = String(previous?.assistantKey || '').trim();
    const nextKey = String(next?.assistantKey || '').trim();
    if (!nextKey) return true;
    if (!previous) return true;
    if (!prevKey) return true;
    return prevKey !== nextKey;
}

function splitOutputBlocks(text, maxChars = 1800) {
    const raw = String(text || '').trim();
    if (!raw) return [];
    const chunks = [];
    for (let i = 0; i < raw.length; i += maxChars) {
        chunks.push(raw.slice(i, i + maxChars));
    }
    return chunks;
}

function hasStructuredStep(entry) {
    return !!(entry?.tool || entry?.input || entry?.result);
}

function buildCodexLiveCard({ entries, projectName, ptsDevice = null, phase = null, inputStateKey = null }) {
    const safeEntries = Array.isArray(entries) ? entries : [];
    const lastWithOutput = [...safeEntries].reverse().find((entry) => entry.output);
    const codexOutput = lastWithOutput?.output || null;
    const resolvedPhase = phase || lastWithOutput?.phase || safeEntries[safeEntries.length - 1]?.phase || null;
    const resolvedPtsDevice = ptsDevice || safeEntries[safeEntries.length - 1]?.ptsDevice || null;
    const lastWithTokens = [...safeEntries].reverse().find((entry) => entry.tokens);
    const resolvedTokens = lastWithTokens?.tokens || null;
    const lastWithDuration = [...safeEntries].reverse().find((entry) => entry.turnStartedAt);
    const resolvedStartedAt = lastWithDuration?.turnStartedAt || null;
    const resolvedEndedAt = safeEntries[safeEntries.length - 1]?.ts || Date.now();
    const showSteps = safeEntries.some(hasStructuredStep);

    const stepRows = safeEntries.map((entry, index) => ({
        tag: 'column_set',
        flex_mode: 'none',
        horizontal_spacing: 'small',
        columns: [
            {
                tag: 'column',
                width: 'auto',
                elements: [{ tag: 'div', text: { tag: 'plain_text', content: String(index + 1) } }],
            },
            {
                tag: 'column',
                width: 'auto',
                elements: [{ tag: 'div', text: { tag: 'plain_text', content: `${entry.icon} ${entry.tool || 'Output'}` } }],
            },
            {
                tag: 'column',
                width: 'weighted',
                weight: 3,
                elements: [{ tag: 'div', text: { tag: 'lark_md', content: entry.input ? `\`${entry.input}\`` : '—' } }],
            },
            {
                tag: 'column',
                width: 'weighted',
                weight: 2,
                elements: [{ tag: 'div', text: { tag: 'plain_text', content: entry.result || '—' } }],
            },
        ],
    }));

    const elements = [];
    if (codexOutput) {
        const chunks = splitOutputBlocks(codexOutput);
        chunks.forEach((chunk, index) => {
            const prefix = index === 0 ? '💬 **Codex**:\n' : '💬 **Codex（续）**:\n';
            elements.push({ tag: 'div', text: { tag: 'lark_md', content: `${prefix}${chunk}` } });
        });
        if (showSteps) {
            elements.push({ tag: 'hr' });
        }
    }
    if (showSteps) {
        elements.push({
            tag: 'column_set',
            flex_mode: 'none',
            horizontal_spacing: 'small',
            columns: [
                { tag: 'column', width: 'auto', elements: [{ tag: 'div', text: { tag: 'plain_text', content: '#' } }] },
                { tag: 'column', width: 'auto', elements: [{ tag: 'div', text: { tag: 'plain_text', content: '工具' } }] },
                { tag: 'column', width: 'weighted', weight: 3, elements: [{ tag: 'div', text: { tag: 'plain_text', content: '命令 / 文件' } }] },
                { tag: 'column', width: 'weighted', weight: 2, elements: [{ tag: 'div', text: { tag: 'plain_text', content: '结果' } }] },
            ],
        });
        elements.push({ tag: 'hr' });
        elements.push(...stepRows.filter(hasStructuredStep));
    }
    if (inputStateKey) {
        elements.push({
            tag: 'action',
            actions: [{
                tag: 'input',
                name: 'user_input',
                placeholder: { tag: 'plain_text', content: '输入指令...' },
                width: 'fill',
                value: { action_type: 'text_input', session_state_key: inputStateKey },
            }],
        });
    }
    elements.push(buildCodexFooter({
        ptsDevice: resolvedPtsDevice,
        projectName: projectName || '',
        tokens: resolvedTokens,
        startedAt: resolvedStartedAt,
        endedAt: resolvedEndedAt,
        timestamp: getTimestamp(),
    }));

    const isFinal = resolvedPhase === 'final_answer';

    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: isFinal ? '✅ 已完成' : `⚡ 执行摘要（${showSteps ? stepRows.filter(hasStructuredStep).length : 1} 步）` },
            template: isFinal ? 'green' : 'blue',
        },
        elements,
    };
}

async function flushBuffer(bufferPath) {
    if (!bufferPath || !fs.existsSync(bufferPath)) return;

    const debounceMs = parseInt(process.env.FEISHU_LIVE_DEBOUNCE_MS || '3000', 10);
    await new Promise((resolve) => setTimeout(resolve, debounceMs));

    let stat;
    try {
        stat = fs.statSync(bufferPath);
    } catch {
        return;
    }
    if (Date.now() - stat.mtimeMs < debounceMs - 500) return;

    let raw;
    try {
        raw = fs.readFileSync(bufferPath, 'utf8');
    } catch {
        return;
    }
    const entries = raw.trim().split('\n').filter(Boolean).map((line) => {
        try {
            return normalizeCodexLiveEntry(JSON.parse(line));
        } catch {
            return null;
        }
    }).filter(Boolean);
    if (!entries.length) return;

    try {
        fs.unlinkSync(bufferPath);
    } catch {
        return;
    }

    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;
    const chatId = process.env.FEISHU_CHAT_ID;
    if (!appId || !appSecret || !chatId) return;

    const sessionKey = path.basename(bufferPath, '.jsonl').replace('codex-live-', '');
    sessionState.load();
    const stateKey = `codex_live_msg_${sessionKey}`;
    const existing = sessionState.data[stateKey] || null;
    const latest = entries[entries.length - 1];
    const createNew = shouldCreateNewCard(existing, latest);
    const allEntries = [...(createNew ? [] : (existing?.entries || [])), ...entries].slice(-40);

    // 为输入框创建 notification entry
    const ptsDevice = latest.ptsDevice || existing?.ptsDevice || null;
    const inputStateKey = existing?.inputStateKey || `feishu_codex_live_${sessionKey}_${Date.now()}`;
    if (ptsDevice) {
        sessionState.addNotification(inputStateKey, {
            host: 'codex',
            session_id: `codex_${sessionKey}`,
            notification_type: 'execution_live',
            pts_device: ptsDevice,
            created_at: Date.now(),
            responses: {},
        });
    }

    const card = buildCodexLiveCard({
        entries: allEntries,
        projectName: latest.projectName || existing?.projectName || '',
        ptsDevice: ptsDevice,
        phase: latest.phase || existing?.phase || null,
        inputStateKey: ptsDevice ? inputStateKey : null,
    });
    const client = createFeishuClient({ appId, appSecret });

    if (!createNew && existing?.message_id) {
        try {
            await client.patchCard({ messageId: existing.message_id, card });
            sessionState.data[stateKey] = {
                ...existing,
                entries: allEntries,
                assistantKey: latest.assistantKey || existing.assistantKey || '',
                phase: latest.phase || existing.phase || null,
                ptsDevice: latest.ptsDevice || existing.ptsDevice || null,
                turnStartedAt: latest.turnStartedAt || existing.turnStartedAt || null,
                updated_at: Date.now(),
                projectName: latest.projectName || existing.projectName || '',
                inputStateKey,
            };
            sessionState.save();
            return;
        } catch {}
    }

    const resp = await client.sendCard({ chatId, card });
    sessionState.data[stateKey] = {
        message_id: resp?.data?.message_id || null,
        entries: allEntries,
        assistantKey: latest.assistantKey || '',
        phase: latest.phase || null,
        ptsDevice: latest.ptsDevice || null,
        turnStartedAt: latest.turnStartedAt || null,
        created_at: Date.now(),
        updated_at: Date.now(),
        projectName: latest.projectName || '',
        inputStateKey,
    };
    sessionState.save();
}

async function main() {
    if (process.argv[2] === '--flush') {
        await flushBuffer(process.argv[3]);
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error('[codex-live] 错误:', err.message);
        process.exit(0);
    });
}

module.exports = {
    parseCaptureConfig,
    normalizeCodexLiveEntry,
    shouldCreateNewCard,
    buildCodexLiveCard,
    flushBuffer,
};
