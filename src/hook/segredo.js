#!/usr/bin/env node
'use strict';

// Lets Claude use a password or key from the Claude Switcher vault without ever seeing it.
// Copied to ~/.claude-switcher/segredo.js; standalone (Node only, nothing from the extension).
//
//   node ~/.claude-switcher/segredo.js lista
//   node ~/.claude-switcher/segredo.js exec [--env NOME=credencial.campo]... -- comando [args...]
//
// In the command and its args, {{credencial.campo}} becomes the value and
// {{arquivo:credencial.campo}} the path of a temporary file holding it (deleted at the end).
// The VS Code window asks for the master password when the vault is locked. Anything the
// command prints goes through a mask, so a value that shows up comes out as ••••.
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SWITCHER_DIR = process.env.CLAUDE_SWITCHER_DIR || path.join(os.homedir(), '.claude-switcher');
const REGISTRY = path.join(SWITCHER_DIR, 'segredo');
const REF = /\{\{(arquivo:)?([a-z0-9-]+\.[a-z0-9-]+)\}\}/g;
const ASK_TIMEOUT_MS = 3 * 60 * 1000; // time to type the master password

const USAGE = `uso:
  segredo lista
      o que existe no cofre (nomes, nunca valores)
  segredo exec [--env NOME=credencial.campo]... -- comando [args...]
      roda o comando com os valores injetados:
        {{credencial.campo}}          vira o valor
        {{arquivo:credencial.campo}}  vira o caminho de um arquivo temporário com o valor
      ex.: segredo exec -- plink -batch -pwfile {{arquivo:server-ssh.senha}} root@host "uptime"
      no Git Bash, prefixe MSYS_NO_PATHCONV=1 quando houver caminho começando com /`;

function fail(msg, code = 2) {
  process.stderr.write(`segredo: ${msg}\n`);
  process.exit(code);
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

function windows() {
  let names = [];
  try {
    names = fs.readdirSync(REGISTRY).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      const w = JSON.parse(fs.readFileSync(path.join(REGISTRY, n), 'utf8'));
      if (alive(w.pid)) out.push(w);
    } catch {}
  }
  return out.sort((a, b) => (b.focusedAt || 0) - (a.focusedAt || 0));
}

function send(pipe, msg, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipe);
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('o VS Code não respondeu a tempo'));
    }, timeoutMs);
    sock.on('connect', () => sock.write(`${JSON.stringify(msg)}\n`));
    sock.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      sock.end();
      try {
        resolve(JSON.parse(buf.slice(0, nl)));
      } catch (e) {
        reject(e);
      }
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// Asks the window used most recently; the next one if it is gone.
async function ask(msg, timeoutMs) {
  const list = windows();
  if (!list.length) fail('nenhuma janela do VS Code com o Claude Switcher está aberta');
  let last;
  for (const w of list) {
    try {
      return await send(w.pipe, msg, timeoutMs);
    } catch (e) {
      last = e;
      if (e.message === 'o VS Code não respondeu a tempo') break;
    }
  }
  fail(last ? last.message : 'não consegui falar com o VS Code');
}

async function lista() {
  const r = await ask({ op: 'list' }, 10000);
  if (!r.ok) fail(r.error);
  if (!r.entries.length) {
    process.stdout.write('o cofre está vazio\n');
    return;
  }
  process.stdout.write(`cofre ${r.locked ? 'trancado (pede a senha mestra no primeiro uso)' : 'destrancado'}\n`);
  const field = (e, f, pad) => process.stdout.write(`${pad}{{${e.ref}.${f.ref}}}  ${f.name}${f.secret ? '' : ' (não secreto)'}\n`);
  // Accounts (PHPMYADMIN -> master, cliente X) under their entry, whose own fields serve them all.
  for (const e of r.entries.filter((x) => !x.parentId)) {
    process.stdout.write(`\n${e.title}\n`);
    for (const f of e.fields) field(e, f, '  ');
    for (const a of r.entries.filter((x) => x.parentId === e.id)) {
      process.stdout.write(`  conta ${a.title}\n`);
      for (const f of a.fields) field(a, f, '    ');
    }
  }
}

// Replaces every value in a chunk of output with ••••.
function masker(values) {
  const list = [...new Set(values.filter((v) => v && v.length >= 4))].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const v of list) out = out.split(v).join('••••');
    return out;
  };
}

async function exec(argv) {
  const sep = argv.indexOf('--');
  if (sep < 0 || sep === argv.length - 1) fail(`falta o comando depois de --\n${USAGE}`);
  const opts = argv.slice(0, sep);
  const cmd = argv.slice(sep + 1);
  const envRefs = {};
  for (let i = 0; i < opts.length; i++) {
    if (opts[i] !== '--env' || !opts[i + 1]) fail(`opção desconhecida: ${opts[i]}\n${USAGE}`);
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=([a-z0-9-]+\.[a-z0-9-]+)$/.exec(opts[++i]);
    if (!m) fail(`--env espera NOME=credencial.campo, veio "${opts[i]}"`);
    envRefs[m[1]] = m[2];
  }
  const refs = new Set(Object.values(envRefs));
  for (const a of cmd) for (const m of a.matchAll(REF)) refs.add(m[2]);
  if (!refs.size) fail('nenhuma credencial no comando ({{credencial.campo}} ou --env)');

  const preview = cmd.join(' ').slice(0, 300);
  const r = await ask({ op: 'resolve', refs: [...refs], command: preview, cwd: process.cwd() }, ASK_TIMEOUT_MS);
  if (!r.ok) fail(r.error);
  const values = r.values;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'segredo-'));
  const files = new Map();
  const fileFor = (ref) => {
    if (!files.has(ref)) {
      const f = path.join(tmp, crypto.randomBytes(6).toString('hex'));
      fs.writeFileSync(f, values[ref], { mode: 0o600 });
      files.set(ref, f);
    }
    return files.get(ref);
  };
  const cleanup = () => {
    for (const f of files.values()) {
      try {
        fs.writeFileSync(f, Buffer.alloc(64));
        fs.unlinkSync(f);
      } catch {}
    }
    try {
      fs.rmdirSync(tmp);
    } catch {}
  };

  const args = cmd.map((a) => a.replace(REF, (_, asFile, ref) => (asFile ? fileFor(ref) : values[ref])));
  const env = { ...process.env };
  for (const [name, ref] of Object.entries(envRefs)) env[name] = values[ref];
  const mask = masker(Object.values(values));

  let child;
  try {
    child = spawn(args[0], args.slice(1), { env, stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    cleanup();
    fail(mask(e.message));
  }
  child.stdout.on('data', (d) => process.stdout.write(mask(d.toString())));
  child.stderr.on('data', (d) => process.stderr.write(mask(d.toString())));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
  child.on('error', (e) => {
    cleanup();
    fail(mask(e.code === 'ENOENT' ? `comando não encontrado: ${cmd[0]}` : e.message), 127);
  });
  child.on('close', (code, signal) => {
    cleanup();
    process.exit(code == null ? (signal ? 1 : 0) : code);
  });
}

const [op, ...rest] = process.argv.slice(2);
if (op === 'lista' || op === 'list') lista().catch((e) => fail(e.message));
else if (op === 'exec') exec(rest).catch((e) => fail(e.message));
else {
  process.stdout.write(`${USAGE}\n`);
  process.exit(op ? 2 : 0);
}
