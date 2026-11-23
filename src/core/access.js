'use strict';

// Acesso: how the switcher is used on this computer, picked before it opens. With no login
// everything is on. In a group, the group's own API checks the login and says what the
// person's level may use: nothing about groups lives anywhere else. Here there is only the
// URL the person pasted and the API's last answer (token, level, permissions), which
// accessView.js keeps in VS Code's secret storage. The API has three routes under that URL:
//   GET  {url}             → { nome }
//   POST {url}/entrar      { email, senha } → { token, expira_em?, usuario: { nome, nivel }, permissoes }
//   GET  {url}/permissoes  Bearer token     → { nivel, permissoes }, or 401 once the token is over

// What a level can be given, as the refusal reads it ("o seu nível não permite …"). '*' is all.
const PERMISSIONS = {
  'contas.usar': 'ver as contas e trocar de conta',
  'contas.gerenciar': 'adicionar, renomear e remover contas',
  memorias: 'abrir a página Memórias (CLAUDE.md global e dos projetos)',
  skills: 'abrir a página Skills',
  'credenciais.usar': 'destrancar o cofre e deixar o Claude usar os segredos',
  'credenciais.gerenciar': 'criar, editar, ver e apagar credenciais, e trocar a senha mestra',
  aprovacoes: 'abrir a página Aprovações e responder os pedidos',
  travas: 'abrir a página Travas (deploy e leitura de produção no modo automático)',
  configuracao: 'ligar e desligar o autoswitcher, o aviso de assunto novo, as conversas no mesmo projeto e as aprovações',
};
const ALL = '*';

// The permission each side bar page needs. The access page is always there.
const PAGES = { accounts: 'contas.usar', memories: 'memorias', skills: 'skills', credentials: 'credenciais.usar', approvals: 'aprovacoes', locks: 'travas', access: null };

// The permission each command needs: the first rule that matches; null is always allowed.
const COMMANDS = [
  [/^claudeSwitcher\.(access\.|showAccess)/, null],
  [/^claudeSwitcher\.(memories\.|showMemories)/, 'memorias'],
  [/^claudeSwitcher\.(skills\.|showSkills)/, 'skills'],
  [/^claudeSwitcher\.(showCredentials|cred\.(unlock|lock|copyRef)$)/, 'credenciais.usar'],
  [/^claudeSwitcher\.cred\./, 'credenciais.gerenciar'],
  [/^claudeSwitcher\.(showApprovals|approvalsAlert$)/, 'aprovacoes'],
  [/^claudeSwitcher\.showLocks/, 'travas'],
  [/^claudeSwitcher\.(addAccount|renameAccount|removeAccount)$/, 'contas.gerenciar'],
  [/^claudeSwitcher\.(showAccounts|menu$|switchNext$|refresh$|useAccount$)/, 'contas.usar'],
  [/^claudeSwitcher\.toggle/, 'configuracao'],
];
// A command left out of the rules needs every permission, so a new one is never open by mistake.
function commandPermission(id) {
  const rule = COMMANDS.find(([re]) => re.test(id));
  return rule ? rule[1] : ALL;
}

const TIMEOUT_MS = 10 * 1000;
const MAX_BODY = 64 * 1024;
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '');
const isPermission = (p) => typeof p === 'string' && (p === ALL || Object.hasOwn(PERMISSIONS, p));
const permissionsOf = (list) => [...new Set(list.filter(isPermission))].sort();
const validToken = (t) => typeof t === 'string' && t.length <= 16384 && /^[\x21-\x7e]+$/.test(t);

// The group's URL as pasted: https (plain http only on this computer, for tests), with no
// login or query in it. { url } with no trailing slash, or { error } to show.
function groupUrl(input) {
  let u;
  try {
    u = new URL(String(input || '').trim());
  } catch {
    return { error: 'Isso não é uma URL. Cole a URL que a sua organização passou, começando com https://.' };
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL.has(u.hostname))) return { error: 'A URL do grupo precisa começar com https://.' };
  if (u.username || u.password) return { error: 'A URL do grupo não pode ter usuário nem senha.' };
  if (u.search) return { error: 'A URL do grupo não pode ter parâmetros (o que vem depois do ?).' };
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}` };
}

// --- the session ---------------------------------------------------------------------------

// What is kept, one of:
//   { modo: 'livre' }
//   { modo: 'grupo', url, nome }     the login is still to be made, or it ended
//   { modo: 'grupo', url, nome, token, usuario, nivel, permissoes, expiraEm }
// Anything else reads as nothing picked yet.
function parseSession(raw) {
  let s;
  try {
    s = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!s || typeof s !== 'object') return null;
  if (s.modo === 'livre') return { modo: 'livre' };
  const g = s.modo === 'grupo' ? groupUrl(s.url) : {};
  if (!g.url) return null;
  const base = { modo: 'grupo', url: g.url, nome: text(s.nome, 80) || new URL(g.url).host };
  if (!validToken(s.token)) return base;
  return {
    ...base,
    token: s.token,
    usuario: text(s.usuario, 120),
    nivel: text(s.nivel, 60),
    permissoes: Array.isArray(s.permissoes) ? permissionsOf(s.permissoes) : [],
    expiraEm: Number.isFinite(s.expiraEm) ? s.expiraEm : null,
  };
}

// 'escolher' (nothing picked), 'login' (a group with no valid login), 'livre' or 'grupo'.
function stateOf(s, now = Date.now()) {
  if (!s) return 'escolher';
  if (s.modo === 'livre') return 'livre';
  return s.token && !(s.expiraEm && s.expiraEm <= now) ? 'grupo' : 'login';
}

const isOpen = (s, now) => ['livre', 'grupo'].includes(stateOf(s, now));

// Whether the session gives a permission (null: always).
function allows(s, perm, now = Date.now()) {
  if (perm === null) return true;
  const state = stateOf(s, now);
  if (state === 'livre') return true;
  if (state !== 'grupo') return false;
  return s.permissoes.includes(ALL) || (perm !== ALL && s.permissoes.includes(perm));
}

// --- the group's API -----------------------------------------------------------------------

// kind: 'rede' (no answer, or the API is down), 'login' (wrong e-mail or password), 'sessao'
// (the token is over), 'limite' (too many tries) or 'resposta' (not what a group API answers).
class AccessError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const notGroup = () => new AccessError('resposta', 'A URL respondeu, mas não como a API de um grupo do Claude Switcher. Confira a URL com quem administra o grupo.');

function failure(r, authKind) {
  const said = text(r.json && r.json.erro, 300);
  if (r.status === 401 || r.status === 403) return new AccessError(authKind, said || (authKind === 'login' ? 'E-mail ou senha inválidos.' : 'A sessão no grupo terminou.'));
  if (r.status === 429) return new AccessError('limite', said || 'Muitas tentativas seguidas. Espere um pouco e tente de novo.');
  if (r.status >= 500) return new AccessError('rede', 'A API do grupo está com problema agora. Tente de novo daqui a pouco.');
  return new AccessError('resposta', said || `A API do grupo respondeu HTTP ${r.status}.`);
}

function parseEntry(body) {
  if (!body || !validToken(body.token) || !Array.isArray(body.permissoes)) throw notGroup();
  const u = body.usuario && typeof body.usuario === 'object' ? body.usuario : {};
  const expira = typeof body.expira_em === 'string' ? Date.parse(body.expira_em) : NaN;
  return { token: body.token, usuario: text(u.nome, 120), nivel: text(u.nivel, 60), permissoes: permissionsOf(body.permissoes), expiraEm: Number.isFinite(expira) ? expira : null };
}

class GroupApi {
  constructor({ fetch: fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  // Redirects are refused: the password goes only to the URL the person pasted.
  async call(url, { method = 'GET', body, token } = {}) {
    const headers = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    let res;
    let raw;
    try {
      res = await this.fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
      raw = await res.text();
    } catch {
      throw new AccessError('rede', 'Não consegui falar com a API do grupo. Confira a URL e a internet.');
    }
    let json = null;
    if (raw.length <= MAX_BODY) {
      try {
        json = JSON.parse(raw);
      } catch {}
    }
    return { status: res.status, json };
  }

  async info(url) {
    const r = await this.call(url);
    if (r.status >= 500 || r.status === 429) throw failure(r, 'resposta');
    const nome = r.status === 200 ? text(r.json && r.json.nome, 80) : '';
    if (!nome) throw notGroup();
    return { nome };
  }

  async enter(url, email, senha) {
    const r = await this.call(`${url}/entrar`, { method: 'POST', body: { email, senha } });
    if (r.status !== 200) throw failure(r, 'login');
    return parseEntry(r.json);
  }

  async permissions(url, token) {
    const r = await this.call(`${url}/permissoes`, { token });
    if (r.status !== 200) throw failure(r, 'sessao');
    if (!r.json || !Array.isArray(r.json.permissoes)) throw notGroup();
    return { nivel: text(r.json.nivel, 60), permissoes: permissionsOf(r.json.permissoes) };
  }
}

// The login as typed, or { error }.
function loginInput(email, senha) {
  const e = text(email, 254);
  if (!/^[^\s@]+@[^\s@]+$/.test(e)) return { error: 'Digite o seu e-mail.' };
  if (typeof senha !== 'string' || !senha || senha.length > 1024) return { error: 'Digite a sua senha.' };
  return { email: e, senha };
}

module.exports = {
  PERMISSIONS,
  ALL,
  PAGES,
  commandPermission,
  groupUrl,
  parseSession,
  stateOf,
  isOpen,
  allows,
  loginInput,
  AccessError,
  GroupApi,
};
