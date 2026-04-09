'use strict';

const {
    buildCardFooter,
    formatTokenCount,
    formatDuration,
    normalizeTokenUsage,
    nowText,
} = require('../lib/card-footer');

/**
 * Codex 专用 footer 构建器 —— 向后兼容包装层
 * 内部委托给通用 buildCardFooter，固定 host 为 'codex'。
 */
function buildCodexFooter(opts) {
    return buildCardFooter({ host: 'codex', ...opts });
}

module.exports = {
    buildCodexFooter,
    buildCardFooter,
    formatTokenCount,
    formatDuration,
    normalizeTokenUsage,
    nowText,
};
