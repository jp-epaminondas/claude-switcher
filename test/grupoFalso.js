'use strict';

// A group API that answers like the real one (src/core/access.js), for the tests and for
// trying the Acesso page by hand:
//   node test/grupoFalso.js     → http://localhost:7317/grupo
// Users: admin@exemplo.com (MASTER, everything) and operador@exemplo.com (OPERADOR), both with
// the password "teste". Levels and what they allow are in LEVELS; changing a user's level
// while it runs (setLevel) shows up at the extension's next check.
const http = require('http');
const crypto = require('crypto');

const LEVELS = {
  MASTER: ['*'],
  OPERADOR: ['contas.usar', 'aprovacoes', 'credenciais.usar'],
  LEITURA: ['contas.usar'],
};

function startFakeGroup({ port = 0, nome = 'Grupo de teste', base = '/grupo', users } = {}) {
  const people = users || {
    'admin@exemplo.com': { senha: 'teste', nome: 'Admin', nivel: 'MASTER' },
    'operador@exemplo.com': { senha: 'teste', nome: 'Operador', nivel: 'OPERADOR' },
  };
  const tokens = new Map(); // token → e-mail
  const calls = [];
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const answerOf = (email) => ({ nivel: people[email].nivel, permissoes: LEVELS[people[email].nivel] || [] });

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const route = req.url.startsWith(base) ? req.url.slice(base.length) || '/' : null;
      calls.push({ method: req.method, route, auth: req.headers.authorization || null, body: raw });
      if (route === '/' && req.method === 'GET') return json(res, 200, { nome });
      if (route === '/entrar' && req.method === 'POST') {
        let body = {};
        try {
          body = JSON.parse(raw);
        } catch {}
        const p = people[body.email];
        if (!p || p.senha !== body.senha) return json(res, 401, { erro: 'E-mail ou senha inválidos.' });
        const token = crypto.randomBytes(24).toString('hex');
        tokens.set(token, body.email);
        return json(res, 200, { token, expira_em: new Date(Date.now() + 8 * 3600 * 1000).toISOString(), usuario: { nome: p.nome, nivel: p.nivel }, ...answerOf(body.email) });
      }
      if (route === '/permissoes' && req.method === 'GET') {
        const email = tokens.get(String(req.headers.authorization || '').replace(/^Bearer /, ''));
        if (!email) return json(res, 401, { erro: 'Sessão encerrada.' });
        return json(res, 200, answerOf(email));
      }
      return json(res, 404, { erro: 'Rota não encontrada.' });
    });
  });

  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () =>
      resolve({
        url: `http://localhost:${server.address().port}${base}`,
        calls,
        setLevel: (email, nivel) => (people[email].nivel = nivel),
        endSessions: () => tokens.clear(),
        close: () => new Promise((r) => server.close(r)),
      }),
    ),
  );
}

if (require.main === module) {
  startFakeGroup({ port: 7317 }).then((g) => console.log(`Grupo de teste em ${g.url}\nadmin@exemplo.com / operador@exemplo.com, senha "teste"`));
}

module.exports = { startFakeGroup, LEVELS };
