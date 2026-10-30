'use strict';

// Side bar list: the accounts, the recommendation, the forecast, then the autoswitcher switch.
const vscode = require('vscode');
const { outStatus, fmtClock, fmtIn, fmtMinutes, fmtPct } = require('../core/usage');
const { MIN_DAYS } = require('../core/demand');
const { reason, reasonLines, soonestBack, fmtSessions } = require('../core/advisor');
const { accountState, usageOf, flagOf, headline, escapeMd } = require('./present');

function createAccountsView(app) {
  const changed = new vscode.EventEmitter();
  const provider = {
    onDidChangeTreeData: changed.event,
    getTreeItem: (item) => item,
    // An empty list shows the "add account" welcome text from package.json.
    getChildren(element) {
      if (element) return element.lines || [];
      let data;
      try {
        data = app.store.load();
      } catch (e) {
        return [new vscode.TreeItem(e.message)];
      }
      if (!data.accounts.length) return [];
      const now = Date.now();
      const advice = app.advise(data, now);
      const spacer = (id) => Object.assign(new vscode.TreeItem(''), { id });
      return [
        ...data.accounts.map((a) => accountItem(a, data, advice, now)),
        spacer('spacer'),
        adviceItem(data, advice, now),
        ...(advice.plan ? [forecastItem(advice.plan, now)] : []),
        spacer('spacer.auto'),
        autoSwitchItem(app.autoSwitch),
      ];
    },
  };
  const view = vscode.window.createTreeView('claudeSwitcher.accounts', { treeDataProvider: provider });

  return {
    refresh(data, now) {
      changed.fire();
      if (!data) return;
      const active = data.accounts.find((a) => a.id === data.activeId);
      const out = data.accounts.filter((a) => outStatus(a.usage, now).out).length;
      view.description = active ? active.label : '';
      view.badge = out ? { value: out, tooltip: `${out} ${out > 1 ? 'contas esgotadas' : 'conta esgotada'}` } : undefined;
    },
    dispose() {
      view.dispose();
      changed.dispose();
    },
  };
}

function accountItem(a, data, advice, now) {
  const s = accountState(a, data, now);
  const u = usageOf(a, now);
  const x = advice.byId.get(a.id);
  const flag = flagOf(a, advice);
  const item = new vscode.TreeItem(a.label, vscode.TreeItemCollapsibleState.None);
  item.id = a.id;
  item.accountId = a.id;
  item.iconPath = new vscode.ThemeIcon(s.icon, s.color ? new vscode.ThemeColor(s.color) : undefined);
  let text;
  if (a.needsLogin || s.out || !u) text = s.situation;
  else if (x.burn) text = `🔥 sobram ${Math.round(x.left)}% · renova ${fmtIn(x.resetsAt, now)}`;
  else text = `5h ${fmtPct(u.five)} · semana ${fmtPct(u.week)}${u.weekResets ? ` · renova ${fmtClock(u.weekResets, now)}` : ''}`;
  item.description = `${flag === 'best' ? '⭐ ' : ''}${s.active && !s.out && !a.needsLogin ? 'em uso · ' : ''}${text}`;
  item.contextValue = s.active ? 'account.active' : 'account';
  if (!s.active) item.command = { command: 'claudeSwitcher.useAccount', title: 'Usar esta conta', arguments: [a.id] };

  const md = new vscode.MarkdownString('', true);
  md.appendMarkdown(`**${escapeMd(a.label)}** · ${escapeMd(a.email || '')}\n\n$(${s.icon}) ${s.situation}\n\n`);
  if (flag === 'best') md.appendMarkdown(`⭐ **Recomendada:** ${reason(x, now)}.\n\n`);
  else if (flag === 'burn') md.appendMarkdown(`🔥 ${reason(x, now)}.\n\n`);
  if (u) {
    if (u.five != null) md.appendMarkdown(`- 5h: **${fmtPct(u.five)}**${u.fiveResets ? ` · zera ${fmtClock(u.fiveResets, now)}` : ''}\n`);
    if (u.week != null) {
      const sessions = x.sessions != null ? ` · sobram ≈ ${fmtSessions(x.sessions)}` : '';
      md.appendMarkdown(`- Semana: **${fmtPct(u.week)}**${sessions}${u.weekResets ? ` · renova ${fmtClock(u.weekResets, now)}` : ''}\n`);
    }
    md.appendMarkdown(`\nAtualizado ${fmtClock(u.fetchedAt, now)}`);
  }
  if (!s.active) md.appendMarkdown('\n\n_Clique para usar esta conta._');
  item.tooltip = md;
  return item;
}

// "Which account should I use?", expanded into one short line per row.
function adviceItem(data, advice, now) {
  const best = advice.best;
  let title;
  let lines;
  if (best) {
    title = `${best.active ? 'Continue na' : 'Use a'} ${best.acc.label}`;
    lines = reasonLines(best, now);
  } else {
    const soon = soonestBack(data, now);
    title = 'Nenhuma conta disponível agora';
    lines = soon ? [`a primeira a voltar é a ${soon.account.label}`, `${fmtClock(soon.until, now)} (${fmtIn(soon.until, now)})`] : [];
  }
  const item = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.Expanded);
  item.id = 'advice';
  item.iconPath = best
    ? new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'))
    : new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.red'));
  item.tooltip = headline(data, advice, now);
  // A switch button instead of a click action: clicking would also collapse the item.
  if (best && !best.active) {
    item.contextValue = 'advice';
    item.accountId = best.id;
  }
  item.lines = lines.map((text, i) => {
    const line = new vscode.TreeItem(text);
    line.id = `advice.${i}`;
    return line;
  });
  return item;
}

// "Will the accounts last at my pace?", from planner.js. A click opens the wait limit setting.
function forecastItem(p, now) {
  const M = p.maxWaitMin;
  const at = (e) => `${fmtMinutes(e.minutes)} parado ${fmtClock(e.start, now)}`;
  const orWait = p.noPauseWaitMin ? [`ou aceite esperas de até ${p.noPauseWaitMin} min`] : [];
  let title;
  let icon;
  let lines;
  // In how many of 10 possible weeks no wait goes over the limit, even without pauses.
  const odds = p.learned && p.scenarios > 1 ? `sem pausas, aguenta em ${Math.round(p.okShare * 10)} de 10 semanas` : null;
  if (p.verdict === 'learning') {
    title = 'Previsão: aprendendo seu ritmo';
    icon = new vscode.ThemeIcon('history');
    lines = [`${p.daysObserved} de ${MIN_DAYS} dias com dados`, 'até lá, só prevê as próximas 2h de uso'];
  } else if (p.verdict === 'ok') {
    title = 'Previsão: as contas aguentam';
    icon = new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
    lines = p.longest
      ? [`maior espera provável: ${at(p.longest)}`, `dentro do seu limite de ${M} min`]
      : [p.learned ? 'nenhuma espera nos próximos 7 dias' : 'nenhuma espera nas próximas 2h'];
  } else if (p.verdict === 'pace') {
    title = 'Previsão: faça pausas';
    icon = new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('charts.yellow'));
    lines = [`pausa de ${p.pace.pauseMin} min a cada ~${fmtMinutes(p.pace.workMin)} de uso`, `sem pausas: ${at(p.longest)}`, ...orWait];
  } else {
    const n = p.short.extraAccounts;
    title = 'Previsão: as contas não aguentam';
    icon = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.red'));
    lines = [
      `~${fmtMinutes(p.short.minutes)} sem poder usar até ${fmtClock(p.short.until, now)}`,
      n ? `adicione ${n} ${n > 1 ? 'contas' : 'conta'} para dar` : 'nem com 3 contas a mais dá',
      ...orWait,
    ];
  }
  if (odds && (p.verdict === 'ok' || p.verdict === 'pace') && p.okShare < 1) lines.push(odds);
  if (p.learned) lines.push(`com base em ${p.daysObserved} dias do seu uso`);
  else if (p.verdict !== 'learning') lines.push('ainda aprendendo: vale para as próximas 2h');
  const item = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.Expanded);
  item.id = 'forecast';
  item.iconPath = icon;
  item.lines = lines.map((text, i) => Object.assign(new vscode.TreeItem(text), { id: `forecast.${i}` }));
  const md = new vscode.MarkdownString('', true);
  md.appendMarkdown(
    `Previsão pelo seu ritmo de uso: quando todas as contas esgotariam ao mesmo tempo e por quanto tempo. Seu limite: **${M} min** parado de uma vez.\n\n`,
  );
  md.appendMarkdown(
    'Ela sorteia semanas a partir dos seus dias reais, puxados e leves, sem supor dia da semana, e planeja pela pior de cada 5. O resto de hoje segue os dias que começaram como hoje.\n\n',
  );
  md.appendMarkdown(
    'Pausar não devolve uso, porque a janela de 5h zera num horário fixo. A pausa deixa você escolher quando esperar, em pedaços menores que o seu limite, em vez de ser cortado no meio de uma tarefa.\n\n',
  );
  md.appendMarkdown('_Clique para mudar o limite._');
  item.tooltip = md;
  item.command = { command: 'workbench.action.openSettings', title: 'Tempo máximo de espera', arguments: ['claudeSwitcher.maxWaitMinutes'] };
  return item;
}

// On/off switch for the autoswitcher; a click flips it.
function autoSwitchItem(auto) {
  const on = !!auto && auto.enabled();
  const problem = on && auto.hookProblem();
  const item = new vscode.TreeItem('Autoswitcher');
  item.id = 'autoSwitch';
  item.description = on ? (problem ? 'ligado · sem continuar sozinho' : 'ligado · troca e continua sozinho') : 'desligado';
  item.iconPath = on
    ? new vscode.ThemeIcon(problem ? 'warning' : 'sync', new vscode.ThemeColor(problem ? 'charts.yellow' : 'charts.green'))
    : new vscode.ThemeIcon('sync-ignored');
  item.command = { command: 'claudeSwitcher.toggleAutoSwitch', title: on ? 'Desligar autoswitcher' : 'Ligar autoswitcher' };
  const md = new vscode.MarkdownString('', true);
  md.appendMarkdown(
    'Quando a conta em uso esgota, o switcher troca para a próxima disponível e o Claude Code continua a tarefa sozinho, sem precisar digitar "continue".\n\n',
  );
  const at = auto ? auto.threshold() : 99;
  if (at < 100) md.appendMarkdown(`Antes disso, quando a conta chega a ${at}%, ele já troca no fim de uma resposta, e a próxima mensagem vai pela conta nova.\n\n`);
  if (problem) md.appendMarkdown(`$(warning) A troca é automática, mas o Claude não continua sozinho: ${escapeMd(problem)}.\n\n`);
  md.appendMarkdown(on ? '_Clique para desligar._' : '_Clique para ligar._');
  item.tooltip = md;
  return item;
}

module.exports = { createAccountsView };
