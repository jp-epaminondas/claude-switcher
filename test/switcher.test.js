'use strict';

// Runs the core against a throwaway Claude config dir and a fake API: no real tokens or
// network. `npm test`
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { Switcher } = require('../src/switcher');
const { ApiError } = require('../src/api');
const { outStatus } = require('../src/usage');

const HOUR = 3600 * 1000;

function fakeApi() {
  const dead = new Set();
  const usage = {};
  const calls = { refresh: [], profile: 0, usage: [] };
  const acct = (token) => token.split('-')[1];
  return {
    calls,
    usage,
    dead,
    async getProfile(at) {
      calls.profile++;
      const a = acct(at);
      return { accountUuid: `uuid-${a}`, email: `${a.toLowerCase()}@x.com`, oauthAccount: { accountUuid: `uuid-${a}`, emailAddress: `${a.toLowerCase()}@x.com` } };
    },
    async getUsage(at) {
      calls.usage.push(acct(at));
      return usage[acct(at)] || { five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 0, resets_at: null } };
    },
    async refreshOAuth(oauth) {
      calls.refresh.push(acct(oauth.refreshToken));
      if (dead.has(oauth.refreshToken)) throw new ApiError('HTTP 400: invalid_grant', 400, { error: 'invalid_grant' });
      dead.add(oauth.refreshToken); // rotation: an old refresh token never works twice
      const [, a, n] = oauth.refreshToken.split('-');
      const m = Number(n) + 1;
      return { ...oauth, accessToken: `at-${a}-${m}`, refreshToken: `rt-${a}-${m}`, expiresAt: Date.now() + 8 * HOUR };
    },
  };
}

const oauth = (a, n, expiresIn = 8 * HOUR) => ({
  accessToken: `at-${a}-${n}`,
  refreshToken: `rt-${a}-${n}`,
  expiresAt: Date.now() + expiresIn,
  scopes: ['user:inference'],
  subscriptionType: 'pro',
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-switcher-test-'));
  const paths = {
    configDir: path.join(root, '.claude'),
    credentials: path.join(root, '.claude', '.credentials.json'),
    globalConfig: path.join(root, '.claude.json'),
  };
  fs.mkdirSync(paths.configDir);
  const dir = path.join(root, '.claude-switcher');
  const api = fakeApi();
  const store = new Store(dir);
  const sw = new Switcher({ paths, store, switcherDir: dir, api });
  const env = {
    root,
    paths,
    api,
    store,
    sw,
    // What Claude Code does on /login or on a token refresh.
    login(a, n, expiresIn) {
      const creds = { claudeAiOauth: oauth(a, n, expiresIn), mcpOAuth: { keep: 'me' } };
      fs.writeFileSync(paths.credentials, JSON.stringify(creds));
      const gc = fs.existsSync(paths.globalConfig) ? JSON.parse(fs.readFileSync(paths.globalConfig, 'utf8')) : { projects: { 'c:/x': 1, 'C:/x': 2 } };
      gc.oauthAccount = { accountUuid: `uuid-${a}`, emailAddress: `${a.toLowerCase()}@x.com`, extra: 'from-claude-code' };
      fs.writeFileSync(paths.globalConfig, JSON.stringify(gc, null, 2));
    },
    live: () => JSON.parse(fs.readFileSync(paths.credentials, 'utf8')),
    gc: () => JSON.parse(fs.readFileSync(paths.globalConfig, 'utf8')),
    acc: (a) => store.load().accounts.find((x) => x.id === `uuid-${a}`),
  };
  return env;
}

test('first run saves the logged-in account, a new login adds another', async () => {
  const t = setup();
  t.login('A', 1);
  const added = await t.sw.syncLive();
  assert.equal(added.label, 'Conta 1');
  assert.equal(t.store.load().activeId, 'uuid-A');
  assert.equal(t.acc('A').oauthAccount.extra, 'from-claude-code', 'keeps the exact block Claude Code wrote');

  assert.equal(await t.sw.syncLive(), null, 'nothing new the second time');
  assert.equal(t.api.calls.profile, 1, 'known tokens need no API call');

  t.login('B', 1);
  assert.equal((await t.sw.syncLive()).label, 'Conta 2');
  assert.equal(t.store.load().activeId, 'uuid-B');
});

test('switching writes the target login and keeps everything else', async () => {
  const t = setup();
  t.login('A', 1);
  await t.sw.syncLive();
  t.login('B', 1);
  await t.sw.syncLive();
  // Claude Code refreshes B before we switch away from it.
  const live = t.live();
  live.claudeAiOauth = oauth('B', 2);
  fs.writeFileSync(t.paths.credentials, JSON.stringify(live));

  const r = await t.sw.switchTo('uuid-A');
  assert.ok(r.switched);
  assert.equal(t.live().claudeAiOauth.accessToken, 'at-A-1');
  assert.deepEqual(t.live().mcpOAuth, { keep: 'me' });
  assert.equal(t.gc().oauthAccount.accountUuid, 'uuid-A');
  assert.deepEqual(t.gc().projects, { 'c:/x': 1, 'C:/x': 2 }, 'rest of .claude.json untouched');
  assert.equal(t.acc('B').credentials.refreshToken, 'rt-B-2', 'outgoing account saved with its newest tokens');
  assert.equal(t.store.load().activeId, 'uuid-A');
  assert.ok(fs.existsSync(path.join(t.root, '.claude-switcher', 'backup', '.credentials.json.orig')));
  assert.deepEqual(t.api.calls.refresh, [], 'valid tokens are not refreshed');

  assert.ok((await t.sw.switchTo('uuid-A')).already);
});

test('a saved login that expired is refreshed on switch; a dead one is reported', async () => {
  const t = setup();
  t.login('A', 1, -HOUR);
  await t.sw.store.update((d) => {
    d.accounts.push({ id: 'uuid-A', label: 'Conta 1', email: 'a@x.com', credentials: oauth('A', 1, -HOUR) });
  });
  t.login('B', 1);
  await t.sw.syncLive();

  const r = await t.sw.switchTo('uuid-A');
  assert.ok(r.switched);
  assert.equal(t.live().claudeAiOauth.accessToken, 'at-A-2');

  await t.sw.switchTo('uuid-B');
  await t.sw.store.update((d) => {
    d.accounts.find((a) => a.id === 'uuid-A').credentials = oauth('A', 1, -HOUR); // rt-A-1 is dead now
  });
  const dead = await t.sw.switchTo('uuid-A');
  assert.ok(dead.needsLogin);
  assert.equal(t.live().claudeAiOauth.accessToken, 'at-B-1', 'live login left alone');
  assert.equal(t.acc('A').needsLogin, true);
});

test('usage polling never refreshes the live account token', async () => {
  const t = setup();
  t.login('A', 1);
  await t.sw.syncLive();
  t.login('B', 1, -HOUR); // live and expired: only Claude Code may refresh it
  await t.sw.store.update((d) => {
    d.accounts.push({ id: 'uuid-B', label: 'Conta 2', email: 'b@x.com', credentials: oauth('B', 1, -HOUR) });
    d.accounts.find((a) => a.id === 'uuid-A').credentials = oauth('A', 1, -HOUR);
    d.activeId = 'uuid-B';
  });

  await t.sw.refreshUsage({ force: true });
  assert.deepEqual(t.api.calls.refresh, [], 'live token expired and unknown owner: no refreshes at all');

  // Claude Code refreshes B; now ownership is provable and A may be refreshed.
  const live = t.live();
  live.claudeAiOauth = oauth('B', 2);
  fs.writeFileSync(t.paths.credentials, JSON.stringify(live));
  await t.sw.syncLive();
  await t.sw.refreshUsage({ force: true });
  assert.deepEqual(t.api.calls.refresh, ['A']);
  assert.deepEqual(t.api.calls.usage.sort(), ['A', 'B']);
});

test('stale activeId does not let a refresh hit the live account', async () => {
  const t = setup();
  t.login('A', 1);
  await t.sw.syncLive();
  t.login('B', 2);
  await t.sw.store.update((d) => {
    // Store thinks A is live and holds an old B token: exactly the case that must not refresh.
    d.accounts.push({ id: 'uuid-B', label: 'Conta 2', email: 'b@x.com', credentials: oauth('B', 1, -HOUR) });
    d.activeId = 'uuid-A';
  });
  assert.equal(await t.sw.refreshSaved('uuid-B'), null);
  assert.deepEqual(t.api.calls.refresh, []);
});

test('out and back events, next account choice', async () => {
  const t = setup();
  const now = Date.now();
  t.login('A', 1);
  await t.sw.syncLive();
  await t.sw.store.update((d) => {
    d.accounts.push({ id: 'uuid-B', label: 'Conta 2', credentials: oauth('B', 1) });
    d.accounts.push({ id: 'uuid-C', label: 'Conta 3', credentials: oauth('C', 1) });
    d.accounts.push({ id: 'uuid-D', label: 'Conta 4', credentials: oauth('D', 1) });
  });
  const full = { five_hour: { utilization: 100, resets_at: new Date(now + 2 * HOUR).toISOString() }, seven_day: { utilization: 40, resets_at: null } };
  await t.sw.recordUsage('uuid-A', full, now);
  await t.sw.recordUsage('uuid-B', full, now);
  await t.sw.recordUsage('uuid-C', { five_hour: { utilization: 60, resets_at: null } }, now);
  await t.sw.recordUsage('uuid-D', { five_hour: { utilization: 10, resets_at: null } }, now);

  const events = await t.sw.collectEvents();
  assert.deepEqual(events.map((e) => `${e.type}:${e.id}:${e.active}`).sort(), ['out:uuid-A:true', 'out:uuid-B:false']);
  assert.deepEqual(await t.sw.collectEvents(), [], 'each event is reported once');

  assert.equal(t.sw.pickNext(t.store.load()).id, 'uuid-D', 'lowest usage among available');
  assert.equal(t.sw.soonestBack(t.store.load()).account.id, 'uuid-A');

  // The 5h window resets: both come back without a new fetch.
  await t.sw.store.update((d) => {
    for (const a of d.accounts) if (a.usage && a.usage.fiveHour) a.usage.fiveHour.resetsAt = now - 1000;
  });
  const back = await t.sw.collectEvents();
  assert.deepEqual(back.map((e) => `${e.type}:${e.id}`).sort(), ['back:uuid-A', 'back:uuid-B']);
});

test('limit info from the usage API', () => {
  const now = Date.now();
  const fetchedAt = now;
  const weekly = new Date(now + 50 * HOUR).toISOString();
  const st = outStatus(
    {
      fetchedAt,
      fiveHour: { pct: 30, resetsAt: now + HOUR },
      sevenDay: { pct: 100, resetsAt: Date.parse(weekly) },
      limits: [],
    },
    now,
  );
  assert.deepEqual(st, { out: true, until: Date.parse(weekly) });
  assert.deepEqual(outStatus({ fetchedAt, fiveHour: { pct: 100, resetsAt: now - 1 }, limits: [] }, now), { out: false });
});

// Usage in the shape advise() reads. pct values are % used; resets in hours from now.
function acct(id, { five = 0, week = 0, weekIn = null, fiveIn = null, active = false } = {}, now) {
  return {
    id,
    label: id,
    credentials: oauth(id, 1),
    usage: {
      fetchedAt: now,
      fiveHour: { pct: five, resetsAt: fiveIn == null ? null : now + fiveIn * HOUR },
      sevenDay: { pct: week, resetsAt: weekIn == null ? null : now + weekIn * HOUR },
      limits: [],
    },
    active,
  };
}
const dataOf = (now, ...accs) => ({ accounts: accs, activeId: (accs.find((a) => a.active) || {}).id || null, ignored: [] });

test('advisor: earliest weekly reset first, burn flag, sticky active', () => {
  const { advise } = require('../src/advisor');
  const now = Date.now();
  // The real situation from the screenshot: 5 in use renews in 15h with 63% left.
  const data = dataOf(
    now,
    acct('C1', { five: 52, week: 34, weekIn: 78, fiveIn: 4 }, now),
    acct('C2', { week: 67, weekIn: 65 }, now),
    acct('C3', { five: 100, week: 75, weekIn: 19, fiveIn: 1.4 }, now),
    acct('C4', { week: 100, weekIn: 18 }, now),
    acct('C5', { week: 37, weekIn: 15, active: true }, now),
  );
  let r = advise(data, now);
  assert.equal(r.best.id, 'C5', 'keep burning the one that renews first');
  assert.ok(r.best.burn);
  assert.equal(r.next.id, 'C2', 'C3/C4 are out; C2 renews before C1');
  assert.equal(r.byId.get('C1').burn, false);

  // Using C1 instead: the advisor points back to C5 and flags it.
  data.activeId = 'C1';
  r = advise(data, now);
  assert.equal(r.best.id, 'C5');
  assert.equal(r.best.active, false);

  // Active renews only 2h after the earliest: not worth a switch.
  const sticky = dataOf(now, acct('A', { week: 50, weekIn: 40, active: true }, now), acct('B', { week: 50, weekIn: 38 }, now));
  assert.equal(advise(sticky, now).best.id, 'A');
  assert.equal(advise(sticky, now).next.id, 'B');

  // Nearly empty accounts go last; unstarted weeks after anything that can expire.
  const order = dataOf(
    now,
    acct('fresh', {}, now),
    acct('empty', { week: 97, weekIn: 2 }, now),
    acct('later', { week: 10, weekIn: 100 }, now),
  );
  assert.equal(advise(order, now).best.id, 'later');
  assert.deepEqual(
    advise(order, now).items.filter((x) => x.available).map((x) => x.id),
    ['fresh', 'empty', 'later'],
    'items keep store order',
  );
});

test('advisor: learns the cost of a 5h session and flags burn early when needed', () => {
  const { advise, learnSessionCost } = require('../src/advisor');
  const now = Date.now();
  const u = (five, week) => ({ fiveHour: { pct: five, resetsAt: now + 3 * HOUR }, sevenDay: { pct: week, resetsAt: now + 50 * HOUR } });
  const a = acct('A', { week: 20, weekIn: 50 }, now);
  learnSessionCost(a, u(0, 10), u(30, 14));
  learnSessionCost(a, u(30, 14), u(80, 20));
  assert.deepEqual(a.calib, { five: 80, week: 10 });
  learnSessionCost(a, u(80, 20), { ...u(5, 20), fiveHour: { pct: 5, resetsAt: now + 9 * HOUR } }); // new 5h window: ignored
  assert.deepEqual(a.calib, { five: 80, week: 10 });

  // 12.5% of the week per session: 80% left = 6.4 sessions = 32h of use; the week renews in
  // 50h, so even at half-time use it would not all get spent.
  a.usage.sevenDay.pct = 20;
  const r = advise(dataOf(now, a), now);
  assert.ok(Math.abs(r.best.sessions - 6.4) < 0.01);
  assert.ok(r.best.burn);
  // Without the learned cost, 50h is outside the 24h window.
  delete a.calib;
  assert.equal(advise(dataOf(now, a), now).best.burn, false);
});

test('burn event fires once when the best account is not the one in use', async () => {
  const t = setup();
  const now = Date.now();
  t.login('A', 1);
  await t.sw.syncLive();
  await t.sw.store.update((d) => {
    d.accounts.push({ id: 'uuid-B', label: 'Conta 2', credentials: oauth('B', 1) });
  });
  await t.sw.recordUsage('uuid-A', { five_hour: { utilization: 10 }, seven_day: { utilization: 20, resets_at: new Date(now + 100 * HOUR).toISOString() } }, now);
  await t.sw.recordUsage('uuid-B', { five_hour: { utilization: 0 }, seven_day: { utilization: 40, resets_at: new Date(now + 10 * HOUR).toISOString() } }, now);
  const events = await t.sw.collectEvents({ burnWindowHours: 24 });
  assert.deepEqual(events, [{ type: 'burn', id: 'uuid-B' }]);
  assert.deepEqual(await t.sw.collectEvents({ burnWindowHours: 24 }), []);
  assert.equal(t.sw.pickNext(t.store.load()).id, 'uuid-B');
});

test('removed accounts are not re-captured unless added again', async () => {
  const t = setup();
  t.login('A', 1);
  await t.sw.syncLive();
  await t.sw.remove('uuid-A');
  t.login('A', 2);
  assert.equal(await t.sw.syncLive(), null);
  assert.equal(t.store.load().accounts.length, 0);
  t.sw.captureNext = true;
  assert.equal((await t.sw.syncLive()).id, 'uuid-A');
  assert.deepEqual(t.store.load().ignored, []);
});
