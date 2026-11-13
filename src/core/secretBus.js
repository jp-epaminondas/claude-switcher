'use strict';

// How `segredo` (run by Claude) reaches the vault: every VS Code window listens on a local
// pipe of its own and registers it in <switcherDir>/segredo/<pid>.json with the last time it
// had focus. `segredo` asks the window used most recently, so the unlock prompt shows up where
// the user is. Windows also tell each other when the vault is unlocked or locked.
//
// Protocol: one JSON line in, one JSON line out, then the connection closes.
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const registryDir = (switcherDir) => path.join(switcherDir, 'segredo');

function pipePath(switcherDir, id) {
  if (process.platform === 'win32') {
    const user = os.userInfo().username.replace(/[^A-Za-z0-9_-]/g, '');
    return `\\\\.\\pipe\\claude-switcher-${user}-${id}`;
  }
  return path.join(registryDir(switcherDir), `${id}.sock`);
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

// The registered windows still running, most recently focused first.
function windows(switcherDir) {
  const dir = registryDir(switcherDir);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      const w = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (alive(w.pid)) out.push(w);
      else fs.unlinkSync(path.join(dir, n));
    } catch {}
  }
  return out.sort((a, b) => (b.focusedAt || 0) - (a.focusedAt || 0));
}

// Sends one message to one pipe and resolves to the answer.
function send(pipe, msg, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipe);
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('sem resposta'));
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

class SecretHost {
  // `handle(msg)` answers a request (async); see credentialsView.js.
  constructor({ switcherDir, handle, log = () => {} }) {
    this.switcherDir = switcherDir;
    this.handle = handle;
    this.log = log;
    this.id = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    this.pipe = pipePath(switcherDir, this.id);
    this.file = path.join(registryDir(switcherDir), `${this.id}.json`);
    this.server = null;
    this.focusedAt = 0;
  }

  start(focused = false) {
    fs.mkdirSync(registryDir(this.switcherDir), { recursive: true });
    this.server = net.createServer((sock) => {
      let buf = '';
      let done = false;
      sock.on('error', () => {});
      sock.on('data', async (d) => {
        if (done) return;
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        done = true;
        const line = buf.slice(0, nl);
        let out;
        try {
          out = await this.handle(JSON.parse(line));
        } catch (e) {
          out = { ok: false, error: e.message };
        }
        if (!sock.destroyed) sock.end(`${JSON.stringify(out)}\n`);
      });
    });
    this.server.on('error', (e) => this.log(`segredo: ${e.message}`));
    this.server.listen(this.pipe);
    this.touch(focused);
  }

  // Records that this window has (or had) the focus.
  touch(focused) {
    if (focused) this.focusedAt = Date.now();
    try {
      fs.writeFileSync(this.file, JSON.stringify({ pid: process.pid, id: this.id, pipe: this.pipe, focusedAt: this.focusedAt }));
    } catch {}
  }

  // Tells every other window (unlock / lock), without waiting on the ones that don't answer.
  async broadcast(msg) {
    const others = windows(this.switcherDir).filter((w) => w.id !== this.id);
    await Promise.all(others.map((w) => send(w.pipe, msg, 2000).catch(() => null)));
  }

  stop() {
    if (this.server) this.server.close();
    try {
      fs.unlinkSync(this.file);
    } catch {}
  }
}

module.exports = { SecretHost, windows, send, pipePath, registryDir };
