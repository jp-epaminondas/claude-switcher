'use strict';

// Side bar page "Aprovações": a PermissionRequest hook in Claude Code's settings sends every
// permission request of every conversation here, so they can be answered from one place in
// whichever VS Code window the user is in. The dialog in the conversation's tab stays too: the
// first answer wins. Each request says where it came from (this window or another one, the
// conversation's title, what was asked) and what Claude wants to do.
const crypto = require('crypto');
const path = require('path');
const vscode = require('vscode');
const { syncApprovalHook, findNode, settingsFile } = require('../core/claudeHook');
const { Approvals, ownerOf, currentWindow, describeTool, suggestionLabel } = require('../core/approvals');
const { fmtClock } = require('../core/usage');
const { escapeMd } = require('./present');

const { Expanded, None } = vscode.TreeItemCollapsibleState;
const POLL_MS = 400;
const BEAT_MS = 15 * 1000;
const LINES = 6; // lines of a command or a change shown under the request

const icon = (id, color) => new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined);
const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const fence = (text) => {
  const s = String(text || '');
  const ticks = '`'.repeat(Math.max(3, ...(s.match(/`+/g) || []).map((m) => m.length + 1)));
  return `${ticks}\n${s}\n${ticks}\n\n`;
};

function createApprovals(app, sidebar) {
  const { paths, log } = app;
  const store = new Approvals(app.switcherDir);
  const enabled = () => !!app.config().get('approvals', true);
  const reveal = () => !!app.config().get('approvalsReveal', true);

  // Conversations opened in this window from now on carry its id: Claude Code runs in this
  // extension host and its hooks inherit the environment.
  const windowId = crypto.randomUUID();
  process.env.CLAUDE_SWITCHER_WINDOW = windowId;
  let focusedAt = vscode.window.state.focused ? Date.now() : 0;

  const statusItem = vscode.window.createStatusBarItem('claudeSwitcher.approvals', vscode.StatusBarAlignment.Left, 99);
  statusItem.name = 'Claude Switcher: aprovações';
  statusItem.command = 'claudeSwitcher.showApprovals';
  statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

  let items = [];
  let lastSig = '';
  let lastBeat = 0;
  const seen = new Set();
  let syncing = Promise.resolve();

  const page = sidebar.page('approvals', 'Aprovações', { getChildren, badgeAlways: true });

  function syncClaudeHook() {
    syncing = syncing.then(async () => {
      const on = enabled();
      try {
        const changed = await syncApprovalHook(paths, app.switcherDir, { enabled: on, nodePath: on ? findNode() : null });
        if (changed) log(`hook das aprovações ${on ? 'instalado em' : 'removido de'} ${settingsFile(paths)}`);
      } catch (e) {
        log(`aprovações: ${e.message}`);
        if (on) vscode.window.showWarningMessage(`Claude Switcher: não consegui ligar as aprovações (${e.message}).`);
      }
    });
    return syncing;
  }

  async function toggle() {
    const on = !enabled();
    await app.config().update('approvals', on, vscode.ConfigurationTarget.Global);
    await syncClaudeHook();
    if (!on) store.removeWindow(windowId);
    vscode.window.showInformationMessage(
      on
        ? 'Aprovações ligado. Os pedidos de permissão de todas as conversas do Claude Code aparecem na página Aprovações, na janela em que você estiver. O pedido continua na aba da conversa também: vale a primeira resposta.'
        : 'Aprovações desligado. Os pedidos de permissão ficam só na aba de cada conversa.',
    );
    lastSig = '';
    poll();
  }

  function windowCard() {
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    const file = vscode.workspace.workspaceFile;
    const open = file && file.scheme === 'file' ? file : vscode.workspace.workspaceFolders?.[0]?.uri;
    return {
      id: windowId,
      pid: process.pid,
      name: (vscode.workspace.name || 'janela sem pasta').replace(/ \(Workspace\)$/, ''),
      folders,
      open: open ? open.toString() : null,
      focused: vscode.window.state.focused,
      focusedAt,
    };
  }

  function beat() {
    store.heartbeat();
    store.saveWindow(windowCard());
    lastBeat = Date.now();
  }

  // This window is the one the user is in: it has the focus, or no window has it and this one
  // had it last.
  function isCurrent(windows) {
    if (vscode.window.state.focused) return true;
    if (windows.some((w) => w.focused && w.id !== windowId)) return false;
    const last = currentWindow(windows);
    return !last || last.id === windowId;
  }

  function itemOf(req, windows) {
    const owner = ownerOf(req, windows);
    const tool = describeTool(req);
    return {
      ...tool,
      req,
      id: req.id,
      project: req.root || req.cwd ? path.basename(req.root || req.cwd) : null,
      where: !owner ? 'unknown' : owner.id === windowId ? 'here' : 'other',
      owner,
      canAllow: !req.answerInTab,
      suggestions: req.answerInTab ? [] : (req.suggestions || []).map((s, i) => ({ i, label: suggestionLabel(s) })).filter((s) => s.label),
      canGo: !!(owner && req.session),
    };
  }

  function poll() {
    try {
      if (!enabled()) {
        items = [];
      } else {
        if (Date.now() - lastBeat > BEAT_MS) beat();
        const asked = store.takeFocus(windowId);
        if (asked) openConversation(asked);
        const windows = store.windows();
        items = store.pending().map((r) => itemOf(r, windows));
        const fresh = items.filter((it) => !seen.has(it.id));
        for (const it of fresh) seen.add(it.id);
        if (fresh.length && reveal() && isCurrent(windows)) show();
      }
      const sig = JSON.stringify([enabled(), items.map((it) => [it.id, it.where, it.owner && it.owner.name, it.req.title])]);
      if (sig !== lastSig) {
        lastSig = sig;
        for (const id of seen) if (!items.some((it) => it.id === id)) seen.delete(id);
        render();
      }
    } catch (e) {
      log(`aprovações: ${e.stack || e.message}`);
    }
  }

  function render() {
    const n = items.length;
    const waiting = `${n} ${n === 1 ? 'pedido esperando' : 'pedidos esperando'}`;
    if (n) {
      statusItem.text = `$(bell-dot) ${n} ${n === 1 ? 'aprovação' : 'aprovações'}`;
      statusItem.tooltip = items.map((it) => `${it.verb}${it.target ? `: ${clip(it.target, 60)}` : ''} · ${it.req.title || it.project || 'conversa'}`).join('\n');
      statusItem.show();
    } else {
      statusItem.hide();
    }
    page.decorate({ description: n ? waiting : enabled() ? '' : 'desligado', badge: n ? { value: n, tooltip: waiting } : undefined });
    page.refresh();
  }

  // Brings the page up in this window, leaving the keyboard where it was.
  function show() {
    if (sidebar.visible()) sidebar.show('approvals');
    else sidebar.focus('approvals').then(() => vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'));
  }

  // --- the rows ---

  function getChildren(element) {
    if (element) return element.lines || [];
    if (!enabled()) return [toggleItem()];
    if (!items.length) {
      const empty = new vscode.TreeItem('Nenhum pedido esperando');
      empty.id = 'approvals.empty';
      empty.iconPath = icon('check');
      empty.tooltip = 'Os pedidos de permissão de todas as conversas do Claude Code, em qualquer janela, aparecem aqui. Cada um diz de qual janela e conversa veio.';
      return [empty, Object.assign(new vscode.TreeItem(''), { id: 'approvals.spacer' }), toggleItem()];
    }
    return items.map(requestItem);
  }

  function whereText(it) {
    if (it.where === 'here') return 'esta janela';
    if (it.where === 'other') return `janela ${it.owner.name}`;
    return 'janela não identificada';
  }

  function requestItem(it) {
    const r = it.req;
    const item = new vscode.TreeItem(`${it.verb}${it.target ? `: ${clip(it.target, 70)}` : ''}`, Expanded);
    item.id = `approval.${it.id}`;
    item.approvalId = it.id;
    item.description = `${whereText(it)} · ${fmtClock(r.at)}`;
    item.iconPath = it.where === 'here' ? icon('bell-dot', 'charts.blue') : it.where === 'other' ? icon('bell-dot', 'charts.orange') : icon('bell-dot');
    // Read by the "when" of each button in package.json.
    item.contextValue = ['approval', it.canAllow && 'allow', it.suggestions.length && 'always', it.canGo && 'go'].filter(Boolean).join(';');
    item.tooltip = tooltip(it);

    const line = (n, text, iconId, extra = {}) => Object.assign(new vscode.TreeItem(text, None), { id: `approval.${it.id}.${n}`, iconPath: iconId ? icon(...[].concat(iconId)) : undefined, tooltip: item.tooltip, ...extra });
    const lines = [];
    lines.push(line('conv', r.title || it.project || 'Conversa', 'comment-discussion', { description: [r.title && it.project, r.prompt && `pedido: “${clip(r.prompt, 80)}”`].filter(Boolean).join(' · ') }));
    if (it.target && it.target.length > 70) lines.push(line('target', it.target, 'info'));
    const b = it.body;
    if (b && (b.kind === 'code' || b.kind === 'text')) {
      const all = String(b.text).split('\n');
      all.slice(0, LINES).forEach((t, i) => lines.push(line(`l${i}`, clip(t, 120) || ' ', i ? undefined : b.kind === 'code' ? 'terminal' : 'note')));
      if (all.length > LINES) lines.push(line('more', `… mais ${all.length - LINES} linhas (passe o mouse para ver tudo)`));
    } else if (b && (b.kind === 'diff' || b.kind === 'diffs')) {
      const edits = b.kind === 'diff' ? [b] : b.edits;
      const all = edits.flatMap((d) => [...String(d.old || '').split('\n').map((t) => ['-', t]), ...String(d.new || '').split('\n').map((t) => ['+', t])]);
      all.slice(0, LINES).forEach(([sign, t], i) =>
        lines.push(line(`d${i}`, clip(t, 120) || ' ', sign === '-' ? ['diff-removed', 'gitDecoration.deletedResourceForeground'] : ['diff-added', 'gitDecoration.addedResourceForeground'])),
      );
      if (all.length > LINES) lines.push(line('more', `… mais ${all.length - LINES} linhas (passe o mouse para ver tudo)`));
    }
    if (r.said) lines.push(line('said', `Claude: ${clip(r.said, 160)}`, 'hubot'));
    if (!it.canAllow) lines.push(line('tab', 'Responda na aba da conversa', 'arrow-right', it.canGo ? { command: { command: 'claudeSwitcher.approvals.go', title: 'Ir para a conversa', arguments: [item] } } : {}));
    for (const s of it.suggestions) lines.push(line(`s${s.i}`, s.label, 'pass', { command: { command: 'claudeSwitcher.approvals.always', title: s.label, arguments: [item, s.i] } }));
    item.lines = lines;
    return item;
  }

  function tooltip(it) {
    const r = it.req;
    const md = new vscode.MarkdownString('', true);
    md.appendMarkdown(`**${escapeMd(it.verb)}**${it.target ? ` · ${escapeMd(it.target)}` : ''}\n\n`);
    md.appendMarkdown(`$(window) ${escapeMd(whereText(it))}${it.project ? ` · $(folder) ${escapeMd(it.project)}` : ''} · ${fmtClock(r.at)}\n\n`);
    if (r.title) md.appendMarkdown(`$(comment-discussion) **${escapeMd(r.title)}**\n\n`);
    if (r.prompt) md.appendMarkdown(`Seu pedido: _${escapeMd(r.prompt)}_\n\n`);
    const b = it.body;
    if (b && (b.kind === 'code' || b.kind === 'text')) md.appendMarkdown(fence(b.text));
    else if (b && (b.kind === 'diff' || b.kind === 'diffs')) {
      const edits = b.kind === 'diff' ? [b] : b.edits;
      md.appendMarkdown(fence(edits.map((d) => [...String(d.old || '').split('\n').map((t) => `- ${t}`), ...String(d.new || '').split('\n').map((t) => `+ ${t}`)].join('\n')).join('\n\n')));
    }
    if (r.said) md.appendMarkdown(`$(hubot) O Claude disse antes: ${escapeMd(r.said)}\n\n`);
    md.appendMarkdown(it.canAllow ? '_Os botões aparecem ao passar o mouse: ✓ aprovar, ✕ negar, ■ parar, ↗ ir para a conversa._' : '_Esta precisa ser respondida na aba da conversa._');
    return md;
  }

  function toggleItem() {
    const on = enabled();
    const item = new vscode.TreeItem('Aprovações');
    item.id = 'approvals.toggle';
    item.description = on ? 'ligado · os pedidos de todas as conversas vêm para cá' : 'desligado';
    item.iconPath = on ? icon('bell', 'charts.green') : icon('bell-slash');
    item.command = { command: 'claudeSwitcher.toggleApprovals', title: on ? 'Desligar aprovações' : 'Ligar aprovações' };
    item.tooltip = `Os pedidos de permissão de todas as conversas do Claude Code, em todas as janelas, aparecem nesta página, na janela em que você estiver. O pedido continua na aba da conversa também: vale a primeira resposta.\n\nClique para ${on ? 'desligar' : 'ligar'}.`;
    return item;
  }

  // --- the answers ---

  const find = (arg) => items.find((x) => x.id === (arg && arg.approvalId));

  function send(it, res, what) {
    let ok = false;
    try {
      ok = store.answer(it.id, res);
    } catch (e) {
      log(`aprovações: ${e.message}`);
    }
    if (!ok) vscode.window.showInformationMessage('Esse pedido já foi respondido.');
    else log(`aprovações: ${what} · ${it.verb}${it.target ? ` ${clip(it.target, 80)}` : ''} · ${it.req.title || it.project || ''}`);
    poll();
  }

  function allow(arg) {
    const it = find(arg);
    if (it && it.canAllow) send(it, { behavior: 'allow' }, 'aprovado');
  }

  async function always(arg, index) {
    const it = find(arg);
    if (!it || !it.suggestions.length) return;
    let s = it.suggestions.find((x) => x.i === index);
    if (!s && it.suggestions.length === 1) s = it.suggestions[0];
    if (!s) s = await vscode.window.showQuickPick(it.suggestions.map((x) => ({ label: x.label, s: x })), { placeHolder: 'Aprovar e lembrar como?' }).then((p) => p && p.s);
    if (s && find(arg)) send(it, { behavior: 'allow', suggestion: s.i }, s.label);
  }

  async function deny(arg) {
    const it = find(arg);
    if (!it || !it.canAllow) return;
    const message = await vscode.window.showInputBox({
      title: `Negar: ${it.verb}${it.target ? ` ${clip(it.target, 60)}` : ''}`,
      prompt: 'O que o Claude deve fazer no lugar? (opcional; Enter nega, Esc cancela)',
    });
    if (message === undefined || !find(arg)) return;
    send(it, { behavior: 'deny', message }, 'negado');
  }

  function stop(arg) {
    const it = find(arg);
    if (it && it.canAllow) send(it, { behavior: 'deny', interrupt: true }, 'negado e parado');
  }

  async function openConversation(session) {
    try {
      await vscode.commands.executeCommand('claude-vscode.editor.open', session);
    } catch (e) {
      log(`aprovações: não abri a conversa ${session} (${e.message})`);
    }
  }

  // Brings the request's conversation to the front, in whichever window it is.
  async function go(arg) {
    const it = find(arg);
    if (!it || !it.canGo) return;
    if (it.owner.id === windowId) return openConversation(it.req.session);
    store.askFocus(it.owner.id, it.req.session);
    // Opening a folder that is already open in another window brings that window up.
    if (it.owner.open) {
      try {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(it.owner.open), { forceNewWindow: true });
      } catch (e) {
        log(`aprovações: não trouxe a janela ${it.owner.name} (${e.message})`);
      }
    }
  }

  const timer = setInterval(poll, POLL_MS);
  const disposables = [
    statusItem,
    vscode.commands.registerCommand('claudeSwitcher.approvals.allow', allow),
    vscode.commands.registerCommand('claudeSwitcher.approvals.always', always),
    vscode.commands.registerCommand('claudeSwitcher.approvals.deny', deny),
    vscode.commands.registerCommand('claudeSwitcher.approvals.stop', stop),
    vscode.commands.registerCommand('claudeSwitcher.approvals.go', go),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) focusedAt = Date.now();
      if (enabled()) beat();
    }),
  ];
  syncClaudeHook();
  poll();

  return {
    toggle,
    enabled,
    count: () => items.length,
    onConfigChanged() {
      syncClaudeHook();
      if (!enabled()) store.removeWindow(windowId);
      lastSig = '';
      poll();
    },
    dispose() {
      clearInterval(timer);
      store.removeWindow(windowId);
      disposables.forEach((d) => d.dispose());
    },
  };
}

module.exports = { createApprovals };
