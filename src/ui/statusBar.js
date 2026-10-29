'use strict';

// The account in use, on the left of the status bar; click opens the quick menu.
const vscode = require('vscode');
const { outStatus, effectivePct, fmtClock, fmtPct } = require('../core/usage');
const { accountState, usageOf, flagOf, headline, escapeMd } = require('./present');

function createStatusBar(app) {
  const item = vscode.window.createStatusBarItem('claudeSwitcher.status', vscode.StatusBarAlignment.Left, 100);
  item.name = 'Claude Switcher';
  item.command = 'claudeSwitcher.menu';

  function update(data, advice, now) {
    const active = data.accounts.find((a) => a.id === data.activeId);
    const outCount = data.accounts.filter((a) => outStatus(a.usage, now).out).length;
    const othersOut = outCount - (active && outStatus(active.usage, now).out ? 1 : 0);
    let text;
    let bg;
    if (!data.accounts.length) {
      text = '$(account) Claude: nenhuma conta salva';
    } else if (!active) {
      text = '$(account) Claude: conta atual não salva';
    } else {
      const st = outStatus(active.usage, now);
      if (st.out) {
        text = `$(error) ${active.label} esgotada${st.until ? ` · volta ${fmtClock(st.until, now)}` : ''}`;
        bg = 'statusBarItem.errorBackground';
      } else {
        const five = effectivePct(active.usage && active.usage.fiveHour, now);
        text = `$(account) ${active.label}${five != null ? ` · ${fmtPct(five)}` : ''}`;
        if (five >= 80) bg = 'statusBarItem.warningBackground';
      }
    }
    if (othersOut) text += ` · $(clock) ${othersOut} fora`;
    item.text = text;
    item.backgroundColor = bg ? new vscode.ThemeColor(bg) : undefined;
    item.tooltip = tooltip(data, advice, now);
    if (app.config().get('showStatusBar', true)) item.show();
    else item.hide();
  }

  function showError(e) {
    item.text = '$(error) Claude Switcher';
    item.tooltip = e.message;
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    item.show();
  }

  return { update, showError, dispose: () => item.dispose() };
}

function tooltip(data, advice, now) {
  const md = new vscode.MarkdownString('', true);
  if (!data.accounts.length) {
    md.appendMarkdown('Nenhuma conta salva ainda. Clique para adicionar.');
    return md;
  }
  const flags = { best: '⭐ ', burn: '🔥 ' };
  md.appendMarkdown(`${escapeMd(headline(data, advice, now))}\n\n`);
  md.appendMarkdown('| | Conta | 5h | Semana | Situação |\n|:-:|:--|--:|--:|:--|\n');
  for (const a of data.accounts) {
    const s = accountState(a, data, now);
    const u = usageOf(a, now) || {};
    const flag = flags[flagOf(a, advice)] || '';
    md.appendMarkdown(`| $(${s.icon}) | ${flag}${escapeMd(a.label)} | ${fmtPct(u.five)} | ${fmtPct(u.week)} | ${s.situation} |\n`);
  }
  md.appendMarkdown('\nClique para trocar de conta.');
  return md;
}

module.exports = { createStatusBar };
