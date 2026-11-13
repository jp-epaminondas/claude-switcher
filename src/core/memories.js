'use strict';

// Claude Code's auto-memory: <configDir>/projects/<encoded project path>/memory/, one file per
// fact plus a MEMORY.md index. Only the user's preferences and corrections (types feedback and
// user) can repeat across projects; facts about a project stay where they are.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readGlobalConfig } = require('./claudeFiles');
const { writeFileAtomic } = require('./fsutil');

const PREFERENCE_TYPES = new Set(['feedback', 'user']);
const INDEX = 'MEMORY.md';
const BODY_CHARS = 1200; // per memory in the prompt
const GENERIC_PARENTS = new Set(['www', 'htdocs', 'desktop', 'documents', 'documentos', 'projects', 'projetos', 'repos', 'src', 'code', 'dev', 'git']);

const projectsDir = (paths) => path.join(paths.configDir, 'projects');
// How Claude Code names a project's folder: every character that isn't a letter or digit becomes '-'.
const encodeProject = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

// Folder name -> the project's real path, from the projects Claude Code knows in ~/.claude.json.
function projectPaths(paths) {
  const gc = readGlobalConfig(paths);
  const map = new Map();
  for (const p of Object.keys((gc && gc.projects) || {})) map.set(encodeProject(p).toLowerCase(), p);
  return map;
}

// ~/.claude.json forgets projects; the session transcripts in the folder still say where they ran.
function cwdFromTranscripts(dir, dirName) {
  let files;
  try {
    files = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => ({ file: path.join(dir, n), at: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .slice(0, 3);
  } catch {
    return null;
  }
  for (const { file } of files) {
    let head = '';
    try {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(64 * 1024);
      head = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0));
      fs.closeSync(fd);
    } catch {
      continue;
    }
    for (const m of head.matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) {
      let cwd;
      try {
        cwd = JSON.parse(`"${m[1]}"`);
      } catch {
        continue;
      }
      if (encodeProject(cwd).toLowerCase() === dirName.toLowerCase()) return cwd;
    }
  }
  return null;
}

// "claude-switcher", "Rota7/web": the folder name, with its parent when that says something.
function labelOf(dirName, realPath) {
  if (!realPath) {
    // Only the encoded name: what comes after the last generic folder (Desktop, www…).
    const tokens = dirName.replace(/^[a-zA-Z]--/, '').split('-');
    let at = -1;
    tokens.forEach((t, i) => GENERIC_PARENTS.has(t.toLowerCase()) && i < tokens.length - 1 && (at = i));
    return tokens.slice(at + 1).join('-');
  }
  const parts = realPath.split(/[\\/]+/).filter(Boolean);
  const last = parts[parts.length - 1] || realPath;
  const parent = parts[parts.length - 2];
  if (!parent || /:$/.test(parent) || GENERIC_PARENTS.has(parent.toLowerCase()) || parts.length <= 2) return last;
  return `${parent}/${last}`;
}

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  if (!m) return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!kv || !kv[2] || kv[1] in meta) continue;
    let v = kv[2].trim();
    if (v.startsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {}
    } else if (/^'.*'$/.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
    meta[kv[1]] = v;
  }
  return { meta, body: text.slice(m[0].length).trim() };
}

// The folder under projects/ that Claude Code uses for a project path. Windows paths come with
// either drive letter case, so an existing folder is matched without case.
function projectDirFor(paths, root) {
  const want = encodeProject(root);
  try {
    const hit = fs.readdirSync(projectsDir(paths)).find((n) => n.toLowerCase() === want.toLowerCase());
    if (hit) return hit;
  } catch {}
  return want;
}

// Every memory of every project, or of one (`project`: its folder name). `id` is the path
// under projects/, with forward slashes.
function scanMemories(paths, { project = null } = {}) {
  const root = projectsDir(paths);
  const real = projectPaths(paths);
  const out = [];
  let dirs = [];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && (!project || d.name === project))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return out;
  }
  for (const d of dirs) {
    const memDir = path.join(root, d.name, 'memory');
    let names;
    try {
      names = fs.readdirSync(memDir).filter((n) => n.endsWith('.md') && n !== INDEX);
    } catch {
      continue;
    }
    const projectPath = real.get(d.name.toLowerCase()) || cwdFromTranscripts(path.join(root, d.name), d.name);
    for (const name of names.sort()) {
      const file = path.join(memDir, name);
      let content;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const { meta, body } = parseFrontmatter(content);
      out.push({
        id: `${d.name}/memory/${name}`,
        file,
        project: d.name,
        projectPath,
        projectLabel: labelOf(d.name, projectPath),
        name: meta.name || name.replace(/\.md$/, ''),
        description: meta.description || '',
        type: meta.type || null,
        body,
        content,
      });
    }
  }
  return out;
}

const isPreference = (m) => PREFERENCE_TYPES.has(m.type);

// Changes whenever a preference memory or the CLAUDE.md changes: the analysis is redone then.
function inputHash(memories, claudeMd) {
  return sha(JSON.stringify([claudeMd, memories.map((m) => [m.id, m.content])]));
}

// --- MEMORY.md ---------------------------------------------------------------------------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LINK_TO_MD = /\]\((?:\.\/)?[^)\s]+\.md\)/g;

// The index without the links to `fileName`. A line that only points there goes; a line that
// lists several memories loses just that link. `edits` is what undoes it (see relinkIndex).
function unlinkFromIndex(text, fileName) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const link = `\\*{0,2}\\[[^\\]]*\\]\\((?:\\./)?${escapeRe(fileName)}\\)\\*{0,2}`;
  const target = new RegExp(`\\]\\((?:\\./)?${escapeRe(fileName)}\\)`);
  const edits = [];
  for (let i = 0; i < lines.length; i++) {
    const before = lines[i];
    if (!target.test(before)) continue;
    const others = (before.match(LINK_TO_MD) || []).filter((l) => !target.test(l)).length;
    if (!others) {
      edits.push({ line: i, before, after: null });
      lines.splice(i--, 1);
      continue;
    }
    let after = before.replace(new RegExp(`\\s*[,;]\\s*${link}`), '');
    if (after === before) after = before.replace(new RegExp(`${link}\\s*[,;]\\s*`), '');
    if (after === before) after = before.replace(new RegExp(link), '');
    edits.push({ line: i, before, after });
    lines[i] = after;
  }
  return { text: lines.join(eol), edits };
}

// Puts back what unlinkFromIndex took out, as far as the index still looks the same.
function relinkIndex(text, edits) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text ? text.split(/\r?\n/) : [];
  for (const e of edits.slice().reverse()) {
    if (lines.includes(e.before)) continue;
    const at = e.after == null ? -1 : lines.indexOf(e.after);
    if (at >= 0) lines[at] = e.before;
    else if (e.after == null) lines.splice(Math.min(e.line, lines.length), 0, e.before);
    else lines.splice(lines.length && !lines[lines.length - 1] ? lines.length - 1 : lines.length, 0, e.before);
  }
  return lines.join(eol);
}

// Deletes a memory and its index links, keeping a copy under `backupDir`. Returns what
// restoreMemory needs, or null when the file is already gone.
async function removeMemory(paths, id, backupDir) {
  const file = path.join(projectsDir(paths), ...id.split('/'));
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const copy = path.join(backupDir, ...id.split('/'));
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.writeFileSync(copy, content);
  const indexFile = path.join(path.dirname(file), INDEX);
  let edits = [];
  if (fs.existsSync(indexFile)) {
    const r = unlinkFromIndex(fs.readFileSync(indexFile, 'utf8'), path.basename(file));
    if (r.edits.length) await writeFileAtomic(indexFile, r.text);
    edits = r.edits;
  }
  fs.unlinkSync(file);
  return { id, content, index: edits };
}

async function restoreMemory(paths, saved) {
  const file = path.join(projectsDir(paths), ...saved.id.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, saved.content);
  if (!saved.index.length) return;
  const indexFile = path.join(path.dirname(file), INDEX);
  const text = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : '';
  const next = relinkIndex(text, saved.index);
  if (next !== text) await writeFileAtomic(indexFile, next);
}

// --- analysis ----------------------------------------------------------------------------

const SYSTEM_PROMPT = `Você organiza as memórias que o Claude Code salvou em vários projetos do mesmo usuário.
Cada memória é uma preferência ou correção que o usuário deu num projeto. A mesma preferência costuma ter sido salva de novo em cada projeto, às vezes com outras palavras ou em outra língua.

Encontre os grupos de memórias que dizem a mesma coisa e que valem para qualquer projeto: jeito de trabalhar, idioma das respostas, commits e git, quando pedir confirmação, estilo de código ou de texto.

Regras:
- Agrupe pelo sentido, não pelas palavras: "Never add Co-Authored-By" e "não colocar coautor do Claude nos commits" são a mesma regra.
- Um grupo precisa ter memórias de pelo menos 2 projetos diferentes. A exceção é quando a regra já está no CLAUDE.md global: aí marque inGlobal = true, e basta 1 memória.
- Não agrupe o que só vale para um projeto (servidores, bancos, telas, nomes de arquivos ou de sistemas do projeto), mesmo que se repita.
- Não agrupe memórias que se contradizem.
- Cada memória entra em no máximo um grupo. Use os ids exatamente como vieram.
- title: até 60 caracteres, em português do Brasil.
- rule: a regra que vai para o CLAUDE.md global, em português do Brasil, numa frase ou duas no imperativo, juntando o que as memórias dizem e sem citar projetos. Em grupos inGlobal, repita a regra que já está no CLAUDE.md.
- Se não houver nenhum grupo, devolva groups vazio.`;

const SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          rule: { type: 'string' },
          inGlobal: { type: 'boolean' },
          ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'rule', 'inGlobal', 'ids'],
      },
    },
  },
  required: ['groups'],
};

function buildPrompt(memories, claudeMd) {
  const parts = [];
  parts.push('## CLAUDE.md global atual', '', claudeMd.trim() ? claudeMd.trim() : '(vazio)', '', '## Memórias', '');
  memories.forEach((m, i) => {
    const body = m.body.length > BODY_CHARS ? `${m.body.slice(0, BODY_CHARS)}…` : m.body;
    parts.push(`### m${i + 1}`, `projeto: ${m.projectLabel}`, `nome: ${m.name}`, `descrição: ${m.description}`, '', body, '');
  });
  return parts.join('\n');
}

// Keeps only groups that hold up: known ids, each once, from enough projects.
function validateGroups(out, memories) {
  const byRef = new Map(memories.map((m, i) => [`m${i + 1}`, m]));
  const used = new Set();
  const groups = [];
  for (const g of (out && Array.isArray(out.groups) && out.groups) || []) {
    if (!g || typeof g.rule !== 'string' || !g.rule.trim() || !Array.isArray(g.ids)) continue;
    const members = [...new Set(g.ids)].map((r) => byRef.get(String(r).trim())).filter((m) => m && !used.has(m.id));
    const projects = new Set(members.map((m) => m.project));
    const inGlobal = !!g.inGlobal;
    if (!members.length || (!inGlobal && projects.size < 2)) continue;
    members.forEach((m) => used.add(m.id));
    const ids = members.map((m) => m.id).sort();
    groups.push({
      key: sha(ids.join('\n')).slice(0, 12),
      title: String(g.title || g.rule).trim().slice(0, 80),
      rule: g.rule.replace(/\s+/g, ' ').trim(),
      inGlobal,
      ids,
    });
  }
  return groups;
}

module.exports = {
  scanMemories,
  projectDirFor,
  isPreference,
  inputHash,
  unlinkFromIndex,
  relinkIndex,
  removeMemory,
  restoreMemory,
  buildPrompt,
  validateGroups,
  labelOf,
  encodeProject,
  projectsDir,
  parseFrontmatter,
  SYSTEM_PROMPT,
  SCHEMA,
};
