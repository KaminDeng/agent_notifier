'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sendSingleSelectCard,
  sendMultiQuestionFirstCard,
} = require('../../src/apps/claude-ask');

test('single-select card maps second option to ArrowDown plus Enter', async () => {
  const sent = [];
  const app = {
    chatId: 'chat-1',
    client: {
      im: {
        message: {
          create: async ({ data }) => {
            sent.push(JSON.parse(data.content));
            return { data: { message_id: 'msg-1' } };
          },
        },
      },
    },
  };

  await sendSingleSelectCard(
    app,
    {
      header: '方案选择',
      question: '请选择方案',
      multiSelect: false,
      options: [
        { label: '选项一', value: 'a' },
        { label: '选项二', value: 'b' },
      ],
    },
    'state-single',
    'fifo:/tmp/agent-inject-pts7',
    'session-1',
    'AskUserQuestion',
    'footer'
  );

  assert.equal(sent.length, 1);

  const card = sent[0];
  const buttons = card.elements.find(el => el.tag === 'action' && el.actions?.[0]?.tag === 'button');
  assert.equal(buttons.actions[1].value.action_type, 'opt_1');

  const { sessionState } = require('../../src/lib/session-state');
  const notification = sessionState.getNotification('state-single');
  assert.equal(notification.responses.opt_0.keys, '\r');
  assert.equal(notification.responses.opt_1.keys, '\x1b[B\r');
  assert.equal(notification.responses.opt_other.keys, '\x1b[B\x1b[B\r');

  sessionState.removeNotification('state-single');
});

test('multi-question first card maps second option to ArrowDown plus Enter', async () => {
  const sent = [];
  const app = {
    chatId: 'chat-1',
    client: {
      im: {
        message: {
          create: async ({ data }) => {
            sent.push(JSON.parse(data.content));
            return { data: { message_id: 'msg-2' } };
          },
        },
      },
    },
  };

  await sendMultiQuestionFirstCard(
    app,
    [
      {
        header: '问题一',
        question: '第一题',
        options: [
          { label: 'A', value: 'a' },
          { label: 'B', value: 'b' },
        ],
      },
      {
        header: '问题二',
        question: '第二题',
        options: [
          { label: 'C', value: 'c' },
        ],
      },
    ],
    'state-multi',
    'fifo:/tmp/agent-inject-pts7',
    'session-1',
    'AskUserQuestion',
    'footer'
  );

  assert.equal(sent.length, 1);

  const { sessionState } = require('../../src/lib/session-state');
  const notification = sessionState.getNotification('state-multi');
  assert.equal(notification.responses.opt_0.keys, '\r');
  assert.equal(notification.responses.opt_1.keys, '\x1b[B\r');
  assert.equal(notification.responses.opt_other.keys, '\x1b[B\x1b[B\r');

  sessionState.removeNotification('state-multi');
});
