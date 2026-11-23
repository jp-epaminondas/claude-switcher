'use strict';

// Acesso: the group's URL, the session kept between windows, what each command and page needs,
// and the talk with the group's API (a fake one on this computer).
const test = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../package.json');
const { PERMISSIONS, ALL, PAGES, commandPermission, groupUrl, parseSession, stateOf, allows, loginInput, GroupApi } = require('../src/core/access');
const { startFakeGroup } = require('./grupoFalso');

test('a URL do grupo precisa ser https, sem login nem parâmetros', () => {
  assert.deepEqual(groupUrl(' https://r7.com.br/Gerenciador/api/v1/claude-switcher/ '), { url: 'https://r7.com.br/Gerenciador/api/v1/claude-switcher' });
  assert.deepEqual(groupUrl('http://localhost:7317/grupo'), { url: 'http://localhost:7317/grupo' });
  assert.ok(groupUrl('http://r7.com.br/grupo').error);
  assert.ok(groupUrl('https://eu:senha@r7.com.br/grupo').error);
  assert.ok(groupUrl('https://r7.com.br/grupo?chave=1').error);
  assert.ok(groupUrl('r7.com.br').error);
  assert.ok(groupUrl('').error);
});

test('todo comando do package.json pede uma permissão conhecida', () => {
  for (const { command } of pkg.contributes.commands) {
    const p = commandPermission(command);
    assert.ok(p === null || Object.hasOwn(PERMISSIONS, p), `${command} caiu em ${p}`);
  }
  assert.equal(commandPermission('claudeSwitcher.cred.copyRef'), 'credenciais.usar');
  assert.equal(commandPermission('claudeSwitcher.cred.copy'), 'credenciais.gerenciar');
  assert.equal(commandPermission('claudeSwitcher.cred.reveal'), 'credenciais.gerenciar');
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
  assert.equal(stateOf(parseSession({ modo: 'outro' })), 'escolher');
  assert.equal(stateOf(parseSession({ modo: 'grupo', url: 'http://r7.com.br/x' })), 'escolher'); // http fora deste computador

  const livre = parseSession(JSON.stringify({ modo: 'livre' }));
  assert.equal(stateOf(livre), 'livre');
  assert.ok(allows(livre, 'travas') && allows(livre, ALL));

  const semLogin = parseSession({ modo: 'grupo', url: 'https://r7.com.br/g', nome: 'Rota7', token: 'tem espaço' });
  assert.equal(stateOf(semLogin), 'login');
  assert.equal(allows(semLogin, 'contas.usar'), false);
  assert.equal(allows(semLogin, null), true);

  const grupo = parseSession({ modo: 'grupo', url: 'https://r7.com.br/g', nome: 'Rota7', token: 'abc', nivel: 'OPERADOR', permissoes: ['aprovacoes', 'contas.usar', 'inventada', 7, 'constructor'], expiraEm: now + 60000 });
  assert.equal(stateOf(grupo, now), 'grupo');
  assert.deepEqual(grupo.permissoes, ['aprovacoes', 'contas.usar']);
  assert.ok(allows(grupo, 'aprovacoes', now));
  assert.equal(allows(grupo, 'travas', now), false);
  assert.equal(allows(grupo, ALL, now), false);
  assert.equal(stateOf(grupo, now + 60000), 'login'); // venceu

  const master = parseSession({ modo: 'grupo', url: 'https://r7.com.br/g', token: 'abc', permissoes: ['*'] });
  assert.equal(master.nome, 'r7.com.br');
  assert.ok(allows(master, 'travas') && allows(master, ALL));
});

test('login: e-mail e senha conferidos antes de ir para a API', () => {
  assert.deepEqual(loginInput(' maria@r7.com.br ', 's3nha'), { email: 'maria@r7.com.br', senha: 's3nha' });
  assert.ok(loginInput('maria', 's3nha').error);
  assert.ok(loginInput('maria@r7.com.br', '').error);
  assert.ok(loginInput('maria@r7.com.br', 'x'.repeat(2000)).error);
});

test('API do grupo: nome, login e permissões, e o nível que muda depois', async () => {
  const g = await startFakeGroup({ nome: 'Rota7' });
  try {
    const api = new GroupApi();
    assert.deepEqual(await api.info(g.url), { nome: 'Rota7' });

    const r = await api.enter(g.url, 'operador@exemplo.com', 'teste');
    assert.equal(r.usuario, 'Operador');
    assert.equal(r.nivel, 'OPERADOR');
    assert.deepEqual(r.permissoes, ['aprovacoes', 'contas.usar', 'credenciais.usar']);
    assert.ok(r.expiraEm > Date.now());
    const entrada = g.calls.find((c) => c.route === '/entrar');
    assert.deepEqual(JSON.parse(entrada.body), { email: 'operador@exemplo.com', senha: 'teste' });
    assert.ok(g.calls.filter((c) => c !== entrada).every((c) => !c.body.includes('teste')), 'a senha só vai para /entrar');

    g.setLevel('operador@exemplo.com', 'LEITURA');
    assert.deepEqual(await api.permissions(g.url, r.token), { nivel: 'LEITURA', permissoes: ['contas.usar'] });
    assert.equal(g.calls.at(-1).auth, `Bearer ${r.token}`);

    await assert.rejects(api.enter(g.url, 'operador@exemplo.com', 'errada'), { kind: 'login', message: 'E-mail ou senha inválidos.' });
    g.endSessions();
    await assert.rejects(api.permissions(g.url, r.token), { kind: 'sessao' });
    await assert.rejects(api.info(`${g.url}/nao-existe`), { kind: 'resposta' });
  } finally {
    await g.close();
  }
});

test('API do grupo: sem resposta, fora do ar, resposta estranha e redirecionamento', async () => {
  const answer = (status, body) => async () => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  await assert.rejects(new GroupApi({ fetch: async () => { throw new TypeError('fetch failed'); } }).info('https://x.com/g'), { kind: 'rede' });
  await assert.rejects(new GroupApi({ fetch: answer(502, '<html>') }).info('https://x.com/g'), { kind: 'rede' });
  await assert.rejects(new GroupApi({ fetch: answer(503, '') }).enter('https://x.com/g', 'a@b.c', 's'), { kind: 'rede' });
  await assert.rejects(new GroupApi({ fetch: answer(429, { erro: 'Calma.' }) }).enter('https://x.com/g', 'a@b.c', 's'), { kind: 'limite', message: 'Calma.' });
  await assert.rejects(new GroupApi({ fetch: answer(200, '<html>login</html>') }).info('https://x.com/g'), { kind: 'resposta' });
  await assert.rejects(new GroupApi({ fetch: answer(200, { token: 'abc' }) }).enter('https://x.com/g', 'a@b.c', 's'), { kind: 'resposta' });

  let init;
  await new GroupApi({ fetch: async (url, i) => ((init = i), answer(200, { nome: 'X' })()) }).info('https://x.com/g');
  assert.equal(init.redirect, 'error');
});
