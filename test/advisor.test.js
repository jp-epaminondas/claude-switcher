'use strict';

// Which account to use: ranking, burn flag, learned session cost.
const test = require('node:test');
const assert = require('node:assert/strict');
const { advise, learnSessionCost } = require('../src/core/advisor');
const { HOUR, acct, dataOf } = require('./helpers');

test('earliest weekly reset first, burn flag, sticky active', () => {
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

test('learns the cost of a 5h session and flags burn early when needed', () => {
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
