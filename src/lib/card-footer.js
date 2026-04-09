'use strict';

const HOST_LABELS = {
    claude: '🤖 Claude',
    codex: '🤖 Codex',
};

function formatTokenCount(n) {
    if (n == null || !Number.isFinite(Number(n))) return null;
    const value = Number(n);
    if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
    if (value >= 1000) return (value / 1000).toFixed(1) + 'k';
    return String(value);
}

function normalizeTokenUsage(tokens) {
    if (!tokens || typeof tokens !== 'object') return null;
    const input = Number.isFinite(Number(tokens.input)) ? Number(tokens.input) : null;
    const cached = Number.isFinite(Number(tokens.cached)) ? Number(tokens.cached) : null;
    const cacheWrite = Number.isFinite(Number(tokens.cacheWrite)) ? Number(tokens.cacheWrite) : null;
    const output = Number.isFinite(Number(tokens.output)) ? Number(tokens.output) : null;
    const total = Number.isFinite(Number(tokens.total)) ? Number(tokens.total) : null;
    // 兼容 claude-hook.js 传入的字段名
    const inputTokens = tokens.inputTokens != null ? Number(tokens.inputTokens) : null;
    const outputTokens = tokens.outputTokens != null ? Number(tokens.outputTokens) : null;
    const cacheReadTokens = tokens.cacheReadTokens != null ? Number(tokens.cacheReadTokens) : null;
    const cacheCreateTokens = tokens.cacheCreateTokens != null ? Number(tokens.cacheCreateTokens) : null;

    const finalInput = input ?? inputTokens;
    const finalOutput = output ?? outputTokens;
    const finalCached = cached ?? cacheReadTokens;
    const finalCacheWrite = cacheWrite ?? cacheCreateTokens;

    if (finalInput == null && finalOutput == null && finalCached == null && finalCacheWrite == null && total == null) return null;
    return { input: finalInput, cached: finalCached, cacheWrite: finalCacheWrite, output: finalOutput, total };
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

function formatDuration(startedAt, endedAt = Date.now()) {
    if (!startedAt) return null;
    const startMs = new Date(startedAt).getTime();
    const endMs = typeof endedAt === 'number' ? endedAt : new Date(endedAt).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
    const totalSec = Math.floor((endMs - startMs) / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h${m}m${s}s`;
    if (m > 0) return `${m}m${s}s`;
    return `${s}s`;
}

/**
 * 通用卡片 footer 构建器
 * 统一格式: 🤖 {Host}  ·  🖥 {terminal}  ·  📁 {projectName}  ·  ⏱ {duration}  ·  ⏰ {timestamp}  ·  📊 token统计
 *
 * @param {Object} opts
 * @param {string} opts.host - 宿主标识: 'claude' | 'codex'
 * @param {string} [opts.ptsDevice] - 终端设备标识，如 'pts/3'、'tmux:session:0'
 * @param {string} [opts.projectName] - 项目名
 * @param {Object|null} [opts.tokens] - token 统计对象
 * @param {string|number|null} [opts.startedAt] - 任务开始时间
 * @param {number} [opts.endedAt] - 任务结束时间，默认 Date.now()
 * @param {string} [opts.duration] - 预计算的时长字符串，优先于 startedAt/endedAt
 * @param {string} [opts.timestamp] - 当前时间文本，默认自动生成
 * @returns {{ tag: string, content: string }} 飞书 markdown 元素
 */
function buildCardFooter({ host, ptsDevice, projectName, tokens, startedAt = null, endedAt = Date.now(), duration = null, timestamp = null }) {
    const parts = [];

    // 🤖 宿主标识
    const hostLabel = HOST_LABELS[host] || `🤖 ${host || 'Unknown'}`;
    parts.push(hostLabel);

    // 🖥 终端标识
    if (ptsDevice) {
        const termStr = String(ptsDevice);
        if (termStr.startsWith('tmux:')) {
            parts.push(`🖥 ${termStr.substring(5)}`);
        } else {
            parts.push(`🖥 ${termStr.replace('/dev/', '')}`);
        }
    }

    // 📁 项目名
    if (projectName) parts.push(`📁 ${projectName}`);

    // ⏱ 时长
    const dur = duration || formatDuration(startedAt, endedAt);
    if (dur) parts.push(`⏱ ${dur}`);

    // ⏰ 时间戳
    parts.push(`⏰ ${timestamp || nowText()}`);

    // 📊 Token 统计
    const normalizedTokens = normalizeTokenUsage(tokens);
    if (normalizedTokens) {
        const tokenParts = [];
        if (normalizedTokens.input != null) tokenParts.push(`输入 ${formatTokenCount(normalizedTokens.input)}`);
        if (normalizedTokens.output != null) tokenParts.push(`输出 ${formatTokenCount(normalizedTokens.output)}`);
        if (normalizedTokens.cached != null) tokenParts.push(`缓存读 ${formatTokenCount(normalizedTokens.cached)}`);
        if (normalizedTokens.cacheWrite != null) tokenParts.push(`缓存写 ${formatTokenCount(normalizedTokens.cacheWrite)}`);
        if (normalizedTokens.total != null) tokenParts.push(`总计 ${formatTokenCount(normalizedTokens.total)}`);
        if (tokenParts.length) parts.push(`📊 ${tokenParts.join(' · ')}`);
    }

    return { tag: 'markdown', content: parts.join('  ·  ') };
}

module.exports = {
    buildCardFooter,
    formatTokenCount,
    formatDuration,
    normalizeTokenUsage,
    nowText,
};
