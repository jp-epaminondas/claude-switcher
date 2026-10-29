'use strict';

// Shared test fixtures: a throwaway Claude config dir and a fake API, no real tokens or network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/core/store');
const { Switcher } = require('../src/core/switcher');
const { ApiError } = require('../src/core/api');

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

module.exports = { HOUR, fakeApi, oauth, setup, acct, dataOf };
