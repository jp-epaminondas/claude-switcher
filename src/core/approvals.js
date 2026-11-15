'use strict';

// Aprovações: the permission requests the hook (src/hook/approval-hook.js) drops in
// ~/.claude-switcher/approvals/, and the VS Code windows that can answer them. Every window
// sees every request; the first answer wins. Each window keeps a card in windows/ saying which
// folders it has open and when it last had the focus, so a request can be traced to the window
// its conversation is in, and the window the user is looking at is the one that speaks up.
const fs = require('fs');
const path = require('path');

const MAX_AGE_MS = 61 * 60 * 1000; // the hook gives up after 59 min
const LEFTOVER_MS = 5 * 60 * 1000;
const WINDOW_FRESH_MS = 45 * 1000; // a window rewrites its card every 15s
const plainId = (id) => typeof id === 'string' && /^[\w-]{1,100}$/.test(id);

const win = process.platform === 'win32';
const keyOf = (p) => {
  const r = path.resolve(p).replace(/\\/g, '/').replace(/\/$/, '');
  return win ? r.toLowerCase() : r;
};
const inside = (file, folder) => {
  const f = keyOf(file);
  const d = keyOf(folder);
  return f === d || f.startsWith(`${d}/`);
};

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const unlink = (file) => {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
};

class Approvals {
  constructor(switcherDir, { alive = pidAlive } = {}) {
    this.dir = path.join(switcherDir, 'approvals');
    this.windowsDir = path.join(this.dir, 'windows');
    this.alive = alive;
  }

  // The hook only waits while some window touched this in the last minute.
  heartbeat() {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, '.alive');
    const now = new Date();
    try {
      fs.utimesSync(file, now, now);
    } catch {
      fs.writeFileSync(file, '');
    }
  }

  // Requests still waiting, oldest first. Ones whose hook is gone are cleared away.
  pending(now = Date.now()) {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      if (!name.endsWith('.req')) {
        if (/\.(res|tmp)$/.test(name)) this.dropLeftover(file, now);
        continue;
      }
      const req = readJson(file);
      const id = name.slice(0, -'.req'.length);
      if (!req || req.id !== id || !plainId(id)) {
        this.dropLeftover(file, now);
        continue;
      }
      if (now - req.at > MAX_AGE_MS || !this.alive(req.pid)) {
        unlink(file);
        continue;
      }
      if (fs.existsSync(path.join(this.dir, `${id}.res`))) continue; // answered, the hook is on it
      out.push(req);
    }
    return out.sort((a, b) => a.at - b.at);
  }

  // Answers a request. False when it was already answered or is gone.
  answer(id, res) {
    if (!plainId(id) || !fs.existsSync(path.join(this.dir, `${id}.req`))) return false;
    const file = path.join(this.dir, `${id}.res`);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(res), { mode: 0o600 });
    try {
      fs.linkSync(tmp, file); // fails if another window answered first; never half written
      return true;
    } catch (e) {
      if (e.code === 'EEXIST') return false;
      throw e;
    } finally {
      unlink(tmp);
    }
  }

  dropLeftover(file, now) {
    try {
      if (now - fs.statSync(file).mtimeMs > LEFTOVER_MS) fs.unlinkSync(file);
    } catch {}
  }

  // --- windows ---

  saveWindow(info) {
    if (!plainId(info.id)) return;
    fs.mkdirSync(this.windowsDir, { recursive: true });
    const file = path.join(this.windowsDir, `${info.id}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(info));
    fs.renameSync(`${file}.tmp`, file);
  }

  removeWindow(id) {
    if (!plainId(id)) return;
    unlink(path.join(this.windowsDir, `${id}.json`));
    unlink(path.join(this.windowsDir, `${id}.focus`));
  }

  // Windows still open. A window that stopped rewriting its card was closed or crashed.
  windows(now = Date.now()) {
    let names;
    try {
      names = fs.readdirSync(this.windowsDir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.windowsDir, name);
      let at = 0;
      try {
        at = fs.statSync(file).mtimeMs;
      } catch {}
      const w = readJson(file);
      if (!w || now - at > WINDOW_FRESH_MS || !this.alive(w.pid)) {
        if (now - at > LEFTOVER_MS) unlink(file);
        continue;
      }
      out.push(w);
    }
    return out;
  }

  // Asks another window to bring a conversation to the front.
  askFocus(windowId, session) {
    if (!plainId(windowId) || !plainId(session)) return;
    fs.mkdirSync(this.windowsDir, { recursive: true });
    fs.writeFileSync(path.join(this.windowsDir, `${windowId}.focus`), JSON.stringify({ session, at: Date.now() }));
  }

  // The conversation some window asked this one to show, once.
  takeFocus(windowId, now = Date.now()) {
    if (!plainId(windowId)) return null;
    const file = path.join(this.windowsDir, `${windowId}.focus`);
    const ask = readJson(file);
    if (!ask && !fs.existsSync(file)) return null;
    unlink(file);
    return ask && plainId(ask.session) && now - ask.at < 30 * 1000 ? ask.session : null;
  }
}

// The window a request came from: the one the conversation was opened in, or else the one with
// its folder open (the deepest folder wins). null when no open window fits.
function ownerOf(req, windows) {
  if (req.window) {
    const w = windows.find((x) => x.id === req.window);
    if (w) return w;
  }
  if (!req.cwd) return null;
  let best = null;
  let depth = -1;
  for (const w of windows) {
    for (const f of w.folders || []) {
      if (inside(req.cwd, f) && keyOf(f).length > depth) {
        best = w;
        depth = keyOf(f).length;
      }
    }
  }
  return best;
}

// The window the user is in: the one that had the focus last.
const currentWindow = (windows) => windows.reduce((a, b) => (!a || (b.focusedAt || 0) > (a.focusedAt || 0) ? b : a), null);

// --- how a request reads on the panel ---

const rel = (file, cwd) => {
  if (typeof file !== 'string') return '';
  if (cwd && inside(file, cwd)) return path.relative(cwd, file).replace(/\\/g, '/') || file;
  return file.replace(/\\/g, '/');
};
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v, null, 2));

// verb: what Claude wants to do; target: on what; body: what to show below.
function describeTool(req) {
  const i = req.input && typeof req.input === 'object' ? req.input : {};
  const cwd = req.root || req.cwd;
  switch (req.tool) {
    case 'Bash':
    case 'PowerShell':
      return { verb: req.tool === 'Bash' ? 'Rodar comando' : 'Rodar no PowerShell', target: str(i.description), body: { kind: 'code', text: str(i.command) } };
    case 'Edit':
      return { verb: 'Editar arquivo', target: rel(i.file_path, cwd), body: { kind: 'diff', old: str(i.old_string), new: str(i.new_string) } };
    case 'MultiEdit':
      return {
        verb: 'Editar arquivo',
        target: rel(i.file_path, cwd),
        body: { kind: 'diffs', edits: (Array.isArray(i.edits) ? i.edits : []).map((e) => ({ old: str(e && e.old_string), new: str(e && e.new_string) })) },
      };
    case 'Write':
      return { verb: 'Criar ou reescrever arquivo', target: rel(i.file_path, cwd), body: { kind: 'code', text: str(i.content) } };
    case 'NotebookEdit':
      return { verb: 'Editar notebook', target: rel(i.notebook_path, cwd), body: { kind: 'code', text: str(i.new_source) } };
    case 'Read':
      return { verb: 'Ler arquivo', target: rel(i.file_path, cwd), body: null };
    case 'Glob':
    case 'Grep':
      return { verb: 'Procurar arquivos', target: str(i.pattern), body: i.path ? { kind: 'text', text: rel(i.path, cwd) } : null };
    case 'WebFetch':
      return { verb: 'Abrir página', target: str(i.url), body: i.prompt ? { kind: 'text', text: str(i.prompt) } : null };
    case 'WebSearch':
      return { verb: 'Pesquisar na web', target: str(i.query), body: null };
    case 'ExitPlanMode':
      return { verb: 'Aprovar o plano', target: '', body: { kind: 'text', text: str(i.plan) } };
    case 'AskUserQuestion': {
      const qs = Array.isArray(i.questions) ? i.questions : [];
      return { verb: 'Pergunta para você', target: '', body: { kind: 'text', text: qs.map((q) => `• ${str(q && q.question)}`).join('\n') } };
    }
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(req.tool || '');
      return { verb: mcp ? `Usar ${mcp[2]} (${mcp[1]})` : `Usar ${req.tool}`, target: '', body: Object.keys(i).length ? { kind: 'code', text: str(i) } : null };
    }
  }
}

const WHERE = { session: 'nesta conversa', localSettings: 'neste projeto, só para você', projectSettings: 'neste projeto', userSettings: 'em todos os projetos' };
const MODES = { acceptEdits: 'aceitar edições', auto: 'automático', plan: 'plano', default: 'normal', dontAsk: 'não perguntar', bypassPermissions: 'sem permissões' };
const ruleText = (r) => (r && r.ruleContent ? `${r.toolName}(${r.ruleContent})` : str(r && r.toolName));

// The "always" options Claude Code suggested, as button labels. null for ones it can't apply.
function suggestionLabel(s) {
  if (!s || typeof s !== 'object') return null;
  const where = WHERE[s.destination] || '';
  if (s.type === 'addRules' && s.behavior === 'allow' && Array.isArray(s.rules) && s.rules.length) return `Sempre permitir ${s.rules.map(ruleText).join(', ')} ${where}`.trim();
  if (s.type === 'setMode' && s.mode) return `Aprovar e mudar para o modo ${MODES[s.mode] || s.mode} ${where}`.trim();
  if (s.type === 'addDirectories' && Array.isArray(s.directories)) return `Aprovar e liberar ${s.directories.join(', ')} ${where}`.trim();
  return null;
}

module.exports = { Approvals, ownerOf, currentWindow, describeTool, suggestionLabel, pidAlive, keyOf, MAX_AGE_MS };
