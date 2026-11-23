'use strict';

// Login APIs that answer like real ones (src/core/access.js), for the tests and for trying the
// Acesso page by hand:
//   node test/grupoFalso.js
// Two kinds:
//   - a Rota7 Gerenciador: only its standard login, which says nothing about the form (GET gives
//     a 404 page), answers errors with HTTP 200 and tipo_erro, and no permissoes: who has access
//     to the application gets in with everything;
//   - a system that declares its form (usuario, password) and gives permissions, with a URL to
//     check them again; changing them while it runs (setPermissions) shows up at the next check.
const http = require('http');
const crypto = require('crypto');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (user, ttl = 8 * 3600) => `${b64({ typ: 'JWT', alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + ttl, user })}.${crypto.randomBytes(16).toString('base64url')}`;

function serve(port, handle) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, body: raw });
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {}
      const send = (status, out, type = 'application/json') => {
        res.writeHead(status, { 'Content-Type': type });
        res.end(type === 'application/json' ? JSON.stringify(out) : out);
      };
      handle(req, body, send);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, calls, origin: `http://localhost:${server.address().port}` })));
}

// The Rota7 Gerenciador's /api/v1/autenticar. Users: comum@exemplo.com (has access to the
// application) and semacesso@exemplo.com (doesn't), password "teste".
async function startFakeGerenciador({ port = 0, chave = 'chave-de-teste', ttl } = {}) {
  const people = { 'comum@exemplo.com': { id: 1, nome: 'Comum', acesso: true }, 'semacesso@exemplo.com': { id: 2, nome: 'Sem acesso', acesso: false } };
  const { server, calls, origin } = await serve(port, (req, body, send) => {
    if (!req.url.startsWith('/Gerenciador/api/v1/autenticar')) return send(404, '<html>404</html>', 'text/html');
    if (req.method !== 'POST') return send(404, '<html>Pagina nao encontrada</html>', 'text/html');
    if (!body.email || !body.senha || !body.chave_aplicacao) return send(400, { status: 'erro', tipo_erro: '0101', mensagem: 'Credenciais invalidas.' });
    const p = people[body.email];
    if (!p || body.senha !== 'teste' || body.chave_aplicacao !== chave) return send(200, { status: 'erro', tipo_erro: '0101', mensagem: 'Credenciais invalidas.' });
    if (!p.acesso) return send(200, { status: 'erro', tipo_erro: '0103', mensagem: 'Credenciais invalidas.' });
    const acessos = [{ ID_APLICACAO: 42, APLICACAO_NOME: 'ai-switcher', APLICACAO_CHAVE: chave, NIVEL_ACESSO: 'COMUM', DESCRICAO_ACESSO: 'COMUM' }];
    const usuario = { id: p.id, nome: p.nome, email: body.email, acessos };
    return send(200, { status: 'ok', token: jwt(usuario, ttl), usuario });
  });
  return { url: `${origin}/Gerenciador/api/v1/autenticar?chave_aplicacao=${chave}`, calls, close: () => new Promise((r) => server.close(r)) };
}

// A system with its own form and permissions. Users: admin (everything) and operador, password
// "teste", and the code "123456".
async function startFakeGroup({ port = 0, nome = 'Empresa X' } = {}) {
  const grants = { admin: ['*'], operador: ['aprovacoes', 'contas.usar'] };
  const tokens = new Map();
  const { server, calls, origin } = await serve(port, (req, body, send) => {
    if (req.url === '/auth/login' && req.method === 'GET') {
      return send(200, { nome, campos: [{ nome: 'usuario', rotulo: 'Usuário' }, { nome: 'password', rotulo: 'Senha', tipo: 'password' }, { nome: 'codigo', rotulo: 'Código do autenticador' }] });
    }
    if (req.url === '/auth/login' && req.method === 'POST') {
      if (!grants[body.usuario] || body.password !== 'teste' || body.codigo !== '123456') return send(401, { erro: 'Usuário, senha ou código não conferem.' });
      const token = crypto.randomBytes(24).toString('hex');
      tokens.set(token, body.usuario);
      return send(200, { access_token: token, expires_in: 3600, usuario: { nome: body.usuario, nivel: body.usuario.toUpperCase() }, permissoes: grants[body.usuario], permissoes_url: `${origin}/auth/permissoes` });
    }
    if (req.url === '/auth/permissoes' && req.method === 'GET') {
      const who = tokens.get(String(req.headers.authorization || '').replace(/^Bearer /, ''));
      if (!who) return send(401, { erro: 'Sessão encerrada.' });
      return send(200, { permissoes: grants[who] });
    }
    return send(404, { erro: 'Rota não encontrada.' });
  });
  return {
    url: `${origin}/auth/login`,
    calls,
    setPermissions: (who, list) => (grants[who] = list),
    endSessions: () => tokens.clear(),
    close: () => new Promise((r) => server.close(r)),
  };
}

if (require.main === module) {
  Promise.all([startFakeGerenciador({ port: 7318 }), startFakeGroup({ port: 7317 })]).then(([r7, x]) =>
    console.log(
      `Gerenciador de teste (login padrão, sem permissões): ${r7.url}\n  comum@exemplo.com e semacesso@exemplo.com, senha "teste"\n` +
        `Sistema com formulário próprio e permissões: ${x.url}\n  usuário admin ou operador, senha "teste", código 123456`,
    ),
  );
}

module.exports = { startFakeGerenciador, startFakeGroup };
