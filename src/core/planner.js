'use strict';

// Looks ahead with the learned demand: when every account would be out at once and for how
// long, which account to use now to wait less, and which pauses keep each wait under the
// user's limit. A pause does not give usage back (the 5h window resets at a fixed time); it
// lets the user choose when to wait, in pieces no longer than the limit, instead of being
// cut off mid-task for longer.
const { advise, sessionCost, hitLimitUnchecked } = require('./advisor');
const { demandModel } = require('./demand');
const { effectivePct, outStatus, fmtMinutes } = require('./usage');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const STEP_MIN = 5;
const HORIZON = WEEK;
const WORK_RATE = 1; // % of a 5h window per hour; below that nobody is working
const DEFAULT_COST = 13; // % of the week a full 5h session costs on Pro, until learned
const MIN_WORK_MIN = 15; // pauses closer together than this are no plan
const MAX_PAUSE_SHARE = 1 / 3; // pausing more of the working time than this is no plan either
const MAX_SUGGESTED_WAIT_MIN = 3 * 60;
const SOON = 2 * HOUR;
const PLAN_PERCENTILE = 0.8; // plan for the worst of every 5 possible weeks

// Each account as the simulation sees it. Usage is in % of a 5h window.
function stateOf(data, now) {
  return data.accounts.map((acc, i) => {
    const u = acc.usage || {};
    const weekFull = (100 / (sessionCost(acc, data.accounts) || DEFAULT_COST)) * 100;
    const five = effectivePct(u.fiveHour, now) || 0;
    const week = effectivePct(u.sevenDay, now) || 0;
    const s = {
      id: acc.id,
      i,
      dead: !acc.credentials || !!acc.needsLogin,
      heldUntil: 0,
      five,
      fiveResets: u.fiveHour && u.fiveHour.resetsAt > now ? u.fiveHour.resetsAt : null,
      weekLeft: (Math.max(0, 100 - week) / 100) * weekFull,
      weekFull,
      weekResets: u.sevenDay && u.sevenDay.resetsAt > now ? u.sevenDay.resetsAt : null,
    };
    const st = outStatus(acc.usage, now);
    // Out for a reason the two windows don't show (another limit, or a limit Claude Code just
    // reported): held until it says, or for a whole 5h window when unknown.
    if (hitLimitUnchecked(acc, now)) s.heldUntil = s.fiveResets || now + 5 * HOUR;
    else if (st.out && five < 100 && week < 100) s.heldUntil = st.until || Infinity;
    return s;
  });
}

const usable = (s, t) => !s.dead && t >= s.heldUntil && s.five < 100 && s.weekLeft > 0;

// Same order as advise(): nearly empty last, earliest weekly reset first.
function choose(states, t) {
  let best = null;
  const key = (s) => [s.weekLeft < 0.05 * s.weekFull || s.five > 95 ? 1 : 0, s.weekResets ?? Infinity, s.five, s.i];
  for (const s of states) {
    if (!usable(s, t)) continue;
    if (!best) {
      best = s;
      continue;
    }
    const a = key(s);
    const b = key(best);
    for (let k = 0; k < a.length; k++) {
      if (a[k] === b[k]) continue;
      if (a[k] < b[k]) best = s;
      break;
    }
  }
  return best;
}

// Steps through the horizon: the user works when the expected rate says so, on `first`
// until it runs out, then on the next one. Waits are the working minutes with no account.
function simulate(states0, now, rates, { first = null } = {}) {
  const states = states0.map((s) => ({ ...s }));
  let cur = (first && states.find((s) => s.id === first)) || null;
  const episodes = [];
  let ep = null;
  let served = 0;
  let wasted = 0;
  for (let k = 0; k < rates.length; k++) {
    const t = now + k * STEP_MIN * MINUTE;
    for (const s of states) {
      if (s.fiveResets && t >= s.fiveResets) {
        s.five = 0;
        s.fiveResets = null;
      }
      if (s.weekResets && t >= s.weekResets) {
        wasted += Math.max(0, s.weekLeft);
        s.weekLeft = s.weekFull;
        s.weekResets += WEEK;
      }
    }
    if (rates[k] < WORK_RATE) continue;
    if (!cur || !usable(cur, t)) cur = choose(states, t);
    if (!cur) {
      if (!ep) ep = { start: t, end: null, minutes: 0 };
      ep.minutes += STEP_MIN;
      continue;
    }
    if (ep) {
      ep.end = t;
      ep.servedBefore = served;
      episodes.push(ep);
      ep = null;
    }
    if (cur.fiveResets == null) cur.fiveResets = t + 5 * HOUR; // first use opens the window
    const used = (rates[k] * STEP_MIN) / 60;
    cur.five += used;
    cur.weekLeft -= used;
    served += STEP_MIN;
  }
  if (ep) {
    ep.servedBefore = served;
    episodes.push(ep); // still waiting when the horizon ends
  }
  const waited = episodes.reduce((sum, e) => sum + e.minutes, 0);
  return { episodes, served, waited, wasted };
}

const RANK = { ok: 0, pace: 1, short: 2 };

function plan(data, now = Date.now(), { maxWaitMin = 20, advice = null, adviceOptions = {} } = {}) {
  advice = advice || advise(data, now, adviceOptions);
  const model = demandModel(data.demand, now, { stepMin: STEP_MIN, horizonMs: HORIZON });
  const states = stateOf(data, now);
  const M = maxWaitMin;
  const base = advice.best ? advice.best.id : null;

  // Every possible week, on the recommended account. The plan follows a bad but plausible
  // one (PLAN_PERCENTILE), so a heavy day is covered, not just an average one.
  const runs = model.scenarios
    .map((rates) => {
      const run = simulate(states, now, rates, { first: base });
      return { rates, run, a: assess(run, now, M) };
    })
    .sort((x, y) => RANK[x.a.verdict] - RANK[y.a.verdict] || x.run.waited - y.run.waited);
  const planned = runs[Math.floor(PLAN_PERCENTILE * (runs.length - 1))];
  const typical = runs[Math.floor(0.5 * (runs.length - 1))];
  const rates = planned.rates;

  // Which account to start on: the recommended one (least usage thrown away) unless another
  // makes the outlook better or saves real waiting soon. Days ahead the forecast is too rough
  // to overrule it, and pauses even out the rest.
  const soonWait = (r) => r.episodes.filter((e) => e.start < now + DAY).reduce((sum, e) => sum + e.minutes, 0);
  const judge = (first) => {
    const run = simulate(states, now, rates, { first });
    return { first, run, a: assess(run, now, M), soon: soonWait(run) };
  };
  const baseJudged = { first: base, run: planned.run, a: planned.a, soon: soonWait(planned.run) };
  let best = baseJudged;
  for (const s of states) {
    if (s.id === base || !usable(s, now)) continue;
    const j = judge(s.id);
    const better = RANK[j.a.verdict] < RANK[best.a.verdict] || (j.a.verdict === best.a.verdict && j.soon <= best.soon - 15);
    if (better) best = j;
  }
  let why = null;
  if (best !== baseJudged) {
    if (best.a.verdict === 'ok') why = baseJudged.a.verdict === 'pace' ? 'com ela não precisa de pausas' : 'com ela as contas aguentam seu ritmo';
    else if (best.a.verdict === 'pace' && baseJudged.a.verdict === 'short') why = 'com ela as contas aguentam com pausas';
    else why = `evita ~${fmtMinutes(baseJudged.soon - best.soon)} de espera nas próximas 24h`;
  }
  const pick = best.first;

  const out = {
    learned: model.learned,
    daysObserved: model.daysObserved,
    activeNow: model.activeNow,
    recent: model.recent,
    maxWaitMin: M,
    pick,
    why,
    ...best.a,
    // Share of the possible weeks with no wait over the limit, even without pauses.
    okShare: runs.filter((r) => r.a.verdict === 'ok').length / runs.length,
    scenarios: runs.length,
    // The heads-up before everything runs out follows the typical week, not the bad one.
    nextStop: typical.a.nextStop,
  };
  if (out.verdict === 'ok' && !model.learned && !model.activeNow) out.verdict = 'learning';
  // How many more accounts like these would make it work.
  if (out.verdict === 'short') {
    const weekFull = states.length ? states[0].weekFull : (100 / DEFAULT_COST) * 100;
    const fresh = (k) => ({ id: `+${k}`, i: states.length + k, dead: false, heldUntil: 0, five: 0, fiveResets: null, weekLeft: weekFull, weekFull, weekResets: null });
    for (let k = 1; k <= 3 && !out.short.extraAccounts; k++) {
      const more = [...states, ...Array.from({ length: k }, (_, j) => fresh(j + 1))];
      if (assess(simulate(more, now, rates, { first: pick }), now, M).verdict !== 'short') out.short.extraAccounts = k;
    }
  }
  return out;
}

// What a simulated run means for the user. Waiting can be spread into pauses no longer than
// the limit: pausing a share f of the working time until the last long wait removes it.
function assess(run, now, M) {
  const eps = run.episodes;
  const over = eps.filter((e) => e.minutes > M);
  const longest = eps.reduce((a, e) => (!a || e.minutes > a.minutes ? e : a), null);
  const out = {
    episodes: eps,
    longest,
    nextStop: eps.length && eps[0].start - now <= SOON ? eps[0] : null,
    // Waits of up to this long need no pauses at all (null when that would be absurd).
    noPauseWaitMin: longest && longest.minutes <= MAX_SUGGESTED_WAIT_MIN ? Math.ceil(longest.minutes / 5) * 5 : null,
    verdict: 'ok',
    pace: null,
    short: null,
  };
  if (!over.length) return out;
  const last = over[over.length - 1];
  const waited = eps.filter((e) => e.start <= last.start).reduce((sum, e) => sum + e.minutes, 0);
  const f = waited / (waited + last.servedBefore);
  let pauseMin = Math.max(1, Math.ceil(f * 60));
  let workMin = 60 - pauseMin;
  if (pauseMin > M) {
    pauseMin = M;
    workMin = Math.floor((M * (1 - f)) / f);
  }
  if (f <= MAX_PAUSE_SHARE && workMin >= MIN_WORK_MIN) {
    out.verdict = 'pace';
    out.pace = { pauseMin, workMin, share: f };
  } else {
    out.verdict = 'short';
    out.short = { minutes: waited, until: last.end || now + HORIZON, share: f };
  }
  return out;
}

// advise() with the plan folded in: the plan's account wins when it saves waiting.
function adviseWithPlan(data, now = Date.now(), { maxWaitMin = 20, ...adviceOptions } = {}) {
  const advice = advise(data, now, adviceOptions);
  const p = plan(data, now, { maxWaitMin, advice });
  advice.plan = p;
  if (p.pick && advice.best && p.pick !== advice.best.id) {
    const x = advice.byId.get(p.pick);
    x.planReason = p.why;
    advice.best = x;
    if (!x.active) advice.next = x;
  }
  return advice;
}

module.exports = { plan, adviseWithPlan, simulate, MIN_WORK_MIN };
