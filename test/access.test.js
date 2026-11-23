'use strict';

// Acesso: the login URL, the form the API asks for, the session kept between windows, what each
// command and page needs, and the talk with login APIs (fake ones on this computer).
const test = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../package.json');
const { PERMISSIONS, ALL, PAGES, commandPermission, loginUrl, groupOf, formInput, parseSession, stateOf, allows, renewable, renewDue, GroupApi } = require('../src/core/access');
const { startFakeGerenciador, startFakeGroup } = require('./grupoFalso');

test('a URL de login: https, sem usuário na URL, e o que vem depois do ? vai no corpo', () => {
  const g = loginUrl(' https://www.rota7solutions.com.br/Gerenciador/api/v1/autenticar?chave_aplicacao=abc123 ');
  assert.deepEqual(g, {
    url: 'https://www.rota7solutions.com.br/Gerenciador/api/v1/autenticar?chave_aplicacao=abc123',
    endpoint: 'https://www.rota7solutions.com.br/Gerenciador/api/v1/autenticar',
    fixos: { chave_aplicacao: 'abc123' },
    host: 'www.rota7solutions.com.br',
  });
  assert.equal(loginUrl('http://localhost:7317/auth/login').url, 'http://localhost:7317/auth/login');
  assert.ok(loginUrl('http://r7.com.br/login').error);
  assert.ok(loginUrl('https://eu:senha@r7.com.br/login').error);
  assert.ok(loginUrl('https://r7.com.br/login?a%20b=1').error);
  assert.ok(loginUrl('r7.com.br').error);
  assert.equal(groupOf('https://www.rota7solutions.com.br/x').nome, 'rota7solutions.com.br');
});

test('o formulário: os campos que a API pediu, ou e-mail e senha', () => {
  const padrao = groupOf('https://r7.com.br/login').campos;
  assert.deepEqual(padrao.map((c) => [c.nome, c.tipo]), [['email', 'email'], ['senha', 'password']]);
  const proprio = groupOf('https://r7.com.br/login', 'X', [{ nome: 'usuario' }, { nome: 'password', rotulo: 'Senha', tipo: 'password' }, { nome: 'usuario' }, { nome: '<script>' }, { nome: 'pin', tipo: 'outro' }]).campos;
  assert.deepEqual(proprio, [
    { nome: 'usuario', rotulo: 'usuario', tipo: 'text' },
    { nome: 'password', rotulo: 'Senha', tipo: 'password' },
    { nome: 'pin', rotulo: 'pin', tipo: 'text' },
  ]);
  assert.deepEqual(formInput(padrao, { email: ' maria@r7.com.br ', senha: ' s3nha ', extra: 'x' }), { values: { email: 'maria@r7.com.br', senha: ' s3nha ' } });
  assert.ok(formInput(padrao, { email: 'maria', senha: 's' }).error);
  assert.equal(formInput(padrao, { email: 'maria@r7.com.br' }).error, 'Preencha: Senha.');
  assert.ok(formInput(padrao, { email: 'maria@r7.com.br', senha: 'x'.repeat(2000) }).error);
});

test('todo comando do package.json pede uma permissão conhecida', () => {
  for (const { command } of pkg.contributes.commands) {
    const p = commandPermission(command);
    assert.ok(p === null || Object.hasOwn(PERMISSIONS, p), `${command} caiu em ${p}`);
  }
  assert.equal(commandPermission('claudeSwitcher.cred.copyRef'), 'credenciais.usar');
  assert.equal(commandPermission('claudeSwitcher.cred.copy'), 'credenciais.gerenciar');
  assert.equal(commandPermission('claudeSwitcher.toggleApprovals'), 'configuracao');
  assert.equal(commandPermission('claudeSwitcher.approvalsAlert'), 'aprovacoes');
  assert.equal(commandPermission('claudeSwitcher.showAccessCurrent'), null);
  assert.equal(commandPermission('claudeSwitcher.algoNovo'), ALL);
});

test('toda página do painel tem a sua permissão', () => {
  for (const name of ['accounts', 'memories', 'skills', 'credentials', 'approvals', 'locks']) assert.ok(Object.hasOwn(PERMISSIONS, PAGES[name]), name);
  assert.equal(PAGES.access, null);
});

test('sessão: sem escolha, sem login, grupo sem login e grupo com login', () => {
  const now = Date.now();
  assert.equal(stateOf(parseSession(undefined)), 'escolher');
  assert.equal(stateOf(parseSession('{quebrado')), 'escolher');
  assert.equal(stateOf(parseSession({ modo: 'grupo', url: 'http://r7.com.br/login' })), 'escolher'); // http fora deste computador

  const livre = parseSession(JSON.stringify({ modo: 'livre' }));
  assert.equal(stateOf(livre), 'livre');
  assert.ok(allows(livre, 'travas') && allows(livre, ALL));

  const url = 'https://r7.com.br/login?chave_aplicacao=abc';
  const semLogin = parseSession({ modo: 'grupo', url, nome: 'Rota7', token: 'tem espaço' });
  assert.equal(stateOf(semLogin), 'login');
  assert.equal(allows(semLogin, 'contas.usar'), false);
  assert.equal(allows(semLogin, null), true);
  assert.deepEqual(semLogin.fixos, { chave_aplicacao: 'abc' });

  const grupo = parseSession({ modo: 'grupo', url, nome: 'Rota7', token: 'abc', nivel: 'COMUM', permissoes: ['aprovacoes', 'contas.usar', 'inventada', 7, 'constructor'], expiraEm: now + 60000, permissoesUrl: 'https://outro.com/p' });
  assert.equal(stateOf(grupo, now), 'grupo');
  assert.deepEqual(grupo.permissoes, ['aprovacoes', 'contas.usar']);
  assert.equal(grupo.permissoesUrl, null, 'conferência só no site do login');
  assert.ok(allows(grupo, 'aprovacoes', now));
  assert.equal(allows(grupo, 'travas', now), false);
  assert.equal(allows(grupo, ALL, now), false);
  assert.equal(stateOf(grupo, now + 60000), 'login'); // venceu

  const tudo = parseSession({ modo: 'grupo', url, token: 'abc', permissoes: ['*'] });
  assert.ok(allows(tudo, 'travas') && allows(tudo, ALL));
  assert.ok(tudo.expiraEm > now, 'sem validade: 12 h');
});

test('Gerenciador do Rota7: login padrão, sem formulário declarado e sem permissões', async () => {
  const r7 = await startFakeGerenciador({ chave: 'chave-x' });
  try {
    const api = new GroupApi();
    const group = await api.describe(r7.url);
    assert.deepEqual(group.campos.map((c) => c.nome), ['email', 'senha'], 'o GET dá 404: e-mail e senha');
    assert.equal(group.nome, 'localhost');

    const r = await api.enter(group, { email: 'comum@exemplo.com', senha: 'teste' });
    assert.equal(r.usuario, 'Comum');
    assert.deepEqual(r.permissoes, ['*'], 'sem permissoes na resposta: tudo');
    assert.ok(r.expiraEm > Date.now() + 7 * 3600 * 1000, 'a validade vem do exp do token');
    assert.equal(r.permissoesUrl, null);
    const login = r7.calls.find((c) => c.method === 'POST');
    assert.equal(login.url, '/Gerenciador/api/v1/autenticar', 'a chave não vai na URL');
    assert.deepEqual(JSON.parse(login.body), { chave_aplicacao: 'chave-x', email: 'comum@exemplo.com', senha: 'teste' });

    await assert.rejects(api.enter(group, { email: 'comum@exemplo.com', senha: 'errada' }), { kind: 'login', message: 'Não foi possível entrar com esses dados (código 0101).' });
    await assert.rejects(api.enter(group, { email: 'semacesso@exemplo.com', senha: 'teste' }), { kind: 'login', message: 'Não foi possível entrar com esses dados (código 0103).' });
  } finally {
    await r7.close();
  }
});

test('sistema com formulário próprio e permissões que mudam depois', async () => {
  const x = await startFakeGroup({ nome: 'Empresa X' });
  try {
    const api = new GroupApi();
    const group = await api.describe(x.url);
    assert.equal(group.nome, 'Empresa X');
    assert.deepEqual(group.campos.map((c) => c.nome), ['usuario', 'password', 'codigo']);

    const values = formInput(group.campos, { usuario: 'operador', password: 'teste', codigo: '123456' }).values;
    const r = await api.enter(group, values);
    assert.equal(r.nivel, 'OPERADOR');
    assert.deepEqual(r.permissoes, ['aprovacoes', 'contas.usar']);
    assert.ok(Math.abs(r.expiraEm - (Date.now() + 3600 * 1000)) < 5000, 'expires_in');
    assert.equal(r.permissoesUrl, `${new URL(x.url).origin}/auth/permissoes`);

    const s = { ...group, ...r };
    x.setPermissions('operador', ['contas.usar']);
    assert.deepEqual(await api.check(s), { permissoes: ['contas.usar'], nivel: 'OPERADOR' });
    assert.equal(x.calls.at(-1).auth, `Bearer ${r.token}`);

    await assert.rejects(api.enter(group, { ...values, codigo: '000000' }), { kind: 'login', message: 'Usuário, senha ou código não conferem.' });
    x.endSessions();
    await assert.rejects(api.check(s), { kind: 'sessao' });
  } finally {
    await x.close();
  }
});

test('API de login: sem resposta, fora do ar, resposta estranha e redirecionamento', async () => {
  const answer = (status, body) => async () => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const group = groupOf('https://x.com/login');
  const values = { email: 'a@b.c', senha: 's' };
  await assert.rejects(new GroupApi({ fetch: async () => { throw new TypeError('fetch failed'); } }).describe('https://x.com/login'), { kind: 'rede' });
  await assert.rejects(new GroupApi({ fetch: answer(503, '') }).enter(group, values), { kind: 'rede' });
  await assert.rejects(new GroupApi({ fetch: answer(429, { erro: 'Calma.' }) }).enter(group, values), { kind: 'limite', message: 'Calma.' });
  await assert.rejects(new GroupApi({ fetch: answer(200, '<html>login</html>') }).enter(group, values), { kind: 'resposta' });
  await assert.rejects(new GroupApi({ fetch: answer(200, { ok: true }) }).enter(group, values), { kind: 'login' });
  assert.deepEqual((await new GroupApi({ fetch: answer(200, '<html>') }).describe('https://x.com/login')).campos.map((c) => c.nome), ['email', 'senha']);

  let init;
  await new GroupApi({ fetch: async (url, i) => ((init = i), answer(200, { token: 'abc' })()) }).enter(group, values);
  assert.equal(init.redirect, 'error');
});

test('manter conectado: renova com o refresh token, que vale uma vez só, e desconecta', async () => {
  const r7 = await startFakeGerenciador({ chave: 'chave-x', manterConectado: true });
  try {
    const api = new GroupApi();
    const group = await api.describe(r7.url);
    const first = await api.enter(group, { email: 'comum@exemplo.com', senha: 'teste' });
    const base = new URL(r7.url).origin;
    assert.match(first.refreshToken, /^[a-f0-9]{64}$/);
    assert.equal(first.renovarUrl, `${base}/Gerenciador/api/v1/renovar`, 'relativa ao login');
    assert.equal(first.desconectarUrl, `${base}/Gerenciador/api/v1/desconectar`);

    const s1 = parseSession({ modo: 'grupo', url: group.url, nome: group.nome, campos: group.campos, ...first });
    assert.ok(renewable(s1));
    assert.equal(renewDue(s1), false, 'token novo: ainda não é hora');
    assert.ok(renewDue(s1, s1.expiraEm - 60 * 1000), 'no fim da vida: renova');
    assert.ok(renewDue({ ...s1, expiraEm: Date.now() - 1000 }), 'vencido: renova');

    const second = await api.renew(s1);
    assert.notEqual(second.token, first.token);
    assert.notEqual(second.refreshToken, first.refreshToken);
    const renovar = r7.calls.find((c) => c.url === '/Gerenciador/api/v1/renovar');
    assert.equal(renovar.auth, `Bearer ${first.refreshToken}`, 'o refresh token vai no header');
    assert.equal(renovar.body, '', 'e não no corpo');

    // O antigo de novo: a conexão inteira cai, inclusive o token novo.
    await assert.rejects(api.renew(s1), { kind: 'sessao' });
    const s2 = { ...s1, ...second };
    await assert.rejects(api.renew(s2), { kind: 'sessao' });

    const other = await api.enter(group, { email: 'comum@exemplo.com', senha: 'teste' });
    const s3 = { ...s1, ...other };
    await api.disconnect(s3);
    await assert.rejects(api.renew(s3), { kind: 'sessao' });

    assert.equal(parseSession({ modo: 'grupo', url: group.url, token: 'a', refreshToken: 'b', renovarUrl: 'https://outro.com/renovar' }).renovarUrl, null, 'renovação só no site do login');
    assert.equal(renewable(parseSession({ modo: 'grupo', url: group.url, token: 'a', permissoes: ['*'] })), false, 'sem refresh token: não renova');
  } finally {
    await r7.close();
  }
});
