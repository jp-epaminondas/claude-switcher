'use strict';

// Acesso: how the switcher is used on this computer, picked before it opens. With no login
// everything is on. In a group, the person pastes the group's login URL, and the extension
// knows nothing else about that system: not its levels, profiles or roles. It only asks which
// of its own permissions (PERMISSIONS) the person has; turning the system's way of organizing
// access into that list is the system's job. The contract, where only the token is required:
//
//   GET  {url}   optional: what the login form asks, { nome?, campos?: [{ nome, rotulo?, tipo? }] }
//                with tipo 'text', 'email' or 'password'. Any other answer (404, a page) means
//                e-mail and senha.
//   POST {url}   the form's fields plus what came after the ? (such as an application's key),
//                as JSON. Logged in when the answer has a token:
//                { token | access_token, usuario?: { nome, nivel }, permissoes?,
//                  expira_em? | expires_in?, permissoes_url? }
//                No permissoes means everything: a system with no levels only logs people in.
//                The session lasts until expira_em, expires_in, the token's own exp, or 12 h.
//   GET  {permissoes_url}   optional, with the token: { permissoes } now, or 401 once the
//                session is over; checked every few minutes.
//   Staying logged in, optional: a login answer with { refresh_token, renovar_url,
//                desconectar_url? } is renewed before it ends, with POST {renovar_url} and the
//                refresh token as Authorization: Bearer; the answer is a login like the first,
//                with a new refresh token. 401 there means log in again. Leaving the group
//                posts {desconectar_url} the same way. These URLs may be relative to the one
//                that answered, and must be on the login's own site.
//
// A Rota7 Gerenciador works as is: its standard login (/api/v1/autenticar) takes the
// application's key in the URL, and refuses whoever has no access to that application.

// What a system can give, as the refusal reads it ("o seu acesso não permite …"). '*' is all.
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
const SESSION_MS = 12 * 3600 * 1000;
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '');
const isPermission = (p) => typeof p === 'string' && (p === ALL || Object.hasOwn(PERMISSIONS, p));
const permissionsOf = (list) => [...new Set(list.filter(isPermission))].sort();
const validToken = (t) => typeof t === 'string' && t.length <= 16384 && /^[\x21-\x7e]+$/.test(t);
const FIELD_NAME = /^[A-Za-z_][\w.-]{0,59}$/;

// --- the login URL and its form ------------------------------------------------------------

// The login URL as pasted: https (plain http only on this computer, for tests), with no login
// in it. What comes after the ? are fields the login always takes; they go in the body.
// → { url, endpoint, fixos, host } or { error } to show.
function loginUrl(input) {
  let u;
  try {
    u = new URL(String(input || '').trim());
  } catch {
    return { error: 'Isso não é uma URL. Cole a URL de login que a sua organização passou, começando com https://.' };
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL.has(u.hostname))) return { error: 'A URL de login precisa começar com https://.' };
  if (u.username || u.password) return { error: 'A URL de login não pode ter usuário nem senha.' };
  const fixos = {};
  for (const [k, v] of [...u.searchParams].slice(0, 20)) {
    if (!FIELD_NAME.test(k) || v.length > 1000) return { error: `A URL de login tem um parâmetro que não dá para usar: ${k.slice(0, 40)}.` };
    fixos[k] = v;
  }
  const endpoint = `${u.origin}${u.pathname}`;
  const query = new URLSearchParams(fixos).toString();
  return { url: query ? `${endpoint}?${query}` : endpoint, endpoint, fixos, host: u.host };
}

const DEFAULT_FIELDS = [
  { nome: 'email', rotulo: 'E-mail', tipo: 'email' },
  { nome: 'senha', rotulo: 'Senha', tipo: 'password' },
];
const FIELD_TYPES = new Set(['text', 'email', 'password']);

// The fields the API asked for, or e-mail and senha.
function fieldsOf(list) {
  const out = [];
  for (const f of Array.isArray(list) ? list.slice(0, 6) : []) {
    if (!f || !FIELD_NAME.test(f.nome) || out.some((o) => o.nome === f.nome)) continue;
    out.push({ nome: f.nome, rotulo: text(f.rotulo, 60) || f.nome, tipo: FIELD_TYPES.has(f.tipo) ? f.tipo : 'text' });
  }
  return out.length ? out : DEFAULT_FIELDS.map((f) => ({ ...f }));
}

// A group: the login URL with its name and its form. null when the URL can't be used.
function groupOf(input, nome, campos) {
  const g = loginUrl(input);
  if (g.error) return null;
  return { url: g.url, endpoint: g.endpoint, fixos: g.fixos, host: g.host, nome: text(nome, 80) || new URL(g.endpoint).hostname.replace(/^www\./, ''), campos: fieldsOf(campos) };
}

// A URL the API gave for later (permissions, renewal), relative to the one that answered and
// only on the login's own site.
function sameSite(input, base, group) {
  if (typeof input !== 'string' || !input) return null;
  try {
    const u = new URL(input, base);
    return u.origin === new URL(group.endpoint).origin && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

// What the person typed, checked against the form → { values } or { error }.
function formInput(campos, values) {
  const v = values && typeof values === 'object' ? values : {};
  const out = {};
  for (const f of campos) {
    const raw = typeof v[f.nome] === 'string' ? v[f.nome] : '';
    const val = f.tipo === 'password' ? raw : text(raw, 1024);
    if (!val || val.length > 1024) return { error: `Preencha: ${f.rotulo}.` };
    if (f.tipo === 'email' && !/^[^\s@]+@[^\s@]+$/.test(val)) return { error: `${f.rotulo}: digite um e-mail.` };
    out[f.nome] = val;
  }
  return { values: out };
}

// --- the session ---------------------------------------------------------------------------

// What is kept, one of:
//   { modo: 'livre' }
//   { modo: 'grupo', url, nome, campos }       the login is still to be made, or it ended
//   { modo: 'grupo', url, nome, campos, token, usuario, nivel, permissoes, emitidoEm, expiraEm,
//     permissoesUrl, refreshToken, renovarUrl, desconectarUrl }
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
  const group = s.modo === 'grupo' ? groupOf(s.url, s.nome, s.campos) : null;
  if (!group) return null;
  const base = { modo: 'grupo', ...group };
  if (!validToken(s.token)) return base;
  return {
    ...base,
    token: s.token,
    usuario: text(s.usuario, 120),
    nivel: text(s.nivel, 60),
    permissoes: Array.isArray(s.permissoes) ? permissionsOf(s.permissoes) : [],
    emitidoEm: Number.isFinite(s.emitidoEm) ? s.emitidoEm : null,
    expiraEm: Number.isFinite(s.expiraEm) ? s.expiraEm : Date.now() + SESSION_MS,
    permissoesUrl: sameSite(s.permissoesUrl, group.endpoint, group),
    refreshToken: validToken(s.refreshToken) ? s.refreshToken : null,
    renovarUrl: sameSite(s.renovarUrl, group.endpoint, group),
    desconectarUrl: sameSite(s.desconectarUrl, group.endpoint, group),
  };
}

// A session that can renew itself, and whether it is time: in the last half of its life, at
// most the last 30 minutes, or already over.
const renewable = (s) => !!(s && s.refreshToken && s.renovarUrl);
function renewDue(s, now = Date.now()) {
  if (!renewable(s)) return false;
  const life = s.emitidoEm ? s.expiraEm - s.emitidoEm : Infinity;
  return now >= s.expiraEm - Math.min(30 * 60 * 1000, life / 2);
}

// 'escolher' (nothing picked), 'login' (a group with no valid login), 'livre' or 'grupo'.
function stateOf(s, now = Date.now()) {
  if (!s) return 'escolher';
  if (s.modo === 'livre') return 'livre';
  return s.token && s.expiraEm > now ? 'grupo' : 'login';
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

// kind: 'rede' (no answer, or the server is down), 'login' (the login wasn't accepted),
// 'sessao' (the session is over), 'limite' (too many tries) or 'resposta' (not a login's answer).
class AccessError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const notLogin = () => new AccessError('resposta', 'A URL respondeu, mas não como um login. Confira a URL com quem administra o grupo.');

// When a JWT says it ends, read without checking the signature: only to lock on time.
function jwtExpiry(token) {
  try {
    const exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).exp;
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

function expiryOf(b, token, now) {
  const at = typeof b.expira_em === 'string' ? Date.parse(b.expira_em) : NaN;
  if (Number.isFinite(at)) return at;
  if (Number.isFinite(b.expires_in) && b.expires_in > 0) return now + b.expires_in * 1000;
  return jwtExpiry(token) || now + SESSION_MS;
}

// A login answer (from logging in or renewing), or null when it isn't one. URLs in it are
// relative to the one that answered.
function loginOf(r, base, group) {
  const b = r.json;
  const token = [b.token, b.access_token].find(validToken);
  if (r.status >= 300 || !token || b.status === 'erro') return null;
  const u = b.usuario && typeof b.usuario === 'object' ? b.usuario : {};
  const now = Date.now();
  return {
    token,
    usuario: text(u.nome, 120),
    nivel: text(u.nivel, 60),
    permissoes: Array.isArray(b.permissoes) ? permissionsOf(b.permissoes) : [ALL],
    emitidoEm: now,
    expiraEm: expiryOf(b, token, now),
    permissoesUrl: sameSite(b.permissoes_url, base, group),
    refreshToken: validToken(b.refresh_token) ? b.refresh_token : null,
    renovarUrl: sameSite(b.renovar_url, base, group),
    desconectarUrl: sameSite(b.desconectar_url, base, group),
  };
}

// A refused login, in the API's words when it gave them ("erro"), else by its error code: some
// systems (the Rota7 Gerenciador) keep their text off the screen and send only the code.
function refusal(b) {
  const said = text(b && b.erro, 300);
  if (said) return said;
  const code = text(b && b.tipo_erro != null ? String(b.tipo_erro) : '', 20);
  return `Não foi possível entrar com esses dados${code ? ` (código ${code})` : ''}.`;
}

class GroupApi {
  constructor({ fetch: fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  // Redirects are refused: what the person types goes only to the URL they pasted.
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
      throw new AccessError('rede', 'Não consegui falar com o servidor do grupo. Confira a URL e a internet.');
    }
    let json = null;
    if (raw.length <= MAX_BODY) {
      try {
        json = JSON.parse(raw);
      } catch {}
    }
    return { status: res.status, json: json && typeof json === 'object' ? json : null };
  }

  // The group behind a login URL, with the form its API asks for (or e-mail and senha).
  async describe(input) {
    const g = loginUrl(input);
    if (g.error) throw new AccessError('resposta', g.error);
    const r = await this.call(g.url);
    const said = r.status === 200 && r.json ? r.json : {};
    return groupOf(g.url, said.nome, said.campos);
  }

  // → { token, usuario, nivel, permissoes, emitidoEm, expiraEm, permissoesUrl, refreshToken, renovarUrl, desconectarUrl }
  async enter(group, values) {
    const r = await this.call(group.endpoint, { method: 'POST', body: { ...group.fixos, ...values } });
    if (r.status === 429) throw new AccessError('limite', text(r.json && r.json.erro, 300) || 'Muitas tentativas seguidas. Espere um pouco e tente de novo.');
    if (r.status >= 500) throw new AccessError('rede', 'O servidor do grupo está com problema agora. Tente de novo daqui a pouco.');
    if (!r.json) throw notLogin();
    const login = loginOf(r, group.endpoint, group);
    if (!login) throw new AccessError('login', refusal(r.json));
    return login;
  }

  // A login from the refresh token, before (or after) the session ends; the old refresh token
  // stops working. 'sessao' when the group says no: log in again. 'rede' to try again later.
  async renew(s) {
    const r = await this.call(s.renovarUrl, { method: 'POST', token: s.refreshToken });
    if (r.status === 429 || r.status >= 500) throw new AccessError('rede', 'O servidor do grupo não respondeu agora.');
    const login = r.json && loginOf(r, s.renovarUrl, s);
    if (!login) throw new AccessError('sessao', 'A sua conexão com o grupo terminou.');
    return login;
  }

  // Leaving the group: its connection stops renewing on the server too. Never fails.
  async disconnect(s) {
    if (!s.desconectarUrl || !s.refreshToken) return;
    await this.call(s.desconectarUrl, { method: 'POST', token: s.refreshToken }).catch(() => {});
  }

  // What the session may use now → { permissoes, nivel }. 'sessao' once it is over.
  async check(s) {
    const r = await this.call(s.permissoesUrl, { token: s.token });
    if (r.status === 401 || r.status === 403) throw new AccessError('sessao', 'A sessão no grupo terminou.');
    if (r.status >= 500 || r.status === 429) throw new AccessError('rede', 'O servidor do grupo não respondeu agora.');
    if (r.status !== 200 || !r.json || !Array.isArray(r.json.permissoes)) throw notLogin();
    return { permissoes: permissionsOf(r.json.permissoes), nivel: text(r.json.nivel, 60) || s.nivel };
  }
}

module.exports = {
  PERMISSIONS,
  ALL,
  PAGES,
  commandPermission,
  loginUrl,
  groupOf,
  formInput,
  parseSession,
  stateOf,
  isOpen,
  allows,
  renewable,
  renewDue,
  AccessError,
  GroupApi,
};
