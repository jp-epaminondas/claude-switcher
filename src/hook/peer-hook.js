'use strict';

// Claude Code runs this in every conversation, so that two conversations working in the same
// project at the same time know about each other instead of losing time over changes they
// did not make. Each conversation keeps a few files in sessions/ (only its own): what it was
// asked, which files it changed, whether it is working or waiting for the user.
// - UserPromptSubmit: notes the prompt and tells the model who else is in the project.
// - PreToolUse (Edit, Write, Bash): warns before it edits a file the other one changed, and
//   holds back once a git command that would sweep up or throw away the other one's changes.
// - PostToolUse (Edit, Write): notes the file it changed.
// - Stop: waiting for the user. SessionEnd: gone, its files go too.
//
// The extension copies this file next to accounts.json, so it must not require anything else.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MINUTE = 60 * 1000;
const RELEVANT_MS = 3 * 60 * MINUTE; // a conversation quiet for longer is left out
const WORKING_MS = 10 * MINUTE; // "working" with no sign of life for longer: probably closed
const FORGET_MS = 2 * 24 * 60 * MINUTE;
const BRIEF_AGAIN_MS = 60 * MINUTE; // the full rules again, in case a compaction dropped them
const RETRY_MS = 10 * MINUTE; // a held-back git command runs when sent again within this
const TASK_MAX = 200;
const FILES_SHOWN = 8;

const win = process.platform === 'win32';
const keyOf = (p) => {
  const r = path.resolve(p).replace(/\\/g, '/').replace(/\/$/, '');
  return win ? r.toLowerCase() : r;
};
const plainId = (id) => typeof id === 'string' && /^[\w-]{1,100}$/.test(id);

// The git repository the folder is in, or the folder itself.
function projectRoot(cwd) {
  const start = path.resolve(cwd);
  for (let d = start; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return start;
  }
}

class Sessions {
  constructor(dir) {
    this.dir = dir;
  }

  file(id, ext) {
    return path.join(this.dir, `${id}.${ext}`);
  }

  read(id, ext) {
    try {
      return fs.readFileSync(this.file(id, ext), 'utf8');
    } catch {
      return null;
    }
  }

  write(id, ext, text) {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(id, ext);
    fs.writeFileSync(`${file}.${process.pid}.tmp`, text);
    fs.renameSync(`${file}.${process.pid}.tmp`, file);
  }

  // Appended a line at a time: hooks of one conversation can run side by side.
  append(id, ext, fields) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.file(id, ext), fields.join('\t') + '\n');
  }

  lines(id, ext) {
    return (this.read(id, ext) || '').split('\n').filter(Boolean).map((l) => l.split('\t'));
  }

  remove(id, ext) {
    try {
      fs.unlinkSync(this.file(id, ext));
    } catch {}
  }

  meta(id) {
    try {
      return JSON.parse(this.read(id, 'json'));
    } catch {
      return null;
    }
  }

  // Any hook of the conversation leaves its mark here.
  touch(id) {
    this.write(id, 'alive', '');
  }

  seen(id) {
    let at = 0;
    for (const ext of ['json', 'alive', 'edits', 'idle']) {
      try {
        at = Math.max(at, fs.statSync(this.file(id, ext)).mtimeMs);
      } catch {}
    }
    return at;
  }

  edits(id) {
    const out = new Map();
    for (const [file, at] of this.lines(id, 'edits')) out.set(keyOf(file), { file, at: Number(at) });
    return out;
  }

  idleSince(id) {
    try {
      return fs.statSync(this.file(id, 'idle')).mtimeMs;
    } catch {
      return null;
    }
  }

  forget(id) {
    for (const ext of ['json', 'alive', 'edits', 'idle', 'notes']) this.remove(id, ext);
  }

  // The other conversations in the same project that still matter.
  peers(me, rootKey, now = Date.now()) {
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {}
    const out = [];
    for (const name of names) {
      const m = /^([\w-]+)\.json$/.exec(name);
      if (!m || m[1] === me) continue;
      const id = m[1];
      const seen = this.seen(id);
      if (now - seen > FORGET_MS) {
        this.forget(id);
        continue;
      }
      const meta = this.meta(id);
      if (!meta || meta.rootKey !== rootKey || now - seen > RELEVANT_MS) continue;
      const idle = this.idleSince(id);
      const working = idle == null && now - seen < WORKING_MS;
      out.push({ id, meta, seen, working, idleSince: idle ?? seen, edits: this.edits(id) });
    }
    return out.sort((a, b) => a.meta.startedAt - b.meta.startedAt);
  }

  noted(id, kind, key, within = Infinity, now = Date.now()) {
    return this.lines(id, 'notes').some(([k, v, at]) => k === kind && v === key && now - Number(at) < within);
  }
}

// What a prompt asks for, or null for answers like "sim" and for commands.
function taskOf(prompt) {
  const text = String(prompt || '')
    .replace(/<(ide_[a-z_]+|system-reminder|command-[a-z-]+)>[\s\S]*?<\/\1>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 15 || text.startsWith('/')) return null;
  return text.length > TASK_MAX ? `${text.slice(0, TASK_MAX - 1)}…` : text;
}

// Files with changes not yet committed, and the ones already staged. null outside git.
function gitStatus(root) {
  let out;
  try {
    out = execFileSync('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
  const dirty = new Set();
  const staged = new Set();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const key = keyOf(path.join(root, entry.slice(3)));
    dirty.add(key);
    if (entry[0] !== ' ' && entry[0] !== '?') staged.add(key);
    if (entry[0] === 'R' || entry[0] === 'C') i++; // the old name comes next
  }
  return { dirty, staged };
}

const ago = (ms) => {
  const m = Math.max(1, Math.round(ms / MINUTE));
  return m < 60 ? `há ${m} min` : `há ${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
};
const rel = (root, file) => path.relative(root, file).replace(/\\/g, '/') || file;
const listFiles = (root, files) => {
  const names = files.map((f) => rel(root, f));
  return names.length > FILES_SHOWN ? `${names.slice(0, FILES_SHOWN).join(', ')} (+${names.length - FILES_SHOWN})` : names.join(', ');
};

const clock = (at) => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const nameOf = (peer) => `a conversa aberta às ${clock(peer.meta.startedAt)}`;
const taskNote = (peer) => (peer.meta.task ? ` (pedido: "${peer.meta.task}")` : '');

// A peer's changed files, minus the ones this conversation changed after it.
function theirFiles(peer, mine) {
  return [...peer.edits.entries()].filter(([key, e]) => !(mine.get(key)?.at > e.at)).map(([key, e]) => ({ key, file: e.file, at: e.at, peer }));
}

// A peer's files that still have changes, newest first (all of them outside git).
function pendingFiles(peer, status, mine) {
  return theirFiles(peer, mine)
    .filter(({ key }) => !status || status.dirty.has(key))
    .sort((a, b) => b.at - a.at)
    .map((f) => f.file);
}

function describe(root, peer, status, mine, now) {
  const state = peer.working ? 'trabalhando agora' : `parada ${ago(now - peer.idleSince)}, esperando o usuário`;
  const task = peer.meta.task ? `, pedido: "${peer.meta.task}"` : '';
  const files = pendingFiles(peer, status, mine);
  const changed = files.length
    ? `\n  Arquivos que ela mudou${status ? ' e ainda não foram para commit' : ''}: ${listFiles(root, files)}`
    : '\n  Ela ainda não tem mudanças fora de commit.';
  const name = nameOf(peer);
  return `- ${name[0].toUpperCase()}${name.slice(1)} (${state}${task}).${changed}`;
}

function briefing(root, peers, status, mine, now, full) {
  const one = peers.length === 1;
  const list = peers.map((p) => describe(root, p, status, mine, now)).join('\n');
  if (!full) return `[Claude Switcher] ${one ? 'A outra conversa' : 'As outras conversas'} do Claude Code neste projeto, agora:\n${list}\nAs regras de antes continuam valendo.`;
  return [
    `[Claude Switcher] ${one ? 'Outra conversa' : `Outras ${peers.length} conversas`} do Claude Code ${one ? 'está' : 'estão'} trabalhando neste mesmo projeto (${root}) ao mesmo tempo que você, a pedido do mesmo usuário. Isso é esperado, não é um problema para investigar.`,
    list,
    'Para uma não atrapalhar a outra:',
    `- Mudanças que você não fez (no git status, no git diff, num arquivo que mudou depois que você leu, em testes ou no build) provavelmente são ${one ? 'dela' : 'delas'}. Não reverta, não formate e não tente consertar: siga com a sua tarefa e, se elas te impedirem, diga ao usuário.`,
    '- Se um Edit falhar porque o arquivo mudou desde a leitura, releia o arquivo e aplique só a sua mudança, mantendo a outra.',
    '- Evite mexer nos arquivos que a outra conversa está mudando; se precisar, mude só a sua parte.',
    '- No commit, adicione só os seus arquivos, pelo nome (git add caminho/do/arquivo). Não use git add -A, git add ., git commit -a, git stash, git checkout -- ., git restore ., git reset --hard nem git clean: eles levariam ou apagariam o trabalho da outra. Não troque de branch.',
  ].join('\n');
}

// --- git commands that touch the other conversation's work ---

const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const PREFIXES = new Set(['sudo', 'command', 'time', 'env', 'exec', 'nohup']);

// The simple commands of a shell line, as words. Quotes keep their text in one word, and a
// heredoc body (a commit message, say) is left out, so neither is mistaken for a command.
function commandsOf(line) {
  const text = String(line).replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$|\))/g, ' ');
  const out = [];
  let words = [];
  let word = null;
  const endWord = () => {
    if (word != null) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const close = text.indexOf(c, i + 1);
      const end = close < 0 ? text.length : close;
      word = (word || '') + text.slice(i + 1, end);
      i = end;
    } else if (c === '\\' && i + 1 < text.length && text[i + 1] !== '\n') {
      word = (word || '') + text[++i];
    } else if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '(' || c === ')') {
      endCommand();
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word = (word || '') + c;
    }
  }
  endCommand();
  return out;
}

const home = () => process.env.HOME || process.env.USERPROFILE || '~';

// Every git command in a shell line, with the folder it runs in.
function gitCommands(command, cwd) {
  const out = [];
  let dir = cwd;
  for (const t of commandsOf(command)) {
    let g = 0;
    while (g < t.length && (PREFIXES.has(t[g]) || /^\w+=/.test(t[g]))) g++;
    if (t[g] === 'cd' && t[g + 1]) {
      dir = path.resolve(dir, t[g + 1].replace(/^~(?=$|[\\/])/, home()));
      continue;
    }
    if (!/(^|[\\/])git(\.exe)?$/i.test(t[g] || '')) continue;
    let here = dir;
    let i = g + 1;
    while (i < t.length && t[i].startsWith('-')) {
      if (t[i] === '-C') here = path.resolve(here, t[i + 1] || '.');
      i += GIT_VALUE_OPTS.has(t[i]) ? 2 : 1;
    }
    if (t[i]) out.push({ sub: t[i], args: t.slice(i + 1), cwd: here });
  }
  return out;
}

const shortFlag = (args, letter) => args.some((a) => /^-[a-zA-Z]+$/.test(a) && a.includes(letter));
const pathArgs = (args) => {
  const dd = args.indexOf('--');
  return (dd >= 0 ? args.slice(dd + 1) : args.filter((a) => !a.startsWith('-'))).map((a) => (a === ':/' || a === ':' ? '/' : a.replace(/\*.*$/, '') || '.'));
};

// What a git command would do to work that is not committed yet: take it into a commit
// ("sweep"), throw it away or hide it ("discard"), commit what is staged ("commit"), or move
// the files under everybody's feet ("branch"). scope: the folders and files it reaches.
function gitRisk({ sub, args, cwd }, root) {
  const all = [root];
  const scoped = (paths) => (paths.length ? paths.map((p) => (p === '/' ? root : path.resolve(cwd, p))) : null);
  if (sub === 'add') {
    const paths = scoped(pathArgs(args));
    if (paths) return { kind: 'sweep', scope: paths };
    return args.some((a) => ['-A', '--all', '-u', '--update'].includes(a)) || shortFlag(args, 'A') ? { kind: 'sweep', scope: all } : null;
  }
  if (sub === 'commit') {
    if (args.includes('--all') || shortFlag(args, 'a')) return { kind: 'sweep', scope: all };
    return { kind: 'commit', scope: all };
  }
  if (sub === 'stash') return ['list', 'show', 'apply', 'pop', 'drop', 'clear', 'branch', 'create', 'store'].includes(args[0]) ? null : { kind: 'discard', scope: all };
  if (sub === 'reset') return args.includes('--hard') ? { kind: 'discard', scope: all } : null;
  if (sub === 'clean') return args.some((a) => a === '--force' || shortFlag(args, 'f')) ? { kind: 'discard', scope: scoped(pathArgs(args.filter((a) => !a.startsWith('-')))) || all } : null;
  if (sub === 'restore') {
    if ((args.includes('--staged') || shortFlag(args, 'S')) && !args.includes('--worktree') && !shortFlag(args, 'W')) return null;
    const paths = scoped(pathArgs(args.filter((a) => !/^(-s|--source)/.test(a))));
    return paths ? { kind: 'discard', scope: paths } : null;
  }
  if (sub === 'switch') return { kind: 'branch', scope: all };
  if (sub === 'checkout') {
    if (args.includes('--')) return { kind: 'discard', scope: scoped(pathArgs(args)) || all };
    const named = args.filter((a) => !a.startsWith('-'));
    const files = named.filter((a) => a === '.' || fs.existsSync(path.resolve(cwd, a)));
    if (files.length) return { kind: 'discard', scope: scoped(files) };
    return { kind: 'branch', scope: all };
  }
  return null;
}

const covers = (scope, key) => scope.some((s) => {
  const k = keyOf(s);
  return key === k || key.startsWith(`${k}/`);
});

const WHY = {
  sweep: 'ele levaria para o commit mudanças que outra conversa fez',
  commit: 'o índice do git já tem arquivos que outra conversa mudou, e eles iriam neste commit',
  discard: 'ele apagaria ou esconderia mudanças que outra conversa fez e ainda não foram para commit',
  branch: 'trocar de branch muda os arquivos debaixo de outra conversa que está trabalhando agora',
};
const INSTEAD = {
  sweep: 'Adicione só os seus arquivos, pelo nome (git add caminho/do/arquivo).',
  commit: 'Tire os arquivos dela do índice com git restore --staged <arquivo> e faça o commit só com os seus.',
  discard: 'Desfaça só os seus arquivos, pelo nome.',
  branch: 'Continue no branch atual, ou peça ao usuário para combinar com a outra conversa.',
};

// The reason to hold a shell command back, or null to let it run.
function holdBack(command, cwd, root, peers, status, mine) {
  for (const risk of gitCommands(command, cwd).map((c) => gitRisk(c, root)).filter(Boolean)) {
    let who;
    let files = [];
    if (risk.kind === 'branch') {
      who = peers.filter((p) => p.working);
    } else {
      const reached = peers
        .flatMap((p) => theirFiles(p, mine))
        .filter(({ key }) => (risk.kind === 'commit' ? !!status && status.staged.has(key) : !status || status.dirty.has(key)) && covers(risk.scope, key));
      who = [...new Set(reached.map((f) => f.peer))];
      files = [...new Set(reached.map((f) => f.file))];
    }
    if (!who.length) continue;
    const list = files.length ? ` Arquivos dela: ${listFiles(root, files)}.` : '';
    return `[Claude Switcher] Não rodei este comando: ${WHY[risk.kind]}. Ela trabalha neste projeto ao mesmo tempo que você: ${who.map((p) => nameOf(p) + taskNote(p)).join('; ')}.${list} ${INSTEAD[risk.kind]} Se o usuário pediu mesmo para fazer isso, rode exatamente o mesmo comando de novo, que ele passa.`;
  }
  return null;
}

// --- the hook ---

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const editedFile = (hook) => {
  const input = hook.tool_input || {};
  const file = input.file_path || input.notebook_path;
  return typeof file === 'string' && file ? path.resolve(hook.cwd || '.', file) : null;
};

function run(hook, sessions, now = Date.now()) {
  const id = hook.session_id;
  if (!plainId(id)) return null;
  const event = hook.hook_event_name;
  if (event === 'SessionEnd') {
    sessions.forget(id);
    return null;
  }
  if (event === 'Stop') {
    if (sessions.meta(id)) sessions.write(id, 'idle', '');
    return null;
  }

  let meta = sessions.meta(id);
  if (!meta) {
    if (!hook.cwd) return null;
    const root = projectRoot(hook.cwd);
    meta = { id, root, rootKey: keyOf(root), startedAt: now, task: null, told: null };
  }
  const { root, rootKey } = meta;

  if (event === 'UserPromptSubmit') {
    sessions.remove(id, 'idle');
    meta.task = taskOf(hook.prompt) || meta.task;
    const peers = sessions.peers(id, rootKey, now);
    const told = meta.told || {};
    let text = null;
    if (peers.length) {
      const status = gitStatus(root);
      const mine = sessions.edits(id);
      const ids = peers.map((p) => p.id).sort().join(',');
      const full = told.ids !== ids || now - (told.fullAt || 0) > BRIEF_AGAIN_MS;
      const sig = peers.map((p) => [p.id, p.working, p.meta.task, pendingFiles(p, status, mine).join('|')].join(':')).join(',');
      if (full || sig !== told.sig) text = briefing(root, peers, status, mine, now, full);
      meta.told = { ids, sig, fullAt: full ? now : told.fullAt };
    } else if (told.ids) {
      text = '[Claude Switcher] A outra conversa que trabalhava neste projeto terminou ou parou faz tempo. Agora só você está mexendo nele.';
      meta.told = null;
    }
    sessions.write(id, 'json', JSON.stringify(meta));
    return text && { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } };
  }

  if (!sessions.meta(id)) sessions.write(id, 'json', JSON.stringify(meta));
  else sessions.touch(id);

  if (event === 'PostToolUse') {
    const file = EDIT_TOOLS.has(hook.tool_name) && editedFile(hook);
    if (file) sessions.append(id, 'edits', [file, now]);
    return null;
  }

  if (event !== 'PreToolUse') return null;
  const peers = sessions.peers(id, rootKey, now);
  if (!peers.length) return null;
  const mine = sessions.edits(id);

  if (EDIT_TOOLS.has(hook.tool_name)) {
    const file = editedFile(hook);
    if (!file) return null;
    const key = keyOf(file);
    const theirs = peers.flatMap((p) => theirFiles(p, mine)).find((f) => f.key === key);
    if (!theirs) return null;
    const note = `${key}@${theirs.at}`;
    if (sessions.noted(id, 'file', note)) return null;
    sessions.append(id, 'notes', ['file', note, now]);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: `[Claude Switcher] ${rel(root, file)} também foi mudado ${ago(now - theirs.at)} por ${nameOf(theirs.peer)}, que trabalha neste projeto ao mesmo tempo que você${taskNote(theirs.peer)}. Se o arquivo não estiver como você leu, é por isso: releia e aplique só a sua mudança, sem desfazer a dela.`,
      },
    };
  }

  if (hook.tool_name === 'Bash') {
    const command = hook.tool_input && hook.tool_input.command;
    if (typeof command !== 'string' || !/\bgit\b/.test(command)) return null;
    const status = gitStatus(root);
    const reason = holdBack(command, hook.cwd || root, root, peers, status, mine);
    if (!reason) return null;
    const key = command.trim().replace(/\s+/g, ' ');
    if (sessions.noted(id, 'cmd', key, RETRY_MS, now)) return null; // sent again: the user wants it
    sessions.append(id, 'notes', ['cmd', key.replace(/\t/g, ' '), now]);
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  }
  return null;
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (input += chunk));
  process.stdin.on('end', () => {
    let hook = {};
    try {
      hook = JSON.parse(input);
    } catch {}
    try {
      const out = run(hook, new Sessions(path.join(__dirname, 'sessions')));
      if (out) process.stdout.write(JSON.stringify(out));
    } catch {}
  });
}

module.exports = { run, Sessions, gitCommands, gitRisk, holdBack, taskOf, projectRoot, keyOf };
