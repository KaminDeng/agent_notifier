'use strict';

const fs = require('node:fs');
const path = require('node:path');

require('../lib/env-config');
const { createFeishuClient } = require('../channels/feishu/feishu-client');
const { resolveFeishuChatId } = require('../channels/feishu/resolve-chat-id');
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
    if (!previous) return true;
    if (!prevKey || !nextKey) return false;
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

function buildStepFallbackSummary(entries) {
    const steps = Array.isArray(entries) ? entries : [];
    if (!steps.length) return null;
    const labels = steps.slice(0, 3).map((entry) => {
        const tool = entry?.tool || '步骤';
        const input = String(entry?.input || '').trim();
        if (!input) return tool;
        return `${tool} ${input}`;
    });
    const suffix = steps.length > 3 ? ` 等 ${steps.length} 步` : '';
    return `正在执行：${labels.join('；')}${suffix}`;
}

function formatStepInput(input, maxChars = 36) {
    const raw = String(input || '').trim();
    if (!raw) return '—';
    const firstLine = raw.split('\n')[0].trim();
    if (!firstLine) return '—';
    const collapsed = firstLine.replace(/\s+/g, ' ');
    const text = collapsed.length > maxChars
        ? `${collapsed.slice(0, maxChars)}…`
        : collapsed;
    return `\`${text}\``;
}

function buildCodexLiveCard({ entries, projectName, ptsDevice = null, phase = null, inputStateKey = null }) {
    const safeEntries = Array.isArray(entries) ? entries : [];
    const outputEntries = safeEntries.filter((entry) => String(entry?.output || '').trim());
    const structuredEntries = safeEntries.filter(hasStructuredStep);
    const lastOutputEntry = getLastOutputEntry(safeEntries);
    const resolvedPhase = phase || lastOutputEntry?.phase || safeEntries[safeEntries.length - 1]?.phase || null;
    const resolvedPtsDevice = ptsDevice || safeEntries[safeEntries.length - 1]?.ptsDevice || null;
    const lastWithTokens = [...safeEntries].reverse().find((entry) => entry.tokens);
    const resolvedTokens = lastWithTokens?.tokens || null;
    const lastWithDuration = [...safeEntries].reverse().find((entry) => entry.turnStartedAt);
    const resolvedStartedAt = lastWithDuration?.turnStartedAt || null;
    const resolvedEndedAt = safeEntries[safeEntries.length - 1]?.ts || Date.now();
    const showSteps = structuredEntries.length > 0;

    const stepRows = structuredEntries.map((entry, index) => ({
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
                elements: [{ tag: 'div', text: { tag: 'lark_md', content: formatStepInput(entry.input) } }],
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
    if (outputEntries.length > 0) {
        outputEntries.forEach((entry, outputIndex) => {
            const chunks = splitOutputBlocks(entry.output);
            chunks.forEach((chunk, chunkIndex) => {
                const isFirst = outputIndex === 0 && chunkIndex === 0;
                const prefix = isFirst ? '💬 **Codex**:\n' : '💬 **Codex（续）**:\n';
                elements.push({ tag: 'div', text: { tag: 'lark_md', content: `${prefix}${chunk}` } });
            });
        });
        if (showSteps) {
            elements.push({ tag: 'hr' });
        }
    } else if (showSteps) {
        const fallbackSummary = buildStepFallbackSummary(structuredEntries);
        if (fallbackSummary) {
            elements.push({ tag: 'div', text: { tag: 'lark_md', content: `💬 **Codex**:\n${fallbackSummary}` } });
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
        elements.push(...stepRows);
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

    const stepCount = structuredEntries.length;
    const liveTitle = showSteps
        ? `⚡ 执行摘要（${stepCount} 步）`
        : '⚡ 执行摘要';

    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: isFinal ? '✅ 已完成' : liveTitle },
            template: isFinal ? 'green' : 'blue',
        },
        elements,
    };
}

function getLastOutputEntry(entries) {
    for (let i = entries.length - 1; i >= 0; i--) {
        if (String(entries[i]?.output || '').trim()) return entries[i];
    }
    return null;
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
    if (!appId || !appSecret) return;

    const client = createFeishuClient({ appId, appSecret });
    const chatId = await resolveFeishuChatId({
        preferredChatId: process.env.FEISHU_CHAT_ID,
        larkClient: client.client,
    });
    if (!chatId) return;

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
