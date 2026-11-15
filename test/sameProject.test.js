'use strict';

// Conversations in the same project: what one tells the other, the git commands it holds
// back, the hooks it installs and the hook script run the way Claude Code runs it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { setup } = require('./helpers');
const { syncHook, syncTopicHook, syncPeerHook, settingsFile } = require('../src/core/claudeHook');
const { run, Sessions, gitCommands, gitRisk, taskOf } = require('../src/hook/peer-hook');

const MINUTE = 60 * 1000;

function project(root) {
  const dir = path.join(root, 'proj');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@x.com');
  git('config', 'user.name', 't');
  for (const f of ['src/a.js', 'src/b.js', 'README.md']) fs.writeFileSync(path.join(dir, f), 'v1\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return dir;
}

// Two conversations, A and B, in the same project; c is what each hook gets from Claude Code.
function two() {
  const t = setup();
  const dir = project(t.root);
  const sessions = new Sessions(path.join(t.root, '.claude-switcher', 'sessions'));
  const say = (id, event, extra = {}, now) => run({ session_id: id, cwd: dir, hook_event_name: event, ...extra }, sessions, now);
  const edit = (id, file, now) => {
    fs.writeFileSync(path.join(dir, file), `${id}\n`);
    say(id, 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: path.join(dir, file) } }, now);
  };
  const bash = (id, command, now) => say(id, 'PreToolUse', { tool_name: 'Bash', tool_input: { command } }, now);
  return { t, dir, sessions, say, edit, bash };
}

const context = (out) => out && out.hookSpecificOutput.additionalContext;
const denied = (out) => out && out.hookSpecificOutput.permissionDecision === 'deny' && out.hookSpecificOutput.permissionDecisionReason;

test('tells a conversation what the other one in the project is doing, once per change', () => {
  const { say, edit } = two();
  assert.equal(say('A', 'UserPromptSubmit', { prompt: 'arruma o loop do envio de mensagens' }), null, 'alone in the project');
  edit('A', 'src/a.js');

  const firstOut = say('B', 'UserPromptSubmit', { prompt: 'cria a tela de login com 2fa' });
  assert.equal(firstOut.systemMessage, 'Claude Switcher: outra conversa está trabalhando neste projeto (pedido: "arruma o loop do envio de mensagens"). Avisei o Claude para não atrapalhar.');
  const first = context(firstOut);
  assert.match(first, /Outra conversa do Claude Code está trabalhando neste mesmo projeto/);
  assert.match(first, /trabalhando agora, pedido: "arruma o loop do envio de mensagens"/);
  assert.match(first, /ainda não foram para commit: src\/a\.js/);
  assert.match(first, /git add -A/);

  assert.equal(say('B', 'UserPromptSubmit', { prompt: 'sim' }), null, 'nothing new');
  edit('A', 'src/b.js');
  say('A', 'Stop');
  const updateOut = say('B', 'UserPromptSubmit', { prompt: 'ok' });
  assert.equal(updateOut.systemMessage, undefined, 'the user hears only when someone comes or goes');
  const update = context(updateOut);
  assert.match(update, /^\[Claude Switcher\] A outra conversa/);
  assert.match(update, /parada há 1 min, esperando o usuário/);
  assert.match(update, /src\/b\.js, src\/a\.js/);
  assert.doesNotMatch(update, /git add -A/, 'the rules only once');

  // And the other way round: A hears about B.
  assert.match(context(say('A', 'UserPromptSubmit', { prompt: 'agora roda os testes do envio' })), /pedido: "cria a tela de login com 2fa"/);

  say('A', 'SessionEnd');
  const ended = say('B', 'UserPromptSubmit', { prompt: 'continua' });
  assert.match(context(ended), /Agora só você está mexendo/);
  assert.match(ended.systemMessage, /a outra conversa deste projeto terminou/);
  assert.equal(say('B', 'UserPromptSubmit', { prompt: 'continua' }), null);
});

test('warns once before an edit to a file the other one changed', () => {
  const { dir, say, edit } = two();
  say('A', 'UserPromptSubmit', { prompt: 'arruma o loop do envio de mensagens' });
  say('B', 'UserPromptSubmit', { prompt: 'cria a tela de login com 2fa' });
  edit('A', 'src/a.js');
  const pre = (file) => say('B', 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: path.join(dir, file) } });

  assert.equal(pre('src/b.js'), null);
  const out = pre('src/a.js');
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined, 'never stops the edit');
  assert.match(context(out), /src\/a\.js também foi mudado há 1 min por a conversa aberta às/);
  assert.equal(pre('src/a.js'), null, 'once');
  edit('A', 'src/a.js', Date.now() + 1000);
  assert.ok(pre('src/a.js'), 'changed again by A');
});

test('holds back once a git command that would take or throw away the other one\'s work', () => {
  const { say, edit, bash } = two();
  say('A', 'UserPromptSubmit', { prompt: 'arruma o loop do envio de mensagens' });
  say('B', 'UserPromptSubmit', { prompt: 'cria a tela de login com 2fa' });
  edit('A', 'src/a.js');
  edit('B', 'src/b.js');

  const held = bash('B', 'git add -A && git commit -m "feat: login"');
  assert.equal(held.systemMessage, 'Claude Switcher: segurei `git add -A && git commit -m "feat: login"`, que levaria para o commit mudanças da outra conversa. Se era isso mesmo, peça de novo que passa.');
  const reason = denied(held);
  assert.match(reason, /levaria para o commit mudanças que outra conversa fez/);
  assert.match(reason, /Arquivos dela: src\/a\.js\./);
  assert.match(reason, /pedido: "arruma o loop do envio de mensagens"/);
  assert.equal(bash('B', 'git add -A  &&  git commit -m "feat: login"'), null, 'sent again: it runs');

  assert.equal(bash('B', 'git add src/b.js && git commit -m "feat: login"'), null, 'only its own file');
  assert.equal(bash('B', 'git status && git diff src/a.js'), null, 'reading is fine');
  assert.match(denied(bash('B', 'git stash')), /apagaria ou esconderia/);
  assert.match(denied(bash('B', 'git checkout -- .')), /apagaria/);
  assert.match(denied(bash('B', 'cd src && git restore a.js')), /apagaria/);
  assert.equal(bash('B', 'git restore src/b.js'), null, 'its own file');
  assert.match(denied(bash('B', 'git reset --hard HEAD')), /apagaria/);
  assert.match(denied(bash('B', 'git commit -am "x"')), /levaria/);
  assert.match(denied(bash('B', 'git switch -c outra')), /trocar de branch/);

  // A file B changed after A is B's own to commit.
  edit('B', 'src/a.js', Date.now() + 1000);
  assert.equal(bash('B', 'git add src/a.js'), null);
});

test('a commit only waits when the index already holds the other one\'s files', () => {
  const { dir, say, edit, bash } = two();
  say('A', 'UserPromptSubmit', { prompt: 'arruma o loop do envio de mensagens' });
  say('B', 'UserPromptSubmit', { prompt: 'cria a tela de login com 2fa' });
  edit('A', 'src/a.js');
  assert.equal(bash('B', 'git commit -m "feat: login"'), null);
  execFileSync('git', ['-C', dir, 'add', 'src/a.js'], { stdio: 'ignore' });
  assert.match(denied(bash('B', 'git commit -m "feat: login"')), /índice do git já tem arquivos/);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'A'], { stdio: 'ignore' });
  assert.equal(bash('B', 'git add -A'), null, 'committed: nothing of A left');
});

test('leaves out conversations in other projects and the ones long quiet', () => {
  const { t, say, edit, sessions } = two();
  const other = path.join(t.root, 'outro');
  fs.mkdirSync(path.join(other, 'sub'), { recursive: true });
  run({ session_id: 'C', cwd: path.join(other, 'sub'), hook_event_name: 'UserPromptSubmit', prompt: 'mexe no outro projeto inteiro' }, sessions);
  say('A', 'UserPromptSubmit', { prompt: 'arruma o loop do envio de mensagens' });
  edit('A', 'src/a.js');
  assert.ok(context(say('B', 'UserPromptSubmit', { prompt: 'cria a tela de login com 2fa' })));
  assert.equal(sessions.peers('B', sessions.meta('B').rootKey).length, 1, 'C is elsewhere');
  assert.equal(sessions.peers('B', sessions.meta('B').rootKey, Date.now() + 4 * 60 * MINUTE).length, 0, 'quiet for hours');
});

test('reads git commands out of a shell line, not out of quotes or a heredoc', () => {
  const cmds = (line) => gitCommands(line, '/p').map((c) => [c.sub, ...c.args].join(' '));
  assert.deepEqual(cmds('git -C sub add -A && git commit -m "fix: git add -A; git stash"'), ['add -A', 'commit -m fix: git add -A; git stash']);
  assert.deepEqual(cmds("git commit -F - <<'EOF'\nfeat: x\n\ngit add -A\nEOF\n"), ['commit -F -']);
  assert.deepEqual(cmds('git commit -m "$(cat <<\'EOF\'\nmsg\n\ngit stash\nEOF\n)"').map((c) => c.split(' ').slice(0, 2).join(' ')), ['commit -m']);
  assert.deepEqual(cmds('echo git stash; GIT_X=1 git stash list | cat'), ['stash list']);

  const risk = (line) => gitRisk(gitCommands(line, '/p')[0], '/p')?.kind ?? null;
  assert.equal(risk('git add .'), 'sweep');
  assert.equal(risk('git add -p'), null);
  assert.equal(risk('git stash list'), null);
  assert.equal(risk('git stash -m wip'), 'discard');
  assert.equal(risk('git reset HEAD~1'), null);
  assert.equal(risk('git restore --staged x.js'), null);
  assert.equal(risk('git clean -fd'), 'discard');
  assert.equal(risk('git checkout -b nova'), 'branch');
  assert.equal(risk('git log --oneline'), null);
});

test('a prompt becomes the task unless it is a short answer or a command', () => {
  assert.equal(taskOf('<ide_opened_file>x.js</ide_opened_file> arruma o loop do envio'), 'arruma o loop do envio');
  assert.equal(taskOf('sim, pode'), null);
  assert.equal(taskOf('/compact agora por favor'), null);
  assert.equal(taskOf('x'.repeat(500)).length, 200);
});

test('settings.json: its hooks sit next to the other features\' and go away alone', async () => {
  const t = setup();
  const file = settingsFile(t.paths);
  fs.writeFileSync(file, '{"model":"opus"}');
  const dir = path.join(t.root, '.claude-switcher');
  await Promise.all([
    syncHook(t.paths, dir, { enabled: true, nodePath: 'node' }),
    syncTopicHook(t.paths, dir, { enabled: true, nodePath: 'node' }),
    syncPeerHook(t.paths, dir, { enabled: true, nodePath: 'node' }),
  ]);
  const on = JSON.parse(fs.readFileSync(file, 'utf8')).hooks;
  assert.deepEqual(Object.keys(on).sort(), ['PostToolUse', 'PreToolUse', 'SessionEnd', 'Stop', 'StopFailure', 'UserPromptSubmit']);
  assert.equal(on.Stop.length, 2);
  assert.equal(on.UserPromptSubmit.length, 2);
  assert.equal(on.PreToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit|Bash');
  assert.ok(fs.existsSync(path.join(dir, 'peer-hook.js')));
  assert.equal(await syncPeerHook(t.paths, dir, { enabled: true, nodePath: 'node' }), false, 'idempotent');

  await syncPeerHook(t.paths, dir, { enabled: false });
  const off = JSON.parse(fs.readFileSync(file, 'utf8')).hooks;
  assert.deepEqual(Object.keys(off).sort(), ['Stop', 'StopFailure', 'UserPromptSubmit']);
  assert.ok(off.Stop[0].hooks[0].args[0].endsWith('limit-hook.js'));
});

function runHook(script, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script]);
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('exit', (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('hook: the copied script talks through the sessions folder next to it', async () => {
  const t = setup();
  const dir = project(t.root);
  const switcher = path.join(t.root, '.claude-switcher');
  await syncPeerHook(t.paths, switcher, { enabled: true, nodePath: process.execPath });
  const script = path.join(switcher, 'peer-hook.js');
  const hook = (id, event, extra) => runHook(script, { session_id: id, cwd: dir, hook_event_name: event, ...extra });

  assert.deepEqual(await hook('A', 'UserPromptSubmit', { prompt: 'arruma o loop do envio de mensagens' }), { code: 0, stdout: '' });
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'A\n');
  await hook('A', 'PostToolUse', { tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src/a.js') } });
  const told = await hook('B', 'UserPromptSubmit', { prompt: 'cria a tela de login com 2fa' });
  assert.match(JSON.parse(told.stdout).hookSpecificOutput.additionalContext, /src\/a\.js/);
  const held = await hook('B', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git add .' } });
  assert.equal(JSON.parse(held.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(await hook('B', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git add .' } }), { code: 0, stdout: '' });
  assert.deepEqual(await runHook(script, { hook_event_name: 'UserPromptSubmit', prompt: 'sem sessão' }), { code: 0, stdout: '' });
  assert.ok(fs.readdirSync(path.join(switcher, 'sessions')).includes('A.edits'));
});
