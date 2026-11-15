'use strict';

// Aprovações: the hook that sends permission requests to the panel and waits, the mailbox the
// windows share, which window a request came from and how a request reads on a card.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { setup } = require('./helpers');
const { syncApprovalHook, syncPeerHook, settingsFile } = require('../src/core/claudeHook');
const { ask, decisionOf, Transcript } = require('../src/hook/approval-hook');
const { Approvals, ownerOf, currentWindow, describeTool, suggestionLabel } = require('../src/core/approvals');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await sleep(30);
  }
};

const SUGGEST = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' }];
const bashHook = (extra = {}) => ({
  session_id: 'sess-1',
  cwd: 'C:/proj',
  hook_event_name: 'PermissionRequest',
  permission_mode: 'default',
  tool_name: 'Bash',
  tool_input: { command: 'npm test', description: 'Roda os testes' },
  permission_suggestions: SUGGEST,
  ...extra,
});

function mailbox() {
  const t = setup();
  const switcher = path.join(t.root, '.claude-switcher');
  return { t, switcher, box: new Approvals(switcher) };
}

const line = (o) => `${JSON.stringify(o)}\n`;
const toolUse = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id) => ({ type: 'user', toolUseResult: {}, message: { content: [{ type: 'tool_result', tool_use_id: id }] } });

test('a request waits for the panel and comes back as Claude Code\'s decision', async () => {
  const { box } = mailbox();
  const asking = ask(bashHook(), box.dir, { env: { CLAUDE_SWITCHER_WINDOW: 'win-a' } });
  const [req] = await until(() => box.pending().length && box.pending());
  assert.equal(req.tool, 'Bash');
  assert.equal(req.window, 'win-a');
  assert.equal(req.root, path.resolve('C:/proj'), 'outside git: the folder itself');
  assert.deepEqual(req.input, { command: 'npm test', description: 'Roda os testes' });

  assert.equal(box.answer(req.id, { behavior: 'allow', suggestion: 0 }), true);
  assert.equal(box.answer(req.id, { behavior: 'deny' }), false, 'the first answer wins');
  assert.deepEqual(box.pending(), [], 'answered: off the panel');
  const out = await asking;
  assert.deepEqual(out.hookSpecificOutput, { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedPermissions: SUGGEST } });
  assert.deepEqual(fs.readdirSync(box.dir), [], 'the hook cleans up after itself');
});

test('a deny carries what the user said, and Parar also stops Claude', () => {
  const deny = decisionOf({ behavior: 'deny', message: '  use o pnpm  ' }, bashHook()).hookSpecificOutput.decision;
  assert.equal(deny.behavior, 'deny');
  assert.match(deny.message, /disse: use o pnpm$/);
  assert.equal(deny.interrupt, undefined);
  const stop = decisionOf({ behavior: 'deny', interrupt: true }, bashHook());
  assert.equal(stop.hookSpecificOutput.decision.interrupt, true);
  assert.match(stop.systemMessage, /negado e parado/);
});

test('only what the hook was given goes back: its own suggestions, its own input', () => {
  assert.equal(decisionOf({ behavior: 'allow', suggestion: 7 }, bashHook()).hookSpecificOutput.decision.updatedPermissions, undefined);
  assert.equal(decisionOf({ behavior: 'allow', updatedInput: { command: 'rm -rf /' } }, bashHook()).hookSpecificOutput.decision.updatedInput, undefined);
  assert.equal(decisionOf({ behavior: 'maybe' }, bashHook()), null);
  const plan = bashHook({ tool_name: 'ExitPlanMode', tool_input: { plan: '1. fazer' } });
  assert.deepEqual(decisionOf({ behavior: 'allow' }, plan).hookSpecificOutput.decision.updatedInput, { plan: '1. fazer' });
  const question = bashHook({ tool_name: 'AskUserQuestion', tool_input: { questions: [] } });
  assert.equal(decisionOf({ behavior: 'allow' }, question), null, 'a question is answered in the tab');
});

test('answered in the tab: the hook sees the result in the transcript and lets go', async () => {
  const { t, box } = mailbox();
  const file = path.join(t.root, 'conv.jsonl');
  fs.writeFileSync(
    file,
    [
      { type: 'ai-title', aiTitle: 'Tela de login' },
      { type: 'user', message: { content: 'cria a tela de login' } },
      toolUse('t0', 'Bash', { command: 'npm test' }),
      toolResult('t0'),
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Vou rodar os testes de novo.' }] } },
      toolUse('t1', 'Bash', { command: 'npm test' }),
    ]
      .map(line)
      .join(''),
  );
  const asking = ask(bashHook({ transcript_path: file }), box.dir, { env: {} });
  const [req] = await until(() => box.pending().length && box.pending());
  assert.equal(req.title, 'Tela de login');
  assert.equal(req.prompt, 'cria a tela de login');
  assert.equal(req.said, 'Vou rodar os testes de novo.');
  assert.equal(req.window, null);

  fs.appendFileSync(file, line(toolResult('t1')));
  assert.equal(await asking, null);
  assert.deepEqual(box.pending(), []);
});

test('the transcript: an earlier call with the same input is not this one', () => {
  const { t } = mailbox();
  const file = path.join(t.root, 'conv.jsonl');
  fs.writeFileSync(file, [toolUse('t0', 'Bash', { command: 'ls' }), toolResult('t0')].map(line).join(''));
  const tr = new Transcript(file, bashHook({ tool_input: { command: 'ls' } })).start();
  assert.equal(tr.useId, null);
  fs.appendFileSync(file, line(toolUse('t1', 'Bash', { command: 'ls' })));
  assert.equal(tr.over(), false, 'the call shows up');
  assert.equal(tr.useId, 't1');
  fs.appendFileSync(file, '{"type":"user","message":{"content":"half a li');
  assert.equal(tr.over(), false, 'a line still being written waits');
  fs.appendFileSync(file, 'ne"}}\n');
  assert.equal(tr.over(), true, 'a new prompt: the conversation moved on');
});

test('the extension taking a request away ends the wait with no decision', async () => {
  const { box } = mailbox();
  const asking = ask(bashHook(), box.dir, { env: {} });
  const [req] = await until(() => box.pending().length && box.pending());
  fs.unlinkSync(path.join(box.dir, `${req.id}.req`));
  assert.equal(await asking, null);
});

test('a request whose hook is gone leaves the panel', () => {
  const { switcher } = mailbox();
  const box = new Approvals(switcher, { alive: (pid) => pid !== 4242 });
  fs.mkdirSync(box.dir, { recursive: true });
  const put = (id, pid, at = Date.now()) => fs.writeFileSync(path.join(box.dir, `${id}.req`), JSON.stringify({ id, pid, at, tool: 'Bash' }));
  put('1-1', 4242);
  put('2-2', 1);
  put('3-3', 1, Date.now() - 2 * 3600 * 1000);
  assert.deepEqual(box.pending().map((r) => r.id), ['2-2']);
  assert.deepEqual(fs.readdirSync(box.dir).sort(), ['2-2.req']);
});

test('which window a request came from, and which window the user is in', () => {
  const windows = [
    { id: 'a', name: 'Rota7', folders: ['C:\\wamp64\\www\\Rota7'], focusedAt: 10 },
    { id: 'b', name: 'web', folders: ['C:\\wamp64\\www\\Rota7\\web'], focusedAt: 30 },
    { id: 'c', name: 'switcher', folders: ['C:\\wamp64\\www\\claude-switcher'], focusedAt: 20 },
  ];
  assert.equal(ownerOf({ window: 'c', cwd: 'C:/wamp64/www/Rota7' }, windows).id, 'c', 'the window the conversation was opened in');
  assert.equal(ownerOf({ window: 'gone', cwd: 'c:/wamp64/www/rota7/web/src' }, windows).id, 'b', 'else the deepest folder');
  assert.equal(ownerOf({ window: null, cwd: 'C:/wamp64/www/Rota7/docs' }, windows).id, 'a');
  assert.equal(ownerOf({ window: null, cwd: 'D:/other' }, windows), null);
  assert.equal(currentWindow(windows).id, 'b');
});

test('windows: a card per window, gone when it stops beating; a focus request is taken once', () => {
  const { switcher } = mailbox();
  const box = new Approvals(switcher);
  box.saveWindow({ id: 'win-a', pid: process.pid, name: 'Rota7', folders: [] });
  box.saveWindow({ id: 'win-b', pid: process.pid, name: 'web', folders: [] });
  assert.deepEqual(box.windows().map((w) => w.id).sort(), ['win-a', 'win-b']);
  assert.deepEqual(box.windows(Date.now() + 60 * 1000), [], 'stale');
  box.removeWindow('win-b');
  assert.deepEqual(box.windows().map((w) => w.id), ['win-a']);

  box.askFocus('win-a', 'sess-1');
  assert.equal(box.takeFocus('win-a'), 'sess-1');
  assert.equal(box.takeFocus('win-a'), null);
  box.askFocus('../x', 'sess-1');
  assert.equal(fs.existsSync(path.join(box.windowsDir, '..', 'x.focus')), false, 'ids are checked');
});

test('how each tool reads on a card', () => {
  const cwd = 'C:/proj';
  assert.deepEqual(describeTool({ tool: 'Bash', cwd, input: { command: 'npm test', description: 'Roda os testes' } }), { verb: 'Rodar comando', target: 'Roda os testes', body: { kind: 'code', text: 'npm test' } });
  const edit = describeTool({ tool: 'Edit', cwd, input: { file_path: 'C:/proj/src/a.js', old_string: 'a', new_string: 'b' } });
  assert.equal(edit.target, 'src/a.js');
  assert.deepEqual(edit.body, { kind: 'diff', old: 'a', new: 'b' });
  assert.equal(describeTool({ tool: 'Write', cwd, input: { file_path: 'D:/x.txt', content: 'oi' } }).target, 'D:/x.txt');
  assert.equal(describeTool({ tool: 'mcp__github__create_issue', input: { title: 'x' } }).verb, 'Usar create_issue (github)');
  assert.equal(describeTool({ tool: 'AskUserQuestion', input: { questions: [{ question: 'Qual?' }] } }).body.text, '• Qual?');

  assert.equal(suggestionLabel(SUGGEST[0]), 'Sempre permitir Bash(npm test) neste projeto, só para você');
  assert.equal(suggestionLabel({ type: 'setMode', mode: 'acceptEdits', destination: 'session' }), 'Aprovar e mudar para o modo aceitar edições nesta conversa');
  assert.equal(suggestionLabel({ type: 'addRules', behavior: 'deny', rules: [{ toolName: 'Bash' }] }), null);
});

test('settings.json: the PermissionRequest hook sits next to the others and goes away alone', async () => {
  const { t, switcher } = mailbox();
  await syncPeerHook(t.paths, switcher, { enabled: true, nodePath: 'node' });
  assert.equal(await syncApprovalHook(t.paths, switcher, { enabled: true, nodePath: 'node' }), true);
  const settings = () => JSON.parse(fs.readFileSync(settingsFile(t.paths), 'utf8'));
  const [group] = settings().hooks.PermissionRequest;
  assert.equal(group.matcher, undefined, 'every tool');
  assert.equal(group.hooks[0].timeout, 3600);
  assert.ok(group.hooks[0].args[0].endsWith('approval-hook.js'));
  assert.ok(fs.existsSync(path.join(switcher, 'approval-hook.js')), 'the script is copied');
  assert.equal(await syncApprovalHook(t.paths, switcher, { enabled: true, nodePath: 'node' }), false, 'idempotent');
  await syncApprovalHook(t.paths, switcher, { enabled: false });
  assert.equal(settings().hooks.PermissionRequest, undefined);
  assert.ok(settings().hooks.PreToolUse, 'the others stay');
});

// The copied script, the way Claude Code runs it.
function runHook(script, input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: '', ...env } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => resolve(out));
    child.stdin.end(JSON.stringify(input));
  });
}

test('hook: in the VS Code extension it waits for the panel; in the terminal or with no window it does nothing', async () => {
  const { t, switcher } = mailbox();
  await syncApprovalHook(t.paths, switcher, { enabled: true, nodePath: process.execPath });
  const script = path.join(switcher, 'approval-hook.js');
  const box = new Approvals(switcher);

  assert.equal(await runHook(script, bashHook(), { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' }), '', 'no window listening');
  box.heartbeat();
  assert.equal(await runHook(script, bashHook(), { CLAUDE_CODE_ENTRYPOINT: 'cli' }), '', 'the terminal shows its dialog only after the hook');

  const running = runHook(script, bashHook(), { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', CLAUDE_SWITCHER_WINDOW: 'win-a' });
  const [req] = await until(() => box.pending().length && box.pending());
  assert.equal(req.window, 'win-a');
  box.answer(req.id, { behavior: 'deny', message: 'agora não' });
  const out = JSON.parse(await running);
  assert.equal(out.hookSpecificOutput.decision.behavior, 'deny');
  assert.match(out.hookSpecificOutput.decision.message, /agora não/);
});
