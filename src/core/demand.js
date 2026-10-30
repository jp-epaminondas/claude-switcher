'use strict';

// Learns how the user spends usage, in "% of a 5h window" (all accounts are assumed to be on
// the same plan, so that unit means the same everywhere). Days are irregular (a full day of
// work, then almost nothing, with no weekday rule), so instead of an average it keeps the
// real days, hour by hour, and forecasts by drawing from them:
// - days: the last KEEP_DAYS days, usage and observed time per hour;
// - recent: consumption per hour right now, with about half an hour of memory;
// - workStart / lastUseAt: the current stretch of continuous use, for pause reminders.
const HOUR = 3600 * 1000;
const MINUTE = 60 * 1000;
const DAY = 24 * HOUR;
const MAX_GAP = 12 * HOUR; // longer gaps between readings are not attributed to any hour
const IDLE_GAP = 10 * MINUTE; // this long without consumption ends a stretch of use
const RECENT_TAU_H = 0.5;
const KEEP_DAYS = 35;
const MIN_DAY_OBS_H = 6; // days observed less than this (VS Code closed) are left out
const MIN_DAYS = 3; // full days needed before forecasting the week
const HALF_LIFE_DAYS = 14; // recent days weigh more, so a change of habit shows up

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const sum = (arr) => arr.reduce((s, x) => s + x, 0);

function dayOf(dm, t) {
  const key = dayKey(t);
  let day = dm.days.find((x) => x.d === key);
  if (!day) {
    day = { d: key, use: new Array(24).fill(0), obs: new Array(24).fill(0) };
    dm.days.push(day);
  }
  return day;
}

// Adds `amount` spread evenly over [from, to] into the hours it covers.
function spread(dm, field, from, to, amount) {
  if (!(to > from) || !amount) return;
  const perMs = amount / (to - from);
  for (let t = from; t < to; ) {
    const d = new Date(t);
    d.setMinutes(60, 0, 0); // start of the next hour
    const end = Math.min(to, d.getTime());
    dayOf(dm, t)[field][new Date(t).getHours()] += perMs * (end - t);
    t = end;
  }
}

function emptyDemand() {
  return { days: [], at: null, last: {}, recent: 0, recentAt: null, lastUseAt: null, workStart: null };
}

// Called with each new usage reading of an account, inside store.update(). Only readings of
// the account in use advance the observed time: that is the one polled every few minutes.
function learnDemand(data, acc, next, isActive) {
  const f = next && next.fiveHour;
  if (!f || f.pct == null) return;
  if (!data.demand || !Array.isArray(data.demand.days)) data.demand = emptyDemand();
  const dm = data.demand;
  const t = next.fetchedAt;
  const p = dm.last[acc.id];
  let used = 0;
  if (p && t > p.at && t - p.at <= MAX_GAP) {
    const sameWindow = p.resetsAt != null && f.resetsAt != null && Math.abs(p.resetsAt - f.resetsAt) < 10 * MINUTE;
    // A new window started since: everything in it was used after the previous reading.
    used = sameWindow ? Math.max(0, f.pct - p.pct) : f.pct;
    spread(dm, 'use', p.at, t, used);
  }
  dm.last[acc.id] = { at: t, pct: f.pct, resetsAt: f.resetsAt };

  if (isActive) {
    if (dm.at && t > dm.at && t - dm.at <= MAX_GAP) spread(dm, 'obs', dm.at, t, (t - dm.at) / HOUR);
    if (p && t > p.at && t - p.at <= MAX_GAP) {
      const k = 1 - Math.exp(-(t - p.at) / HOUR / RECENT_TAU_H);
      dm.recent += k * (used / ((t - p.at) / HOUR) - dm.recent);
      dm.recentAt = t;
      if (used > 0) {
        if (!dm.lastUseAt || p.at - dm.lastUseAt > IDLE_GAP) dm.workStart = p.at;
        dm.lastUseAt = t;
      }
    }
    dm.at = Math.max(dm.at || 0, t);
  }
  const round = (x) => Math.round(x * 1e4) / 1e4; // keeps accounts.json readable
  dm.days.sort((a, b) => (a.d < b.d ? -1 : 1));
  if (dm.days.length > KEEP_DAYS) dm.days.splice(0, dm.days.length - KEEP_DAYS);
  for (const day of dm.days) {
    day.use = day.use.map(round);
    day.obs = day.obs.map(round);
  }
  dm.recent = round(dm.recent);
}

// Small seeded generator, so the forecast holds still between refreshes.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function draw(weights, total, rand) {
  let r = rand() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

// Usage up to `hour` (fractional) of a day.
const usedBy = (day, hour) => {
  const h = Math.floor(hour);
  return sum(day.use.slice(0, h)) + (h < 24 ? day.use[h] * (hour - h) : 0);
};

// Possible futures, as consumption per hour for each step from now on. Every future day is a
// real past day drawn at random (recent ones more often); the rest of today follows past days
// that had gone like today so far. The first hour leans on the current pace. Without enough
// days, a single future: the current pace for two hours.
function demandModel(dm, now, { count = 40, stepMin = 5, horizonMs = 7 * DAY } = {}) {
  const today = dayKey(now);
  const pool = dm && Array.isArray(dm.days) ? dm.days.filter((x) => x.d !== today && sum(x.obs) >= MIN_DAY_OBS_H) : [];
  const learned = pool.length >= MIN_DAYS;
  const activeNow = !!dm && dm.lastUseAt != null && now - dm.lastUseAt <= IDLE_GAP;
  const recent = activeNow && dm.recentAt ? dm.recent : 0;
  const steps = Math.round(horizonMs / (stepMin * MINUTE));

  // Calendar of the steps: which day from now (0 = today) and which hour.
  const dayIdx = new Int16Array(steps);
  const hourOf = new Int8Array(steps);
  const lean = new Float32Array(steps);
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  for (let k = 0; k < steps; k++) {
    const t = now + k * stepMin * MINUTE;
    const d = new Date(t);
    hourOf[k] = d.getHours();
    d.setHours(0, 0, 0, 0);
    dayIdx[k] = Math.round((d.getTime() - midnight.getTime()) / DAY);
    lean[k] = recent ? Math.exp(-(t - now) / HOUR) : 0;
  }

  const scenarios = [];
  if (!learned) {
    const rates = new Float32Array(steps);
    for (let k = 0; k < steps; k++) if (k * stepMin * MINUTE < 2 * HOUR) rates[k] = recent;
    scenarios.push(rates);
  } else {
    const ageOf = (x) => (now - new Date(`${x.d}T12:00:00`).getTime()) / DAY;
    const weights = pool.map((x) => 0.5 ** (ageOf(x) / HALF_LIFE_DAYS));
    const total = sum(weights);
    // Today so far, against the same part of each past day.
    const nowHour = new Date(now).getHours() + new Date(now).getMinutes() / 60;
    const todaySoFar = dm.days.find((x) => x.d === today);
    const soFar = todaySoFar ? usedBy(todaySoFar, nowHour) : 0;
    const typical = sum(pool.map((x) => sum(x.use))) / pool.length;
    const sigma = Math.max(10, 0.3 * typical);
    const likeToday = pool.map((x, i) => weights[i] * Math.exp(-(((usedBy(x, nowHour) - soFar) / sigma) ** 2)));
    const likeTotal = sum(likeToday) || total;
    const rand = rng(Math.floor(now / HOUR));
    const days = Math.max(...dayIdx) + 1;
    for (let s = 0; s < count; s++) {
      const picked = [];
      for (let d = 0; d < days; d++) picked.push(pool[d === 0 ? draw(likeToday, likeTotal, rand) : draw(weights, total, rand)]);
      const rates = new Float32Array(steps);
      for (let k = 0; k < steps; k++) {
        const base = picked[dayIdx[k]].use[hourOf[k]];
        rates[k] = lean[k] * recent + (1 - lean[k]) * base;
      }
      scenarios.push(rates);
    }
  }
  return { learned, daysObserved: pool.length, activeNow, recent, scenarios };
}

// How long the user has been using Claude without a break (0 when idle).
function workedFor(dm, now) {
  if (!dm || !dm.workStart || !dm.lastUseAt || now - dm.lastUseAt > IDLE_GAP) return 0;
  return now - dm.workStart;
}

module.exports = { learnDemand, demandModel, workedFor, dayKey, MIN_DAYS, IDLE_GAP };
