'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { claudePaths, switcherDir } = require('./src/paths');
const { Store } = require('./src/store');
const { Switcher } = require('./src/switcher');
const { mtime } = require('./src/fsutil');
const { outStatus, effectivePct, fmtClock, fmtIn, fmtPct } = require('./src/usage');
const { advise, reason, fmtSessions } = require('./src/advisor');

const MINUTE = 60 * 1000;

let paths;
let store;
let sw;
let statusItem;
let output;
let tree;
let treeView;
let refreshMenu = null;
let ticking = false;
let tickAgain = false;
let forceAgain = false;
let lastCredMtime = -1;
let lastConfigMtime = -1;
let lastSyncAt = 0;

const config = () => vscode.workspace.getConfiguration('claudeSwitcher');
const adviceOptions = () => ({ burnWindowHours: Math.max(1, Number(config().get('burnWindowHours')) || 24) });
const adviceFor = (data, now) => advise(data, now, adviceOptions());
const log = (msg) => output && output.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);

function activate(context) {
  output = vscode.window.createOutputChannel('Claude Switcher');
  paths = claudePaths();
  const dir = switcherDir();
  store = new Store(dir);
  sw = new Switcher({ paths, store, switcherDir: dir, log });

  tree = new AccountsTree();
  treeView = vscode.window.createTreeView('claudeSwitcher.accounts', { treeDataProvider: tree });

  statusItem = vscode.window.createStatusBarItem('claudeSwitcher.status', vscode.StatusBarAlignment.Left, 100);
  statusItem.name = 'Claude Switcher';
  statusItem.command = 'claudeSwitcher.menu';

  context.subscriptions.push(
    output,
    statusItem,
    treeView,
    vscode.commands.registerCommand('claudeSwitcher.menu', showMenu),
    vscode.commands.registerCommand('claudeSwitcher.switchNext', switchNext),
    vscode.commands.registerCommand('claudeSwitcher.addAccount', addAccount),
    vscode.commands.registerCommand('claudeSwitcher.refresh', () => tick({ force: true })),
    vscode.commands.registerCommand('claudeSwitcher.useAccount', (arg) => withAccount(arg, pickAccount)),
    vscode.commands.registerCommand('claudeSwitcher.renameAccount', (arg) => withAccount(arg, renameAccount)),
    vscode.commands.registerCommand('claudeSwitcher.removeAccount', (arg) => withAccount(arg, removeAccount)),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('claudeSwitcher') && render()),
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
    for (const ev of await sw.collectEvents(adviceOptions())) onEvent(ev);
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
  } else if (ev.type === 'burn' && config().get('notifyBurn', true)) {
    const x = adviceFor(data, Date.now()).byId.get(acc.id);
    if (!x || !x.burn) return;
    vscode.window
      .showInformationMessage(`🔥 Use a ${acc.label} agora: ${reason(x)}.`, `Usar ${acc.label}`)
      .then((choice) => choice && doSwitch(acc.id));
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
      .then((choice) => choice && showAccounts());
    return;
  }
  if (config().get('autoSwitch', false)) {
    doSwitch(next.id, `${acc.label} esgotou. `);
    return;
  }
  vscode.window.showWarningMessage(`${acc.label} esgotou.${back}`, `Trocar para ${next.label}`, 'Ver contas').then((choice) => {
    if (choice === 'Ver contas') showAccounts();
    else if (choice) doSwitch(next.id);
  });
}

function showAccounts() {
  vscode.commands.executeCommand('claudeSwitcher.accounts.focus');
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
    .then((choice) => choice && showAccounts());
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

// Commands invoked from the side bar get a tree item; from code, an account id.
function withAccount(arg, fn) {
  const id = typeof arg === 'string' ? arg : arg && arg.accountId;
  const acc = id && store.load().accounts.find((a) => a.id === id);
  return acc ? fn(acc) : undefined;
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

async function renameAccount(acc) {
  const label = await vscode.window.showInputBox({
    title: 'Renomear conta',
    prompt: acc.email,
    value: acc.label,
    validateInput: (v) => (v.trim() ? null : 'Digite um nome'),
  });
  if (label) await sw.rename(acc.id, label.trim());
  render();
}

async function removeAccount(acc) {
  const ok = await vscode.window.showWarningMessage(
    `Remover ${acc.label} (${acc.email}) do switcher?`,
    { modal: true, detail: 'O login dessa conta deixa de ficar salvo aqui. Para trazê-la de volta, use "Adicionar conta".' },
    'Remover',
  );
  if (ok) await sw.remove(acc.id);
  render();
}

// --- how an account is shown (side bar, menu, status bar tooltip) -------------------------

function accountState(a, data, now) {
  const active = a.id === data.activeId;
  const st = outStatus(a.usage, now);
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

class AccountsTree {
  constructor() {
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
  }

  refresh() {
    this.changed.fire();
  }

  getTreeItem(item) {
    return item;
  }

  // An empty list shows the "add account" welcome text from package.json.
  getChildren(element) {
    if (element) return [];
    let data;
    try {
      data = store.load();
    } catch (e) {
      return [new vscode.TreeItem(e.message)];
    }
    const now = Date.now();
    const advice = adviceFor(data, now);
    return data.accounts.map((a) => accountTreeItem(a, data, advice, now));
  }
}

function accountTreeItem(a, data, advice, now) {
  const s = accountState(a, data, now);
  const u = usageOf(a, now);
  const x = advice.byId.get(a.id);
  const isBest = advice.best && advice.best.id === a.id;
  const item = new vscode.TreeItem(a.label, vscode.TreeItemCollapsibleState.None);
  item.id = a.id;
  item.accountId = a.id;
  item.iconPath = new vscode.ThemeIcon(s.icon, s.color ? new vscode.ThemeColor(s.color) : undefined);
  let text;
  if (a.needsLogin || s.out || !u) text = s.situation;
  else if (x.burn) text = `🔥 sobram ${Math.round(x.left)}% · renova ${fmtIn(x.resetsAt, now)}`;
  else text = `5h ${fmtPct(u.five)} · semana ${fmtPct(u.week)}${u.weekResets ? ` · renova ${fmtClock(u.weekResets, now)}` : ''}`;
  item.description = `${isBest ? '⭐ ' : ''}${s.active && !s.out && !a.needsLogin ? 'em uso · ' : ''}${text}`;
  item.contextValue = s.active ? 'account.active' : 'account';
  if (!s.active) item.command = { command: 'claudeSwitcher.useAccount', title: 'Usar esta conta', arguments: [a.id] };

  const md = new vscode.MarkdownString('', true);
  md.appendMarkdown(`**${escapeMd(a.label)}** · ${escapeMd(a.email || '')}\n\n$(${s.icon}) ${s.situation}\n\n`);
  if (isBest) md.appendMarkdown(`⭐ **Recomendada:** ${reason(x, now)}.\n\n`);
  else if (x.burn) md.appendMarkdown(`🔥 ${reason(x, now)}.\n\n`);
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

// One-line answer to "which account should I use?", shown on top of the side bar list.
function headline(data, advice, now) {
  if (!data.accounts.length) return undefined;
  const best = advice.best;
  if (best) return `⭐ ${best.active ? 'Continue na' : 'Use a'} ${best.acc.label}: ${reason(best, now)}.`;
  const soon = sw.soonestBack(data, now);
  const when = soon ? ` A primeira a voltar é a ${soon.account.label}, ${fmtClock(soon.until, now)} (${fmtIn(soon.until, now)}).` : '';
  return `Nenhuma conta disponível agora.${when}`;
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
    const advice = adviceFor(data, now);
    const next = advice.next;
    const items = [
      ...data.accounts.map((a) => {
        const s = accountState(a, data, now);
        const flag = advice.best && advice.best.id === a.id ? '⭐ recomendada  ·  ' : advice.byId.get(a.id).burn ? '🔥 vai perder uso  ·  ' : '';
        return {
          label: `$(${s.icon}) ${a.label}`,
          description: a.email,
          detail: `${flag}${s.situation}  ·  ${usageSummary(a, now)}`,
          account: a,
          buttons: [
            { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Renomear', action: 'rename' },
            { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Remover do switcher', action: 'remove' },
          ],
        };
      }),
      { label: 'Ações', kind: vscode.QuickPickItemKind.Separator },
      {
        label: '$(arrow-swap) Trocar para a próxima disponível',
        description: next ? `→ ${next.acc.label}` : 'nenhuma disponível agora',
        detail: next ? reason(next, now) : undefined,
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

  qp.onDidTriggerItemButton(({ item, button }) => {
    qp.hide();
    if (button.action === 'rename') renameAccount(item.account);
    else if (button.action === 'remove') removeAccount(item.account);
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

function render() {
  if (!statusItem) return;
  if (tree) tree.refresh();
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
  const advice = adviceFor(data, now);
  const active = data.accounts.find((a) => a.id === data.activeId);
  const outCount = data.accounts.filter((a) => outStatus(a.usage, now).out).length;
  const othersOut = outCount - (active && outStatus(active.usage, now).out ? 1 : 0);

  if (treeView) {
    treeView.message = headline(data, advice, now);
    treeView.description = active ? active.label : '';
    treeView.badge = outCount ? { value: outCount, tooltip: `${outCount} ${outCount > 1 ? 'contas esgotadas' : 'conta esgotada'}` } : undefined;
  }

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
  statusItem.tooltip = tooltip(data, advice, now);
  if (config().get('showStatusBar', true)) statusItem.show();
  else statusItem.hide();
  if (refreshMenu) refreshMenu();
}

const escapeMd = (s) => String(s).replace(/[|\\`*_[\]<>]/g, '\\$&');

function tooltip(data, advice, now) {
  const md = new vscode.MarkdownString('', true);
  if (!data.accounts.length) {
    md.appendMarkdown('Nenhuma conta salva ainda. Clique para adicionar.');
    return md;
  }
  md.appendMarkdown(`${escapeMd(headline(data, advice, now))}\n\n`);
  md.appendMarkdown('| | Conta | 5h | Semana | Situação |\n|:-:|:--|--:|--:|:--|\n');
  for (const a of data.accounts) {
    const s = accountState(a, data, now);
    const u = usageOf(a, now) || {};
    const flag = advice.best && advice.best.id === a.id ? '⭐ ' : advice.byId.get(a.id).burn ? '🔥 ' : '';
    md.appendMarkdown(`| $(${s.icon}) | ${flag}${escapeMd(a.label)} | ${fmtPct(u.five)} | ${fmtPct(u.week)} | ${s.situation} |\n`);
  }
  md.appendMarkdown('\nClique para trocar de conta.');
  return md;
}

module.exports = { activate, deactivate };
