'use strict';

const HOUR = 3600 * 1000;

const parseTime = (s) => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : null;
};

// Keeps only what the switcher needs from /api/oauth/usage (or Claude Code's cached copy).
function normalizeUsage(raw, fetchedAt = Date.now()) {
  const win = (w) => (w && typeof w.utilization === 'number' ? { pct: w.utilization, resetsAt: parseTime(w.resets_at) } : null);
  // Scoped limits (e.g. one model only) don't stop the account as a whole.
  const limits = Array.isArray(raw && raw.limits)
    ? raw.limits
        .filter((l) => l && !l.scope && typeof l.percent === 'number')
        .map((l) => ({ kind: l.kind, pct: l.percent, resetsAt: parseTime(l.resets_at) }))
    : [];
  return { fetchedAt, fiveHour: win(raw && raw.five_hour), sevenDay: win(raw && raw.seven_day), limits };
}

// Usage of a window right now: once its reset time has passed it is back to zero, even if
// we haven't fetched since.
function effectivePct(w, now = Date.now()) {
  if (!w || w.pct == null) return null;
  if (w.resetsAt && w.resetsAt <= now) return 0;
  return w.pct;
}

// An account is out while any account-wide window sits at 100%; `until` is when the last of
// them resets (null when the API didn't say).
function outStatus(usage, now = Date.now()) {
  if (!usage) return { out: false };
  const windows = [usage.fiveHour, usage.sevenDay, ...(usage.limits || [])].filter(Boolean);
  let out = false;
  let unknown = false;
  let until = 0;
  for (const w of windows) {
    if (w.pct == null || w.pct < 100) continue;
    if (w.resetsAt == null) {
      if (now - usage.fetchedAt < 5 * HOUR) out = unknown = true;
      continue;
    }
    if (w.resetsAt <= now) continue;
    out = true;
    until = Math.max(until, w.resetsAt);
  }
  return out ? { out: true, until: unknown ? null : until } : { out: false };
}

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const pad = (n) => String(n).padStart(2, '0');

// "15:30", "amanhã 09:00", "sex 22:59" or "03/11 22:59".
function fmtClock(ms, now = Date.now()) {
  const d = new Date(ms);
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = new Date(now);
  if (d.toDateString() === day.toDateString()) return hhmm;
  day.setDate(day.getDate() + 1);
  if (d.toDateString() === day.toDateString()) return `amanhã ${hhmm}`;
  if (ms - now < 6 * 24 * HOUR) return `${WEEKDAYS[d.getDay()]} ${hhmm}`;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${hhmm}`;
}

// "em 45min", "em 2h05", "em 3d 4h".
function fmtIn(ms, now = Date.now()) {
  const min = Math.max(0, Math.round((ms - now) / 60000));
  return min < 1 ? 'agora' : `em ${fmtMinutes(min)}`;
}

// "45min", "2h05", "3d 4h".
function fmtMinutes(total) {
  let min = Math.max(0, Math.round(total));
  const d = Math.floor(min / 1440);
  min -= d * 1440;
  const h = Math.floor(min / 60);
  min -= h * 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h${min ? pad(min) : ''}`;
  return `${min}min`;
}

const fmtPct = (p) => (p == null ? '–' : `${Math.round(p)}%`);

module.exports = { normalizeUsage, effectivePct, outStatus, fmtClock, fmtIn, fmtMinutes, fmtPct };
