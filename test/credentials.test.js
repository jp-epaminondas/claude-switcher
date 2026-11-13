'use strict';

// Credentials: the encrypted vault, the server.md import, and `segredo` using a value without
// ever printing it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Vault } = require('../src/core/vault');
const { SecretHost } = require('../src/core/secretBus');
const { parseServerMd } = require('../src/core/serverMd');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-switcher-cred-'));
const SECRET = 's3cr3t-Pw#2026';

test('vault: encrypted at rest, names readable while locked, wrong password refused', async () => {
  const dir = tmpDir();
  const v = new Vault(dir);
  await assert.rejects(v.create('curta'), /8 caracteres/);
  await v.create('senha mestra boa');
  const e = await v.addEntry('SERVER SSH', [
    { name: 'Host', value: '10.0.0.1', secret: false },
    { name: 'Senha', value: SECRET, secret: true },
  ]);
  await v.setField(e.id, null, { name: 'Senha', value: 'outra-senha-123', secret: true });
  assert.deepEqual(
    v.entries()[0].fields.map((f) => f.ref),
    ['host', 'senha', 'senha-2'],
  );

  const raw = fs.readFileSync(path.join(dir, 'credenciais.vault'), 'utf8');
  assert.ok(!raw.includes(SECRET) && !raw.includes('10.0.0.1'), 'no value in the clear');
  assert.ok(raw.includes('SERVER SSH'), 'names are');

  v.lock();
  assert.equal(v.unlocked, false);
  assert.deepEqual(
    v.catalog().entries.map((x) => [x.ref, x.fields.map((f) => [f.ref, f.secret])]),
    [['server-ssh', [['host', false], ['senha', true], ['senha-2', true]]]],
  );
  assert.throws(() => v.resolve('server-ssh.senha'), /trancado/);
  await assert.rejects(v.unlock('errada'), /senha mestra errada/);

  // Another window: same file, unlocked with the key the first one hands over.
  const other = new Vault(dir);
  await v.unlock('senha mestra boa');
  assert.equal(v.resolve('server-ssh.senha').field.value, SECRET);
  assert.throws(() => v.resolve('server-ssh.nada'), /tem: host, senha, senha-2/);
  assert.equal(other.adoptKey(Buffer.alloc(32).toString('base64')), false);
  assert.equal(other.adoptKey(v.exportKey()), true);
  await v.renameEntry(e.id, 'Servidor produção');
  other.reload();
  assert.equal(other.entries()[0].ref, 'servidor-producao');

  await v.changeMaster('outra senha mestra');
  v.lock();
  await assert.rejects(v.unlock('senha mestra boa'), /errada/);
  await v.unlock('outra senha mestra');
  assert.equal(v.resolve('servidor-producao.senha').field.value, SECRET);
});

test('server.md: titles, then one value per line, named by what it looks like', () => {
  const text = [
    'Os projetos ficam nas pastas sandbox e production do servidor deste exemplo',
    '',
    'SERVER SSH',
    '/var/www/a',
    '/var/www/b',
    '10.0.0.1',
    'root',
    'Xy@123#abc',
    '',
    'SITE CLOUDFLARE',
    'ops@example.com',
    'Pass@2026',
    'sk-or-v1-0123456789abcdef0123456789abcdef',
    '',
    'api claude',
    'sk-ant-xyz0123456789abcdefghij',
    '',
    'SYNCTHING - LOGIN DOS PCS (ajustar-syncthing.bat)',
    'rota7',
    'Rota72205',
  ].join('\r\n');
  assert.deepEqual(
    parseServerMd(text).map((e) => [e.title, e.fields.map((f) => `${f.name}${f.secret ? '*' : ''}`)]),
    [
      ['Anotações', ['Nota']],
      ['SERVER SSH', ['Caminho', 'Caminho 2', 'Host', 'Usuário', 'Senha*']],
      ['SITE CLOUDFLARE', ['Login', 'Senha*', 'Chave*']],
      ['api claude', ['Chave*']],
      ['SYNCTHING - LOGIN DOS PCS (ajustar-syncthing.bat)', ['Usuário', 'Senha*']],
    ],
  );
});

// Runs src/hook/segredo.js against a window (SecretHost) backed by `vault`.
function segredo(dir, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'hook', 'segredo.js'), ...args], {
      env: { ...process.env, CLAUDE_SWITCHER_DIR: dir },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('segredo: lista shows names, exec injects values that never show up', async () => {
  const dir = tmpDir();
  const vault = new Vault(dir);
  await vault.create('senha mestra boa');
  await vault.addEntry('SERVER SSH', [{ name: 'Senha', value: SECRET, secret: true }]);
  let allow = true;
  const asked = [];
  const host = new SecretHost({
    switcherDir: dir,
    async handle(msg) {
      if (msg.op === 'list') return { ok: true, locked: !vault.unlocked, entries: vault.catalog().entries };
      asked.push(msg);
      if (!allow) return { ok: false, error: 'o usuário não liberou o cofre' };
      return { ok: true, values: Object.fromEntries(msg.refs.map((r) => [r, vault.resolve(r).field.value])) };
    },
  });
  host.start(true);
  try {
    const list = await segredo(dir, ['lista']);
    assert.equal(list.code, 0, list.stderr);
    assert.match(list.stdout, /\{\{server-ssh\.senha\}\}/);
    assert.ok(!list.stdout.includes(SECRET));

    // As a file: the command reads it, prints it, and the output is masked.
    const printFile = "const f=process.argv[1];console.log(f);console.log(require('fs').readFileSync(f,'utf8'))";
    const r = await segredo(dir, ['exec', '--', process.execPath, '-e', printFile, '{{arquivo:server-ssh.senha}}']);
    assert.equal(r.code, 0, r.stderr);
    const [file, shown] = r.stdout.trim().split(/\r?\n/);
    assert.equal(shown, '••••');
    assert.ok(!r.stdout.includes(SECRET));
    assert.equal(fs.existsSync(file), false, 'the temporary file is gone');
    assert.equal(asked[0].command.includes(SECRET), false);
    assert.match(asked[0].command, /\{\{arquivo:server-ssh\.senha\}\}/, 'the window sees the command with the ref');

    // In an env var and inline; the exit code comes through.
    const env = await segredo(dir, ['exec', '--env', 'PW=server-ssh.senha', '--', process.execPath, '-e', `process.exit(process.env.PW===${JSON.stringify(SECRET)}?7:1)`]);
    assert.equal(env.code, 7);
    const inline = await segredo(dir, ['exec', '--', process.execPath, '-e', 'console.error(process.argv[1])', '{{server-ssh.senha}}']);
    assert.equal(inline.stderr.trim(), '••••');

    allow = false;
    const denied = await segredo(dir, ['exec', '--', process.execPath, '-e', '0', '{{server-ssh.senha}}']);
    assert.equal(denied.code, 2);
    assert.match(denied.stderr, /não liberou/);
    const none = await segredo(dir, ['exec', '--', process.execPath, '-e', '0']);
    assert.match(none.stderr, /nenhuma credencial/);
  } finally {
    host.stop();
  }
});

test('segredo: no VS Code window, a clear error', async () => {
  const r = await segredo(tmpDir(), ['lista']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /nenhuma janela do VS Code/);
});
