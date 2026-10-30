'use strict';

const { outStatus, effectivePct, fmtClock, fmtIn } = require('./usage');

const HOUR = 3600 * 1000;
const MIN_LEARNED = 60; // % of a 5h session observed before the learned cost is trusted
const STICKY_MS = 3 * HOUR; // don't suggest a switch over a reset only this much earlier

// Learns how much of the weekly limit a full 5h session costs, from two readings taken in the
// same 5h window and the same week. The sums telescope, so integer rounding washes out.
function learnSessionCost(acc, prev, next) {
  const f0 = prev && prev.fiveHour;
  const f1 = next && next.fiveHour;
  const w0 = prev && prev.sevenDay;
  const w1 = next && next.sevenDay;
  if (!f0 || !f1 || !w0 || !w1) return;
  const same = (a, b) => a != null && b != null && Math.abs(a - b) < 10 * 60 * 1000;
  if (!same(f0.resetsAt, f1.resetsAt) || !same(w0.resetsAt, w1.resetsAt)) return;
  const dFive = f1.pct - f0.pct;
  const dWeek = w1.pct - w0.pct;
  if (dFive <= 0 || dWeek < 0) return;
  const c = acc.calib || { five: 0, week: 0 };
  c.five += dFive;
  c.week += dWeek;
  if (c.five > 400) {
    // Halve the history so a plan change shows up within a couple of sessions.
    c.five /= 2;
    c.week /= 2;
  }
  acc.calib = c;
}

const costOf = (five, week) => (five >= MIN_LEARNED && week > 0 ? (week / five) * 100 : null);

// % of the week one full 5h session costs: the account's own figure once it has enough data,
// otherwise the figure pooled over all accounts, otherwise unknown.
function sessionCost(acc, accounts) {
  const own = acc.calib && costOf(acc.calib.five, acc.calib.week);
  if (own) return own;
  let five = 0;
  let week = 0;
  for (const a of accounts) {
    if (a.calib) {
      five += a.calib.five;
      week += a.calib.week;
    }
  }
  return costOf(five, week);
}

// Claude Code just reported this account at its limit and its usage hasn't been fetched since.
const hitLimitUnchecked = (acc, now) =>
  !!acc.limitHitAt && now - acc.limitHitAt < 5 * HOUR && !(acc.usage && acc.usage.fetchedAt > acc.limitHitAt);

// Ranks accounts by which to use now: earliest weekly reset first. Whatever is left on that
// account is thrown away at its reset, while the others keep their usage for later.
function advise(data, now = Date.now(), { burnWindowHours = 24, minBurnPct = 10 } = {}) {
  const n = data.accounts.length;
  const cur = data.accounts.findIndex((a) => a.id === data.activeId);
  const items = data.accounts.map((acc, i) => {
    const u = acc.usage || {};
    const five = effectivePct(u.fiveHour, now) || 0;
    const week = effectivePct(u.sevenDay, now) || 0;
    const left = Math.max(0, 100 - week);
    const resetsAt = u.sevenDay && u.sevenDay.resetsAt > now ? u.sevenDay.resetsAt : null;
    const hours = resetsAt ? (resetsAt - now) / HOUR : null;
    const cost = sessionCost(acc, data.accounts);
    const sessions = cost ? left / cost : null;
    const available = !!acc.credentials && !acc.needsLogin && !outStatus(acc.usage, now).out && !hitLimitUnchecked(acc, now);
    // Leftover the reset would throw away: the week renews soon, or more is left than you
    // could spend before then even using this account half of the time.
    const burn =
      available && hours != null && left >= minBurnPct && (hours <= burnWindowHours || (sessions != null && sessions * 5 * 2 >= hours));
    return {
      acc,
      id: acc.id,
      active: acc.id === data.activeId,
      available,
      five,
      week,
      left,
      resetsAt,
      sessions,
      burn,
      nearlyEmpty: left < 5 || five > 95,
      order: cur < 0 ? i : (i - cur + n) % n,
    };
  });

  // NaN (two unknown resets) falls through to the next criterion.
  const ranked = items
    .filter((x) => x.available)
    .sort(
      (x, y) =>
        x.nearlyEmpty - y.nearlyEmpty ||
        (x.resetsAt ?? Infinity) - (y.resetsAt ?? Infinity) ||
        x.five - y.five ||
        x.order - y.order,
    );

  let best = ranked[0] || null;
  const active = items.find((x) => x.active);
  if (best && active && active !== best && active.available && !active.nearlyEmpty) {
    const a = active.resetsAt ?? Infinity;
    const b = best.resetsAt ?? Infinity;
    if (a === b || a - b <= STICKY_MS) best = active;
  }
  return {
    items,
    byId: new Map(items.map((x) => [x.id, x])),
    best,
    next: ranked.find((x) => !x.active) || null,
  };
}

// The out account that comes back first, with its time.
function soonestBack(data, now = Date.now()) {
  let first = null;
  for (const a of data.accounts) {
    const st = outStatus(a.usage, now);
    if (st.out && st.until && (!first || st.until < first.until)) first = { account: a, until: st.until };
  }
  return first;
}

function fmtSessions(s) {
  if (s < 1) return 'menos de 1 sessão de 5h';
  const r = Math.round(s);
  return `${r} ${r === 1 ? 'sessão' : 'sessões'} de 5h`;
}

// Why this account is the one to use, as short lines (the side bar shows one per row).
function reasonLines(x, now = Date.now()) {
  if (!x) return [];
  if (x.planReason) return [x.planReason, 'pela previsão do seu ritmo'];
  const when = x.resetsAt ? `${fmtClock(x.resetsAt, now)} (${fmtIn(x.resetsAt, now)})` : '';
  if (x.burn) {
    const sessions = x.sessions != null ? ` (≈ ${fmtSessions(x.sessions)})` : '';
    return [`sobram ${Math.round(x.left)}% da semana${sessions}`, `renova ${when}`, 'use antes que perca'];
  }
  if (x.resetsAt) return [`a semana dela renova ${when}`, 'as que renovam depois ficam guardadas'];
  return ['nenhuma conta tem uso prestes a vencer'];
}

const reason = (x, now = Date.now()) => reasonLines(x, now).join(', ');

module.exports = { advise, reason, reasonLines, soonestBack, learnSessionCost, sessionCost, hitLimitUnchecked, fmtSessions };
