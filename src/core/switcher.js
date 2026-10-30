'use strict';

const defaultApi = require('./api');
const files = require('./claudeFiles');
const { normalizeUsage, outStatus } = require('./usage');
const { advise, learnSessionCost } = require('./advisor');
const { learnDemand, workedFor } = require('./demand');

const HOUR = 3600 * 1000;

const MINUTE = 60 * 1000;
const RECENT_SWITCH_MS = MINUTE;
const LIMIT_HIT_TTL = 30 * MINUTE;
const isExpired = (oauth, marginMs = MINUTE) => !oauth || !oauth.expiresAt || oauth.expiresAt - Date.now() < marginMs;
const find = (data, id) => data.accounts.find((a) => a.id === id);
const sameTokens = (a, b) =>
  !!(a && b && ((a.refreshToken && a.refreshToken === b.refreshToken) || (a.accessToken && a.accessToken === b.accessToken)));

// Account logic with no VS Code dependency.
//
// Ground rule: the tokens in ~/.claude/.credentials.json belong to Claude Code. It refreshes
// them in place, and a refresh token may be single-use, so this class never refreshes the live
// account's token. It only refreshes saved accounts that are verifiably not the live one.
class Switcher {
  // `rank` orders the accounts (advise() or adviseWithPlan()); the switch and the events use it.
  constructor({ paths, store, switcherDir, log = () => {}, api = defaultApi, rank = advise }) {
    this.paths = paths;
    this.store = store;
    this.switcherDir = switcherDir;
    this.log = log;
    this.api = api;
    this.rank = rank;
    this.owners = new Map(); // accessToken -> profile
    this.captureNext = false; // set by "add account": save the next login even if it was removed before
  }

  async whoOwns(accessToken) {
    if (this.owners.has(accessToken)) return this.owners.get(accessToken);
    const profile = await this.api.getProfile(accessToken);
    this.owners.set(accessToken, profile);
    if (this.owners.size > 50) this.owners.delete(this.owners.keys().next().value);
    return profile;
  }

  // Which account Claude Code is logged into. `certain` is false when we could only guess from
  // ~/.claude.json (token expired and unknown to us, or the API unreachable).
  async identifyLive(data) {
    const oauth = files.readLiveOauth(this.paths);
    if (!oauth) return { oauth: null, id: null, certain: true };
    const known = data.accounts.find((a) => sameTokens(a.credentials, oauth));
    if (known) return { oauth, id: known.id, certain: true };
    // New tokens: Claude Code refreshed them, or someone logged into another account.
    if (!isExpired(oauth, 0)) {
      try {
        const profile = await this.whoOwns(oauth.accessToken);
        return { oauth, id: profile.accountUuid, profile, certain: true };
      } catch (e) {
        this.log(`não consegui identificar a conta logada: ${e.message}`);
      }
    }
    const gc = files.readGlobalConfig(this.paths);
    return { oauth, id: (gc && gc.oauthAccount && gc.oauthAccount.accountUuid) || null, certain: false };
  }

  newAccount(data, profile) {
    const labels = new Set(data.accounts.map((a) => a.label));
    let n = data.accounts.length + 1;
    while (labels.has(`Conta ${n}`)) n++;
    return {
      id: profile.accountUuid,
      label: `Conta ${n}`,
      email: profile.email,
      oauthAccount: profile.oauthAccount,
      credentials: null,
      usage: null,
      addedAt: Date.now(),
    };
  }

  // Copies the live tokens into the saved account that owns them, and saves an account seen
  // for the first time. Must run inside store.update(). `trustGuess` accepts an uncertain
  // match: right before a switch, the live tokens are about to be overwritten and would
  // otherwise be lost.
  absorbLive(data, live, { trustGuess = false } = {}) {
    if (!live.oauth || !live.id) return null;
    let acc = find(data, live.id);
    let added = null;
    if (!acc) {
      const allowed = !data.ignored.includes(live.id) || this.captureNext;
      if (!live.profile || !allowed) return null;
      acc = added = this.newAccount(data, live.profile);
      data.accounts.push(acc);
      data.ignored = data.ignored.filter((x) => x !== live.id);
      this.captureNext = false;
    }
    if (live.certain || trustGuess) {
      acc.credentials = live.oauth;
      acc.needsLogin = false;
      data.activeId = acc.id;
    }
    const gc = files.readGlobalConfig(this.paths);
    if (gc && gc.oauthAccount && gc.oauthAccount.accountUuid === acc.id) {
      acc.oauthAccount = gc.oauthAccount;
      acc.email = gc.oauthAccount.emailAddress || acc.email;
    }
    return added;
  }

  // Keeps the store in step with whatever Claude Code is logged into. Returns the account
  // that was just added, if any.
  async syncLive() {
    return this.store.update(async (data) => this.absorbLive(data, await this.identifyLive(data)));
  }

  async switchTo(id) {
    return this.store.update((data) => this.switchIn(data, id));
  }

  // switchTo() for callers already inside store.update().
  async switchIn(data, id) {
    const target = find(data, id);
    if (!target) throw new Error('conta não encontrada');
    const live = await this.identifyLive(data);
    // Save the outgoing account's newest tokens before they're replaced.
    this.absorbLive(data, live, { trustGuess: true });
    if (live.oauth && live.id === id) {
      data.activeId = id;
      return { already: true, account: target };
    }
    if (!target.credentials) throw new Error(`${target.label} não tem login salvo`);
    // Not live, so its tokens are ours to refresh. Doing it here catches a dead login
    // before Claude Code is pointed at it.
    if (isExpired(target.credentials)) {
      try {
        target.credentials = await this.api.refreshOAuth(target.credentials);
        target.needsLogin = false;
      } catch (e) {
        if (!e.isAuth) throw e;
        target.needsLogin = true;
        return { needsLogin: true, account: target };
      }
    }
    files.backupOnce(this.paths, this.switcherDir);
    await files.writeLiveOauth(this.paths, target.credentials);
    if (target.oauthAccount) {
      try {
        await files.writeOauthAccount(this.paths, target.oauthAccount);
      } catch (e) {
        this.log(`credenciais trocadas, mas não consegui atualizar oauthAccount em .claude.json: ${e.message}`);
      }
    }
    data.activeId = id;
    data.lastSwitch = { at: Date.now(), toId: id };
    this.owners.set(target.credentials.accessToken, { accountUuid: id, email: target.email, oauthAccount: target.oauthAccount });
    return { switched: true, account: target, fromId: live.id };
  }

  // A Claude Code session stopped because its account hit the usage limit (reported by the
  // StopFailure hook at `at`). Moves to the next account unless that already happened, and
  // says whether the session should resume.
  async onLimit({ sessionId, at = Date.now() }) {
    return this.store.update(async (data) => {
      const now = Date.now();
      this.absorbLive(data, await this.identifyLive(data), { trustGuess: true });
      const hits = {};
      for (const [k, v] of Object.entries(data.limitHits || {})) if (now - v.at < LIMIT_HIT_TTL) hits[k] = v;
      data.limitHits = hits;
      const prev = hits[sessionId];
      const current = find(data, data.activeId) || null;
      const count = (prev ? prev.count : 0) + 1;
      const record = (acc) => (hits[sessionId] = { accountId: acc ? acc.id : null, at: now, count });

      // Backstop: a session that keeps failing stays stopped.
      if (count > Math.max(3, data.accounts.length + 1)) {
        record(current);
        return { resume: false, reason: 'loop', from: current };
      }
      // The request failed on the account that was live when it went out. A switch moments
      // before (another session's limit, or a click) means it failed on the old account and
      // only needs to resume, unless this session already resumed here and failed again.
      const last = data.lastSwitch;
      const resumedHere = prev && current && prev.accountId === current.id;
      if (current && last && last.toId === current.id && last.at > at - RECENT_SWITCH_MS && !resumedHere) {
        record(current);
        return { resume: true, account: current };
      }
      // Out until its usage is fetched again, so the ranking can't send us straight back.
      if (current) current.limitHitAt = now;
      for (;;) {
        const next = this.pickNext(data, now);
        if (!next) {
          record(current);
          return { resume: false, reason: 'none', from: current };
        }
        const r = await this.switchIn(data, next.id);
        if (r.needsLogin) continue; // now flagged, so pickNext skips it
        record(r.account);
        return { resume: true, switched: true, from: current, account: r.account };
      }
    });
  }

  // Re-checked inside the store lock right before refreshing a saved token. Any doubt counts
  // as "live", because refreshing Claude Code's own token could log it out.
  async mightBeLive(data, acc) {
    if (data.activeId === acc.id) return true;
    const oauth = files.readLiveOauth(this.paths);
    if (!oauth) return false;
    if (sameTokens(oauth, acc.credentials)) return true;
    const gc = files.readGlobalConfig(this.paths);
    if (gc && gc.oauthAccount && gc.oauthAccount.accountUuid === acc.id) return true;
    if (isExpired(oauth, 0)) return true;
    try {
      return (await this.whoOwns(oauth.accessToken)).accountUuid === acc.id;
    } catch {
      return true;
    }
  }

  async refreshSaved(id) {
    return this.store.update(async (data) => {
      const acc = find(data, id);
      if (!acc || !acc.credentials) return null;
      if (!isExpired(acc.credentials)) return acc.credentials.accessToken; // another window just did it
      if (await this.mightBeLive(data, acc)) return null;
      try {
        acc.credentials = await this.api.refreshOAuth(acc.credentials);
        acc.needsLogin = false;
        return acc.credentials.accessToken;
      } catch (e) {
        if (e.isAuth) acc.needsLogin = true;
        acc.usageError = e.message;
        acc.usageErrorAt = Date.now();
        this.log(`refresh de ${acc.label} falhou: ${e.message}`);
        return null;
      }
    });
  }

  async accessTokenFor(acc, live) {
    if (acc.id === live.id) return live.certain && !isExpired(live.oauth, 0) ? live.oauth.accessToken : null;
    if (!acc.credentials || acc.needsLogin) return null;
    if (!isExpired(acc.credentials)) return acc.credentials.accessToken;
    if (live.oauth && !live.certain) return null;
    return this.refreshSaved(acc.id);
  }

  isDue(acc, isLive, now, activeEveryMs, idleEveryMs) {
    const last = Math.max((acc.usage && acc.usage.fetchedAt) || 0, acc.usageErrorAt || 0);
    // It was out and its reset time just passed: confirm right away.
    if (acc.out && acc.out.until && acc.out.until <= now && last < acc.out.until) return true;
    return now - last >= (isLive ? activeEveryMs : idleEveryMs);
  }

  async refreshUsage({ force = false, only = null, activeEveryMs = 3 * MINUTE, idleEveryMs = 15 * MINUTE } = {}) {
    const data = this.store.load();
    const live = await this.identifyLive(data);
    const now = Date.now();
    for (const acc of data.accounts) {
      if (only && !only.includes(acc.id)) continue;
      if (!force && !this.isDue(acc, acc.id === live.id, now, activeEveryMs, idleEveryMs)) continue;
      const token = await this.accessTokenFor(acc, live);
      if (!token) continue;
      try {
        await this.recordUsage(acc.id, await this.api.getUsage(token), Date.now());
      } catch (e) {
        this.log(`uso de ${acc.label}: ${e.message}`);
        await this.store.update((d) => {
          const a = find(d, acc.id);
          if (!a) return;
          a.usageError = e.message;
          a.usageErrorAt = Date.now();
          if (e.isAuth && a.id !== live.id) a.needsLogin = true;
        });
      }
    }
  }

  async recordUsage(id, raw, fetchedAt) {
    return this.store.update((data) => {
      const acc = find(data, id);
      if (!acc || (acc.usage && acc.usage.fetchedAt >= fetchedAt)) return false;
      const usage = normalizeUsage(raw, fetchedAt);
      learnSessionCost(acc, acc.usage, usage);
      learnDemand(data, acc, usage, acc.id === data.activeId);
      acc.usage = usage;
      acc.usageError = null;
      acc.usageErrorAt = null;
      return true;
    });
  }

  // Claude Code caches its own /usage reads in ~/.claude.json; reusing them saves API calls.
  async absorbClaudeCache() {
    const gc = files.readGlobalConfig(this.paths);
    const c = gc && gc.cachedUsageUtilization;
    if (!c || !c.accountUuid || !c.utilization || !c.fetchedAtMs) return false;
    return this.recordUsage(c.accountUuid, c.utilization, c.fetchedAtMs);
  }

  // Accounts that ran out or came back since the last check, plus a "burn" event when the
  // recommended account is not the one in use and has usage about to be thrown away. Runs
  // under the store lock, so with several windows open only one of them reports each event.
  async collectEvents(adviceOptions = {}) {
    return this.store.update((data) => {
      const now = Date.now();
      const events = [];
      for (const acc of data.accounts) {
        const st = outStatus(acc.usage, now);
        if (st.out) {
          if (!acc.out) events.push({ type: 'out', id: acc.id, until: st.until, active: acc.id === data.activeId });
          acc.out = { until: st.until, since: (acc.out && acc.out.since) || now };
        } else if (acc.out) {
          delete acc.out;
          events.push({ type: 'back', id: acc.id, active: acc.id === data.activeId });
        }
      }
      const advice = this.rank(data, now, adviceOptions);
      const best = advice.best;
      if (best && best.burn && !best.active) {
        const week = Math.round(best.resetsAt / HOUR); // once per account per weekly cycle
        if (best.acc.burnNotified !== week) {
          best.acc.burnNotified = week;
          events.push({ type: 'burn', id: best.id });
        }
      }
      if (advice.plan && adviceOptions.notifyPace !== false) events.push(...planEvents(data, advice.plan, now));
      return events;
    });
  }

  // Account to move to (never the one in use): see advise() for the ranking.
  pickNext(data, now = Date.now()) {
    const next = this.rank(data, now).next;
    return next ? next.acc : null;
  }

  async rename(id, label) {
    return this.store.update((data) => {
      const acc = find(data, id);
      if (acc) acc.label = label;
    });
  }

  // Forgets the account. It is also ignored from then on, otherwise it would be saved again
  // right away while it is still the one logged in.
  async remove(id) {
    return this.store.update((data) => {
      data.accounts = data.accounts.filter((a) => a.id !== id);
      if (!data.ignored.includes(id)) data.ignored.push(id);
    });
  }
}

// Reminders from the plan, each at most so often: a heads-up before every account runs out,
// the next pause once enough work has gone by, and a daily note when even pauses won't do.
function planEvents(data, p, now) {
  const pn = (data.planNotified = data.planNotified || {});
  const events = [];
  if (p.nextStop && p.activeNow && p.nextStop.start - now <= 30 * MINUTE && (!pn.stopAt || now - pn.stopAt > 2 * HOUR)) {
    pn.stopAt = now;
    events.push({ type: 'stopSoon', start: p.nextStop.start, end: p.nextStop.end, minutes: p.nextStop.minutes, maxWaitMin: p.maxWaitMin });
  } else if (p.verdict === 'pace' && workedFor(data.demand, now) > 0) {
    const since = Math.max(data.demand.workStart, (pn.pauseAt || 0) + p.pace.pauseMin * MINUTE);
    if (now - since >= p.pace.workMin * MINUTE) {
      pn.pauseAt = now;
      events.push({ type: 'pause', ...p.pace, maxWaitMin: p.maxWaitMin });
    }
  }
  if (p.verdict === 'short' && p.learned) {
    const day = new Date(now).toDateString();
    if (pn.short !== day) {
      pn.short = day;
      events.push({ type: 'short', ...p.short, maxWaitMin: p.maxWaitMin });
    }
  }
  return events;
}

module.exports = { Switcher, isExpired };
