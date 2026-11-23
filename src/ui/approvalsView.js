'use strict';

// Side bar page "Aprovações": a PermissionRequest hook in Claude Code's settings sends every
// permission request of every conversation here, so they can be answered from one place in
// whichever VS Code window the user is in. The dialog in the conversation's tab stays too: the
// first answer wins. The page is a webview of its own (claudeSwitcher.approvals), shown in the
// panel in place of the tree while it is the page on screen: one card per request, saying where
// it came from (this window or another one, the conversation's title, what was asked) and what
// Claude wants to do.
const crypto = require('crypto');
const path = require('path');
const vscode = require('vscode');
const { syncApprovalHook, findNode, settingsFile } = require('../core/claudeHook');
const { Approvals, ownerOf, currentWindow, describeTool, suggestionLabel } = require('../core/approvals');

const VIEW = 'claudeSwitcher.approvals';
const POLL_MS = 400;
const BEAT_MS = 15 * 1000;
const ACTIONS = new Set(['allow', 'always', 'deny', 'stop']);
// How the window the user is in speaks up when a request arrives (claudeSwitcher.approvalsReveal).
const ALERTS = {
  notify: { label: '$(bell) Aviso no canto da janela', detail: 'Com os botões Ver e Ir para a conversa. A página não abre sozinha.' },
  page: { label: '$(layout-sidebar-left) Abrir a página Aprovações', detail: 'No painel, sem tirar o cursor de onde ele está.' },
  none: { label: '$(circle-slash) Não avisar', detail: 'Só o número na barra de status e no ícone do painel, que aparece em todos os modos.' },
};

function createApprovals(app, sidebar) {
  const { paths, log } = app;
  const store = new Approvals(app.switcherDir);
  const enabled = () => !!app.config().get('approvals', true);
  // A boolean is from before there were three ways: true opened the page.
  const alertMode = () => {
    const v = app.config().get('approvalsReveal', 'notify');
    if (typeof v === 'boolean') return v ? 'page' : 'none';
    return v in ALERTS ? v : 'notify';
  };

  // Conversations opened in this window from now on carry its id: Claude Code runs in this
  // extension host and its hooks inherit the environment.
  const windowId = crypto.randomUUID();
  process.env.CLAUDE_SWITCHER_WINDOW = windowId;
  let focusedAt = vscode.window.state.focused ? Date.now() : 0;

  const statusItem = vscode.window.createStatusBarItem('claudeSwitcher.approvals', vscode.StatusBarAlignment.Left, 99);
  statusItem.name = 'Claude Switcher: aprovações';
  statusItem.command = 'claudeSwitcher.showApprovals';
  statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');

  // In the tree it has no rows; it lends the panel its badge while another page is on screen.
  const page = sidebar.page('approvals', 'Aprovações', { viewId: VIEW, badgeAlways: true });

  let view = null;
  let items = [];
  let lastSig = '';
  let lastBeat = 0;
  const seen = new Set();
  let syncing = Promise.resolve();

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
    const suggestions = req.answerInTab ? [] : (req.suggestions || []).map((s, i) => ({ i, label: suggestionLabel(s) })).filter((s) => s.label);
    return {
      id: req.id,
      at: req.at,
      verb: tool.verb,
      target: tool.target,
      body: tool.body,
      title: req.title,
      prompt: req.prompt,
      said: req.said,
      project: req.root || req.cwd ? path.basename(req.root || req.cwd) : null,
      where: !owner ? 'unknown' : owner.id === windowId ? 'here' : 'other',
      windowName: owner ? owner.name : null,
      canAllow: !req.answerInTab,
      allowLabel: req.tool === 'ExitPlanMode' ? 'Aprovar o plano' : 'Aprovar',
      suggestions,
      canGo: !!(owner && req.session),
      session: req.session,
      ownerId: owner ? owner.id : null,
      ownerOpen: owner ? owner.open : null,
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
        if (fresh.length && isCurrent(windows)) alert(fresh);
      }
      const sig = JSON.stringify([enabled(), items.map((it) => [it.id, it.where, it.windowName, it.title])]);
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
    const badge = n ? { value: n, tooltip: waiting } : undefined;
    if (n) {
      statusItem.text = `$(bell-dot) ${n} ${n === 1 ? 'aprovação' : 'aprovações'}`;
      statusItem.tooltip = items.map((it) => `${it.verb}${it.target ? `: ${it.target}` : ''} · ${it.title || it.project || 'conversa'}`).join('\n');
      statusItem.show();
    } else {
      statusItem.hide();
    }
    page.decorate({ description: n ? waiting : enabled() ? '' : 'desligado', badge });
    if (!view) return;
    view.badge = badge;
    view.description = n ? waiting : '';
    post();
  }

  function post() {
    if (!view) return;
    // Only what a card shows goes to the page.
    const cards = items.map(({ session, ownerId, ownerOpen, ...shown }) => shown);
    view.webview.postMessage({ type: 'state', enabled: enabled(), items: cards, now: Date.now() });
  }

  // Brings the page up in this window, leaving the keyboard where it was.
  function show() {
    if (view && view.visible) return;
    if (sidebar.visible()) sidebar.show('approvals');
    else sidebar.focus('approvals').then(() => vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'));
  }

  function alert(fresh) {
    const mode = alertMode();
    if (mode === 'page') show();
    else if (mode === 'notify' && !(view && view.visible)) notify(fresh);
  }

  // A notice in the corner: the panel and the keyboard stay where they are. It hides itself
  // after a few seconds and stays in the notification list.
  async function notify(fresh) {
    const it = fresh[0];
    const one = fresh.length === 1;
    const from = it.where === 'other' ? ` (outra janela: ${it.windowName})` : '';
    const text = one
      ? `Claude pede permissão: ${it.verb}${it.target ? `: ${it.target}` : ''} · ${it.title || it.project || 'conversa'}${from}`
      : `${fresh.length} pedidos de permissão do Claude esperando.`;
    const pick = await vscode.window.showInformationMessage(text, 'Ver', ...(one && it.canGo ? ['Ir para a conversa'] : []));
    if (pick === 'Ver') sidebar.focus('approvals');
    else if (pick === 'Ir para a conversa') go(it);
  }

  async function chooseAlert() {
    const now = alertMode();
    const picks = Object.entries(ALERTS).map(([mode, a]) => ({ ...a, mode, description: mode === now ? 'atual' : undefined }));
    const pick = await vscode.window.showQuickPick(picks, { title: 'Quando chega um pedido de permissão', placeHolder: 'Como a janela em que você está avisa' });
    if (pick && pick.mode !== now) await app.config().update('approvalsReveal', pick.mode, vscode.ConfigurationTarget.Global);
  }

  async function openConversation(session) {
    try {
      await vscode.commands.executeCommand('claude-vscode.editor.open', session);
    } catch (e) {
      log(`aprovações: não abri a conversa ${session} (${e.message})`);
    }
  }

  // Brings the request's conversation to the front, in whichever window it is.
  async function go(it) {
    if (!it.canGo) return;
    if (it.ownerId === windowId) return openConversation(it.session);
    store.askFocus(it.ownerId, it.session);
    // Opening a folder that is already open in another window brings that window up.
    if (it.ownerOpen) {
      try {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(it.ownerOpen), { forceNewWindow: true });
      } catch (e) {
        log(`aprovações: não trouxe a janela ${it.windowName} (${e.message})`);
      }
    }
  }

  function answer(it, msg) {
    if (msg.action === 'always' && !it.suggestions.some((s) => s.i === msg.suggestion)) return;
    if (!it.canAllow) return;
    const message = typeof msg.message === 'string' ? msg.message.slice(0, 2000) : '';
    const res =
      msg.action === 'allow'
        ? { behavior: 'allow' }
        : msg.action === 'always'
          ? { behavior: 'allow', suggestion: msg.suggestion }
          : { behavior: 'deny', message, interrupt: msg.action === 'stop' };
    let ok = false;
    try {
      ok = store.answer(it.id, res);
    } catch (e) {
      log(`aprovações: ${e.message}`);
    }
    if (!ok) vscode.window.showInformationMessage('Esse pedido já foi respondido.');
    else log(`aprovações: ${msg.action} · ${it.verb}${it.target ? ` ${it.target}` : ''} · ${it.title || it.project || ''}`);
    poll();
  }

  // Anything from the page is checked against the cards on screen.
  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ready') return post();
    if (msg.type === 'toggle') return toggle();
    const it = typeof msg.id === 'string' && items.find((x) => x.id === msg.id);
    if (!it) return;
    if (msg.type === 'go') go(it);
    else if (msg.type === 'answer' && ACTIONS.has(msg.action)) answer(it, msg);
  }

  const provider = {
    resolveWebviewView(webviewView) {
      view = webviewView;
      const media = vscode.Uri.joinPath(vscode.Uri.file(path.join(__dirname, '..', '..')), 'media');
      webviewView.webview.options = { enableScripts: true, localResourceRoots: [media] };
      webviewView.webview.html = html(webviewView.webview, media);
      webviewView.webview.onDidReceiveMessage(onMessage);
      webviewView.onDidChangeVisibility(() => webviewView.visible && post());
      webviewView.onDidDispose(() => {
        if (view === webviewView) view = null;
      });
      render();
    },
  };

  const timer = setInterval(poll, POLL_MS);
  const disposables = [
    statusItem,
    vscode.window.registerWebviewViewProvider(VIEW, provider),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) focusedAt = Date.now();
      if (enabled()) beat();
    }),
  ];
  syncClaudeHook();
  poll();

  return {
    toggle,
    chooseAlert,
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

function html(webview, media) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'approvals.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'approvals.js'));
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Aprovações</title>
</head>
<body>
<main id="list" aria-live="polite"></main>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}

module.exports = { createApprovals };
