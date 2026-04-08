/**
 * Claude Code Hook 统一处理器
 * 读取 hook stdin JSON，根据事件类型发送不同格式的飞书卡片通知
 *
 * 支持的事件:
 *   Stop         - 任务完成，携带最后一条助手消息
 *   Notification - 等待用户操作（权限确认、方案选择等）
 *   StopFailure  - 异常退出（API 错误等）
 */

const fs = require('fs');
const path = require('path');
const { envConfig } = require('../lib/env-config');
const { sessionState } = require('../lib/session-state');
const { resolvePtsDevice } = require('../lib/terminal-inject');
const Lark = require('@larksuiteoapi/node-sdk');
const { parseMarkdownToElements } = require('../lib/feishu-card-utils');

// ── 会话统计 ─────────────────────────────────────────────

function parseSessionStats(transcriptPath) {
    if (!transcriptPath) return null;
    try {
        const raw = fs.readFileSync(transcriptPath, 'utf8').trim();
        if (!raw) return null;
        const lines = raw.split('\n');

        const timestamps = [];
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheCreateTokens = 0;

        for (const line of lines) {
            let d;
            try { d = JSON.parse(line); } catch { continue; }
            if (d.timestamp) timestamps.push(d.timestamp);
            if (d.type === 'assistant') {
                const usage = (d.message && d.message.usage) || {};
                inputTokens += usage.input_tokens || 0;
                outputTokens += usage.output_tokens || 0;
                cacheReadTokens += usage.cache_read_input_tokens || 0;
                cacheCreateTokens += usage.cache_creation_input_tokens || 0;
            }
        }

        let duration = '';
        if (timestamps.length >= 2) {
            const ms = new Date(timestamps[timestamps.length - 1]) - new Date(timestamps[0]);
            const totalSec = Math.floor(ms / 1000);
            const h = Math.floor(totalSec / 3600);
            const m = Math.floor((totalSec % 3600) / 60);
            const s = totalSec % 60;
            duration = h > 0 ? `${h}h${m}m${s}s` : m > 0 ? `${m}m${s}s` : `${s}s`;
        }

        return { duration, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens };
    } catch {
        return null;
    }
}

function formatTokenCount(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
}

// ── 工具函数 ─────────────────────────────────────────────

/** 从 transcript 提取最近的 AskUserQuestion 数据及上下文文本 */
function extractAskUserQuestion(transcriptPath) {
    if (!transcriptPath) return null;
    try {
        const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
        // 只检查最后一条 assistant 消息，避免读到更早的 AskUserQuestion
        for (let i = lines.length - 1; i >= 0; i--) {
            let d;
            try { d = JSON.parse(lines[i]); } catch { continue; }
            if (d.type !== 'assistant') continue;
            // 找到最后一条 assistant 消息，检查是否包含 AskUserQuestion
            const content = d.message?.content || [];
            let askInput = null;
            let contextText = '';
            for (const block of content) {
                if (block.type === 'text' && block.text) {
                    contextText += block.text + '\n';
                }
                if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
                    askInput = block.input;
                }
            }
            if (askInput) {
                askInput._contextText = contextText.trim();
                return askInput;
            }
            return null;
        }
    } catch {}
    return null;
}

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        let resolved = false;
        const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };

        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => data += chunk);
        process.stdin.on('end', () => {
            try { done(JSON.parse(data)); }
            catch { done({}); }
        });
        // 超时保护，防止没有 stdin 时卡死
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

/** 从助手消息中提取第一行有意义的文本作为标题 */
function extractTitle(message, maxLen = 50) {
    if (!message) return '任务已完成';
    const lines = message.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        // 跳过空行、代码块标记、纯分隔线
        if (!trimmed || trimmed.startsWith('```') || /^[-=─]+$/.test(trimmed)) continue;
        // 去掉 markdown 格式符号
        const cleaned = trimmed.replace(/^[#*>]+\s*/, '').replace(/[*`_~]/g, '').trim();
        if (!cleaned) continue;
        return cleaned.length <= maxLen ? cleaned : cleaned.substring(0, maxLen) + '...';
    }
    return '任务已完成';
}

/** 清理文本 */
function truncate(text) {
    if (!text) return '';
    return text.trim();
}

// ── 卡片构建 ─────────────────────────────────────────────

/** 构建输入框行（可选 Esc 按钮，通过 ENABLE_ESC_BUTTON=true 开启） */
function buildInputRow(stateKey) {
    const actions = [
        {
            tag: 'input',
            name: 'user_input',
            placeholder: { tag: 'plain_text', content: '输入指令...' },
            width: 'fill',
            value: { action_type: 'text_input', session_state_key: stateKey },
        },
    ];
    if (process.env.ENABLE_ESC_BUTTON === 'true') {
        actions.push({
            tag: 'button',
            text: { tag: 'plain_text', content: 'esc' },
            type: 'danger',
            size: 'small',
            value: { action_type: 'esc', session_state_key: stateKey },
        });
    }
    return { tag: 'action', actions };
}

function buildCard(title, body, template, projectName, stats) {
    const noteParts = [];
    if (projectName) noteParts.push(`📁 ${projectName}`);
    if (stats && stats.duration) noteParts.push(`⏱ ${stats.duration}`);
    noteParts.push(`⏰ ${getTimestamp()}`);

    const elements = parseMarkdownToElements(body);

    if (stats) {
        const tokenParts = [];
        tokenParts.push(`输入 ${formatTokenCount(stats.inputTokens)}`);
        tokenParts.push(`输出 ${formatTokenCount(stats.outputTokens)}`);
        if (stats.cacheReadTokens > 0) tokenParts.push(`缓存读 ${formatTokenCount(stats.cacheReadTokens)}`);
        if (stats.cacheCreateTokens > 0) tokenParts.push(`缓存写 ${formatTokenCount(stats.cacheCreateTokens)}`);
        noteParts.push(`📊 ${tokenParts.join(' · ')}`);
    }

    elements.push({ tag: 'markdown', content: noteParts.join('  ·  ') });

    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: title },
            template
        },
        elements
    };
}

// ── 事件处理 ─────────────────────────────────────────────

function handleStop(data, stats) {
    const lastMsg = data.last_assistant_message || '';
    const title = extractTitle(lastMsg);
    const body = truncate(lastMsg) || '任务已完成，可以查看执行结果了';
    return buildCard(`✅ ${title}`, body, 'green', getProjectName(data.cwd), stats);
}

function handleNotification(data, stats) {
    const type = data.notification_type || '';
    const message = data.message || '需要你的操作';

    const titleMap = {
        'permission_prompt': '权限确认',
        'idle_prompt': '等待输入',
        'elicitation_dialog': '等待操作'
    };
    const title = titleMap[type] || '等待操作';

    return buildCard(`⏸️ ${title}`, message, 'orange', getProjectName(data.cwd), stats);
}

function handleStopFailure(data, stats) {
    const error = data.error || 'unknown';
    const details = data.error_details || '发生未知错误';

    const errorMap = {
        'rate_limit': 'API 频率限制',
        'authentication_failed': '认证失败',
        'billing_error': '计费错误',
        'server_error': '服务器错误',
        'max_output_tokens': '输出超长',
        'invalid_request': '请求无效'
    };
    const title = errorMap[error] || '异常退出';

    return buildCard(`❌ ${title}`, details, 'red', getProjectName(data.cwd), stats);
}

// ── 飞书自建应用 API 发送卡片 ──────────────────────────────

/** 获取飞书自建应用 client 和 chatId，无配置则返回 null */
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

/** 通过自建应用 API 发送普通卡片（Stop / StopFailure） */
async function sendFeishuAppCard(data, event, stats) {
    const app = await getFeishuAppClient();
    if (!app) return;

    const feishuHandlers = {
        'Stop': handleStop,
        'Notification': handleNotification,
        'StopFailure': handleStopFailure
    };
    const handler = feishuHandlers[event];
    if (!handler) return;

    const card = handler(data, stats);

    // 给所有卡片添加输入框，支持从卡片直接输入指令
    const sessionId = data.session_id || '';
    const stateKey = `feishu_${sessionId.substring(0, 8)}_${Date.now()}`;
    const ptsDevice = resolvePtsDevice(process.ppid);

    // 在 footer（最后一个元素）之前插入输入框
    const inputEl = buildInputRow(stateKey);
    const insertAt = card.elements.length - 1;
    if (insertAt >= 0) {
        card.elements.splice(insertAt, 0, inputEl);
    } else {
        card.elements.push(inputEl);
    }

    // 存储 session state，使 listener 能路由输入到终端
    sessionState.addNotification(stateKey, {
        session_id: sessionId,
        notification_type: event,
        pts_device: ptsDevice,
        created_at: Date.now(),
        responses: {
            'esc': { keys: '\x1b', label: 'Esc' },
        },
    });

    try {
        await app.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
                receive_id: app.chatId,
                msg_type: 'interactive',
                content: JSON.stringify(card),
            },
        });
    } catch (err) {
        console.error('[feishu-app] 发送卡片失败:', err.message);
    }
}

// ── 飞书交互卡片（Notification 事件，带回调按钮） ────────────

async function sendFeishuInteractiveCard(data, stats) {
    const app = await getFeishuAppClient();
    if (!app) return;

    const projectName = getProjectName(data.cwd);
    const type = data.notification_type || '';
    const message = data.message || '需要你的操作';
    const sessionId = data.session_id || '';

    // AskUserQuestion 已由 ask-handler.js（PreToolUse）处理，跳过重复卡片
    // 检查 sessionState 里是否有近期的 feishu_ask_ 条目（30 秒内）
    const sessionPrefix = sessionId.substring(0, 8);
    sessionState.load();
    const hasRecentAsk = Object.entries(sessionState.data)
        .some(([k, v]) => k.startsWith(`feishu_ask_${sessionPrefix}`) && Date.now() - (v.created_at || 0) < 30000);
    if (hasRecentAsk) return;

    // bypassPermissions 模式下 PreToolUse 不触发，从 transcript 检测 AskUserQuestion
    const askInput = extractAskUserQuestion(data.transcript_path);
    if (askInput) {
        const { sendSingleSelectCard, sendMultiSelectCard, sendMultiQuestionFirstCard } = require('./claude-ask');
        const questions = Array.isArray(askInput.questions) ? askInput.questions : [];
        if (questions.length > 0) {
            questions.forEach(q => { q._contextText = askInput._contextText || ''; });
            const ptsDevice = resolvePtsDevice(process.ppid);
            const stateKey = `feishu_ask_${sessionPrefix}_${Date.now()}`;
            const notificationType = 'AskUserQuestion';

            const termLabel = ptsDevice?.startsWith('tmux:')
                ? `🖥 ${ptsDevice.substring(5)}`
                : (ptsDevice || '🖥 未知终端');
            const noteArr = [];
            if (projectName) noteArr.push(`📁 ${projectName}`);
            noteArr.push(termLabel);
            noteArr.push(`⏰ ${getTimestamp()}`);
            const noteParts = noteArr.join('  ·  ');

            if (questions.length > 1) {
                await sendMultiQuestionFirstCard(app, questions, stateKey, ptsDevice, sessionId, notificationType, noteParts);
            } else {
                const q = questions[0];
                if (q.multiSelect) {
                    await sendMultiSelectCard(app, q, stateKey, ptsDevice, sessionId, notificationType, noteParts);
                } else {
                    await sendSingleSelectCard(app, q, stateKey, ptsDevice, sessionId, notificationType, noteParts);
                }
            }
            return;
        }
    }

    // Create a unique key for session-state.json
    const stateKey = `feishu_${sessionPrefix}_${Date.now()}`;

    // 解析终端目标（提前获取用于卡片显示）
    const ptsDevice = resolvePtsDevice(process.ppid);
    const termLabel = ptsDevice?.startsWith('tmux:') ? `🖥 ${ptsDevice.substring(5)}` : (ptsDevice || '🖥 未知终端');

    // 构建底部信息栏
    const noteParts = [];
    if (projectName) noteParts.push(`📁 ${projectName}`);
    noteParts.push(termLabel);
    if (stats && stats.duration) noteParts.push(`⏱ ${stats.duration}`);
    noteParts.push(`⏰ ${getTimestamp()}`);

    let title, buttons, responses, cardMessage;

    if (type === 'idle_prompt') {
        // idle_prompt：只有输入框，没有按钮（避免和权限卡片混淆）
        title = '💬 等待输入';
        cardMessage = 'Claude 等待你的下一步指令';
        buttons = null;
        responses = {};
    } else {
        // 权限确认等通用 Notification
        const titleMap = { 'permission_prompt': '🔐 权限确认', 'elicitation_dialog': '📋 等待操作' };
        title = titleMap[type] || '⏸️ 等待操作';

        // 从 transcript 读取工具详情 + 从 pty 输出读取实际选项
        let toolDesc = message || '需要你的操作';
        let parsedOptions = [];
        try {
            // 1. 从 transcript 获取工具调用详情
            const tLines = fs.readFileSync(data.transcript_path, 'utf8').trim().split('\n');
            for (let i = tLines.length - 1; i >= 0; i--) {
                let d; try { d = JSON.parse(tLines[i]); } catch { continue; }
                if (d.type !== 'assistant') continue;
                const blocks = d.message?.content || [];
                for (const b of blocks) {
                    if (b.type === 'tool_use') {
                        const input = b.input || {};
                        if (b.name === 'Bash' && input.command) {
                            toolDesc = `⚡ **Bash**\n\`\`\`\n${input.command}\n\`\`\``;
                            if (input.description) toolDesc += `\n${input.description}`;
                        } else if (input.file_path) {
                            const icons = { Read: '📖', Edit: '✏️', Write: '📝' };
                            toolDesc = `${icons[b.name] || '🔧'} **${b.name}**: \`${input.file_path}\``;
                        } else {
                            toolDesc = `🔧 **${b.name}**`;
                        }
                        break;
                    }
                }
                if (toolDesc !== (message || '需要你的操作')) break;
            }

            // 2. 从 pty 输出文件读取终端实际选项
            const ptsDevice = resolvePtsDevice(process.ppid);
            const ptsMatch = ptsDevice?.match(/pts(\d+)/);
            if (ptsMatch) {
                const outputPath = `/tmp/claude-pty-output-${ptsMatch[1]}`;
                if (fs.existsSync(outputPath)) {
                    const rawOutput = fs.readFileSync(outputPath, 'utf8');
                    // 去掉 ANSI 转义码（颜色、光标移动等），再解析选项
                    // eslint-disable-next-line no-control-regex
                    const cleanOutput = rawOutput.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
                    const optRegex = /(\d+)\.\s*(.+)/g;
                    let m;
                    while ((m = optRegex.exec(cleanOutput)) !== null) {
                        const text = m[2].trim().split(/\r|\n/)[0].trim();
                        if (text && /^(Yes|No)/i.test(text)) {
                            parsedOptions.push({ num: m[1], text });
                        }
                    }
                }
            }
        } catch {}

        cardMessage = toolDesc;

        if (parsedOptions.length > 0) {
            // 从终端输出解析到了实际选项，生成完全匹配的按钮
            buttons = parsedOptions.map(opt => {
                const isPositive = /^yes/i.test(opt.text);
                const isNegative = /^no/i.test(opt.text);
                return {
                    text: `${opt.num}. ${opt.text}`,
                    actionType: `opt_${opt.num}`,
                    color: isPositive ? 'green' : (isNegative ? 'red' : 'default'),
                };
            });
            buttons.push({ text: '🔓 全局允许', actionType: 'bypass', color: 'default' });
            responses = {};
            parsedOptions.forEach(opt => {
                responses[`opt_${opt.num}`] = { keys: opt.num, label: opt.text };
            });
            responses['bypass'] = { keys: '1', label: '全局允许' };
        } else {
            // 无法解析选项，使用通用按钮
            buttons = [
                { text: '✅ 允许一次', actionType: 'opt_1', color: 'green' },
                { text: '🔓 会话允许', actionType: 'opt_2', color: 'default' },
                { text: '❌ 拒绝', actionType: 'opt_no', color: 'red' },
                { text: '🔓 全局允许', actionType: 'bypass', color: 'default' },
            ];
            responses = {
                'opt_1': { keys: '1', label: '已允许' },
                'opt_2': { keys: '2', label: '会话允许' },
                'opt_no': { keys: '\x1b', label: '已拒绝' },
                'bypass': { keys: '1', label: '全局允许' },
            };
        }
    }

    // Build card JSON
    const cardElements = parseMarkdownToElements(cardMessage);

    if (buttons) {
        const buttonElements = buttons.map(btn => ({
            tag: 'button',
            text: { tag: 'plain_text', content: btn.text },
            type: btn.color === 'red' ? 'danger' : (btn.color === 'green' ? 'primary' : 'default'),
            value: { action_type: btn.actionType, session_state_key: stateKey },
        }));
        // 权限卡片：按钮和输入框合并到同一行
        if (type === 'permission_prompt') {
            buttonElements.push({
                tag: 'input',
                name: 'user_input',
                placeholder: { tag: 'plain_text', content: '输入指令...' },
                width: 'fill',
                value: { action_type: 'text_input', session_state_key: stateKey },
            });
            cardElements.push({ tag: 'action', actions: buttonElements });
        } else {
            cardElements.push({ tag: 'action', actions: buttonElements });
            cardElements.push(buildInputRow(stateKey));
        }
    } else {
        // 无按钮时单独输入框
        cardElements.push(buildInputRow(stateKey));
    }

    cardElements.push({ tag: 'markdown', content: noteParts.join('  ·  ') });

    const card = {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: title },
            template: 'orange',
        },
        elements: cardElements,
    };

    // Send the card
    try {
        await app.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
                receive_id: app.chatId,
                msg_type: 'interactive',
                content: JSON.stringify(card),
            },
        });

        // Resolve pts device and store notification state
        const ptsDevice = resolvePtsDevice(process.ppid);
        responses['esc'] = { keys: '\x1b', label: 'Esc' };
        sessionState.addNotification(stateKey, {
            session_id: sessionId,
            notification_type: type,
            pts_device: ptsDevice,
            created_at: Date.now(),
            responses: responses,
        });
    } catch (err) {
        console.error('[feishu] 发送交互卡片失败:', err.message);
    }
}

// ── 主流程 ───────────────────────────────────────────────

async function main() {
    const data = await readStdin();
    const event = data.hook_event_name;
    if (!event) return;

    const stats = parseSessionStats(data.transcript_path);
    const tasks = [];
    const useFeishuApp = envConfig.getFeishuAppConfig().enabled;
    if (!useFeishuApp) return;

    if (event === 'Notification') {
        const type = data.notification_type || '';
        if (type === 'permission_prompt') {
            const ptsDevice = resolvePtsDevice(process.ppid);
            sessionState.load();
            const meta = sessionState.data['__meta__'] || {};
            const autoDevices = meta.autoApproveDevices || [];
            if (autoDevices.includes(ptsDevice)) {
                const { injectKeys } = require('../lib/terminal-inject');
                injectKeys(ptsDevice, '2').catch(() => {});
                return;
            }
        }
        if (type !== 'idle_prompt' && type !== 'elicitation_dialog') {
            tasks.push(sendFeishuInteractiveCard(data, stats));
        }
    } else {
        tasks.push(sendFeishuAppCard(data, event, stats));
    }

    if (tasks.length > 0) {
        await Promise.allSettled(tasks);
    }
}

main().catch(err => {
    console.error('Hook handler error:', err.message);
    process.exit(0); // 不要阻塞 Claude
});
