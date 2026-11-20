'use strict';

// Page "Skills": Claude reads the conversations (see conversations.js) and points out the tasks
// the user keeps asking for, that a skill would teach once; for the one picked, it writes the
// SKILL.md from what really happened in those conversations. Nothing is installed before the
// user reads the draft, and installing can be undone. State shared by every window lives in
// skills.json; drafts in skill-drafts/.
const fs = require('fs');
const path = require('path');
const { Store } = require('./store');
const { writeFileAtomic } = require('./fsutil');
const { ConversationIndex, excerpt, redact } = require('./conversations');
const sk = require('./skills');
const md = require('./claudeMd');

const DAY = 24 * 3600 * 1000;
const KEEP_CREATED = 50;
const EVIDENCE = 5; // conversations a draft is written from
const AUTO_EVERY = 7 * DAY;
const AUTO_MIN_NEW = 10; // new conversations before an automatic analysis
// Sonnet finds the repeats far better than Haiku. At the CLI's default effort it thinks over
// 200 conversations for more than 10 min; at medium it answers in 1 to 2 min, just as well.
const MODEL = 'sonnet';
const EFFORT = 'medium';
const TIMEOUT = 10 * 60 * 1000;

class SkillCurator {
  // `run({ prompt, system, schema, model, timeoutMs })` asks Claude and resolves to the answer.
  constructor({ paths, switcherDir, run, log = () => {} }) {
    this.paths = paths;
    this.switcherDir = switcherDir;
    this.run = run;
    this.log = log;
    this.index = new ConversationIndex(paths, switcherDir, { log });
    this.store = new Store(switcherDir, {
      name: 'skills',
      defaults: { analysis: null, error: null, ignored: [], drafts: {}, created: [], autoAt: 0 },
    });
    this.running = null;
    this.drafting = new Set();
  }

  draftsDir() {
    return path.join(this.switcherDir, 'skill-drafts');
  }

  // Every skill Claude Code would see from these projects: the user's, the projects', plugins'
  // and claude.ai's. `roots`: project folders to look in.
  allSkills(roots = []) {
    const seen = new Set();
    const project = [];
    for (const r of roots) {
      if (!r || seen.has(r.path.toLowerCase())) continue;
      seen.add(r.path.toLowerCase());
      project.push(...sk.projectSkills(r.path).map((s) => ({ ...s, projectLabel: r.label })));
    }
    return [...sk.userSkills(this.paths), ...project, ...sk.pluginSkills(this.paths), ...sk.syncedSkills(this.paths)];
  }

  projectRoots(entries) {
    const by = new Map();
    for (const e of entries) if (e.cwd && !by.has(e.project)) by.set(e.project, { path: e.cwd, label: e.label });
    return [...by.values()].filter((r) => fs.existsSync(r.path));
  }

  // Everything the page shows. `root`: the project open in VS Code.
  view(root = null) {
    const data = this.store.load();
    const entries = this.index.entries();
    const a = data.analysis;
    const ignored = new Set(data.ignored.map((g) => g.key));
    const byKey = new Map(entries.map((e) => [e.key, e]));
    const suggestions = [];
    for (const s of (a && a.suggestions) || []) {
      if (ignored.has(s.key)) continue;
      const evidence = s.evidence.map((x) => ({ ...x, entry: byKey.get(x.conv) || null })).filter((x) => x.entry);
      suggestions.push({ ...s, evidence, draft: data.drafts[s.key] || null });
    }
    const usage = sk.usageOf(entries);
    const withUsage = (list) => list.map((s) => ({ ...s, usage: usage(s) }));
    const drafts = Object.values(data.drafts).filter((d) => !d.key || !suggestions.some((s) => s.key === d.key));
    return {
      analyzedAt: a ? a.at : null,
      running: !!this.running,
      error: data.error ? data.error.message : null,
      suggestions,
      drafts, // drafts not tied to a suggestion on screen ("Nova skill…")
      ignoredCount: data.ignored.length,
      convCount: entries.filter((e) => e.prompts.length).length,
      projectCount: new Set(entries.filter((e) => e.prompts.length).map((e) => e.project)).size,
      newSince: a ? entries.filter((e) => e.prompts.length && (e.start || 0) > a.at).length : null,
      indexed: entries.length > 0,
      user: withUsage(sk.userSkills(this.paths)),
      project: root ? withUsage(sk.projectSkills(root)) : [],
      others: withUsage([...sk.pluginSkills(this.paths), ...sk.syncedSkills(this.paths)]),
      created: data.created,
    };
  }

  // Reads what is new in the conversations (no tokens).
  refreshIndex(opts) {
    return this.index.refresh(opts);
  }

  // The conversations were read at least once.
  indexed() {
    return Object.keys(this.index.load().files).length > 0;
  }

  // Claude looks for tasks that keep coming back. Always runs when called: the conversations
  // change all the time, so there is no "nothing changed" to skip on.
  async analyze() {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        await this.refreshIndex();
        const entries = this.index.entries();
        const data = this.store.load();
        const digest = sk.buildDigest(entries);
        let suggestions = [];
        if (digest.refs.size >= 2) {
          const shown = [...digest.refs.values()];
          const skills = this.allSkills(this.projectRoots(shown));
          // Prompts sometimes carry a password typed in: it goes out as [segredo].
          const prompt = redact(
            sk.buildAnalysisPrompt({ digest, commands: sk.repeatedCommands(shown), skills, usage: sk.usageOf(entries), ignored: data.ignored }),
          ).text;
          const out = await this.run({ prompt, system: sk.ANALYSIS_SYSTEM, schema: sk.ANALYSIS_SCHEMA, model: MODEL, effort: EFFORT, timeoutMs: TIMEOUT });
          suggestions = sk.validateSuggestions(out, digest.refs, skills.filter((s) => s.editable));
        }
        const analysis = { at: Date.now(), conversations: digest.refs.size, suggestions };
        await this.store.update((d) => {
          d.analysis = analysis;
          d.error = null;
        });
        return analysis;
      } catch (e) {
        this.log(`análise das skills: ${e.message}`);
        await this.store.update((d) => (d.error = { message: e.message, at: Date.now() })).catch(() => {});
        throw e;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  // An automatic analysis is due: a week since the last one and enough new conversations.
  autoDue(now = Date.now()) {
    const data = this.store.load();
    const last = Math.max((data.analysis && data.analysis.at) || 0, data.autoAt || 0);
    if (now - last < AUTO_EVERY) return false;
    const since = (data.analysis && data.analysis.at) || 0;
    return this.index.entries().filter((e) => e.prompts.length && (e.start || 0) > since).length >= AUTO_MIN_NEW;
  }

  // Only one window runs it: the one that marks it first.
  async claimAuto(now = Date.now()) {
    if (!this.autoDue(now)) return false;
    return this.store.update((d) => {
      const last = Math.max((d.analysis && d.analysis.at) || 0, d.autoAt || 0);
      if (now - last < AUTO_EVERY) return false;
      d.autoAt = now;
      return true;
    });
  }

  async ignore(key) {
    return this.store.update((d) => {
      const s = d.analysis && d.analysis.suggestions.find((x) => x.key === key);
      if (s && !d.ignored.some((g) => g.key === key)) d.ignored.push({ key, title: s.title, why: s.why });
    });
  }

  async clearIgnored() {
    return this.store.update((d) => (d.ignored = []));
  }

  // --- drafts --------------------------------------------------------------------------------

  // What a draft is written from: the conversations, as excerpts.
  async excerpts(evidence) {
    const out = [];
    for (const x of evidence.slice(0, EVIDENCE)) {
      const e = x.entry;
      try {
        out.push({ label: e.label, at: e.start || e.end, title: e.titleShown, text: await excerpt(this.index.fileOf(e.key), x.prompt) });
      } catch (err) {
        this.log(`skills: não li a conversa ${e.key} (${err.message})`);
      }
    }
    return out;
  }

  // Claude writes the SKILL.md. `task` says what the skill is; `target`: where it goes
  // ({ scope, project }); `improves`: the SKILL.md it rewrites; `name`: the skill's, when
  // already decided (else Claude names it).
  async write({ id, key = null, name: given = null, title, task, target, improves = null, evidence }) {
    if (this.drafting.has(id)) throw new Error('essa skill já está sendo escrita');
    this.drafting.add(id);
    try {
      const excerpts = await this.excerpts(evidence);
      const existing = improves ? md.readMd(improves) : null;
      const projectMd =
        target.scope === 'project'
          ? md
              .projectMdPaths(target.project.path)
              .map((f) => md.readMd(f))
              .filter(Boolean)
              .join('\n\n')
          : null;
      const roots = target.scope === 'project' ? [{ path: target.project.path, label: target.project.label }] : [];
      const others = this.allSkills(roots)
        .filter((s) => !improves || !sk.samePath(s.file, improves))
        .map((s) => sk.skillLine(s));
      const prompt = sk.buildDraftPrompt({ task, existing, claudeMd: md.readClaudeMd(this.paths), projectMd, others, excerpts });
      const vault = fs.existsSync(path.join(this.switcherDir, 'credenciais.vault'));
      const out = await this.run({ prompt, system: sk.draftSystem({ vault }), schema: sk.DRAFT_SCHEMA, model: MODEL, effort: EFFORT, timeoutMs: TIMEOUT });
      const body = String((out && out.body) || '').trim();
      const description = String((out && out.description) || '').trim();
      if (!body || !description) throw new Error('o Claude não devolveu a skill');
      const name = (improves && sk.readSkill(improves)?.name) || given || sk.slug(out.name) || sk.slug(title) || 'nova-skill';
      const clean = redact(sk.composeSkill({ name, description, body }));
      const dir = path.join(this.draftsDir(), id);
      const file = path.join(dir, sk.SKILL_FILE);
      fs.mkdirSync(dir, { recursive: true });
      await writeFileAtomic(file, clean.text);
      const evidenceFile = path.join(dir, 'conversas.md');
      await writeFileAtomic(evidenceFile, excerpts.map((x, i) => `## Conversa ${i + 1} · ${x.label}${x.title ? ` · ${x.title}` : ''}\n\n${x.text}\n`).join('\n'));
      const draft = {
        id,
        key,
        name,
        title,
        scope: target.scope,
        project: target.project || null,
        improves,
        file,
        evidenceFile,
        at: Date.now(),
        note: String((out && out.note) || '').trim(),
        redacted: clean.count,
      };
      await this.store.update((d) => (d.drafts[id] = draft));
      return draft;
    } finally {
      this.drafting.delete(id);
    }
  }

  // A draft for one of the suggestions.
  async draft(key) {
    const data = this.store.load();
    const s = data.analysis && data.analysis.suggestions.find((x) => x.key === key);
    if (!s) throw new Error('essa sugestão não existe mais; analise de novo');
    const byKey = new Map(this.index.entries().map((e) => [e.key, e]));
    const evidence = s.evidence.map((x) => ({ ...x, entry: byKey.get(x.conv) })).filter((x) => x.entry);
    if (!evidence.length) throw new Error('as conversas dessa sugestão não existem mais');
    const where = s.scope === 'project' ? `projeto ${s.project.label} (${s.project.path}): vale só nele` : 'global: vale em todos os projetos';
    const task = [
      `nome: ${s.name}`,
      `título: ${s.title}`,
      `onde: ${where}`,
      `o que se repete: ${s.why}`,
      `quando usar: ${s.when}`,
      s.steps.length ? `passos vistos nas conversas:\n${s.steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}` : '',
    ].filter(Boolean);
    const improves = s.improves && fs.existsSync(s.improves) ? s.improves : null;
    return this.write({ id: key, key, name: s.name, title: s.title, task, target: { scope: s.scope, project: s.project }, improves, evidence });
  }

  // A skill the user describes in their own words. `target`: { scope, project? }. The
  // conversations that look like the request go along as examples.
  async draftFree(request, target) {
    const entries = this.index.entries().filter((e) => target.scope !== 'project' || sk.samePath(e.cwd, target.project.path));
    const evidence = sk.related(entries, request).map((x) => ({ conv: x.entry.key, prompt: x.prompt, entry: x.entry }));
    const where = target.scope === 'project' ? `projeto ${target.project.label} (${target.project.path}): vale só nele` : 'global: vale em todos os projetos';
    const task = [`onde: ${where}`, `pedido do usuário: ${String(request).trim()}`];
    if (!evidence.length) task.push('Não achei conversas sobre isso: escreva a partir do pedido, sem inventar comandos ou caminhos que ele não diz.');
    const id = `nova-${md.stamp()}`;
    return this.write({ id, title: String(request).trim().slice(0, 60), task, target, evidence });
  }

  draftOf(file) {
    const data = this.store.load();
    return Object.values(data.drafts).find((d) => sk.samePath(d.file, file)) || null;
  }

  async discard(id) {
    await this.store.update((d) => delete d.drafts[id]);
    fs.rmSync(path.join(this.draftsDir(), id), { recursive: true, force: true });
  }

  // --- installing ----------------------------------------------------------------------------

  targetOf(draft, name) {
    const base = draft.scope === 'project' ? sk.projectSkillsDir(draft.project.path) : sk.userSkillsDir(this.paths);
    return path.join(base, name, sk.SKILL_FILE);
  }

  // Puts the draft (as it is on disk, edited or not) where Claude Code reads it. A skill that is
  // already there is only replaced when the draft improves it or with `overwrite`; its old text
  // is kept for undo and in memory-backup/skills.
  async install(id, { overwrite = false } = {}) {
    return this.store.update(async (d) => {
      const draft = d.drafts[id];
      if (!draft) throw new Error('esse rascunho não existe mais');
      const text = fs.readFileSync(draft.file, 'utf8');
      const check = sk.checkSkillText(text);
      if (check.error) throw new Error(check.error);
      const file = this.targetOf(draft, check.name);
      const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      if (previous != null && !overwrite && !sk.samePath(file, draft.improves || '')) {
        throw Object.assign(new Error(`já existe uma skill ${check.name}`), { code: 'EEXIST', file });
      }
      const at = Date.now();
      if (previous != null) {
        const copy = path.join(this.switcherDir, 'memory-backup', 'skills', md.stamp(at), check.name, sk.SKILL_FILE);
        fs.mkdirSync(path.dirname(copy), { recursive: true });
        fs.writeFileSync(copy, previous);
      }
      await writeFileAtomic(file, text);
      const suggestion = (d.analysis && d.analysis.suggestions.find((s) => s.key === draft.key)) || null;
      if (suggestion) d.analysis.suggestions = d.analysis.suggestions.filter((s) => s !== suggestion);
      delete d.drafts[id];
      const record = { id: `${at}-${check.name}`, at, name: check.name, scope: draft.scope, file, previous, written: text, suggestion };
      d.created = [...d.created, record].slice(-KEEP_CREATED);
      fs.rmSync(path.join(this.draftsDir(), id), { recursive: true, force: true });
      return { id: record.id, name: check.name, file, replaced: previous != null };
    });
  }

  // Takes an install back: the old skill returns (or the new one goes), and the suggestion
  // comes back to the page.
  async undoInstall(recordId) {
    return this.store.update(async (d) => {
      const r = d.created.find((x) => x.id === recordId);
      if (!r) throw new Error('não há mais o que desfazer');
      const now = md.readMd(r.file);
      if (now !== r.written) throw new Error('a skill mudou depois disso; remova pelo botão de lixeira');
      if (r.previous != null) await writeFileAtomic(r.file, r.previous);
      else {
        fs.rmSync(r.file, { force: true });
        try {
          fs.rmdirSync(path.dirname(r.file)); // only when empty: scripts the user added stay
        } catch {}
      }
      if (r.suggestion && d.analysis && !d.analysis.suggestions.some((s) => s.key === r.suggestion.key)) d.analysis.suggestions.push(r.suggestion);
      d.created = d.created.filter((x) => x !== r);
    });
  }

  // Deletes a user or project skill (its whole folder), with a copy. Returns what restoreSkill needs.
  async removeSkill(dir) {
    if (!fs.existsSync(path.join(dir, sk.SKILL_FILE))) throw new Error('essa skill não existe mais');
    const backup = path.join(this.switcherDir, 'memory-backup', 'skills', md.stamp(), path.basename(dir));
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.cpSync(dir, backup, { recursive: true });
    fs.rmSync(dir, { recursive: true, force: true });
    return { dir, backup };
  }

  async restoreSkill({ dir, backup }) {
    if (fs.existsSync(dir)) throw new Error('já existe outra skill com esse nome');
    fs.cpSync(backup, dir, { recursive: true });
  }
}

module.exports = { SkillCurator, AUTO_MIN_NEW };
