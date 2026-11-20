'use strict';

// The conversations Claude Code saved (<configDir>/projects/<project>/<session>.jsonl), read
// down to what shows a task coming back: what the user asked, the commands that ran and the
// skills used. The files run into tens of MB and only grow, so each one is read once and then
// only its new bytes; what was read is kept in conversations.json, shared by every window.
const fs = require('fs');
const path = require('path');
const { promptOf } = require('./topic');
const { readJson, writeFileAtomic } = require('./fsutil');
const mem = require('./memories');

const VERSION = 1; // a new version reads every conversation again
const CHUNK = 4 * 1024 * 1024;
const PROMPT_CHARS = 600; // per prompt kept in the index
const MAX_PROMPTS = 300; // per conversation

// Lines worth parsing: the user's prompts (not tool results), tool calls and titles. Tool
// results are most of a file's bytes and say nothing about what was asked.
const USER = Buffer.from('"type":"user"');
const ASSISTANT = Buffer.from('"type":"assistant"');
const TOOL_USE = Buffer.from('"tool_use"');
const TOOL_RESULT = Buffer.from('"tool_use_id"');
const TITLE = Buffer.from('-title"');
const wanted = (line) =>
  (line.includes(USER) && !line.includes(TOOL_RESULT)) || (line.includes(ASSISTANT) && line.includes(TOOL_USE)) || line.includes(TITLE);

// Each complete line from `start` on, with the offset right after it. A line still being
// written (no line break yet) is left for the next read.
async function* linesFrom(file, start = 0) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const chunk = Buffer.alloc(CHUNK);
    let carry = Buffer.alloc(0);
    let pos = start;
    for (;;) {
      const { bytesRead } = await fh.read(chunk, 0, CHUNK, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      const base = pos - buf.length;
      let from = 0;
      for (let nl = buf.indexOf(10, from); nl !== -1; nl = buf.indexOf(10, from)) {
        yield { line: buf.subarray(from, nl), end: base + nl + 1 };
        from = nl + 1;
      }
      carry = Buffer.from(buf.subarray(from)); // a copy: `chunk` is read into again
    }
  } finally {
    await fh.close();
  }
}

// --- what the user typed -------------------------------------------------------------------

const ACK =
  /^(ok(ay)?|sim|s|n|não|nao|continue|continua|pode( ir| seguir| fazer| continuar)?|isso( mesmo)?|beleza|blz|valeu|obrigad[oa]|certo|perfeito|show|top|manda|vai|segue|bora|faz|faça|fechou|entendi|ótimo|otimo|legal|yes|go|next)[\s.!,]*$/i;

// The prompt without what was pasted or attached into it, on one line.
function cleanPrompt(text) {
  return String(text)
    .replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/g, ' [texto colado] ')
    .replace(/<(ide_selection|ide_opened_file|system-reminder)\b[^>]*>[\s\S]*?<\/\1>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "ok", "continue", "sim": about what came before, never a task of their own.
const isTask = (text) => text.length >= 3 && !ACK.test(text);

// The prompt as counted everywhere (index, digest and excerpts number prompts the same way).
function taskOf(o) {
  const p = promptOf(o);
  if (!p) return null;
  const text = cleanPrompt(p);
  return isTask(text) ? text : null;
}

// --- commands ------------------------------------------------------------------------------

// Commands that only look around or move files: in every conversation, they tell nothing.
const GENERIC = new Set([
  ...(
    'grep rg cat sed ls dir for while if echo wc cd mkdir rm rmdir cp mv head tail find awk printf sleep timeout export source set test ' +
    'true false pwd which where type sort uniq xargs tee touch diff tr cut basename dirname date stat file du df env read exit chmod ' +
    'start-sleep get-childitem get-content select-string set-location foreach-object foreach where-object select-object get-item ' +
    'test-path write-output write-host out-file set-content add-content remove-item copy-item move-item new-item measure-object ' +
    'sort-object format-table format-list get-process get-date join-path split-path resolve-path convertfrom-json convertto-json out-null ' +
    'invoke-expression add-type powershell pwsh bash sh cmd node php python python3 py done fi esac'
  ).split(' '),
  ...['status', 'diff', 'log', 'show', 'branch', 'ls-files', 'rev-parse', 'grep', 'fetch', 'remote', 'config', 'blame', 'cat-file', 'describe'].map((s) => `git ${s}`),
]);
const RUNNERS = new Set(['node', 'php', 'python', 'python3', 'py', 'ruby', 'deno', 'bun', 'tsx', 'ts-node']);
const SUBCOMMANDS = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'npx', 'docker', 'docker-compose', 'gh', 'composer', 'adb', 'cargo', 'go', 'dotnet', 'kubectl',
  'pip', 'pip3', 'code', 'wsl', 'vsce', 'firebase', 'vercel', 'supabase', 'flutter', 'expo', 'eas', 'wrangler', 'terraform',
  'az', 'aws', 'gcloud', 'systemctl', 'pm2', 'artisan',
]);
const SCRIPT = /\.(m?js|cjs|ts|php|py|rb|sh|ps1|bat)$/i;
const unquote = (t) => t.replace(/^["']|["']$/g, '');

// Shell words that come before the command itself.
const LEADING = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', 'time', 'sudo', 'exec', 'nohup', '!', '{', '(', '&', 'call', 'start']);

// What kind of command this is, without its arguments: "npm run package", "node segredo.js",
// "plink", "git commit". Null when it says nothing (see GENERIC).
function familyOf(segment) {
  // FILES="a b", PX='x y', C=$(git rev-parse HEAD): one assignment each, left out.
  const tokens = (segment.trim().match(/[A-Za-z_]\w*=(?:"(?:[^"\\]|\\.)*"|'[^']*'|\$\([^()]*\)|\S*)|"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) || []).filter(
    (t) => !/^[A-Za-z_]\w*=/.test(t),
  );
  while (tokens.length && LEADING.has(tokens[0].toLowerCase())) tokens.shift();
  if (!tokens.length) return null;
  const exe = unquote(tokens[0]).split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  const args = tokens.slice(1).map(unquote);
  let fam = exe;
  if (RUNNERS.has(exe)) {
    const script = args.find((a) => SCRIPT.test(a));
    if (script) fam = `${exe} ${script.split(/[\\/]/).pop()}`;
    else if (exe === 'php' && args[0] === 'artisan') fam = `php artisan${args[1] && !args[1].startsWith('-') ? ` ${args[1]}` : ''}`;
  } else if (SUBCOMMANDS.has(exe)) {
    const plain = (a) => a && !a.startsWith('-') && !/[\\/:=]/.test(a) && a.length < 30;
    // git -C <dir> status: the folder is not the subcommand.
    if (exe === 'git') while (/^-[Cc]$/.test(args[0] || '')) args.splice(0, 2);
    let sub = exe === 'code' ? args[0] : args.find(plain);
    if (sub && ['npm', 'pnpm', 'yarn'].includes(exe) && sub === 'run') {
      const next = args.slice(args.indexOf('run') + 1).find(plain);
      if (next) sub = `run ${next}`;
    }
    if (sub) fam = `${exe} ${sub}`;
  }
  if (GENERIC.has(fam) || !/^[a-z0-9][\w.+-]*( [\w.:+-]+){0,2}$/i.test(fam)) return null;
  return fam;
}

// The families in a command line. Only its first line counts (joined where it continues): what
// follows is a heredoc, a script or SQL, not commands. Quoted text and $(…) never split a command.
function families(command) {
  const first = String(command || '')
    .replace(/(\\|`|&&|\|\||\|)[ \t]*\r?\n/g, (m, end) => (end === '\\' || end === '`' ? ' ' : `${end} `))
    .split(/\r?\n/)[0];
  const quoted = [];
  const masked = first.replace(/"(?:[^"\\]|\\.)*"|'[^']*'|\$\([^()]*\)/g, (q) => `\u0000${quoted.push(q) - 1}\u0000`);
  const unmask = (s) => s.replace(/\u0000(\d+)\u0000/g, (_, i) => quoted[Number(i)]);
  const out = [];
  for (const seg of masked.split(/&&|\|\||;|\|/).slice(0, 6)) {
    const text = unmask(seg);
    const fam = familyOf(text);
    if (fam) out.push(fam);
    // segredo.js exec -- plink …: what really ran is after the "--".
    const inner = /segredo\.js["']?\s+exec\b.*?\s--\s+(.*)$/.exec(text);
    const innerFam = inner && familyOf(inner[1]);
    if (innerFam) out.push(innerFam);
  }
  return out;
}

// --- secrets -------------------------------------------------------------------------------

// What looks like a password, token or key, so it never reaches the model or a skill file.
// References to the vault ({{credencial.campo}}, --env NOME=credencial.campo) stay: they are
// not the value.
const VAULT_REF = /\{\{[^{}\s]+\}\}|--env\s+[A-Za-z_][A-Za-z0-9_]*=[\w.-]+/g;
const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[segredo]'],
  [/(\b\w+:\/\/[^\s:@/]+:)[^\s@/]+@/g, '$1[segredo]@'],
  [/(\bBearer\s+)[\w.~+/-]+=*/gi, '$1[segredo]'],
  [/((?:^|\s)(?:-pw|--password|--passwd|--token|--api-key|--secret|--pass)(?:\s+|=))("[^"]*"|'[^']*'|[^\s"'\0]+)/gi, '$1[segredo]'],
  [/(\b[\w-]*(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|senha)[\w-]*["']?\s*[:=]\s*)("[^"\n\0]*"|'[^'\n\0]*'|[^\s"',;)}\0]+)/gi, '$1[segredo]'],
  [/\b(?:sk-ant-[\w-]{10,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[\w]{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,})\b/g, '[segredo]'],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, '[segredo]'],
  // Long random strings (hex, base64): a digit, a lower and an upper case letter, no separators.
  [/(?<![\w/.{-])(?=[\w-]*\d)(?=[\w-]*[a-z])(?=[\w-]*[A-Z])[A-Za-z0-9_-]{32,}(?![\w-])/g, '[segredo]'],
];

function redact(text) {
  const refs = [];
  let out = String(text).replace(VAULT_REF, (m) => `\u0000${refs.push(m) - 1}\u0000`);
  let count = 0;
  for (const [re, by] of SECRETS) {
    out = out.replace(re, (...m) => {
      const sub = by.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? '');
      if (sub !== m[0]) count++;
      return sub;
    });
  }
  // A value already taken out stays a single [segredo], never "[segredo]=[segredo]".
  out = out.replace(/(\[segredo\])(?:["']?\s*[:=]\s*\[segredo\])+/g, '$1');
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => refs[Number(i)]);
  return { text: out, count };
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// --- the index -----------------------------------------------------------------------------

function newEntry(key, dir) {
  return { key, project: dir, cwd: null, title: null, start: null, end: null, bytes: 0, size: 0, prompts: [], commands: {}, skills: {} };
}

const bump = (map, k) => (map[k] = (map[k] || 0) + 1);

// One line of a transcript into its entry.
function absorb(entry, o) {
  if (o.type === 'custom-title' && o.customTitle) entry.customTitle = o.customTitle;
  if (o.type === 'ai-title' && o.aiTitle) entry.title = o.aiTitle;
  if (o.isSidechain) return;
  if (!entry.cwd && typeof o.cwd === 'string') entry.cwd = o.cwd;
  const at = Date.parse(o.timestamp) || null;
  const m = o.message;
  if (o.type === 'user' && m) {
    if (typeof m.content === 'string') {
      const slash = /<command-name>\/?([^<\s]+)<\/command-name>/.exec(m.content);
      if (slash) bump(entry.skills, slash[1]);
    }
    const task = taskOf(o);
    if (task && entry.prompts.length < MAX_PROMPTS) entry.prompts.push({ t: clip(task, PROMPT_CHARS), at });
    if (task && at) entry.start = entry.start || at;
  } else if (o.type === 'assistant' && m && Array.isArray(m.content)) {
    for (const c of m.content) {
      if (c.type !== 'tool_use' || !c.input) continue;
      if (c.name === 'Bash' || c.name === 'PowerShell') for (const f of families(c.input.command)) bump(entry.commands, f);
      else if (c.name === 'Skill' && c.input.skill) bump(entry.skills, String(c.input.skill));
      else if (/^mcp__/.test(c.name)) bump(entry.commands, `mcp ${c.name.split('__')[1]}`);
    }
  }
  if (at) entry.end = Math.max(entry.end || 0, at);
}

class ConversationIndex {
  constructor(paths, switcherDir, { log = () => {} } = {}) {
    this.paths = paths;
    this.file = path.join(switcherDir, 'conversations.json');
    this.log = log;
    this.cache = null; // { mtime, data }
    this.refreshing = null;
  }

  load() {
    let st = null;
    try {
      st = fs.statSync(this.file);
    } catch {}
    if (this.cache && st && this.cache.mtime === st.mtimeMs) return this.cache.data;
    let data = null;
    try {
      data = readJson(this.file);
    } catch {}
    if (!data || data.version !== VERSION) data = { version: VERSION, files: {} };
    if (st) this.cache = { mtime: st.mtimeMs, data };
    return data;
  }

  // Every conversation read so far, with its project's label and path.
  entries() {
    const real = new Map();
    const out = [];
    for (const e of Object.values(this.load().files)) {
      if (!real.has(e.project)) real.set(e.project, e.cwd);
      const cwd = e.cwd || real.get(e.project) || null;
      out.push({ ...e, cwd, label: mem.labelOf(e.project, cwd), titleShown: e.customTitle || e.title || null });
    }
    return out;
  }

  // Reads what is new in every transcript. One refresh at a time per window; two windows that
  // refresh together read the same bytes and write the same result.
  refresh({ onProgress = () => {} } = {}) {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh(onProgress).finally(() => (this.refreshing = null));
    }
    return this.refreshing;
  }

  async doRefresh(onProgress) {
    const root = mem.projectsDir(this.paths);
    const data = structuredClone(this.load());
    const seen = new Set();
    let changed = false;
    let dirs = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {}
    const todo = [];
    for (const d of dirs) {
      let names = [];
      try {
        names = fs.readdirSync(path.join(root, d.name)).filter((n) => n.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const n of names) {
        const key = `${d.name}/${n}`;
        const file = path.join(root, d.name, n);
        seen.add(key);
        let size;
        try {
          size = fs.statSync(file).size;
        } catch {
          continue;
        }
        let e = data.files[key];
        if (e && size === e.size) continue;
        if (!e || size < e.bytes) e = data.files[key] = newEntry(key, d.name); // rewritten: start over
        todo.push({ e, file, size });
      }
    }
    for (const key of Object.keys(data.files)) {
      if (!seen.has(key)) {
        delete data.files[key];
        changed = true;
      }
    }
    let done = 0;
    for (const { e, file, size } of todo) {
      onProgress({ done: done++, total: todo.length });
      try {
        for await (const { line, end } of linesFrom(file, e.bytes)) {
          e.bytes = end;
          if (!wanted(line)) continue;
          let o;
          try {
            o = JSON.parse(line.toString('utf8'));
          } catch {
            continue;
          }
          absorb(e, o);
        }
        e.size = size;
      } catch (err) {
        this.log(`conversas: não li ${file} (${err.message})`);
      }
      changed = true;
    }
    if (changed) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      await writeFileAtomic(this.file, JSON.stringify(data));
      this.cache = null;
    }
    return { read: todo.length };
  }

  fileOf(key) {
    return path.join(mem.projectsDir(this.paths), ...key.split('/'));
  }
}

// --- a conversation, condensed, for the skill to be written from ---------------------------

const toolLine = (c) => {
  const i = c.input || {};
  if (c.name === 'Bash' || c.name === 'PowerShell') return `$ ${clip(String(i.command || '').trim(), 600)}`;
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(c.name)) return `(${c.name === 'Write' ? 'escreveu' : 'editou'} ${i.file_path || i.notebook_path || ''})`;
  if (c.name === 'Read') return null;
  if (c.name === 'Skill') return `(usou a skill ${i.skill})`;
  if (c.name === 'WebFetch') return `(abriu ${i.url})`;
  if (c.name === 'Grep' || c.name === 'Glob' || c.name === 'TodoWrite' || c.name === 'ToolSearch') return null;
  return `(${c.name})`;
};

const resultText = (c) =>
  typeof c.content === 'string'
    ? c.content
    : Array.isArray(c.content)
      ? c.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n')
      : '';

// From the user's prompt number `from` (1-based, numbered like the index) to `follow` prompts
// after it: what was asked, what Claude said and ran, what failed and what the user corrected.
// Secrets are taken out.
async function excerpt(file, from = 1, { maxChars = 12000, follow = 5 } = {}) {
  const out = [];
  let size = 0;
  let n = 0;
  let on = false;
  const push = (s) => {
    if (s == null) return true;
    out.push(s);
    size += s.length + 1;
    return size < maxChars;
  };
  outer: for await (const { line } of linesFrom(file, 0)) {
    let o;
    try {
      o = JSON.parse(line.toString('utf8'));
    } catch {
      continue;
    }
    if (o.isSidechain || !o.message) continue;
    const m = o.message;
    if (o.type === 'user') {
      const task = taskOf(o);
      if (task) {
        n++;
        if (n === from) on = true;
        if (on && n > from + follow) break;
        if (on && !push(`\nUSUÁRIO: ${clip(task, 1500)}`)) break;
        continue;
      }
      if (!on || !Array.isArray(m.content)) continue;
      for (const c of m.content) {
        if (c.type === 'tool_result' && c.is_error && !push(`  ✗ ${clip(resultText(c).replace(/\s+/g, ' ').trim(), 300)}`)) break outer;
      }
    } else if (o.type === 'assistant' && on && Array.isArray(m.content)) {
      for (const c of m.content) {
        const s = c.type === 'text' && c.text.trim() ? `CLAUDE: ${clip(c.text.trim().replace(/\n{2,}/g, '\n'), 500)}` : c.type === 'tool_use' ? toolLine(c) : null;
        if (!push(s)) break outer;
      }
    }
  }
  if (size >= maxChars) out.push('[…]');
  return redact(out.join('\n').trim()).text;
}

module.exports = { ConversationIndex, linesFrom, cleanPrompt, isTask, taskOf, familyOf, families, redact, excerpt, absorb, newEntry, GENERIC };
