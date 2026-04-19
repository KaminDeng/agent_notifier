'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseCaptureConfig,
  shouldCreateNewCard,
  buildCodexLiveCard,
  normalizeCodexLiveEntry,
} = require('../../src/apps/codex-live');

test('parseCaptureConfig mirrors Claude semantics', () => {
  assert.deepEqual(parseCaptureConfig('tools,output'), {
    tools: true,
    output: true,
    results: false,
  });
  assert.equal(parseCaptureConfig(''), null);
  assert.deepEqual(parseCaptureConfig('1'), {
    tools: true,
    output: true,
    results: true,
  });
});

test('assistant key change creates new card', () => {
  assert.equal(
    shouldCreateNewCard({ assistantKey: 'a' }, { assistantKey: 'b' }),
    true
  );
  assert.equal(
    shouldCreateNewCard({ assistantKey: 'a' }, { assistantKey: 'a' }),
    false
  );
  assert.equal(
    shouldCreateNewCard(null, { assistantKey: 'a' }),
    true
  );
  assert.equal(
    shouldCreateNewCard({ assistantKey: 'a' }, { assistantKey: '' }),
    false
  );
});

test('buildCodexLiveCard renders Claude-style summary card', () => {
  const card = buildCodexLiveCard({
    entries: [{
      tool: 'Bash',
      icon: '⚡',
      input: 'pwd',
      result: '/tmp/demo',
      output: 'checking cwd',
      tokens: { input: 1200, cached: 300, output: 88, total: 1288 },
      turnStartedAt: '2026-04-07T10:00:00.000Z',
      ts: new Date('2026-04-07T10:01:05.000Z').getTime(),
    }],
    projectName: 'demo',
    ptsDevice: '/dev/pts/3',
  });

  assert.equal(card.header.template, 'blue');
  assert.ok(card.header.title.content.includes('执行摘要'));
  const firstBlock = card.elements.find(el => el.tag === 'div');
  assert.ok(firstBlock.text.content.includes('Codex'));
  const footer = card.elements.find(el => el.tag === 'markdown');
  assert.ok(footer.content.includes('🤖 Codex'));
  assert.ok(footer.content.includes('pts/3'));
  assert.ok(footer.content.includes('📁 demo'));
  assert.ok(footer.content.includes('⏱ 1m5s'));
  assert.match(
    footer.content,
    /🤖 Codex.*pts\/3.*📁 demo.*⏱ 1m5s.*⏰ .*📊 输入 1\.2k · 输出 88 · 缓存读 300 · 总计 1\.3k/
  );
});

test('buildCodexLiveCard renders structured step rows and correct step count', () => {
  const card = buildCodexLiveCard({
    entries: [{
      tool: 'exec_command',
      icon: '⚡',
      input: 'rtk git status',
      result: '退出码 0',
      phase: 'commentary',
    }],
    projectName: 'demo',
    phase: 'commentary',
  });

  assert.equal(card.header.title.content, '⚡ 执行摘要（1 步）');
  const dataRow = card.elements.find((el) =>
    el.tag === 'column_set' &&
    el.columns?.[0]?.elements?.[0]?.text?.content === '1'
  );
  assert.ok(dataRow, '应渲染步骤数据行');
});

test('buildCodexLiveCard truncates long command/file input to single line', () => {
  const card = buildCodexLiveCard({
    entries: [{
      tool: 'exec_command',
      icon: '⚡',
      input: 'rtk git add very/long/path/to/some/file/name/that/keeps/growing/and/growing.js\nsecond line',
      result: '退出码 0',
      phase: 'commentary',
    }],
    projectName: 'demo',
    phase: 'commentary',
  });

  const dataRow = card.elements.find((el) =>
    el.tag === 'column_set' &&
    el.columns?.[0]?.elements?.[0]?.text?.content === '1'
  );
  const commandCell = dataRow?.columns?.[2]?.elements?.[0]?.text?.content || '';
  assert.ok(commandCell.startsWith('`rtk git add'));
  assert.ok(commandCell.endsWith('…`'));
  assert.ok(!commandCell.includes('\n'));
  assert.ok(commandCell.length <= 40);
});

test('buildCodexLiveCard renders fallback summary when only steps exist', () => {
  const card = buildCodexLiveCard({
    entries: [{
      tool: 'exec_command',
      icon: '⚡',
      input: 'rtk git status',
      result: null,
      phase: 'commentary',
    }],
    projectName: 'demo',
    phase: 'commentary',
  });

  const summaryBlock = card.elements.find((el) =>
    el.tag === 'div' &&
    typeof el.text?.content === 'string' &&
    el.text.content.includes('**Codex**')
  );
  assert.ok(summaryBlock, '应渲染兜底概要段');
  assert.ok(summaryBlock.text.content.includes('正在执行'));
});

test('buildCodexLiveCard does not render fake step table for output-only entries', () => {
  const card = buildCodexLiveCard({
    entries: [{
      icon: '💬',
      output: '只有助手文本，没有工具事件',
    }],
    projectName: 'demo',
    phase: 'commentary',
  });

  const headerRow = card.elements.find((el) =>
    el.tag === 'column_set' &&
    el.columns?.some((col) => col.elements?.some((item) => item.text?.content === '工具'))
  );
  assert.equal(headerRow, undefined);
  assert.equal(card.header.title.content, '⚡ 执行摘要');
});

test('buildCodexLiveCard appends multiple outputs in the same turn', () => {
  const card = buildCodexLiveCard({
    entries: [
      { icon: '💬', output: '第一段输出' },
      { icon: '💬', output: '第二段输出' },
    ],
    projectName: 'demo',
    phase: 'commentary',
  });

  const codexBlocks = card.elements.filter((el) =>
    el.tag === 'div' &&
    typeof el.text?.content === 'string' &&
    el.text.content.includes('**Codex')
  );
  assert.equal(codexBlocks.length, 2);
  assert.ok(codexBlocks[0].text.content.includes('第一段输出'));
  assert.ok(codexBlocks[1].text.content.includes('第二段输出'));
});

test('buildCodexLiveCard uses green completion card for final answer', () => {
  const card = buildCodexLiveCard({
    entries: [{
      icon: '💬',
      output: '任务完成',
      phase: 'final_answer',
    }],
    projectName: 'demo',
    phase: 'final_answer',
  });

  assert.equal(card.header.template, 'green');
  assert.ok(card.header.title.content.includes('已完成'));
});

test('buildCodexLiveCard splits long output into multiple content blocks', () => {
  const longText = 'A'.repeat(5000);
  const card = buildCodexLiveCard({
    entries: [{
      icon: '💬',
      output: longText,
    }],
    projectName: 'demo',
    phase: 'commentary',
  });

  const codexBlocks = card.elements.filter((el) =>
    el.tag === 'div' &&
    typeof el.text?.content === 'string' &&
    el.text.content.includes('**Codex')
  );
  assert.ok(codexBlocks.length >= 2);
});

test('normalizeCodexLiveEntry keeps assistant output and optional tool/result fields', () => {
  const entry = normalizeCodexLiveEntry({
    kind: 'output',
    text: 'done',
    assistant_key: 'task-1',
    tool: 'Bash',
    input: 'pwd',
    result: '/tmp/demo',
    phase: 'final_answer',
    pts_device: '/dev/pts/9',
    turn_started_at: '2026-04-07T10:00:00.000Z',
    tokens: { input: 100, cached: 20, output: 5, total: 105 },
  });

  assert.equal(entry.output, 'done');
  assert.equal(entry.assistantKey, 'task-1');
  assert.equal(entry.tool, 'Bash');
  assert.equal(entry.input, 'pwd');
  assert.equal(entry.result, '/tmp/demo');
  assert.equal(entry.phase, 'final_answer');
  assert.equal(entry.ptsDevice, '/dev/pts/9');
  assert.equal(entry.turnStartedAt, '2026-04-07T10:00:00.000Z');
  assert.deepEqual(entry.tokens, { input: 100, cached: 20, cacheWrite: null, output: 5, total: 105 });
});
