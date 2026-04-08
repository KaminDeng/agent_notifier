'use strict';

require('../lib/env-config');
const fs = require('node:fs');
const path = require('node:path');
const { createFeishuClient } = require('../channels/feishu/feishu-client');
const { parseOutputBlock } = require('../adapters/codex/cli-output-parser');
const { sessionState } = require('../lib/session-state');
const { parseMarkdownToElements } = require('../lib/feishu-card-utils');

const TMP_DIR = '/tmp';
const OUTPUT_PREFIX = 'claude-pty-output-';
const POLL_MS = 1500;

/** 根据 pts 编号解析注入目标：FIFO 优先，否则使用裸 pts */
function resolvePtsTarget(ptsNum) {
    const fifoPath = `/tmp/agent-inject-pts${ptsNum}`;
    try {
        if (fs.statSync(fifoPath).isFIFO()) return `fifo:${fifoPath}`;
    } catch {}
    return `/dev/pts/${ptsNum}`;
}

/** 从任意 ptsDevice 格式中提取纯数字编号 */
function extractPtsNum(ptsDevice) {
    const m = String(ptsDevice).match(/pts(\d+)$/);
    return m ? m[1] : String(ptsDevice).replace('/dev/pts/', '');
}
const WATCHER_BUFFER_MAX_CHARS = 100000;
const COMPLETION_HINT_PATTERN = /\b(done|completed|complete|finished|resolved|successful(?:ly)?|all set|updated \d+ files?)\b|(?:已完成|完成了|处理完成|任务完成|执行完成|搞定)/i;

// 思考/状态指示行 — Codex 思考动画和状态行，不触发最终卡片
const THINKING_NOISE_PATTERN = /(?:thinking|combobulating|contemplating|working|processing|loading|pending|analyzing|reasoning|please wait|waiting|booting|starting|booping)/i;

function computeReadPlan({ prevOffset = 0, nextOffset = 0, prevMtimeMs = 0, nextMtimeMs = 0, isFirstSeen = false }) {
    if (isFirstSeen && nextOffset > 0) {
        return {
            shouldRead: false,
            readOffset: 0,
            readLength: 0,
        };
    }

    if (nextOffset > prevOffset) {
        return {
            shouldRead: true,
            readOffset: prevOffset,
            readLength: nextOffset - prevOffset,
        };
    }

    // pty-relay rewrites a fixed-size rolling buffer, so size may remain unchanged.
    if (nextOffset > 0 && nextOffset === prevOffset && nextMtimeMs > prevMtimeMs) {
        return {
            shouldRead: true,
            readOffset: 0,
            readLength: nextOffset,
        };
    }

    // Handle truncation/rotation by reading the current full file once.
    if (nextOffset > 0 && nextOffset < prevOffset) {
        return {
            shouldRead: true,
            readOffset: 0,
            readLength: nextOffset,
        };
    }

    return {
        shouldRead: false,
        readOffset: 0,
        readLength: 0,
    };
}

function nowText() {
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

function buildStateKey(ptsNum) {
    return `feishu_codex_auto_${ptsNum}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function buildInputRow(stateKey) {
    return {
        tag: 'action',
        actions: [
            {
                tag: 'input',
                name: 'user_input',
                placeholder: { tag: 'plain_text', content: '输入指令...' },
                width: 'fill',
                value: { action_type: 'text_input', session_state_key: stateKey },
            },
        ],
    };
}

function buildFooter({ ptsDevice, cwd, tokens }) {
    const parts = ['🤖 Codex'];
    if (ptsDevice) parts.push(`🖥 ${ptsDevice.replace('/dev/', '')}`);
    const cwdLabel = cwd && String(cwd).trim() && cwd !== 'N/A'
        ? (path.basename(String(cwd).trim()) || String(cwd).trim())
        : null;
    if (cwdLabel) parts.push(`📁 ${cwdLabel}`);
    if (tokens) {
        const fmt = n => (n != null && n >= 1000) ? (n / 1000).toFixed(1) + 'k' : String(n ?? 'N/A');
        parts.push(`📊 in ${fmt(tokens.input)} · out ${fmt(tokens.output)}`);
    }
    parts.push(`⏰ ${nowText()}`);
    return { tag: 'markdown', content: parts.join('  ·  ') };
}

function buildExecutionSummaryCard(summaryData, ptsDevice, stateKey) {
    const summary = (summaryData?.summary || '').trim() || '任务已完成（未解析到详细摘要）';
    const cwd = summaryData?.cwd || null;
    const tokens = summaryData?.tokens || null;

    const title = '✅ 执行摘要';
    const contentEls = parseMarkdownToElements(summary).map(el =>
        el.tag === 'markdown'
            ? { tag: 'div', text: { tag: 'lark_md', content: el.content } }
            : el
    );
    const elements = [...contentEls];
    elements.push(buildInputRow(stateKey));
    elements.push(buildFooter({ ptsDevice, cwd, tokens }));

    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: title },
            template: 'green',
        },
        elements,
    };
}

function buildLiveSummaryCard(summaryData, ptsDevice, stateKey) {
    const summary = (summaryData?.summary || '').trim() || '执行中...';
    const cwd = summaryData?.cwd || null;
    const tokens = summaryData?.tokens || null;

    const title = '⚡ 执行中';
    const contentEls = parseMarkdownToElements(summary).map(el =>
        el.tag === 'markdown'
            ? { tag: 'div', text: { tag: 'lark_md', content: el.content } }
            : el
    );
    const elements = [...contentEls];
    elements.push(buildInputRow(stateKey));
    elements.push(buildFooter({ ptsDevice, cwd, tokens }));

    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: title },
            template: 'blue',
        },
        elements,
    };
}

function isCompletionLikeSummary(text) {
    return COMPLETION_HINT_PATTERN.test(String(text || ''));
}

function buildCard(parsed, ptsDevice, stateKey) {
    const { kind, question, options = [] } = parsed;

    const titleMap = {
        approval:      '⏸️ 操作确认',
        confirm:       '⏸️ 操作确认',
        single_select: '⏸️ 选择方案',
        multi_select:  '⏸️ 多项选择',
        text_input:    '💬 等待输入',
        open_question: '💬 等待输入',
    };
    const title = titleMap[kind] || '⏸️ 等待操作';

    const contentEls = question ? parseMarkdownToElements(question).map(el =>
        el.tag === 'markdown'
            ? { tag: 'div', text: { tag: 'lark_md', content: el.content } }
            : el
    ) : [];
    const elements = [...contentEls];

    if (kind === 'approval') {
        elements.push({
            tag: 'action',
            actions: [
                {
                    tag: 'button',
                    text: { tag: 'plain_text', content: '✅ 允许 (y)' },
                    type: 'primary',
                    value: { action_type: 'allow', session_state_key: stateKey },
                },
                {
                    tag: 'button',
                    text: { tag: 'plain_text', content: '❌ 拒绝 (n)' },
                    type: 'danger',
                    value: { action_type: 'deny', session_state_key: stateKey },
                },
            ],
        });
    } else if (kind === 'confirm' && options.length > 0) {
        elements.push({
            tag: 'action',
            actions: options.slice(0, 6).map(opt => {
                const isYes = /^(yes|是|确认)/i.test(opt.label);
                const isNo  = /^(no|否|取消)/i.test(opt.label);
                return {
                    tag: 'button',
                    text: { tag: 'plain_text', content: opt.label },
                    type: isYes ? 'primary' : (isNo ? 'danger' : 'default'),
                    value: {
                        action_type: 'single_select',
                        selected_value: String(opt.value ?? opt.label),
                        session_state_key: stateKey,
                    },
                };
            }),
        });
    } else if (kind === 'single_select' && options.length > 0) {
        elements.push({
            tag: 'action',
            actions: options.slice(0, 6).map((opt, idx) => ({
                tag: 'button',
                text: { tag: 'plain_text', content: opt.label },
                type: idx === 0 ? 'primary' : 'default',
                value: {
                    action_type: 'single_select',
                    selected_value: String(opt.value ?? opt.label),
                    session_state_key: stateKey,
                },
            })),
        });
    } else if (kind === 'multi_select' && options.length > 0) {
        elements.push({
            tag: 'action',
            actions: options.slice(0, 6).map(opt => ({
                tag: 'button',
                text: { tag: 'plain_text', content: opt.label },
                type: 'default',
                value: {
                    action_type: 'single_select',
                    selected_value: String(opt.value ?? opt.label),
                    session_state_key: stateKey,
                },
            })),
        });
        elements.push({
            tag: 'action',
            actions: [{
                tag: 'input',
                name: 'codex_multi',
                placeholder: { tag: 'plain_text', content: '输入编号，用空格分隔（如: 1 3）' },
                width: 'fill',
                value: { action_type: 'text_input', session_state_key: stateKey },
            }],
        });
    }

    elements.push(buildInputRow(stateKey));
    elements.push(buildFooter({ ptsDevice, cwd: null }));

    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: title },
            template: 'orange',
        },
        elements,
    };
}

class CodexWatcher {
    constructor() {
        const appId = process.env.FEISHU_APP_ID;
        const appSecret = process.env.FEISHU_APP_SECRET;
        const chatId = process.env.FEISHU_CHAT_ID;

        if (!appId || !appSecret || !chatId) {
            throw new Error('需要 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_CHAT_ID');
        }

        this.chatId = chatId;
        this.client = createFeishuClient({ appId, appSecret });
        this.offsets = new Map();
        this.mtimes = new Map();
        this.buffers = new Map();
        this.signatures = new Map();
        this.timer = null;
        this._finalCardTimers = new Map();
        this._codexPtsSet = new Set();
    }

    /** 扫描 /proc 找出运行 codex 的 pts 编号 */
    _refreshCodexPtsSet() {
        try {
            const { execSync } = require('child_process');
            const out = execSync("ps -eo tty,args 2>/dev/null | grep -i codex | grep -v grep | grep -v watcher | grep -v 'vscode'", {
                encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
            });
            const pts = new Set();
            for (const line of out.trim().split('\n')) {
                const m = line.match(/pts\/(\d+)/);
                if (m) pts.add(m[1]);
            }
            this._codexPtsSet = pts;
        } catch {
            // 静默失败，保留上次结果
        }
    }

    /** 判断 pts 设备是否属于 Codex */
    _isCodexPts(ptsDevice) {
        const num = extractPtsNum(ptsDevice);
        return this._codexPtsSet.has(num);
    }

    /**
     * patch 后延迟发最终卡片（带输入框）
     * 仅对非噪音内容触发，噪音(Thinking/Booping...)不启动定时器
     * 每次新 patch 重置定时器，确保只在内容稳定后发一次
     */
    _scheduleFinalCard(ptsNum, summaryData, ptsDevice, stateKey, assistantKey) {
        const text = String(summaryData?.summary || '').trim();
        // 噪音内容不触发最终卡片
        if (!text || THINKING_NOISE_PATTERN.test(text)) {
            return;
        }

        const existing = this._finalCardTimers.get(ptsNum);
        if (existing) clearTimeout(existing);

        const timerId = setTimeout(async () => {
            this._finalCardTimers.delete(ptsNum);
            try {
                const finalCard = buildExecutionSummaryCard(summaryData, ptsDevice, stateKey);
                const resp = await this.client.sendCard({ chatId: this.chatId, card: finalCard });
                const messageId = resp?.data?.message_id || null;
                const summaryStateKey = `codex_summary_msg_${ptsNum}`;
                sessionState.load();
                sessionState.data[summaryStateKey] = {
                    ...(sessionState.data[summaryStateKey] || {}),
                    message_id: messageId,
                    state_key: stateKey,
                    mode: 'execution_summary',
                    assistant_key: assistantKey || null,
                    updated_at: Date.now(),
                    pts_device: ptsDevice,
                };
                sessionState.save();
                console.log(`[codex-watcher] 已发送最终卡片(带输入框) -> ${ptsDevice}`);
            } catch (err) {
                console.error(`[codex-watcher] 发送最终卡片失败:`, err.message);
            }
        }, 3000);

        this._finalCardTimers.set(ptsNum, timerId);
    }

    async start() {
        // 检测当前哪些 pts 运行着 Codex 进程
        this._refreshCodexPtsSet();
        this._codexPtsRefreshTimer = setInterval(() => this._refreshCodexPtsSet(), 30000);

        this.timer = setInterval(() => {
            this.tick().catch((err) => {
                console.error('[codex-watcher] tick 失败:', err.message);
            });
        }, POLL_MS);
        await this.tick();
        console.log('[codex-watcher] 已启动，监听 Codex PTY 输出文件');
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        console.log('[codex-watcher] 已停止');
    }

    async tick() {
        const names = fs.readdirSync(TMP_DIR).filter((name) => name.startsWith(OUTPUT_PREFIX));
        for (const name of names) {
            await this.processOutputFile(path.join(TMP_DIR, name));
        }
    }

    async processOutputFile(filePath) {
        // 只处理 Codex 进程所在的 pts，跳过 Claude 终端
        const ptsMatch = filePath.match(/claude-pty-output-(\d+)$/);
        if (ptsMatch && !this._codexPtsSet.has(ptsMatch[1])) return;

        const stat = fs.statSync(filePath);
        const isFirstSeen = !this.offsets.has(filePath);
        const prevOffset = this.offsets.get(filePath) || 0;
        const prevMtimeMs = this.mtimes.get(filePath) || 0;
        const nextOffset = stat.size;
        const nextMtimeMs = stat.mtimeMs || 0;
        const plan = computeReadPlan({
            prevOffset,
            nextOffset,
            prevMtimeMs,
            nextMtimeMs,
            isFirstSeen,
        });
        this.offsets.set(filePath, nextOffset);
        this.mtimes.set(filePath, nextMtimeMs);
        if (!plan.shouldRead) return;

        const fd = fs.openSync(filePath, 'r');
        const len = plan.readLength;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, plan.readOffset);
        fs.closeSync(fd);

        const chunkText = buf.toString('utf8');
        const old = this.buffers.get(filePath) || '';
        // 全文重读(文件被重写或截断)时替换 buffer，避免旧内容污染解析
        const isFullReread = plan.readOffset === 0;
        const merged = isFullReread
            ? chunkText.slice(-WATCHER_BUFFER_MAX_CHARS)
            : (old + chunkText).slice(-WATCHER_BUFFER_MAX_CHARS);
        this.buffers.set(filePath, merged);
        const ptsNum = filePath.replace(/^.*claude-pty-output-/, '');
        const ptsDevice = resolvePtsTarget(ptsNum);

        // Prefer parsing the latest incremental chunk, then fall back to merged buffer.
        // This avoids older terminal history masking newly emitted prompts.
        let parsed = parseOutputBlock(chunkText);
        if (!parsed || parsed.kind === 'none') {
            parsed = parseOutputBlock(merged);
        }
        if (!parsed || parsed.kind === 'none') {
            // PTY 终端输出包含用户输入回显和终端噪音，不从这里生成摘要卡片
            // 摘要卡片统一由 processAssistantFeed（session-watcher 提供的干净数据）生成
            return;
        }
        if (!parsed.question || parsed.question.length < 3) return;

        const signature = `${parsed.kind}:${parsed.question}`;
        if (this.signatures.get(ptsDevice) === signature) return;
        this.signatures.set(ptsDevice, signature);

        const stateKey = buildStateKey(ptsNum);
        sessionState.addNotification(stateKey, {
            host: 'codex',
            session_id: `codex_${ptsNum}`,
            notification_type: 'codex_auto_prompt',
            pts_device: ptsDevice,
            created_at: Date.now(),
            responses: {},
        });

        const card = buildCard(parsed, ptsDevice, stateKey);
        await this.client.sendCard({ chatId: this.chatId, card });
        console.log(`[codex-watcher] 已发送 ${parsed.kind} 卡片 -> ${ptsDevice}`);
        return;
    }

    async upsertSummaryCard(summaryData, ptsDevice, mode, template, signature = null, forceCreate = false, assistantKey = null) {
        const ptsNum = extractPtsNum(ptsDevice);
        const summaryStateKey = `codex_summary_msg_${ptsNum}`;
        sessionState.load();
        const current = sessionState.data[summaryStateKey] || null;
        const stateKey = current?.state_key || buildStateKey(ptsNum);
        if (!current?.state_key) {
            sessionState.addNotification(stateKey, {
                host: 'codex',
                session_id: `codex_${ptsNum}`,
                notification_type: mode,
                pts_device: ptsDevice,
                created_at: Date.now(),
                responses: {},
            });
        }
        const card = template === 'green'
            ? buildExecutionSummaryCard(summaryData, ptsDevice, stateKey)
            : buildLiveSummaryCard(summaryData, ptsDevice, stateKey);

        // 完成卡片(绿色)强制新建：飞书 patch API 会丢失交互元素(input)
        const shouldCreate = forceCreate || template === 'green';

        if (!shouldCreate && current?.message_id) {
            try {
                await this.client.patchCard({ messageId: current.message_id, card });
                const stateEntry = sessionState.getNotification(stateKey) || {};
                sessionState.addNotification(stateKey, {
                    ...stateEntry,
                    host: 'codex',
                    session_id: `codex_${ptsNum}`,
                    notification_type: mode,
                    pts_device: ptsDevice,
                    created_at: stateEntry.created_at || Date.now(),
                    responses: stateEntry.responses || {},
                });
                sessionState.data[summaryStateKey] = {
                    ...current,
                    state_key: stateKey,
                    mode,
                    signature: signature || current.signature || null,
                    assistant_key: assistantKey || current.assistant_key || null,
                    updated_at: Date.now(),
                    pts_device: ptsDevice,
                };
                sessionState.save();
                console.log(`[codex-watcher] 已 patch ${mode} 卡片 -> ${ptsDevice}`);
                // patch 成功后启动定时器：内容稳定 3 秒后发最终卡片(带输入框)
                this._scheduleFinalCard(ptsNum, summaryData, ptsDevice, stateKey, assistantKey);
                return;
            } catch (err) {
                console.error(`[codex-watcher] patch ${mode} 失败，改为 create -> ${ptsDevice}:`, err.message);
            }
        }

        const resp = await this.client.sendCard({ chatId: this.chatId, card });
        const messageId = resp?.data?.message_id || null;
        sessionState.load();
        const stateEntry = sessionState.data[stateKey] || {};
        sessionState.data[stateKey] = {
            ...stateEntry,
            host: 'codex',
            session_id: `codex_${ptsNum}`,
            notification_type: mode,
            pts_device: ptsDevice,
            created_at: stateEntry.created_at || Date.now(),
            responses: stateEntry.responses || {},
        };
        sessionState.data[summaryStateKey] = {
            message_id: messageId,
            state_key: stateKey,
            mode,
            signature: signature || null,
            assistant_key: assistantKey || null,
            created_at: Date.now(),
            updated_at: Date.now(),
            pts_device: ptsDevice,
        };
        sessionState.save();
        console.log(`[codex-watcher] 已发送 ${mode} 卡片 -> ${ptsDevice}`);
    }
}

async function main() {
    const watcher = new CodexWatcher();
    process.on('SIGINT', () => {
        watcher.stop();
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        watcher.stop();
        process.exit(0);
    });
    await watcher.start();
}

if (require.main === module) {
    main().catch((err) => {
        console.error('[codex-watcher] 启动失败:', err.message);
        process.exit(1);
    });
}

module.exports = {
    CodexWatcher,
    main,
    buildExecutionSummaryCard,
    buildLiveSummaryCard,
    buildCard,
    computeReadPlan,
    isCompletionLikeSummary,
};
