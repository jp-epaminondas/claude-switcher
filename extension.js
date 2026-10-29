'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { claudePaths, switcherDir } = require('./src/paths');
const { Store } = require('./src/store');
const { Switcher } = require('./src/switcher');
const { mtime } = require('./src/fsutil');
const { outStatus, effectivePct, fmtClock, fmtIn, fmtPct } = require('./src/usage');

const MINUTE = 60 * 1000;

let paths;
let store;
let sw;
let statusItem;
let output;
let refreshMenu = null;
let ticking = false;
let tickAgain = false;
let forceAgain = false;
let lastCredMtime = -1;
let lastConfigMtime = -1;
let lastSyncAt = 0;

const config = () => vscode.workspace.getConfiguration('claudeSwitcher');
const log = (msg) => output && output.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);

function activate(context) {
  output = vscode.window.createOutputChannel('Claude Switcher');
  paths = claudePaths();
  const dir = switcherDir();
  store = new Store(dir);
  sw = new Switcher({ paths, store, switcherDir: dir, log });

  statusItem = vscode.window.createStatusBarItem('claudeSwitcher.status', vscode.StatusBarAlignment.Right, 1000);
  statusItem.name = 'Claude Switcher';
  statusItem.command = 'claudeSwitcher.menu';
  statusItem.show();

  context.subscriptions.push(
    output,
    statusItem,
    vscode.commands.registerCommand('claudeSwitcher.menu', showMenu),
    vscode.commands.registerCommand('claudeSwitcher.switchNext', switchNext),
    vscode.commands.registerCommand('claudeSwitcher.addAccount', addAccount),
    vscode.commands.registerCommand('claudeSwitcher.refresh', () => tick({ force: true })),
  );

  // Claude Code rewrites the first two when it refreshes a token or someone logs in; other
  // VS Code windows rewrite the store. Polling stat() is cheap and dependable on Windows.
  const watched = [
    [paths.credentials, 2000, () => tick()],
    [paths.globalConfig, 5000, () => tick()],
    [store.file, 2000, () => render()],
  ];
  for (const [file, interval, fn] of watched) fs.watchFile(file, { interval }, fn);
  const timer = setInterval(() => tick(), 30 * 1000);
  context.subscriptions.push({
    dispose() {
      clearInterval(timer);
      for (const [file] of watched) fs.unwatchFile(file);
    },
  });

  render();
  tick();
}

function deactivate() {}

// One pass: follow logins/refreshes, pick up usage, report accounts that ran out or came back.
async function tick({ force = false } = {}) {
  if (ticking) {
    tickAgain = true;
    forceAgain = forceAgain || force;
    return;
  }
  ticking = true;
  try {
    const credMtime = mtime(paths.credentials);
    if (force || credMtime !== lastCredMtime || Date.now() - lastSyncAt > 5 * MINUTE) {
      lastCredMtime = credMtime;
      lastSyncAt = Date.now();
      const added = await sw.syncLive();
      if (added) vscode.window.showInformationMessage(`Claude Switcher: ${added.label} salva (${added.email}).`);
    }
    const configMtime = mtime(paths.globalConfig);
    if (configMtime !== lastConfigMtime) {
      lastConfigMtime = configMtime;
      await sw.absorbClaudeCache();
    }
    const activeEveryMs = Math.max(1, Number(config().get('pollIntervalMinutes')) || 3) * MINUTE;
    await sw.refreshUsage({ force, activeEveryMs });
    for (const ev of await sw.collectEvents()) onEvent(ev);
  } catch (e) {
    lastCredMtime = -1; // retry the sync on the next tick
    log(`erro: ${e.stack || e.message}`);
  } finally {
    ticking = false;
    render();
    if (tickAgain) {
      const f = forceAgain;
      tickAgain = forceAgain = false;
      tick({ force: f });
    }
  }
}

function onEvent(ev) {
  const data = store.load();
  const acc = data.accounts.find((a) => a.id === ev.id);
  if (!acc) return;
  if (ev.type === 'out' && ev.active) {
    onActiveOut(data, acc, ev.until);
  } else if (ev.type === 'back' && config().get('notifyWhenBack', true)) {
    if (ev.active) {
      vscode.window.showInformationMessage(`✅ ${acc.label} voltou: o limite zerou.`);
    } else {
      vscode.window
        .showInformationMessage(`✅ ${acc.label} voltou e já está disponível.`, `Usar ${acc.label}`)
        .then((choice) => choice && doSwitch(acc.id));
    }
  }
}

function onActiveOut(data, acc, until) {
  const back = until ? ` Volta ${fmtClock(until)} (${fmtIn(until)}).` : '';
  const next = sw.pickNext(data);
  if (!next) {
    vscode.window
      .showWarningMessage(`${acc.label} esgotou.${back} Nenhuma outra conta disponível agora.`, 'Ver contas')
      .then((choice) => choice && showMenu());
    return;
  }
  if (config().get('autoSwitch', false)) {
    doSwitch(next.id, `${acc.label} esgotou. `);
    return;
  }
  vscode.window.showWarningMessage(`${acc.label} esgotou.${back}`, `Trocar para ${next.label}`, 'Ver contas').then((choice) => {
    if (choice === 'Ver contas') showMenu();
    else if (choice) doSwitch(next.id);
  });
}

async function doSwitch(id, prefix = '') {
  let result;
  try {
    result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Trocando conta do Claude…' },
      () => sw.switchTo(id),
    );
  } catch (e) {
    log(`troca falhou: ${e.stack || e.message}`);
    vscode.window.showErrorMessage(`Claude Switcher: não consegui trocar de conta (${e.message}).`);
    return;
  } finally {
    render();
  }
  const acc = result.account;
  if (result.needsLogin) {
    vscode.window
      .showWarningMessage(`${acc.label} (${acc.email}) precisa fazer login de novo.`, 'Fazer login')
      .then((choice) => choice && addAccount());
    return;
  }
  if (result.already) {
    vscode.window.showInformationMessage(`${acc.label} já é a conta em uso.`);
    return;
  }
  log(`trocado para ${acc.label} (${acc.email})`);
  vscode.window
    .showInformationMessage(
      `${prefix}Agora usando ${acc.label} (${acc.email}). O Claude Code passa a usar essa conta na próxima mensagem.`,
      'Recarregar janela',
    )
    .then((choice) => choice && vscode.commands.executeCommand('workbench.action.reloadWindow'));
  sw.refreshUsage({ force: true, only: [id] }).then(render, (e) => log(`uso após troca: ${e.message}`));
}

async function switchNext() {
  let data;
  try {
    data = store.load();
  } catch (e) {
    vscode.window.showErrorMessage(`Claude Switcher: ${e.message}`);
    return;
  }
  if (!data.accounts.length) return addAccount();
  const next = sw.pickNext(data);
  if (next) return doSwitch(next.id);
  const soon = sw.soonestBack(data);
  const when = soon ? ` A primeira a voltar é ${soon.account.label}, ${fmtClock(soon.until)} (${fmtIn(soon.until)}).` : '';
  vscode.window
    .showWarningMessage(`Nenhuma outra conta disponível agora.${when}`, 'Ver contas')
    .then((choice) => choice && showMenu());
}

async function addAccount() {
  try {
    await sw.syncLive(); // make sure the current account is saved before its tokens get replaced
  } catch (e) {
    log(`sync antes do login: ${e.message}`);
  }
  const choice = await vscode.window.showInformationMessage(
    'Adicionar outra conta do Claude',
    {
      modal: true,
      detail:
        'Vou abrir um terminal com "claude auth login". Faça login no navegador com a outra conta.\n\n' +
        'Quando o login terminar, o switcher salva a conta sozinho. A conta atual já está salva e continua na lista.\n\n' +
        'Para trocar de conta use sempre o switcher, nunca o Logout do Claude Code.',
    },
    'Abrir login',
  );
  if (choice !== 'Abrir login') return;
  sw.captureNext = true;
  const terminal = vscode.window.createTerminal({ name: 'Claude: login', shellPath: claudeExecutable(), shellArgs: ['auth', 'login'] });
  terminal.show();
}

// Prefer the binary bundled with the Claude Code extension: it is the one VS Code runs.
function claudeExecutable() {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  if (ext) {
    const bundled = path.join(ext.extensionPath, 'resources', 'native-binary', exe);
    if (fs.existsSync(bundled)) return bundled;
  }
  return exe;
}

async function pickAccount(acc) {
  const data = store.load();
  if (acc.id === data.activeId) {
    vscode.window.showInformationMessage(`${acc.label} já é a conta em uso.`);
    return;
  }
  if (acc.needsLogin) {
    const choice = await vscode.window.showWarningMessage(`${acc.label} (${acc.email}) precisa fazer login de novo.`, 'Fazer login');
    if (choice) addAccount();
    return;
  }
  const st = outStatus(acc.usage);
  if (st.out) {
    const until = st.until ? ` até ${fmtClock(st.until)}` : '';
    const choice = await vscode.window.showWarningMessage(`${acc.label} está esgotada${until}. Trocar mesmo assim?`, 'Trocar');
    if (!choice) return;
  }
  return doSwitch(acc.id);
}

function showMenu() {
  const qp = vscode.window.createQuickPick();
  qp.title = 'Contas do Claude';
  qp.placeholder = 'Escolha a conta que o Claude Code vai usar';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  const keyOf = (item) => (item.account ? item.account.id : item.action);

  const fill = () => {
    let data;
    try {
      data = store.load();
    } catch (e) {
      qp.items = [{ label: `$(error) ${e.message}` }];
      return;
    }
    const now = Date.now();
    const next = sw.pickNext(data, now);
    const items = [
      ...data.accounts.map((a) => accountItem(a, data, now)),
      { label: 'Ações', kind: vscode.QuickPickItemKind.Separator },
      {
        label: '$(arrow-swap) Trocar para a próxima disponível',
        description: next ? `→ ${next.label}` : 'nenhuma disponível agora',
        action: 'next',
      },
      { label: '$(add) Adicionar conta…', action: 'add' },
      { label: '$(refresh) Atualizar uso agora', action: 'refresh' },
    ];
    // Keep the highlighted row when the list refreshes underneath the user.
    const activeKey = qp.activeItems[0] && keyOf(qp.activeItems[0]);
    qp.items = items;
    const again = activeKey && items.find((i) => keyOf(i) === activeKey);
    if (again) qp.activeItems = [again];
  };

  qp.onDidTriggerItemButton(async ({ item, button }) => {
    const acc = item.account;
    qp.hide();
    if (button.action === 'rename') {
      const label = await vscode.window.showInputBox({
        title: 'Renomear conta',
        prompt: acc.email,
        value: acc.label,
        validateInput: (v) => (v.trim() ? null : 'Digite um nome'),
      });
      if (label) await sw.rename(acc.id, label.trim());
    } else if (button.action === 'remove') {
      const ok = await vscode.window.showWarningMessage(
        `Remover ${acc.label} (${acc.email}) do switcher?`,
        { modal: true, detail: 'O login dessa conta deixa de ficar salvo aqui. Para trazê-la de volta, use "Adicionar conta".' },
        'Remover',
      );
      if (ok) await sw.remove(acc.id);
    }
    render();
  });
  qp.onDidAccept(() => {
    const item = qp.selectedItems[0];
    qp.hide();
    if (!item) return;
    if (item.action === 'next') switchNext();
    else if (item.action === 'add') addAccount();
    else if (item.action === 'refresh') tick({ force: true });
    else if (item.account) pickAccount(item.account);
  });
  qp.onDidHide(() => {
    refreshMenu = null;
    qp.dispose();
  });

  fill();
  refreshMenu = fill;
  qp.show();
}

function accountItem(a, data, now) {
  const active = a.id === data.activeId;
  const st = outStatus(a.usage, now);
  let icon;
  let state;
  if (a.needsLogin) {
    icon = 'warning';
    state = 'Precisa de login de novo';
  } else if (st.out) {
    icon = 'error';
    state = st.until ? `Esgotada · volta ${fmtClock(st.until, now)} (${fmtIn(st.until, now)})` : 'Esgotada';
  } else if (active) {
    icon = 'pass-filled';
    state = 'Em uso';
  } else {
    icon = 'circle-large-outline';
    state = 'Disponível';
  }
  return {
    label: `$(${icon}) ${a.label}`,
    description: a.email,
    detail: `${state}  ·  ${usageSummary(a, now)}`,
    account: a,
    buttons: [
      { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Renomear', action: 'rename' },
      { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Remover do switcher', action: 'remove' },
    ],
  };
}

function usageSummary(a, now) {
  const u = a.usage;
  if (!u) return a.usageError ? 'uso indisponível' : 'uso ainda não consultado';
  const parts = [];
  const five = effectivePct(u.fiveHour, now);
  if (five != null) {
    const resets = five > 0 && five < 100 && u.fiveHour.resetsAt ? ` (zera ${fmtClock(u.fiveHour.resetsAt, now)})` : '';
    parts.push(`5h ${fmtPct(five)}${resets}`);
  }
  const week = effectivePct(u.sevenDay, now);
  if (week != null) parts.push(`semana ${fmtPct(week)}`);
  parts.push(`atualizado ${fmtClock(u.fetchedAt, now)}`);
  return parts.join(' · ');
}

function render() {
  if (!statusItem) return;
  let data;
  try {
    data = store.load();
  } catch (e) {
    statusItem.text = '$(error) Claude Switcher';
    statusItem.tooltip = e.message;
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    return;
  }
  const now = Date.now();
  const active = data.accounts.find((a) => a.id === data.activeId);
  const othersOut = data.accounts.filter((a) => a !== active && outStatus(a.usage, now).out).length;
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
  statusItem.text = text;
  statusItem.backgroundColor = bg ? new vscode.ThemeColor(bg) : undefined;
  statusItem.tooltip = tooltip(data, now);
  if (refreshMenu) refreshMenu();
}

const escapeMd = (s) => String(s).replace(/[|\\`*_[\]<>]/g, '\\$&');

function tooltip(data, now) {
  const md = new vscode.MarkdownString('', true);
  if (!data.accounts.length) {
    md.appendMarkdown('Nenhuma conta salva ainda. Clique para adicionar.');
    return md;
  }
  md.appendMarkdown('**Contas do Claude**\n\n| | Conta | 5h | Semana | Situação |\n|:-:|:--|--:|--:|:--|\n');
  for (const a of data.accounts) {
    const active = a.id === data.activeId;
    const st = outStatus(a.usage, now);
    let situation = active ? 'em uso' : 'disponível';
    if (a.needsLogin) situation = 'precisa de login';
    else if (st.out) situation = st.until ? `volta ${fmtClock(st.until, now)} (${fmtIn(st.until, now)})` : 'esgotada';
    const five = fmtPct(effectivePct(a.usage && a.usage.fiveHour, now));
    const week = fmtPct(effectivePct(a.usage && a.usage.sevenDay, now));
    md.appendMarkdown(`| ${active ? '$(pass-filled)' : ''} | ${escapeMd(a.label)} | ${five} | ${week} | ${situation} |\n`);
  }
  md.appendMarkdown('\nClique para trocar de conta.');
  return md;
}

module.exports = { activate, deactivate };
