'use strict';

// How an account is described, shared by the side bar, the menu and the status bar.
const { outStatus, effectivePct, fmtClock, fmtIn, fmtPct } = require('../core/usage');
const { reason, soonestBack } = require('../core/advisor');

function accountState(a, data, now) {
  const active = a.id === data.activeId;
  const st = outStatus(a.usage, now, data.outAt);
  if (a.needsLogin) return { active, icon: 'warning', color: 'charts.yellow', situation: 'precisa de login de novo' };
  if (st.out) {
    const situation = st.until ? `esgotada · volta ${fmtClock(st.until, now)} (${fmtIn(st.until, now)})` : 'esgotada';
    return { active, out: true, icon: 'error', color: 'charts.red', situation };
  }
  if (active) return { active, icon: 'pass-filled', color: 'charts.green', situation: 'em uso' };
  return { active, icon: 'circle-large-outline', situation: 'disponível' };
}

function usageOf(a, now) {
  const u = a.usage;
  if (!u) return null;
  return {
    five: effectivePct(u.fiveHour, now),
    fiveResets: u.fiveHour && u.fiveHour.resetsAt > now ? u.fiveHour.resetsAt : null,
    week: effectivePct(u.sevenDay, now),
    weekResets: u.sevenDay && u.sevenDay.resetsAt > now ? u.sevenDay.resetsAt : null,
    fetchedAt: u.fetchedAt,
  };
}

function usageSummary(a, now) {
  const u = usageOf(a, now);
  if (!u) return a.usageError ? 'uso indisponível' : 'uso ainda não consultado';
  const parts = [];
  if (u.five != null) parts.push(`5h ${fmtPct(u.five)}${u.five > 0 && u.five < 100 && u.fiveResets ? ` (zera ${fmtClock(u.fiveResets, now)})` : ''}`);
  if (u.week != null) parts.push(`semana ${fmtPct(u.week)}`);
  parts.push(`atualizado ${fmtClock(u.fetchedAt, now)}`);
  return parts.join(' · ');
}

// 'best' for the recommended account, 'burn' for one about to lose usage, else null.
function flagOf(a, advice) {
  if (advice.best && advice.best.id === a.id) return 'best';
  return advice.byId.get(a.id).burn ? 'burn' : null;
}

// One-line answer to "which account should I use?".
function headline(data, advice, now) {
  if (!data.accounts.length) return undefined;
  const best = advice.best;
  if (best) return `⭐ ${best.active ? 'Continue na' : 'Use a'} ${best.acc.label}: ${reason(best, now)}.`;
  const soon = soonestBack(data, now);
  const when = soon ? ` A primeira a voltar é a ${soon.account.label}, ${fmtClock(soon.until, now)} (${fmtIn(soon.until, now)}).` : '';
  return `Nenhuma conta disponível agora.${when}`;
}

const escapeMd = (s) => String(s).replace(/[|\\`*_[\]<>]/g, '\\$&');

// Usage as a bar of blocks: used in red, what is left in green, in the theme's chart colors.
// Only some usage reads as at least one red block, and anything short of 100% keeps one green.
// The hover's MarkdownString needs supportHtml for the colors.
function usageBar(pct, width = 20) {
  if (pct == null) return '';
  let used = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);
  if (pct > 0 && pct < 100) used = Math.min(width - 1, Math.max(1, used));
  const seg = (n, color) => (n ? `<span style="color:var(--vscode-charts-${color});">${'█'.repeat(n)}</span>` : '');
  return seg(used, 'red') + seg(width - used, 'green');
}

module.exports = { accountState, usageOf, usageSummary, flagOf, headline, escapeMd, usageBar };
