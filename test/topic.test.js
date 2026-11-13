'use strict';

// Topic guard: what it reads from a transcript, when it lets a prompt through without asking,
// the hook it installs next to the autoswitcher's, and the hook script itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { setup } = require('./helpers');
const { LimitQueue } = require('../src/core/limitQueue');
const { syncHook, syncTopicHook, settingsFile } = require('../src/core/claudeHook');
const { readConversation, quickVerdict, classification, blockReason, TopicState } = require('../src/core/topic');

const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
const reply = (text, context) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: context - 1002, output_tokens: 50 } },
});

function transcript(root, entries, padding = 0) {
  const file = path.join(root, 'sess.jsonl');
  const lines = entries.map((e) => JSON.stringify(e));
  // A long tool result in the middle, so the first prompt sits outside the tail that is read.
  if (padding) lines.splice(2, 0, JSON.stringify(user([{ type: 'tool_result', tool_use_id: 'x', content: 'á'.repeat(padding) }])));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

test('reads the first and latest prompts and the context of the last reply', () => {
  const t = setup();
  const file = transcript(
    t.root,
    [
      user('oque melhorar no WA'),
      reply('Algumas ideias.', 40000),
      user([{ type: 'text', text: '<ide_opened_file>x.js</ide_opened_file>' }, { type: 'text', text: 'arruma o loop do envio' }]),
      user([{ type: 'tool_result', tool_use_id: 't', content: 'ok' }]),
      user('Caveat: lixo do Claude Code', { isMeta: true }),
      user('resumo', { isCompactSummary: true }),
      user('[Request interrupted by user]'),
      reply('Arrumei.', 420000),
    ],
    3 * 1024 * 1024,
  );
  const conv = readConversation(file);
  assert.equal(conv.first, 'oque melhorar no WA');
  assert.deepEqual(conv.recent, ['arruma o loop do envio']);
  assert.equal(conv.contextTokens, 420000);
  assert.equal(conv.lastReply, 'Arrumei.');

  const q = classification(conv, 'agora cria a tela de login do 2fa');
  assert.match(q.prompt, /\(primeiro\) oque melhorar no WA/);
  assert.match(q.prompt, /Novo pedido: agora cria a tela de login do 2fa/);
  assert.match(blockReason(conv, 'tela de login'), /assunto novo \(tela de login\).*420k tokens/);
});

test('lets a prompt through without asking when it can', () => {
  const conv = { contextTokens: 400000, recent: ['arruma o loop do envio'], first: null, lastReply: '' };
  const long = 'agora cria a tela de login do sistema de 2fa';
  const v = (prompt, over = {}, state) => quickVerdict({ prompt, conv: { ...conv, ...over }, minTokens: 150000, state });
  assert.equal(v(long), 'ask');
  assert.equal(v(long, { contextTokens: 100000 }), 'allow', 'small conversation');
  assert.equal(v('/compact'), 'allow', 'commands');
  assert.equal(v('sim, pode fazer'), 'allow', 'short answers');
  assert.equal(v(long, { recent: [] }), 'allow', 'nothing to compare with');
  assert.equal(v(`  ${long.toUpperCase()} `, {}, { blocked: long }), 'insisted', 'sent again');
  assert.equal(v(long, {}, { mutedAt: 300000 }), 'allow', 'chose to stay, context grew less than minTokens');
  assert.equal(v(long, {}, { mutedAt: 200000 }), 'ask', 'grew enough since');
});

test('remembers per session, ignoring ids that are not plain', () => {
  const t = setup();
  const state = new TopicState(t.root);
  state.set('abc-1', { blocked: 'x' });
  assert.equal(state.get('abc-1').blocked, 'x');
  state.set('../fora', { blocked: 'x' });
  assert.deepEqual(state.get('../fora'), {});
  assert.deepEqual(state.get('nada'), {});
});

test('settings.json: the topic hook sits next to the autoswitcher hooks', async () => {
  const t = setup();
  const file = settingsFile(t.paths);
  fs.writeFileSync(file, '{"model":"opus"}');
  const dir = path.join(t.root, '.claude-switcher');

  // Started together, the way the extension starts them: neither write is lost.
  await Promise.all([syncHook(t.paths, dir, { enabled: true, nodePath: 'node' }), syncTopicHook(t.paths, dir, { enabled: true, nodePath: 'node' })]);
  const on = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(on.hooks).sort(), ['Stop', 'StopFailure', 'UserPromptSubmit']);
  assert.deepEqual(on.hooks.UserPromptSubmit, [{ hooks: [{ type: 'command', command: 'node', args: [path.join(dir, 'topic-hook.js')], timeout: 40 }] }]);
  assert.ok(fs.existsSync(path.join(dir, 'topic-hook.js')));
  assert.equal(await syncTopicHook(t.paths, dir, { enabled: true, nodePath: 'node' }), false, 'idempotent');

  await syncTopicHook(t.paths, dir, { enabled: false });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).hooks).sort(), ['Stop', 'StopFailure'], 'only its own hook goes');
  await syncHook(t.paths, dir, { enabled: false });
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "model": "opus"\n}');
});

function runHook(dir, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, 'topic-hook.js')]);
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('exit', (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify(input));
  });
}

async function answerNext(queue, res) {
  for (let i = 0; i < 100; i++) {
    const got = queue.take();
    if (got.length) {
      await queue.answer(got[0].id, res);
      return got[0].req;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the hook never asked');
}

test('hook: blocks the prompt only when the extension says so', async () => {
  const t = setup();
  const dir = path.join(t.root, '.claude-switcher');
  await syncTopicHook(t.paths, dir, { enabled: true, nodePath: process.execPath });
  const queue = new LimitQueue(dir, 'topics');
  const hook = { session_id: 's1', transcript_path: 'C:/t/s1.jsonl', cwd: 'C:/p', hook_event_name: 'UserPromptSubmit', prompt: 'faz outra coisa' };

  assert.deepEqual(await runHook(dir, hook), { code: 0, stdout: '' }, 'no window listening');

  queue.heartbeat();
  const [blocked, req] = await Promise.all([runHook(dir, hook), answerNext(queue, { block: true, reason: 'Assunto novo.' })]);
  assert.deepEqual([req.sessionId, req.transcriptPath, req.prompt], ['s1', 'C:/t/s1.jsonl', 'faz outra coisa']);
  assert.equal(blocked.code, 0);
  assert.deepEqual(JSON.parse(blocked.stdout), { decision: 'block', reason: 'Assunto novo.' });

  const [passed] = await Promise.all([runHook(dir, hook), answerNext(queue, { block: false })]);
  assert.deepEqual(passed, { code: 0, stdout: '' });

  // The autoswitcher's mailbox is a different folder.
  assert.deepEqual(new LimitQueue(dir).take(), []);
});
