'use strict';

/**
 * 回归测试：多问题 AskUserQuestion 完整流程
 *
 * 覆盖以下已修复的 bug：
 *   1. sendNextQuestion 曾使用 '\n' 而非 '\r' 拼接 Enter 键
 *   2. 全部问题回答完毕后，"完成卡片" 误注入了额外的 '\n' 到终端
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { SessionState } = require('../../src/lib/session-state');

// ── 被 mock 的注入模块路径 ───────────────────────────────────
const TERMINAL_INJECT_PATH = require.resolve('../../src/lib/terminal-inject');

// ── 辅助：创建一个隔离的 SessionState（写到 /tmp 避免污染生产状态文件）
function makeTempSessionState() {
    const tmpPath = `/tmp/test-multi-q-session-state-${process.pid}.json`;
    return new SessionState(tmpPath);
}

// ── 辅助：重置 require 缓存中的 terminal-inject，以便注入 mock ─
function stubTerminalInject(injections) {
    // 先清出缓存
    delete require.cache[TERMINAL_INJECT_PATH];

    // 构造一个满足 terminal-inject 导出结构的 stub
    const stub = {
        resolveTarget: () => null,
        resolvePtsDevice: () => null,
        injectKeys: async (_target, keys) => {
            injections.push(keys);
            return true;
        },
        injectText: async (_target, text) => {
            injections.push(text);
            return true;
        },
        // feishu-listener 不直接使用这两个，但保留导出完整性
        createTerminalInjector: () => ({}),
        createTerminalRouter: () => ({}),
    };

    require.cache[TERMINAL_INJECT_PATH] = {
        id: TERMINAL_INJECT_PATH,
        filename: TERMINAL_INJECT_PATH,
        loaded: true,
        exports: stub,
    };

    return stub;
}

// ── 辅助：恢复 terminal-inject 的真实模块 ──────────────────
function restoreTerminalInject() {
    delete require.cache[TERMINAL_INJECT_PATH];
}

// ── 辅助：构建假飞书 listener 对象 ─────────────────────────
// 使用 Object.create(FL.prototype) 使得 handleCardAction 中 this.sendNextQuestion 可用。
// FL 在每个测试中动态获取，因此 makeFakeListener 接受 FL 作为参数。
function makeFakeListener(FL, state, sent) {
    const listener = Object.create(FL.prototype);
    listener.state = state;
    listener.client = {
        im: {
            message: {
                create: async ({ data }) => {
                    sent.push(JSON.parse(data.content));
                    return { data: { message_id: 'msg-1' } };
                },
            },
        },
    };
    listener.sleep = () => Promise.resolve();
    listener.codexInputBridge = null;
    listener.unifiedInteractionHandler = null;
    return listener;
}

test('多问题流程：Q1→Q2→完成，仅注入 2 次 \\r，不产生额外注入', async (t) => {
    const injections = [];

    // 在测试开始前 stub，确保 feishu-listener 内的 injectKeys 被拦截
    // feishu-listener 已被 require 过，但 handleCardAction 内部用的是
    // 其 require 时绑定的 injectKeys 引用；需要在首次 require 前 stub，
    // 或通过 fake listener 绕过真实注入。
    // 本测试选择：先 stub terminal-inject，再重新 require feishu-listener，
    // 以确保模块内闭包引用的是 stub 版本。

    // 清理 feishu-listener 的 require 缓存，让它重新绑定 stub
    const LISTENER_PATH = require.resolve('../../src/apps/feishu-listener');
    delete require.cache[LISTENER_PATH];

    stubTerminalInject(injections);

    // 重新加载 feishu-listener，使其 require 到 stub 版的 terminal-inject
    // 注意：FeishuListener 构造函数会读取环境变量并连接飞书，所以我们
    // 直接使用 prototype 方法而不实例化真实的 FeishuListener。
    const { FeishuListener: FL } = require('../../src/apps/feishu-listener');

    const state = makeTempSessionState();
    const sent = [];
    const listener = makeFakeListener(FL, state, sent);

    // ── 准备 Q1 的 session state（与 sendMultiQuestionFirstCard 存储格式一致）
    const stateKey = 'test-multi-q-state';
    const ptsDevice = 'fifo:/tmp/test-multi-q';
    const ARROW_DOWN = '\x1b[B';

    const questions = [
        {
            header: '问题一',
            question: '请选择 Q1 选项',
            options: [
                { label: 'Option A', value: 'a' },
                { label: 'Option B', value: 'b' },
            ],
        },
        {
            header: '问题二',
            question: '请选择 Q2 选项',
            options: [
                { label: 'Option C', value: 'c' },
                { label: 'Option D', value: 'd' },
            ],
        },
    ];

    // Q1 responses（与 sendMultiQuestionFirstCard 一致）
    const q1Responses = {};
    questions[0].options.forEach((opt, idx) => {
        q1Responses[`opt_${idx}`] = { keys: ARROW_DOWN.repeat(idx) + '\r', label: opt.label };
    });
    q1Responses['opt_other'] = { keys: ARROW_DOWN.repeat(questions[0].options.length) + '\r', label: 'Other' };
    q1Responses['_other_num'] = { keys: ARROW_DOWN.repeat(questions[0].options.length) + '\r', label: '_meta' };
    q1Responses['interrupt'] = { keys: '\x1b', label: '⛔ Interrupt' };

    state.addNotification(stateKey, {
        session_id: 'test-session',
        notification_type: 'AskUserQuestion',
        pts_device: ptsDevice,
        created_at: Date.now(),
        responses: q1Responses,
        _all_questions: questions,
        _current_q: 0,
        _chat_id: 'chat-test-1',
        _note_parts: '测试 footer',
    });

    // ── 阶段 1：点击 Q1 的 opt_0（第一个选项，直接 Enter）
    const q1ActionData = {
        action: {
            tag: 'button',
            value: { action_type: 'opt_0', session_state_key: stateKey },
        },
    };

    await FL.prototype.handleCardAction.call(listener, q1ActionData);

    // 断言：注入了 '\r'（Q1 第一个选项 = 0 次 ↓ + Enter）
    assert.equal(injections.length, 1, '点击 Q1 opt_0 后应有且仅有 1 次注入');
    assert.equal(injections[0], '\r', 'Q1 opt_0 应注入纯 \\r，不含 \\n');

    // 断言：发送了 Q2 卡片
    assert.equal(sent.length, 1, '应已向飞书发送 Q2 卡片');
    const q2Card = sent[0];
    assert.equal(q2Card.header?.template, 'orange', 'Q2 卡片应使用 orange 模板');

    // ── 找到 Q2 的 stateKey（格式：<baseKey>_q1）
    const q2StateKey = `${stateKey}_q1`;

    // 断言：Q2 state 已写入，且 responses 使用 '\r' 而非 '\n'
    const q2Notif = state.getNotification(q2StateKey);
    assert.ok(q2Notif, `sessionState 中应能找到 Q2 state，key = ${q2StateKey}`);
    assert.equal(q2Notif.responses.opt_0.keys, '\r', 'Q2 opt_0 响应应使用 \\r 而非 \\n');
    assert.equal(
        q2Notif.responses.opt_1.keys,
        ARROW_DOWN + '\r',
        'Q2 opt_1 响应应使用 \\x1b[B\\r 而非 \\x1b[B\\n'
    );

    // Q2 卡片的按钮 value 中必须携带正确的 session_state_key
    const q2Actions = q2Card.elements?.find(el => el.tag === 'action' && el.actions?.[0]?.tag === 'button');
    assert.ok(q2Actions, 'Q2 卡片应包含按钮 action 块');
    assert.equal(
        q2Actions.actions[0].value.session_state_key,
        q2StateKey,
        'Q2 按钮的 session_state_key 应为 q2StateKey'
    );

    // ── 阶段 2：点击 Q2 的 opt_0（最后一题，点击后发"完成卡片"）
    const q2ActionData = {
        action: {
            tag: 'button',
            value: { action_type: 'opt_0', session_state_key: q2StateKey },
        },
    };

    await FL.prototype.handleCardAction.call(listener, q2ActionData);

    // 断言：第二次注入了 '\r'（Q2 第一个选项）
    assert.equal(injections.length, 2, '点击 Q2 opt_0 后总注入次数应为 2（Q1 + Q2 各一次）');
    assert.equal(injections[1], '\r', 'Q2 opt_0 应注入纯 \\r');

    // 断言：发送了"完成卡片"（green 模板，标题含"全部已回答"）
    assert.equal(sent.length, 2, '应已向飞书发送完成卡片');
    const doneCard = sent[1];
    assert.equal(doneCard.header?.template, 'green', '完成卡片应使用 green 模板');
    assert.ok(
        doneCard.header?.title?.content?.includes('全部已回答'),
        '完成卡片标题应含"全部已回答"'
    );

    // 核心回归断言：完成卡片不得有携带 session_state_key 的按钮（避免用户误点触发额外注入）
    const doneActionBlocks = (doneCard.elements || []).filter(el => el.tag === 'action');
    for (const block of doneActionBlocks) {
        for (const action of (block.actions || [])) {
            assert.ok(
                !action.value?.session_state_key,
                '完成卡片的按钮不应含 session_state_key（会导致额外注入）'
            );
        }
    }

    // 核心回归断言：从头到尾总注入次数 = 2，不允许有第 3 次注入
    assert.equal(
        injections.length,
        2,
        '全程应恰好注入 2 次（每题 1 次），不得有额外注入（完成卡片 bug）'
    );

    // ── 清理 ──────────────────────────────────────────────
    try { require('fs').unlinkSync(`/tmp/test-multi-q-session-state-${process.pid}.json`); } catch {}
    restoreTerminalInject();
    // 恢复 feishu-listener 缓存，避免影响其他测试
    delete require.cache[LISTENER_PATH];
});

test('多问题流程：Q2 responses 使用 \\r 而非 \\n（sendNextQuestion 键值回归）', async () => {
    const injections = [];

    const LISTENER_PATH = require.resolve('../../src/apps/feishu-listener');
    delete require.cache[LISTENER_PATH];
    stubTerminalInject(injections);
    const { FeishuListener: FL } = require('../../src/apps/feishu-listener');

    const state = makeTempSessionState();
    const sent = [];
    const listener = makeFakeListener(FL, state, sent);

    const stateKey = 'test-keys-regression';
    const ARROW_DOWN = '\x1b[B';

    const questions = [
        {
            header: 'Q1',
            question: '第一题',
            options: [{ label: 'A', value: 'a' }],
        },
        {
            header: 'Q2',
            question: '第二题',
            options: [
                { label: 'X', value: 'x' },
                { label: 'Y', value: 'y' },
                { label: 'Z', value: 'z' },
            ],
        },
    ];

    const q1Resp = {};
    questions[0].options.forEach((opt, idx) => {
        q1Resp[`opt_${idx}`] = { keys: ARROW_DOWN.repeat(idx) + '\r', label: opt.label };
    });
    q1Resp['opt_other'] = { keys: ARROW_DOWN.repeat(1) + '\r', label: 'Other' };
    q1Resp['_other_num'] = { keys: ARROW_DOWN.repeat(1) + '\r', label: '_meta' };
    q1Resp['interrupt'] = { keys: '\x1b', label: '⛔ Interrupt' };

    state.addNotification(stateKey, {
        session_id: 'sess-keys',
        notification_type: 'AskUserQuestion',
        pts_device: 'fifo:/tmp/test-keys-fifo',
        created_at: Date.now(),
        responses: q1Resp,
        _all_questions: questions,
        _current_q: 0,
        _chat_id: 'chat-keys',
        _note_parts: '',
    });

    await FL.prototype.handleCardAction.call(listener, {
        action: { tag: 'button', value: { action_type: 'opt_0', session_state_key: stateKey } },
    });

    const q2StateKey = `${stateKey}_q1`;
    const q2Notif = state.getNotification(q2StateKey);
    assert.ok(q2Notif, 'Q2 state 应存在');

    // 验证 Q2 options 的 keys 均以 '\r' 结尾，不以 '\n' 结尾
    for (let i = 0; i < questions[1].options.length; i++) {
        const entry = q2Notif.responses[`opt_${i}`];
        assert.ok(entry, `opt_${i} 应存在于 Q2 responses`);
        assert.ok(entry.keys.endsWith('\r'), `Q2 opt_${i} 的 keys 应以 \\r 结尾，实际: ${JSON.stringify(entry.keys)}`);
        assert.ok(!entry.keys.endsWith('\n'), `Q2 opt_${i} 的 keys 不应以 \\n 结尾`);
    }

    // 验证 opt_other 的 keys
    assert.ok(q2Notif.responses.opt_other.keys.endsWith('\r'), 'Q2 opt_other 应以 \\r 结尾');

    // 清理
    try { require('fs').unlinkSync(`/tmp/test-multi-q-session-state-${process.pid}.json`); } catch {}
    restoreTerminalInject();
    delete require.cache[LISTENER_PATH];
});
