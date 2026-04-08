'use strict';

require('../src/lib/env-config');

const { resolvePtsDevice } = require('../src/lib/terminal-inject');
const {
    getFeishuAppClient,
    getProjectName,
    getTimestamp,
    sendSingleSelectCard,
} = require('../src/apps/claude-ask');

async function main() {
    const app = await getFeishuAppClient();
    if (!app) {
        console.error('[send-claude-ask-test-card] 飞书配置缺失');
        process.exit(1);
    }

    const ptsDevice = resolvePtsDevice(process.pid);
    const projectName = getProjectName(process.cwd());
    const termLabel = ptsDevice?.startsWith('tmux:')
        ? `🖥 ${ptsDevice.substring(5)}`
        : (ptsDevice || '🖥 未知终端');
    const noteParts = [projectName ? `📁 ${projectName}` : null, termLabel, `⏰ ${getTimestamp()}`]
        .filter(Boolean)
        .join('  ·  ');

    await sendSingleSelectCard(
        app,
        {
            header: '方案选择',
            question: '请选择本轮回归验证要走的方案',
            options: [
                { label: '测试选项一', value: 'option-a' },
                { label: '测试选项二', value: 'option-b' },
            ],
        },
        `feishu_ask_test_${Date.now()}`,
        ptsDevice,
        'test-session',
        'AskUserQuestion',
        noteParts
    );

    console.log('[send-claude-ask-test-card] 已发送方案选择卡片');
}

main().catch(err => {
    console.error('[send-claude-ask-test-card]', err.message);
    process.exit(1);
});
