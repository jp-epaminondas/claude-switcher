'use strict';

// Autoswitcher: what happens when Claude Code reports a usage limit, the hook it runs, and
// the hook entry in Claude Code's settings.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { setup } = require('./helpers');
const { advise } = require('../src/core/advisor');
const { LimitQueue } = require('../src/core/limitQueue');
const { syncHook, findNode, settingsFile } = require('../src/core/claudeHook');

// Saves A, B and C, with A logged in.
async function threeAccounts() {
  const t = setup();
  for (const a of ['C', 'B', 'A']) {
    t.login(a, 1);
    await t.sw.syncLive();
  }
  return t;
}
const liveAccount = (t) => t.live().claudeAiOauth.accessToken.split('-')[1];

test('a limit moves to the next account once, even when several sessions hit it', async () => {
  const t = await threeAccounts();
  const r = await t.sw.onLimit({ sessionId: 's1', at: Date.now() });
  assert.ok(r.resume && r.switched);
  assert.equal(r.from.id, 'uuid-A');
  const first = liveAccount(t);
  assert.notEqual(first, 'A');

  // s2's request was in flight on A when s1 hit the limit: it resumes on the new account.
  const r2 = await t.sw.onLimit({ sessionId: 's2', at: Date.now() - 2000 });
  assert.ok(r2.resume && !r2.switched);
  assert.equal(liveAccount(t), first, 'no second switch');

  // s1 resumed on the new account and failed again: that one is out too. A has not been
  // checked since its limit, so it is not picked again.
  const r3 = await t.sw.onLimit({ sessionId: 's1', at: Date.now() });
  assert.ok(r3.resume && r3.switched);
  const second = liveAccount(t);
  assert.ok(![first, 'A'].includes(second), `went to ${second}`);

  const r4 = await t.sw.onLimit({ sessionId: 's1', at: Date.now() });
  assert.deepEqual([r4.resume, r4.reason], [false, 'none']);
  assert.equal(liveAccount(t), second, 'stays put when nothing is left');
});

test('an account is pickable again once its usage was fetched after the limit', async () => {
  const t = await threeAccounts();
  const availableA = () => advise(t.store.load()).byId.get('uuid-A').available;
  await t.sw.onLimit({ sessionId: 's1', at: Date.now() });
  assert.equal(availableA(), false);
  await t.sw.refreshUsage({ force: true, only: ['uuid-A'] }); // fake API: A at 0%
  assert.equal(availableA(), true);
});

test('a session that keeps failing stops resuming', async () => {
  const t = await threeAccounts();
  let r;
  for (let i = 0; i < 10; i++) {
    r = await t.sw.onLimit({ sessionId: 's1', at: Date.now() - 2 * 60 * 1000 });
    if (!r.resume) break;
    await t.sw.refreshUsage({ force: true }); // usage keeps saying 0%, so accounts look available
  }
  assert.equal(r.resume, false);
  assert.equal(r.reason, 'loop');
});

test('settings.json: hook added and removed, the rest left alone', async () => {
  const t = setup();
  const file = settingsFile(t.paths);
  const userHook = { matcher: 'overloaded', hooks: [{ type: 'command', command: 'echo hi' }] };
  const original = { model: 'opus', permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }], StopFailure: [userHook] } };
  fs.writeFileSync(file, JSON.stringify(original, null, 2) + '\n');
  const dir = path.join(t.root, '.claude-switcher');

  assert.equal(await syncHook(t.paths, dir, { enabled: true, nodePath: 'C:/node/node.exe' }), true);
  const on = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(on.model, 'opus');
  assert.deepEqual(on.hooks.Stop[0], original.hooks.Stop[0], "the user's own Stop hook stays first");
  assert.deepEqual(on.hooks.Stop[1], {
    hooks: [{ type: 'command', command: 'C:/node/node.exe', args: [path.join(dir, 'limit-hook.js')], async: true, timeout: 30 }],
  });
  assert.deepEqual(on.hooks.StopFailure[0], userHook);
  assert.deepEqual(on.hooks.StopFailure[1], {
    matcher: 'rate_limit',
    hooks: [{ type: 'command', command: 'C:/node/node.exe', args: [path.join(dir, 'limit-hook.js')], asyncRewake: true, timeout: 120 }],
  });
  assert.ok(fs.existsSync(path.join(dir, 'limit-hook.js')), 'script copied next to accounts.json');
  assert.equal(await syncHook(t.paths, dir, { enabled: true, nodePath: 'C:/node/node.exe' }), false, 'idempotent');

  assert.equal(await syncHook(t.paths, dir, { enabled: false }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original);
  assert.equal(await syncHook(t.paths, dir, { enabled: false }), false);

  // Nothing else in hooks: the keys it created go away again.
  fs.writeFileSync(file, '{"model":"opus"}');
  await syncHook(t.paths, dir, { enabled: true, nodePath: 'node' });
  await syncHook(t.paths, dir, { enabled: false });
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "model": "opus"\n}');
});

test('settings.json that does not parse is never overwritten', async () => {
  const t = setup();
  const file = settingsFile(t.paths);
  fs.writeFileSync(file, '{ "model": "opus", // comentário\n}');
  await assert.rejects(syncHook(t.paths, t.root, { enabled: true, nodePath: 'node' }), /JSON válido/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "model": "opus", // comentário\n}');

  fs.writeFileSync(file, '{"model":"opus"}');
  await assert.rejects(syncHook(t.paths, t.root, { enabled: true, nodePath: null }), /Node\.js/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"model":"opus"}', 'no hook without node to run it');
});

test('findNode looks through PATH', () => {
  const t = setup();
  const bin = path.join(t.root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'node.exe'), '');
  assert.equal(findNode({ PATH: ['C:/nope', bin].join(path.delimiter) }, 'win32'), path.join(bin, 'node.exe'));
  assert.equal(findNode({ PATH: 'C:/nope' }, 'win32'), null);
});

// Runs the hook script the way Claude Code does: JSON on stdin, exit code and stderr back.
function runHook(dir, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, 'limit-hook.js')]);
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code) => resolve({ code, stderr }));
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

test('hook: resumes the session with exit 2 when the extension says so', async () => {
  const t = setup();
  const dir = path.join(t.root, '.claude-switcher');
  await syncHook(t.paths, dir, { enabled: true, nodePath: process.execPath });
  const queue = new LimitQueue(dir);
  const hook = { session_id: 'sess-1', hook_event_name: 'StopFailure', error: 'rate_limit' };

  // No window listening: gives up right away.
  const quiet = await runHook(dir, hook);
  assert.deepEqual(quiet, { code: 0, stderr: '' });

  queue.heartbeat();
  const [resumed, req] = await Promise.all([runHook(dir, hook), answerNext(queue, { resume: true, message: 'Continue de onde parou.' })]);
  assert.equal(req.sessionId, 'sess-1');
  assert.deepEqual(resumed, { code: 2, stderr: 'Continue de onde parou.' });

  const [stopped] = await Promise.all([runHook(dir, hook), answerNext(queue, { resume: false })]);
  assert.deepEqual(stopped, { code: 0, stderr: '' });

  const other = await runHook(dir, { ...hook, error: 'overloaded' });
  assert.equal(other.code, 0, 'only usage limits');
  assert.deepEqual(queue.take(), []);

  // The end of a normal turn is only reported; the hook doesn't wait for anything.
  const started = Date.now();
  const turn = await runHook(dir, { session_id: 'sess-1', hook_event_name: 'Stop' });
  assert.deepEqual(turn, { code: 0, stderr: '' });
  assert.ok(Date.now() - started < 5000);
  const turns = queue.takeTurns();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].sessionId, 'sess-1');
  assert.deepEqual(queue.takeTurns(), [], 'taken once');
});

test('at the end of a turn, an account at 99% hands over to the next one', async () => {
  const t = await threeAccounts();
  const soon = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  const usage = (five, week = 10) => ({ five_hour: { utilization: five, resets_at: soon }, seven_day: { utilization: week, resets_at: soon } });

  t.api.usage.A = usage(98);
  await t.sw.refreshUsage({ force: true });
  assert.equal(await t.sw.onTurnEnd({ threshold: 99 }), null, 'below the threshold');

  t.api.usage.A = usage(99);
  t.api.usage.B = usage(99);
  t.api.usage.C = usage(99);
  await t.sw.refreshUsage({ force: true });
  assert.equal(await t.sw.onTurnEnd({ threshold: 99 }), null, 'no point moving to an account just as full');
  assert.equal(liveAccount(t), 'A');

  t.api.usage.B = usage(20);
  t.api.usage.C = usage(5, 99); // the week counts too
  await t.sw.refreshUsage({ force: true });
  const r = await t.sw.onTurnEnd({ threshold: 99 });
  assert.equal(r.from.id, 'uuid-A');
  assert.equal(r.account.id, 'uuid-B');
  assert.equal(liveAccount(t), 'B');
});
