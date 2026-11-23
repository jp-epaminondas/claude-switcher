'use strict';

// Página Acesso: where the switcher opens until the person picks how to use it, with no login
// or in a group (src/core/access.js). The choice lives in VS Code's secret storage, shared by
// every window. The rest of the extension asks here what is allowed (app.access): commands go
// through command(), pages through canPage(), and what runs on its own checks can() or
// open(). A group whose API gave a permissions URL is asked again now and then, so a change
// there applies without a new login. A session with a refresh token renews itself before it
// ends (or on the way back, after the computer was off); one without ends with its token.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { PERMISSIONS, ALL, PAGES, commandPermission, loginUrl, formInput, parseSession, stateOf, isOpen, allows, renewable, renewDue, AccessError, GroupApi } = require('../core/access');
const { withDirLock } = require('../core/fsutil');

const VIEW = 'claudeSwitcher.access';
const KEY = 'claudeSwitcher.acesso';
const CHECK_MS = 5 * 60 * 1000;
const TICK_MS = 30 * 1000;
const clock = (ms) => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function createAccess(app, context) {
  const { log } = app;
  const api = new GroupApi();
  const changed = new vscode.EventEmitter();
  let session = null;
  let sidebar = null;
  let view = null;
  // The steps of a group login, on screen only: { step: 'url' } or { step: 'login', group }.
  let draft = null;
  let busy = false;
  let error = '';
  let reason = '';
  let checkedAt = 0;
  let lastKey = null;

  const status = vscode.window.createStatusBarItem('claudeSwitcher.access', vscode.StatusBarAlignment.Left, 101);
  status.name = 'Claude Switcher: acesso';
  status.command = 'claudeSwitcher.showAccess';
  status.text = '$(lock) Claude Switcher: entrar';
  status.tooltip = 'Escolha como usar o Claude Switcher: sem login ou em um grupo.';

  const state = () => stateOf(session, Date.now());
  const open = () => isOpen(session, Date.now());
  const can = (perm) => allows(session, perm, Date.now());
  const canPage = (name) => can(Object.hasOwn(PAGES, name) ? PAGES[name] : ALL);

  // Why something is refused, as one sentence.
  function why(perm) {
    if (!open()) return 'o Claude Switcher está travado até você escolher como usar, sem login ou em um grupo';
    return `o seu acesso no grupo ${session.nome}${session.nivel ? ` (${session.nivel})` : ''} não permite ${PERMISSIONS[perm] || 'esse comando'}`;
  }

  function refuse(perm) {
    const text = why(perm);
    vscode.window.showWarningMessage(`Claude Switcher: ${text[0].toUpperCase()}${text.slice(1)}.`, ...(open() ? [] : ['Escolher'])).then((c) => c && show());
  }

  // Registers a command that runs only when the session allows it.
  const command = (id, fn) =>
    vscode.commands.registerCommand(id, (...args) => {
      const perm = commandPermission(id);
      return can(perm) ? fn(...args) : refuse(perm);
    });

  // Puts the state everywhere: the "when" keys of package.json, the status bar, the page, and
  // the rest of the extension when something it depends on changed.
  function apply() {
    const st = state();
    const key = JSON.stringify([st, st === 'grupo' ? session.permissoes : null]);
    if (key !== lastKey) {
      const opening = !isOpenState(lastKey) && open();
      lastKey = key;
      vscode.commands.executeCommand('setContext', 'claudeSwitcher.acesso', st);
      vscode.commands.executeCommand('setContext', 'claudeSwitcher.aberto', open());
      for (const p of Object.keys(PERMISSIONS)) vscode.commands.executeCommand('setContext', `claudeSwitcher.pode.${p}`, can(p));
      if (open()) status.hide();
      else status.show();
      changed.fire({ state: st, opening });
    }
    post();
  }
  const isOpenState = (key) => !!key && ['livre', 'grupo'].includes(JSON.parse(key)[0]);

  async function load() {
    try {
      session = parseSession(await context.secrets.get(KEY));
    } catch (e) {
      log(`acesso: não consegui ler a escolha guardada (${e.message})`);
      session = null;
    }
  }

  // Kept as given; held here as read back, so it has everything a session has.
  async function save(next) {
    session = next ? parseSession(next) : null;
    try {
      if (next) await context.secrets.store(KEY, JSON.stringify(next));
      else await context.secrets.delete(KEY);
    } catch (e) {
      log(`acesso: não consegui guardar a escolha (${e.message})`);
      vscode.window.showWarningMessage('Claude Switcher: não consegui guardar a escolha de acesso. Ela vale só nesta janela até o VS Code fechar.');
    }
    apply();
  }

  function show() {
    if (sidebar) sidebar.focus('access');
  }

  // The group part of a session, kept when its login ends.
  const groupPart = (s) => ({ modo: 'grupo', url: s.url, nome: s.nome, campos: s.campos });

  // --- what the page asks for ------------------------------------------------------------

  async function working(fn) {
    if (busy) return;
    busy = true;
    error = '';
    post();
    try {
      await fn();
    } catch (e) {
      error = e instanceof AccessError ? e.message : 'Algo deu errado. Tente de novo.';
      if (!(e instanceof AccessError)) log(`acesso: ${e.stack || e.message}`);
    } finally {
      busy = false;
      post();
    }
  }

  async function chooseFree() {
    draft = null;
    error = '';
    reason = '';
    await save({ modo: 'livre' });
    log('acesso: sem login');
  }

  // The URL is asked what its form wants; a URL that can't be used never goes out.
  function submitUrl(input) {
    const g = loginUrl(input);
    if (g.error) {
      error = g.error;
      return post();
    }
    return working(async () => {
      draft = { step: 'login', group: await api.describe(g.url) };
    });
  }

  // The group the login screen is for: the one just found, or the one whose login ended.
  const loginTarget = () => (draft && draft.step === 'login' ? draft.group : state() === 'login' ? session : null);

  function submitLogin(values) {
    const group = loginTarget();
    if (!group) return;
    const input = formInput(group.campos, values);
    if (input.error) {
      error = input.error;
      return post();
    }
    return working(async () => {
      const r = await api.enter(group, input.values);
      draft = null;
      reason = '';
      checkedAt = Date.now();
      await save({ ...groupPart(group), ...r });
      log(`acesso: entrou no grupo ${group.nome} (${group.endpoint})${r.nivel ? `, nível ${r.nivel}` : ''}: ${r.permissoes.join(', ') || 'nenhuma permissão'}`);
    });
  }

  async function leave() {
    if (!session || session.modo !== 'grupo') return;
    const choice = await vscode.window.showWarningMessage(
      `Sair do grupo ${session.nome}?`,
      { modal: true, detail: 'O Claude Switcher fica travado até você escolher de novo como usar: sem login ou em um grupo.' },
      'Sair do grupo',
    );
    if (choice !== 'Sair do grupo') return;
    log(`acesso: saiu do grupo ${session.nome}`);
    api.disconnect(session);
    draft = null;
    reason = '';
    await save(null);
    show();
  }

  // Renews the session with its refresh token, one window at a time: the first one to get the
  // lock renews and the others, reading the session again inside it, find it renewed already.
  // A refresh token works once, so two windows renewing with the same one would end it.
  let renewing = null;
  const renew = () => (renewing = renewing || renewNow().finally(() => (renewing = null)));
  async function renewNow() {
    try {
      fs.mkdirSync(app.switcherDir, { recursive: true });
      await withDirLock(path.join(app.switcherDir, 'acesso.lock'), async () => {
        await load();
        const s = session;
        if (!renewable(s) || !(state() === 'login' || renewDue(s))) return;
        try {
          const r = await api.renew(s);
          await save({ ...groupPart(s), ...r });
          log(`acesso: sessão no grupo ${s.nome} renovada até ${clock(r.expiraEm)}`);
        } catch (e) {
          if (e.kind === 'sessao') await lose(s, 'A sua conexão com o grupo terminou. Entre de novo.');
          else log(`acesso: não consegui renovar a sessão no grupo ${s.nome} (${e.message}); tento de novo daqui a pouco`);
        }
      }, { staleMs: 30 * 1000, timeoutMs: 25 * 1000 });
    } catch (e) {
      log(`acesso: renovação: ${e.message}`);
    }
    apply();
  }

  // Asks the group's permissions URL what this person may use now. A session that ended
  // locks; a network hiccup keeps the last answer until the session's own end.
  async function check(force = false) {
    if (state() !== 'grupo' || !session.permissoesUrl || (!force && Date.now() - checkedAt < CHECK_MS)) return;
    checkedAt = Date.now();
    const s = session;
    try {
      const r = await api.check(s);
      if (session !== s) return;
      if (r.permissoes.join() !== s.permissoes.join() || r.nivel !== s.nivel) {
        await save({ ...s, ...r });
        log(`acesso: permissões no grupo ${s.nome} agora: ${r.permissoes.join(', ') || 'nenhuma'}`);
        vscode.window.showInformationMessage(`Claude Switcher: o seu acesso no grupo ${s.nome} mudou.`, 'Ver').then((c) => c && show());
      } else post();
    } catch (e) {
      if (session !== s) return;
      if (e.kind !== 'sessao') {
        log(`acesso: não consegui conferir as permissões no grupo ${s.nome} (${e.message}); sigo com as últimas até ${clock(s.expiraEm)}`);
        return post();
      }
      // The token was refused; the refresh token may still give a new one.
      if (renewable(s)) return renew();
      lose(s, 'A sua sessão no grupo terminou. Entre de novo.');
    }
  }

  async function lose(s, why) {
    reason = why;
    log(`acesso: sessão no grupo ${s.nome} terminou`);
    await save(groupPart(s));
    vscode.window.showWarningMessage(`Claude Switcher: a sua sessão no grupo ${s.nome} terminou. Entre de novo para continuar.`, 'Entrar').then((c) => c && show());
  }

  // --- the page ----------------------------------------------------------------------------

  const loginScreen = (g, extra) => ({ screen: 'login', nome: g.nome, host: g.host, campos: g.campos, ...extra });

  function screen() {
    if (draft && draft.step === 'url') return { screen: 'url' };
    if (draft) return loginScreen(draft.group, { back: 'voltar' });
    const st = state();
    if (st === 'login') {
      const waiting = renewable(session) ? 'Sem resposta do grupo para renovar a sessão: tento de novo sozinho. Se preferir, entre de novo.' : '';
      return loginScreen(session, { reason: reason || waiting || 'A sua sessão no grupo venceu. Entre de novo.', back: 'sair' });
    }
    if (st !== 'grupo') return { screen: st };
    return {
      screen: 'grupo',
      nome: session.nome,
      host: session.host,
      usuario: session.usuario,
      nivel: session.nivel,
      until: clock(session.expiraEm),
      keep: renewable(session),
      checkable: !!session.permissoesUrl,
      checked: session.permissoesUrl && checkedAt ? clock(checkedAt) : '',
      permissions: Object.entries(PERMISSIONS).map(([id, label]) => ({ label: label[0].toUpperCase() + label.slice(1), on: can(id) })),
    };
  }

  function post() {
    if (view) view.webview.postMessage({ type: 'state', ...screen(), busy, error });
  }

  const ACTIONS = {
    ready: () => post(),
    livre: () => chooseFree(),
    grupo: () => {
      draft = { step: 'url' };
      error = '';
      post();
    },
    url: (msg) => submitUrl(typeof msg.url === 'string' ? msg.url.slice(0, 4000) : ''),
    entrar: (msg) => submitLogin(msg.valores),
    voltar: () => {
      draft = draft && draft.step === 'login' ? { step: 'url' } : null;
      error = '';
      post();
    },
    cancelar: () => {
      draft = null;
      error = '';
      post();
    },
    sair: () => leave(),
    conferir: () => working(() => check(true)),
  };

  const provider = {
    resolveWebviewView(webviewView) {
      view = webviewView;
      const media = vscode.Uri.joinPath(vscode.Uri.file(path.join(__dirname, '..', '..')), 'media');
      webviewView.webview.options = { enableScripts: true, localResourceRoots: [media] };
      webviewView.webview.html = html(webviewView.webview, media);
      webviewView.webview.onDidReceiveMessage((msg) => msg && typeof msg.type === 'string' && Object.hasOwn(ACTIONS, msg.type) && ACTIONS[msg.type](msg));
      webviewView.onDidChangeVisibility(() => webviewView.visible && post());
      webviewView.onDidDispose(() => {
        if (view === webviewView) view = null;
      });
    },
  };

  // Every half minute: a session renews before it ends (one with no refresh token locks at its
  // end), and the group is asked again when due.
  const timer = setInterval(() => {
    if (renewDue(session)) renew();
    else if (state() === 'login' && session.token) lose(session, 'A sua sessão no grupo venceu. Entre de novo.');
    else check();
  }, TICK_MS);

  const disposables = [
    status,
    changed,
    vscode.window.registerWebviewViewProvider(VIEW, provider),
    // Another window chose, logged in or left: this one follows.
    context.secrets.onDidChange(async (e) => {
      if (e.key !== KEY) return;
      await load();
      apply();
    }),
    command('claudeSwitcher.access.leave', leave),
  ];

  return {
    command,
    can,
    canPage,
    open,
    why,
    refuse,
    show,
    onDidChange: changed.event,
    // The Acesso page goes first on the side bar, so the panel opens on it while locked.
    attach(bar) {
      sidebar = bar;
      bar.page('access', 'Acesso', { viewId: VIEW });
    },
    async start() {
      await load();
      // Back after the session ended (the computer was off): renewed before anything shows.
      if (renewDue(session)) await renew();
      apply();
      check(true);
    },
    dispose() {
      clearInterval(timer);
      disposables.forEach((d) => d.dispose());
    },
  };
}

function html(webview, media) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'access.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'access.js'));
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Acesso</title>
</head>
<body>
<main id="page" aria-live="polite"></main>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}

module.exports = { createAccess };
