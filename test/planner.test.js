'use strict';

// Learning the user's pace and planning around it, with synthetic accounts and demand.
const test = require('node:test');
const assert = require('node:assert/strict');
const { HOUR, acct, dataOf } = require('./helpers');
const { learnDemand, demandModel, workedFor, dayKey } = require('../src/core/demand');
const { plan, adviseWithPlan } = require('../src/core/planner');
const { Switcher } = require('../src/core/switcher');

const MINUTE = 60 * 1000;
const DAY = 24 * HOUR;
const monday9 = () => new Date(2026, 9, 26, 9, 0, 0, 0).getTime();

// Past days, fully observed, each working `rate(i)` % of a 5h window per hour from 9h to 21h.
function history(now, rate, days = 14) {
  const out = [];
  for (let i = days; i >= 1; i--) {
    const r = typeof rate === 'function' ? rate(i) : rate;
    const use = new Array(24).fill(0);
    for (let h = 9; h < 21; h++) use[h] = r;
    out.push({ d: dayKey(now - i * DAY), use, obs: new Array(24).fill(1) });
  }
  return { days: out, at: null, last: {}, recent: 0, recentAt: null, lastUseAt: null, workStart: null };
}

// Accounts whose weekly limit never binds, so only the 5h windows matter.
const roomy = (a) => ((a.calib = { five: 1000, week: 10 }), a);
const two = (now) => dataOf(now, roomy(acct('A', { active: true }, now)), roomy(acct('B', {}, now)));

test('learns the pace from readings of the account in use, day by day', () => {
  const now = monday9();
  const a = acct('A', {}, now);
  const data = dataOf(now, a);
  data.activeId = 'A';
  const reading = (t, pct) => ({ fetchedAt: t, fiveHour: { pct, resetsAt: now + 5 * HOUR }, sevenDay: { pct: 0, resetsAt: null }, limits: [] });
  for (let i = 0; i <= 10; i++) learnDemand(data, a, reading(now + i * 3 * MINUTE, i * 2), true); // 2% every 3 min
  const dm = data.demand;
  const today = dm.days.find((x) => x.d === dayKey(now));
  const sum = (arr) => arr.reduce((s, x) => s + x, 0);
  assert.ok(Math.abs(sum(today.use) - 20) < 0.01, `used ${sum(today.use)}`);
  assert.ok(Math.abs(sum(today.obs) - 0.5) < 0.01, `observed ${sum(today.obs)}`);
  assert.ok(Math.abs(today.use[9] - 20) < 0.01, 'all in the 9h hour');
  assert.ok(dm.recent > 25 && dm.recent <= 40, `recent ${dm.recent}`);
  assert.equal(workedFor(dm, now + 30 * MINUTE), 30 * MINUTE);
  assert.equal(workedFor(dm, now + 45 * MINUTE), 0, 'a break ends the stretch');

  // The window resets: what shows in the new one was all used since.
  learnDemand(data, a, { ...reading(now + 33 * MINUTE, 3), fiveHour: { pct: 3, resetsAt: now + 6 * HOUR } }, true);
  assert.ok(Math.abs(sum(today.use) - 23) < 0.01);

  const m = demandModel(dm, now + 33 * MINUTE);
  assert.equal(m.learned, false, 'today alone is not a history');
  assert.equal(m.scenarios.length, 1);
  assert.ok(m.scenarios[0][1] > 0, 'the current pace still counts');
});

test('the rest of today follows the past days that went like today', () => {
  const now = new Date(2026, 9, 26, 14, 0, 0, 0).getTime();
  const dm = history(now, (i) => (i % 2 ? 60 : 2)); // heavy and light days, mixed
  const restOfToday = (soFarRate) => {
    const d = { ...dm, days: [...dm.days] };
    const use = new Array(24).fill(0);
    for (let h = 9; h < 14; h++) use[h] = soFarRate;
    d.days.push({ d: dayKey(now), use, obs: new Array(24).fill(1) });
    const m = demandModel(d, now);
    const at16 = (2 * 60) / 5; // step at 16:00
    return m.scenarios.reduce((s, r) => s + r[at16], 0) / m.scenarios.length;
  };
  assert.ok(restOfToday(60) > 50, `a heavy morning: ${restOfToday(60)}`);
  assert.ok(restOfToday(2) < 10, `a light morning: ${restOfToday(2)}`);
});

test('irregular days are planned for the heavy ones, not the average', () => {
  const now = monday9();
  const steady = two(now);
  steady.demand = history(now, 32); // about the average of the mix below
  assert.equal(plan(steady, now, { maxWaitMin: 20 }).verdict, 'ok');

  const mixed = two(now);
  mixed.demand = history(now, (i) => (i % 2 ? 60 : 4));
  const p = plan(mixed, now, { maxWaitMin: 20 });
  assert.notEqual(p.verdict, 'ok', 'the heavy days need pauses');
  assert.ok(p.okShare < 0.5, `ok in ${p.okShare} of the weeks`);
});

test('enough accounts: no waiting', () => {
  const now = monday9();
  const data = two(now);
  data.demand = history(now, 30); // 150% per 5h against 200% of capacity
  const p = plan(data, now, { maxWaitMin: 20 });
  assert.equal(p.verdict, 'ok');
  assert.deepEqual(p.episodes, []);
  assert.equal(p.okShare, 1);
});

test('a little short: pauses spread the wait under the limit', () => {
  const now = monday9();
  const data = two(now);
  data.demand = history(now, 50); // 250% per 5h against 200%: about a fifth of the time waiting
  const p = plan(data, now, { maxWaitMin: 20 });
  assert.equal(p.verdict, 'pace');
  assert.ok(p.longest.minutes > 20, `without pauses it waits ${p.longest.minutes} min at once`);
  assert.ok(p.pace.pauseMin >= 10 && p.pace.pauseMin <= 20, JSON.stringify(p.pace));
  assert.ok(p.pace.workMin >= 30, JSON.stringify(p.pace));
  assert.equal(p.noPauseWaitMin, 60, 'or accept waits of an hour');
  assert.equal(plan(data, now, { maxWaitMin: 60 }).verdict, 'ok');
});

test('far too short: asks for another account', () => {
  const now = monday9();
  const data = dataOf(now, roomy(acct('A', { active: true }, now)));
  data.demand = history(now, 100); // an hour of work per 5h window
  const p = plan(data, now, { maxWaitMin: 20 });
  assert.equal(p.verdict, 'short');
  assert.ok(p.short.share > 0.5, 'would be stopped most of the time');
  assert.equal(p.short.extraAccounts, 2);
  assert.equal(p.noPauseWaitMin, null, 'waits of 4h are no suggestion');
});

test('the weekly limit counts too', () => {
  const now = monday9();
  // Default cost (13% of the week per 5h session): 5 sessions' worth left on one account.
  const data = dataOf(now, acct('A', { active: true, week: 35, weekIn: 6 * 24 }, now));
  data.demand = history(now, 20);
  assert.equal(plan(data, now, { maxWaitMin: 20 }).verdict, 'short', 'runs out of the week days before it renews');
});

test('no history and idle: still learning', () => {
  const now = monday9();
  const data = dataOf(now, acct('A', { active: true }, now));
  assert.equal(plan(data, now).verdict, 'learning');
  data.demand = history(now, 30, 2);
  assert.equal(plan(data, now).verdict, 'learning', 'two days are not enough');
});

test('reminders: a pause after enough work, not twice in a row', async () => {
  const now = Date.now();
  const data = two(now);
  data.demand = history(now, 50);
  data.demand.workStart = now - 2 * HOUR;
  data.demand.lastUseAt = now - MINUTE;
  data.demand.recent = 50;
  data.demand.recentAt = now - MINUTE;
  const store = { update: async (fn) => fn(data), load: () => data };
  const sw = new Switcher({ paths: {}, store, switcherDir: '', rank: (d, t) => adviseWithPlan(d, t, { maxWaitMin: 20 }) });
  const types = (evs) => evs.map((e) => e.type).filter((t) => t !== 'out' && t !== 'back' && t !== 'burn');

  const first = types(await sw.collectEvents());
  assert.ok(first.includes('pause') || first.includes('stopSoon'), JSON.stringify(first));
  assert.deepEqual(types(await sw.collectEvents()), [], 'not twice in a row');
});
