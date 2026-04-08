'use strict';

require('../src/lib/env-config');
const { createFeishuClient } = require('../src/channels/feishu/feishu-client');

function parseArg(name) {
    const idx = process.argv.indexOf(name);
    if (idx === -1) return null;
    return process.argv[idx + 1] || null;
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

async function main() {
    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;
    const chatId = process.env.FEISHU_CHAT_ID;
    const text = parseArg('--text') || process.env.CODEX_DIRECT_TEXT || '';
    const title = parseArg('--title') || '⚡ Codex 执行中';

    if (!appId || !appSecret || !chatId) {
        throw new Error('需要 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_CHAT_ID');
    }
    if (!text.trim()) {
        throw new Error('需要 --text 或 CODEX_DIRECT_TEXT');
    }

    const client = createFeishuClient({ appId, appSecret });
    const card = {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: title },
            template: 'blue',
        },
        elements: [
            { tag: 'div', text: { tag: 'lark_md', content: text.trim() } },
            { tag: 'markdown', content: `🤖 Codex  ·  ⏰ ${nowText()}` },
        ],
    };

    await client.sendCard({ chatId, card });
    console.log('[codex-direct] 已直接发送到飞书');
}

if (require.main === module) {
    main().catch((err) => {
        console.error('[codex-direct] 失败:', err.message);
        process.exit(1);
    });
}

