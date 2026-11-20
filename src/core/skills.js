'use strict';

// The skills Claude Code loads, the SKILL.md format, and what Claude is asked when it looks for
// tasks that keep coming back in the conversations and when it writes a skill for one.
// User skills live in <configDir>/skills/<name>/SKILL.md, a project's in
// <root>/.claude/skills/<name>/SKILL.md; plugins and claude.ai bring their own, read only.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson } = require('./fsutil');
const { parseFrontmatter } = require('./memories');

const SKILL_FILE = 'SKILL.md';
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const userSkillsDir = (paths) => path.join(paths.configDir, 'skills');
const projectSkillsDir = (root) => path.join(root, '.claude', 'skills');

// "Publicar versão!" -> "publicar-versao".
function slug(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

function readSkill(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const { meta } = parseFrontmatter(text);
  const dir = path.dirname(file);
  return { name: meta.name || path.basename(dir), description: meta.description || '', file, dir };
}

// The skills in a skills folder, one per subfolder with a SKILL.md. `synced` is claude.ai's.
function skillsIn(dir, source) {
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'synced');
  } catch {
    return [];
  }
  return names
    .map((d) => readSkill(path.join(dir, d.name, SKILL_FILE)))
    .filter(Boolean)
    .map((s) => ({ ...s, source, id: s.name, editable: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const userSkills = (paths) => skillsIn(userSkillsDir(paths), 'user');
const projectSkills = (root) => (root ? skillsIn(projectSkillsDir(root), 'project').map((s) => ({ ...s, root })) : []);

// Skills of the installed plugins, named the way the Skill tool calls them ("postman:bootstrap").
function pluginSkills(paths) {
  const data = (() => {
    try {
      return readJson(path.join(paths.configDir, 'plugins', 'installed_plugins.json'));
    } catch {
      return null;
    }
  })();
  const out = [];
  for (const [id, installs] of Object.entries((data && data.plugins) || {})) {
    const install = Array.isArray(installs) ? installs[installs.length - 1] : null;
    if (!install || !install.installPath) continue;
    const plugin = id.split('@')[0];
    for (const s of skillsIn(path.join(install.installPath, 'skills'), 'plugin')) {
      out.push({ ...s, id: `${plugin}:${s.name}`, plugin, editable: false });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// Skills synced from claude.ai, from each bucket's manifest.
function syncedSkills(paths) {
  const root = path.join(userSkillsDir(paths), 'synced');
  const out = new Map();
  let buckets = [];
  try {
    buckets = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'));
  } catch {
    return [];
  }
  for (const b of buckets) {
    let manifest = null;
    try {
      manifest = readJson(path.join(root, b.name, 'manifest.json'));
    } catch {}
    for (const s of (manifest && manifest.skills) || []) {
      if (!s || !s.name || out.has(s.name)) continue;
      const file = path.join(root, b.name, s.name, SKILL_FILE);
      out.set(s.name, { name: s.name, description: s.description || '', file, dir: path.dirname(file), source: 'claude.ai', id: `anthropic-skills:${s.name}`, editable: false });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// How many times each skill was used, from the conversation index (`entries`): the Skill tool
// and /name typed by the user. Plugin and claude.ai skills also count by their short name.
function usageOf(entries) {
  const count = new Map();
  const last = new Map();
  for (const e of entries) {
    for (const [name, n] of Object.entries(e.skills || {})) {
      count.set(name, (count.get(name) || 0) + n);
      if (e.end && (!last.get(name) || e.end > last.get(name))) last.set(name, e.end);
    }
  }
  return (skill) => {
    const keys = [skill.id, skill.name, `anthropic-skills:${skill.name}`].filter((k, i, a) => a.indexOf(k) === i);
    return {
      count: keys.reduce((n, k) => n + (count.get(k) || 0), 0),
      lastAt: keys.reduce((t, k) => Math.max(t, last.get(k) || 0), 0) || null,
    };
  };
}

// The file Claude Code reads: the frontmatter it needs, then the body. The description goes in
// double quotes (a JSON string is valid YAML), since it often has ": " in it.
function composeSkill({ name, description, body }) {
  const desc = String(description || '').replace(/\s+/g, ' ').trim();
  return `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${String(body || '').trim()}\n`;
}

// The skill a SKILL.md text describes, or why it can't be installed.
function checkSkillText(text) {
  const { meta, body } = parseFrontmatter(text);
  if (!/^---\r?\n/.test(text)) return { error: 'falta o cabeçalho (--- name / description ---) no começo do arquivo' };
  const name = String(meta.name || '').trim();
  if (!NAME.test(name)) return { error: `o nome "${name}" não serve: use só letras minúsculas, números e hífens (até 64)` };
  if (!String(meta.description || '').trim()) return { error: 'falta a description, que é o que faz o Claude usar a skill' };
  if (!body.trim()) return { error: 'a skill está vazia' };
  return { name, description: meta.description };
}

// --- looking for tasks that come back --------------------------------------------------------

const DAY = 24 * 3600 * 1000;
const DIGEST_CHARS = 150000;
const DIGEST_DAYS = 120;
const FIRST_CHARS = 280;
const OTHER_CHARS = 140;
const SHOWN_PROMPTS = 12;

const fmtDate = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '?');

// Which prompts of a conversation the digest shows: the first one, then all when there are
// few, else the first few and the last ones (where "now publish it" usually comes).
function shownPrompts(prompts) {
  const idx = prompts.map((_, i) => i);
  if (idx.length <= SHOWN_PROMPTS) return idx;
  return [...idx.slice(0, 4), ...idx.slice(-(SHOWN_PROMPTS - 4))];
}

// The conversations as Claude reads them: newest first, a few lines each, numbered so it can
// point at them (c12 is a conversation, c12.3 its third prompt). `refs`: ref -> entry.
function buildDigest(entries, { now = Date.now(), maxChars = DIGEST_CHARS, days = DIGEST_DAYS } = {}) {
  const list = entries
    .filter((e) => e.prompts.length && (e.end || e.start || 0) >= now - days * DAY)
    .sort((a, b) => (b.start || b.end || 0) - (a.start || a.end || 0));
  const refs = new Map();
  const parts = [];
  let size = 0;
  for (const e of list) {
    const ref = `c${refs.size + 1}`;
    const lines = [`### ${ref} · ${e.label} · ${fmtDate(e.start || e.end)}${e.titleShown ? ` · ${e.titleShown}` : ''}`];
    const shown = shownPrompts(e.prompts);
    let prev = -1;
    for (const i of shown) {
      if (i > prev + 1) lines.push(`(… ${i - prev - 1} pedidos)`);
      lines.push(`${i + 1}. ${clip(e.prompts[i].t, i === 0 ? FIRST_CHARS : OTHER_CHARS)}`);
      prev = i;
    }
    const cmds = Object.entries(e.commands || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([f, n]) => (n > 1 ? `${f} ×${n}` : f));
    if (cmds.length) lines.push(`comandos: ${cmds.join(', ')}`);
    const used = Object.keys(e.skills || {});
    if (used.length) lines.push(`skills: ${used.join(', ')}`);
    const block = lines.join('\n');
    if (size + block.length > maxChars) break;
    parts.push(block);
    size += block.length + 2;
    refs.set(ref, e);
  }
  return { text: parts.join('\n\n'), refs, total: list.length };
}

// Commands that show up in several of these conversations, with where.
function repeatedCommands(entries, { min = 3, max = 25 } = {}) {
  const by = new Map();
  for (const e of entries) {
    for (const f of Object.keys(e.commands || {})) {
      if (!by.has(f)) by.set(f, { convs: 0, projects: new Set() });
      const x = by.get(f);
      x.convs++;
      x.projects.add(e.label);
    }
  }
  return [...by]
    .filter(([, x]) => x.convs >= min)
    .sort((a, b) => b[1].convs - a[1].convs)
    .slice(0, max)
    .map(([f, x]) => `- ${f}: ${x.convs} conversas (${[...x.projects].slice(0, 4).join(', ')}${x.projects.size > 4 ? ', …' : ''})`);
}

const ANALYSIS_SYSTEM = `Você analisa o histórico de conversas de um usuário com o Claude Code e encontra as tarefas que ele pede de novo e de novo e que valeriam uma skill.

Uma skill é um arquivo SKILL.md que o Claude Code carrega sozinho quando um pedido combina com a descrição dela. Ela ensina um procedimento: os passos, os comandos e caminhos certos, as conferências e os erros a evitar. Vale a pena quando o Claude teve que redescobrir o mesmo procedimento, ou ser lembrado dele, em várias conversas.

Sugira uma skill quando:
- o mesmo tipo de tarefa aparece em pelo menos 2 conversas diferentes, mesmo com outras palavras ("suba em commits separados" e "manda pro git separando os commits" são a mesma tarefa);
- a tarefa tem um procedimento concreto que se repete: comandos, arquivos, ordem dos passos, conferências (publicar, fazer deploy, gerar versão, rodar no celular, capturar requisições, importar dados, atualizar o servidor);
- ou o usuário precisou explicar ou corrigir o mesmo jeito de fazer em mais de uma conversa.
Os comandos de cada conversa ajudam a ver o procedimento por trás dos pedidos.

Não sugira:
- preferências de uma linha que valem sempre (idioma, estilo de commit, quando pedir confirmação): isso é regra de CLAUDE.md, não skill;
- trabalho comum de desenvolvimento que muda a cada vez (criar uma tela, corrigir um bug, explicar um código, revisar um projeto);
- o que uma skill existente já cobre. Se ela cobre a tarefa mas o usuário continua corrigindo ou completando o procedimento, sugira melhorá-la, com improves;
- o que o usuário já recusou.

Para cada sugestão:
- name: o nome da skill, em kebab-case, curto, em português sem acentos (ex.: publicar-versao, deploy-servidor). Ao melhorar uma skill, o nome dela.
- title: até 60 caracteres, em português do Brasil.
- scope: "project" quando a tarefa é de um projeto só (comandos, caminhos ou sistemas daquele projeto); "global" quando aparece em vários projetos ou não depende de nenhum.
- project: o projeto, escrito como aparece no histórico, quando scope é "project"; senão "".
- why: uma frase dizendo o que se repete e o que a skill evita.
- when: quando o Claude deve usar a skill, com as palavras que o usuário costuma usar nos pedidos.
- steps: de 3 a 7 passos curtos do procedimento, como aparece nas conversas.
- evidence: as conversas em que a tarefa aparece, como c12.3 (conversa 12, pedido 3), apontando o pedido em que ela começa. Use as referências exatamente como vieram.
- improves: o nome da skill existente que a sugestão melhora, ou "".
Ordene da mais útil para a menos útil, no máximo 8. Se nada se repete de verdade, devolva suggestions vazio.`;

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          title: { type: 'string' },
          scope: { type: 'string', enum: ['global', 'project'] },
          project: { type: 'string' },
          why: { type: 'string' },
          when: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' } },
          evidence: { type: 'array', items: { type: 'string' } },
          improves: { type: 'string' },
        },
        required: ['name', 'title', 'scope', 'project', 'why', 'when', 'steps', 'evidence', 'improves'],
      },
    },
  },
  required: ['suggestions'],
};

const skillLine = (s, usage) => {
  const where = s.source === 'project' ? `projeto ${s.projectLabel || path.basename(s.root || '')}` : s.source === 'user' ? 'global' : s.source;
  const u = usage ? usage(s).count : 0;
  return `- ${s.id} (${where}${u ? `, usada ${u}×` : ''}): ${clip(String(s.description).replace(/\s+/g, ' '), 260)}`;
};

function buildAnalysisPrompt({ digest, commands, skills, usage, ignored }) {
  const parts = ['## Skills que já existem', '', skills.length ? skills.map((s) => skillLine(s, usage)).join('\n') : '(nenhuma)', ''];
  if (ignored.length) {
    parts.push('## Sugestões que o usuário recusou (não sugira de novo)', '', ignored.map((g) => `- ${g.title}: ${g.why || ''}`).join('\n'), '');
  }
  if (commands.length) parts.push('## Comandos que aparecem em várias conversas', '', commands.join('\n'), '');
  parts.push('## Conversas (da mais recente para a mais antiga)', '', digest.text);
  return parts.join('\n');
}

// Keeps the suggestions that hold up: real conversations, at least two of them, a usable name,
// and a project that is one of them. `editable`: the user's and the projects' skills.
function validateSuggestions(out, refs, editable) {
  const seen = new Set();
  const list = [];
  for (const s of (out && Array.isArray(out.suggestions) && out.suggestions) || []) {
    if (!s || !s.title || !Array.isArray(s.evidence)) continue;
    const evidence = [];
    for (const r of s.evidence) {
      const m = /^(c\d+)(?:\.(\d+))?$/.exec(String(r).trim());
      const e = m && refs.get(m[1]);
      if (!e || evidence.some((x) => x.conv === e.key)) continue;
      evidence.push({ conv: e.key, prompt: Math.min(Math.max(1, Number(m[2]) || 1), e.prompts.length), entry: e });
    }
    if (evidence.length < 2) continue;
    // A project skill belongs to the project named, or else to the one most of the evidence is from.
    let scope = s.scope === 'project' ? 'project' : 'global';
    let project = null;
    if (scope === 'project') {
      const want = String(s.project || '').trim().toLowerCase();
      const named = evidence.find((x) => x.entry.label.toLowerCase() === want);
      const counts = new Map();
      for (const x of evidence) counts.set(x.entry.project, (counts.get(x.entry.project) || 0) + 1);
      const most = [...counts].sort((a, b) => b[1] - a[1])[0][0];
      const pick = named ? named.entry : evidence.find((x) => x.entry.project === most).entry;
      if (pick.cwd) project = { dir: pick.project, path: pick.cwd, label: pick.label };
      else scope = 'global';
    }
    const name = slug(s.name) || slug(s.title);
    if (!name) continue;
    const inScope = editable.filter((k) => (scope === 'project' ? k.source === 'project' && project && samePath(k.root, project.path) : k.source === 'user'));
    const improvesName = slug(s.improves);
    const improves = inScope.find((k) => k.name === improvesName) || inScope.find((k) => k.name === name) || null;
    const key = sha([scope, project ? project.dir.toLowerCase() : '', improves ? improves.name : name].join('\n')).slice(0, 12);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({
      key,
      name: improves ? improves.name : name,
      title: clip(String(s.title).trim(), 80),
      scope,
      project,
      why: String(s.why || '').trim(),
      when: String(s.when || '').trim(),
      steps: (Array.isArray(s.steps) ? s.steps : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 8),
      evidence: evidence.map(({ conv, prompt }) => ({ conv, prompt })),
      improves: improves ? improves.file : null,
    });
  }
  return list;
}

const samePath = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// --- writing a skill ----------------------------------------------------------------------

function draftSystem({ vault }) {
  const secrets = vault
    ? '- Nunca escreva senhas, tokens ou chaves. Quando um comando precisa de uma credencial, use o cofre do Claude Switcher: `node ~/.claude-switcher/segredo.js exec -- comando ... {{credencial.campo}}` (ou `{{arquivo:credencial.campo}}` quando o programa lê de arquivo, ou `--env NOME=credencial.campo`), e diga para ver os nomes com `node ~/.claude-switcher/segredo.js lista`.'
    : '- Nunca escreva senhas, tokens ou chaves. Quando um comando precisa de uma credencial, diga de onde o Claude deve pegá-la (variável de ambiente, arquivo do usuário), sem o valor.';
  return `Você escreve skills para o Claude Code a partir de conversas reais do usuário com ele.

Uma skill é um SKILL.md. O Claude Code lê só a description de cada skill para decidir quando carregá-la; o corpo é lido quando ela é usada. Devolva:
- name: o nome em kebab-case (quando ele vier pronto no pedido, repita).
- description: até 1024 caracteres, de 1 a 3 frases em português do Brasil. Diga o que a skill faz e quando usar, com as palavras que o usuário usa nos pedidos, os nomes dos sistemas e dos comandos. Seja específico: é por ela que o Claude decide. Comece pelo verbo ("Publica…", "Gera…") e inclua "Use quando…".
- body: o corpo em Markdown, sem o cabeçalho ---, em português do Brasil:
  - um título e uma ou duas frases sobre o objetivo;
  - os passos numerados, no imperativo, com os comandos, caminhos e parâmetros exatos que funcionaram nas conversas, em blocos de código;
  - como conferir que deu certo;
  - uma seção "Cuidados" com os erros que aconteceram nas conversas (linhas com ✗) e as correções que o usuário fez, ditos como regra;
  - só o que o Claude não saberia sozinho, sem explicar o óbvio. No máximo umas 150 linhas.
  - Generalize: o que muda a cada vez (nomes de arquivo, mensagens, versões, ids) vira um <marcador>, com a indicação de onde tirar o valor.
${secrets} Nas conversas, o que parecia segredo já aparece como [segredo].
- Siga as regras do CLAUDE.md global e do projeto, sem repeti-las na skill.
- Ao melhorar uma skill que já existe, devolva a skill inteira atualizada, mantendo o que continua valendo.
- note: uma frase para o usuário dizendo o que a skill cobre ou o que ficou de fora.`;
}

const DRAFT_SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' }, description: { type: 'string' }, body: { type: 'string' }, note: { type: 'string' } },
  required: ['name', 'description', 'body', 'note'],
};

function buildDraftPrompt({ task, existing, claudeMd, projectMd, others, excerpts }) {
  const parts = ['## A skill', '', ...task, ''];
  if (existing) parts.push('## A skill atual (melhore esta)', '', existing.trim(), '');
  parts.push('## CLAUDE.md global', '', claudeMd.trim() || '(vazio)', '');
  if (projectMd != null) parts.push('## CLAUDE.md do projeto', '', projectMd.trim() || '(vazio)', '');
  if (others.length) parts.push('## Outras skills (não repita o que elas fazem)', '', others.join('\n'), '');
  parts.push('## Conversas em que a tarefa aconteceu', '');
  excerpts.forEach((x, i) => parts.push(`### Conversa ${i + 1} · ${x.label} · ${fmtDate(x.at)}${x.title ? ` · ${x.title}` : ''}`, '', x.text || '(vazia)', ''));
  return parts.join('\n');
}

// --- finding conversations for a skill the user describes ----------------------------------

const STOP = new Set(
  'de da do das dos que para pra com uma um em no na nos nas por os as se eu me meu minha quero preciso faça faz isso esse essa este esta como mais tem ter ser seguinte agora aqui ele ela voce você nao não sim mas ou ao quando sempre the and for with that this skill skills claude'.split(' '),
);
const words = (s) =>
  new Set(
    String(s)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !STOP.has(w)),
  );

// The conversations whose prompts share the most words with `request`, best first, with the
// prompt where the overlap is highest.
function related(entries, request, { max = 3, min = 2 } = {}) {
  const want = words(request);
  if (!want.size) return [];
  const scored = [];
  for (const e of entries) {
    let best = { score: 0, prompt: 1 };
    e.prompts.forEach((p, i) => {
      const w = words(p.t);
      let score = 0;
      for (const x of want) if (w.has(x)) score++;
      if (score > best.score) best = { score, prompt: i + 1 };
    });
    if (best.score >= Math.min(min, want.size)) scored.push({ entry: e, ...best });
  }
  return scored.sort((a, b) => b.score - a.score || (b.entry.end || 0) - (a.entry.end || 0)).slice(0, max);
}

module.exports = {
  SKILL_FILE,
  userSkillsDir,
  projectSkillsDir,
  slug,
  readSkill,
  userSkills,
  projectSkills,
  pluginSkills,
  syncedSkills,
  usageOf,
  composeSkill,
  checkSkillText,
  buildDigest,
  repeatedCommands,
  buildAnalysisPrompt,
  validateSuggestions,
  ANALYSIS_SYSTEM,
  ANALYSIS_SCHEMA,
  draftSystem,
  DRAFT_SCHEMA,
  buildDraftPrompt,
  related,
  samePath,
  skillLine,
};
