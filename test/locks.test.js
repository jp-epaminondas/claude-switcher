'use strict';

// Travas: releasing and locking again what auto mode holds back, as exceptions in
// autoMode.allow, without touching anything else in Claude Code's settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { setup } = require('./helpers');
const { LOCKS, released, setReleased, entryOf } = require('../src/core/locks');
const { syncApprovalHook, updateSettings, readSettings, settingsFile } = require('../src/core/claudeHook');

const lock = (id) => LOCKS.find((l) => l.id === id);
const toggle = (paths, id, on) =>
  updateSettings(paths, (s) => {
    const ids = new Set(released(s));
    if (on) ids.add(id);
    else ids.delete(id);
    setReleased(s, ids);
  });

test('releasing a lock adds its exception after the built-in ones; locking it again leaves the file as it was', async () => {
  const t = setup();
  const original = { model: 'opus', permissions: { allow: ['Bash(npm test)'] } };
  fs.writeFileSync(settingsFile(t.paths), JSON.stringify(original, null, 2) + '\n');

  assert.equal(await toggle(t.paths, 'prod-deploy', true), true);
  const s = readSettings(t.paths).settings;
  assert.deepEqual(s.autoMode, { allow: ['$defaults', entryOf(lock('prod-deploy'))] });
  assert.deepEqual(s.permissions, original.permissions);
  assert.deepEqual(released(s), ['prod-deploy']);
  assert.match(s.autoMode.allow[1], /^Deploy em produção \[Claude Switcher: prod-deploy, liberado pelo usuário\]: .*Production Deploy/);

  assert.equal(await toggle(t.paths, 'prod-deploy', true), false, 'idempotent');
  await toggle(t.paths, 'git-destructive', true);
  assert.deepEqual(released(readSettings(t.paths).settings), ['prod-deploy', 'git-destructive']);

  await toggle(t.paths, 'prod-deploy', false);
  await toggle(t.paths, 'git-destructive', false);
  assert.deepEqual(readSettings(t.paths).settings, original);
});

test("the user's own auto mode entries stay, and a list written without $defaults keeps without it", () => {
  const mine = { autoMode: { environment: ['$defaults', 'Trusted internal domains: *.rota7.com'], allow: ['$defaults', 'Deploying to staging is allowed'] } };
  setReleased(mine, new Set(['prod-read']));
  assert.deepEqual(mine.autoMode.allow, ['$defaults', 'Deploying to staging is allowed', entryOf(lock('prod-read'))]);
  assert.deepEqual(mine.autoMode.environment, ['$defaults', 'Trusted internal domains: *.rota7.com']);
  setReleased(mine, new Set());
  assert.deepEqual(mine.autoMode.allow, ['$defaults', 'Deploying to staging is allowed']);

  const replaced = { autoMode: { allow: ['Only this'] } };
  setReleased(replaced, new Set(['prod-shell']));
  assert.deepEqual(replaced.autoMode.allow, ['Only this', entryOf(lock('prod-shell'))]);
  setReleased(replaced, new Set());
  assert.deepEqual(replaced.autoMode.allow, ['Only this']);
});

test('settings with nothing of ours are left alone; an old wording or a lock that no longer exists is rewritten', () => {
  const plain = { autoMode: { allow: ['$defaults'] } };
  setReleased(plain, new Set(released(plain)));
  assert.deepEqual(plain, { autoMode: { allow: ['$defaults'] } });

  const old = {
    autoMode: {
      allow: ['$defaults', 'Deploy em produção [Claude Switcher: prod-deploy, liberado pelo usuário]: texto antigo', 'Algo [Claude Switcher: removed-lock, liberado pelo usuário]: x'],
    },
  };
  setReleased(old, new Set(released(old)));
  assert.deepEqual(old.autoMode.allow, ['$defaults', entryOf(lock('prod-deploy'))]);
});

test('the locks and the hooks share settings.json without losing each other', async () => {
  const t = setup();
  await Promise.all([toggle(t.paths, 'prod-read', true), syncApprovalHook(t.paths, `${t.root}/.claude-switcher`, { enabled: true, nodePath: 'node' }), toggle(t.paths, 'git-destructive', true)]);
  const s = readSettings(t.paths).settings;
  assert.deepEqual(released(s), ['prod-read', 'git-destructive']);
  assert.equal(s.hooks.PermissionRequest.length, 1);
});

test('a broken settings.json is reported, not overwritten', async () => {
  const t = setup();
  fs.writeFileSync(settingsFile(t.paths), '{ "model": ');
  await assert.rejects(toggle(t.paths, 'prod-deploy', true), /não é um JSON válido/);
  assert.equal(fs.readFileSync(settingsFile(t.paths), 'utf8'), '{ "model": ');
});
