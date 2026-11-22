'use strict';

// Joins preferences that Claude Code saved again and again, once per project, into the global
// CLAUDE.md, where they count for every project and every account. Claude finds the repeats
// (see memories.js); joining writes the rule and deletes the copies, with a backup, and both
// can be undone. State shared by every window lives in memories.json.
const fs = require('fs');
const path = require('path');
const { Store } = require('./store');
const md = require('./claudeMd');
const mem = require('./memories');

const KEEP_MERGED = 50;
const SPLIT_BATCH = 100; // memories per question when splitting by subproject

// The prompt for "Nova instrução", for the global CLAUDE.md or a project's (`label`).
function instructionPrompt(label) {
  const where = label
    ? `o CLAUDE.md do projeto "${label}" de um usuário do Claude Code. Esse arquivo vale só nesse projeto e é lido no começo de toda conversa nele.`
    : 'o CLAUDE.md global de um usuário do Claude Code. Esse arquivo vale em todos os projetos dele e é lido no começo de toda conversa.';
  const scope = label
    ? '- wrongScope: true quando o pedido é uma preferência pessoal que valeria em qualquer projeto (idioma, commits, estilo de resposta): ela ficaria melhor no CLAUDE.md global.'
    : '- wrongScope: true quando o pedido só faz sentido num projeto, servidor ou sistema específico (no global ele valeria em todos).';
  return `Você escreve instruções para ${where}
Você recebe o arquivo atual e um pedido escrito livremente pelo usuário. Transforme o pedido numa instrução e diga onde ela entra.

- rule: a instrução em português do Brasil, em uma ou duas frases no imperativo, clara e sem ambiguidade. Diga o que fazer (e quando), não o que o usuário pediu. Sem citar o pedido, sem markdown de lista.
- section: o título de uma seção existente onde ela se encaixa, copiado exatamente como está no arquivo. Se nenhuma servir, um título novo e curto.
- replaces: se um item que já existe diz o mesmo ou o contrário, copie o texto exato desse item (sem o "- " do começo); senão, "".
${scope}
- note: uma frase curta para o usuário: onde entrou e por quê, o que substitui, ou por que o lugar parece errado.`;
}

const INSTRUCTION_SCHEMA = {
  type: 'object',
  properties: {
    rule: { type: 'string' },
    section: { type: 'string' },
    replaces: { type: 'string' },
    wrongScope: { type: 'boolean' },
    note: { type: 'string' },
  },
  required: ['rule', 'section', 'replaces', 'wrongScope', 'note'],
};

class Curator {
  // `run({ prompt, system, schema })` asks Claude and resolves to the structured answer.
  constructor({ paths, switcherDir, run, log = () => {} }) {
    this.paths = paths;
    this.switcherDir = switcherDir;
    this.run = run;
    this.log = log;
    // subprojects: { <project folder>: { <memory file>: { sub, manual? } } }, see split().
    this.store = new Store(switcherDir, { name: 'memories', defaults: { analysis: null, error: null, ignored: [], merged: [], subprojects: {} } });
    this.running = null;
    this.splitting = null; // { promise, done, total } while split() runs
  }

  // What the analysis would look at right now.
  snapshot() {
    const all = mem.scanMemories(this.paths);
    const memories = all.filter(mem.isPreference);
    const claudeMd = md.readClaudeMd(this.paths);
    return { all, memories, claudeMd, hash: mem.inputHash(memories, claudeMd) };
  }

  // Everything the panel shows. `stale`: memories or CLAUDE.md changed since the analysis.
  view() {
    const data = this.store.load();
    const snap = this.snapshot();
    const byId = new Map(snap.all.map((m) => [m.id, m]));
    const ignored = new Set(data.ignored);
    const a = data.analysis;
    const suggestions = [];
    for (const g of (a && a.groups) || []) {
      if (ignored.has(g.key)) continue;
      const members = g.ids.map((id) => byId.get(id)).filter(Boolean);
      if (!members.length || (!g.inGlobal && new Set(members.map((m) => m.project)).size < 2)) continue;
      suggestions.push({ ...g, members });
    }
    return {
      analyzedAt: a ? a.at : null,
      stale: !a || a.inputHash !== snap.hash,
      running: !!this.running,
      error: data.error && data.error.inputHash === snap.hash ? data.error.message : null,
      suggestions,
      ignoredCount: data.ignored.length,
      preferenceCount: snap.memories.length,
      projectCount: new Set(snap.memories.map((m) => m.project)).size,
      claudeMd: snap.claudeMd,
      merged: data.merged,
    };
  }

  // Runs the analysis when something changed since the last one (or always, with `force`).
  async analyze({ force = false } = {}) {
    if (this.running) return this.running;
    const snap = this.snapshot();
    const data = this.store.load();
    if (!force && data.analysis && data.analysis.inputHash === snap.hash) return data.analysis;
    this.running = (async () => {
      try {
        const out = snap.memories.length ? await this.run({ prompt: mem.buildPrompt(snap.memories, snap.claudeMd), system: mem.SYSTEM_PROMPT, schema: mem.SCHEMA }) : { groups: [] };
        const analysis = { inputHash: snap.hash, at: Date.now(), groups: mem.validateGroups(out, snap.memories) };
        await this.store.update((d) => {
          d.analysis = analysis;
          d.error = null;
        });
        return analysis;
      } catch (e) {
        this.log(`análise das memórias: ${e.message}`);
        await this.store.update((d) => (d.error = { message: e.message, at: Date.now(), inputHash: snap.hash })).catch(() => {});
        throw e;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  // Our own edits don't call for a new analysis: they only take out what was already decided.
  // Runs inside store.update(), after the edit.
  keepFresh(d, wasFresh) {
    if (wasFresh && d.analysis) d.analysis.inputHash = this.snapshot().hash;
  }

  // Writes `rule` (the suggestion's text, maybe edited) into CLAUDE.md and deletes the copies.
  // For a suggestion already in CLAUDE.md, only deletes the copies.
  async merge(key, rule) {
    return this.store.update(async (d) => {
      const g = d.analysis && d.analysis.groups.find((x) => x.key === key);
      if (!g) throw new Error('essa sugestão não existe mais; analise de novo');
      const hashBefore = this.snapshot().hash;
      const wasFresh = d.analysis.inputHash === hashBefore;
      const at = Date.now();
      let written = null;
      if (!g.inGlobal) {
        written = md.normalizeRule(rule || g.rule);
        if (!written) throw new Error('a regra está vazia');
        const text = md.readClaudeMd(this.paths);
        const next = md.addRule(text, written);
        if (next !== text) await md.writeClaudeMd(this.paths, this.switcherDir, next);
      }
      const backupDir = path.join(this.switcherDir, 'memory-backup', md.stamp(at));
      const files = [];
      for (const id of g.ids) {
        const saved = await mem.removeMemory(this.paths, id, backupDir);
        if (saved) files.push(saved);
      }
      d.analysis.groups = d.analysis.groups.filter((x) => x !== g);
      const record = { id: `${at}-${key}`, at, group: g, rule: written, files, analyzedHash: wasFresh ? hashBefore : null };
      d.merged = [...d.merged, record].slice(-KEEP_MERGED);
      this.keepFresh(d, wasFresh);
      return { id: record.id, rule: written, removed: files.length, backupDir };
    });
  }

  // Where an instruction goes: the global CLAUDE.md (no target) or a project file
  // (`{ file, label }`, from projectView()).
  readTarget(target) {
    return target ? md.readMd(target.file) : md.readClaudeMd(this.paths);
  }

  writeTarget(target, text) {
    return target ? md.writeMd(target.file, this.switcherDir, text) : md.writeClaudeMd(this.paths, this.switcherDir, text);
  }

  // Claude turns a free-form request ("quando eu pedir deploy, confira antes...") into an
  // instruction, with the section it belongs in and the item it replaces.
  async draftInstruction(request, target = null) {
    const text = this.readTarget(target);
    const title = target ? `CLAUDE.md do projeto ${target.label}` : 'CLAUDE.md global';
    const prompt = [`## ${title} atual`, '', text.trim() || '(vazio)', '', '## Pedido do usuário', '', String(request).trim()].join('\n');
    const out = await this.run({ prompt, system: instructionPrompt(target && target.label), schema: INSTRUCTION_SCHEMA });
    const rule = md.normalizeRule((out && out.rule) || '');
    if (!rule) throw new Error('o Claude não devolveu uma instrução');
    const sections = md.parseClaudeMd(text).blocks.filter((b) => b.kind === 'section');
    const wanted = String((out && out.section) || '').replace(/^#+\s*/, '').trim() || (target ? 'Instruções' : md.PREFS_TITLE);
    const existing = sections.find((sec) => sec.title.trim().toLowerCase() === wanted.toLowerCase());
    const replaced = out.replaces ? md.findItem(text, out.replaces) : null;
    return {
      rule,
      section: existing ? existing.title : wanted,
      newSection: !existing,
      replaces: replaced ? md.normalizeRule(replaced.text) : null,
      wrongScope: !!out.wrongScope,
      note: String(out.note || '').trim(),
    };
  }

  // Writes the instruction (taking out the item it replaces). Returns what undo needs.
  async addInstruction({ rule, section, replaces = null }, target = null) {
    const before = this.readTarget(target);
    let text = before;
    if (replaces) {
      const old = md.findItem(text, replaces);
      if (old) text = md.removeBlock(text, md.refOf(old)) ?? text;
    }
    text = md.addRule(text, rule, section);
    if (text === before) return null;
    await this.writeTarget(target, text);
    return { before, after: text, target };
  }

  // Puts the file back as it was, unless it changed since.
  async undoInstruction({ before, after, target = null }) {
    if (this.readTarget(target) !== after) throw new Error('o arquivo mudou depois disso; desfaça pelo botão de remover');
    await this.writeTarget(target, before);
  }

  // --- the project open in VS Code ---------------------------------------------------------

  // Its instruction files and the memories Claude Code saved for it. In a folder of several
  // repositories, each memory carries its subproject (`sub`, null until split() places it).
  projectView(root) {
    const files = md.projectMdPaths(root).map((file) => ({ file, text: md.readMd(file), exists: fs.existsSync(file) }));
    const dir = mem.projectDirFor(this.paths, root);
    const parts = root.split(/[\\/]+/).filter(Boolean);
    const subprojects = mem.subprojectsOf(root);
    const known = new Set([...subprojects, mem.GENERAL]);
    const placed = subprojects.length ? this.store.load().subprojects[dir] || {} : {};
    const memories = mem.scanMemories(this.paths, { project: dir }).map((m) => {
      const at = placed[path.basename(m.file)];
      return { ...m, sub: at && known.has(at.sub) ? at.sub : null, subManual: !!(at && at.manual) };
    });
    return {
      root,
      dir,
      label: parts[parts.length - 1] || root,
      files,
      // "Nova instrução" writes here: the file that exists, the root CLAUDE.md otherwise.
      target: (files.find((f) => f.exists) || files[0]).file,
      memoryDir: path.join(mem.projectsDir(this.paths), dir, 'memory'),
      memories,
      subprojects,
      splitting: this.splitting && { done: this.splitting.done, total: this.splitting.total },
    };
  }

  // Claude (Haiku) says which subproject each memory is about, 100 at a time; each answer is
  // kept as it comes, so `onBatch` can show the groups filling in. Only the memories not placed
  // yet go, or with `force` all but the ones the user moved by hand. Resolves to how many it placed.
  async split(root, { force = false, onBatch = () => {} } = {}) {
    if (this.splitting) return this.splitting.promise;
    const p = this.projectView(root);
    if (!p.subprojects.length) return 0;
    const todo = p.memories.filter((m) => (force ? !m.subManual : m.sub == null));
    if (!todo.length) return 0;
    const present = new Set(p.memories.map((m) => path.basename(m.file)));
    const subs = p.subprojects.map((name) => ({ name, about: mem.aboutSubproject(root, name) }));
    const state = { done: 0, total: todo.length };
    this.splitting = state;
    state.promise = (async () => {
      let placed = 0;
      try {
        for (let i = 0; i < todo.length; i += SPLIT_BATCH) {
          const batch = todo.slice(i, i + SPLIT_BATCH);
          const out = await this.run({ prompt: mem.buildSplitPrompt(batch, subs), system: mem.SPLIT_PROMPT, schema: mem.splitSchema(p.subprojects) });
          const found = mem.validateSplit(out, batch, p.subprojects);
          await this.store.update((d) => {
            const map = (d.subprojects[p.dir] = d.subprojects[p.dir] || {});
            for (const file of Object.keys(map)) if (!present.has(file)) delete map[file];
            for (const [file, sub] of found) if (!(map[file] && map[file].manual)) map[file] = { sub };
          });
          placed += found.length;
          state.done += batch.length;
          onBatch();
        }
        return placed;
      } finally {
        this.splitting = null;
      }
    })();
    return state.promise;
  }

  // The user puts a memory in another subproject; split() leaves it there from then on.
  async moveMemory(root, id, sub) {
    const p = this.projectView(root);
    if (!p.subprojects.includes(sub) && sub !== mem.GENERAL) throw new Error(`"${sub}" não é um subprojeto de ${p.label}`);
    const m = p.memories.find((x) => x.id === id);
    if (!m) throw new Error('essa memória não existe mais');
    await this.store.update((d) => {
      d.subprojects[p.dir] = d.subprojects[p.dir] || {};
      d.subprojects[p.dir][path.basename(m.file)] = { sub, manual: true };
    });
  }

  // Takes a section or item out of a project file (`ref` from claudeMd.refOf).
  async removeFromFile(file, ref) {
    const text = md.readMd(file);
    const next = md.removeBlock(text, ref);
    if (next == null) throw new Error('o arquivo mudou; a lista foi atualizada, tente de novo');
    await md.writeMd(file, this.switcherDir, next);
  }

  // Deletes one memory (and its link in MEMORY.md), with a backup. Returns what restoreMemory needs.
  async deleteMemory(id) {
    const saved = await mem.removeMemory(this.paths, id, path.join(this.switcherDir, 'memory-backup', md.stamp()));
    if (!saved) throw new Error('essa memória não existe mais');
    return saved;
  }

  restoreMemory(saved) {
    return mem.restoreMemory(this.paths, saved);
  }

  async ignore(key) {
    return this.store.update((d) => {
      if (!d.ignored.includes(key)) d.ignored.push(key);
    });
  }

  async clearIgnored() {
    return this.store.update((d) => (d.ignored = []));
  }

  // The join that wrote this CLAUDE.md item, if any.
  mergedFor(itemText) {
    const rule = md.normalizeRule(itemText);
    const data = this.store.load();
    return data.merged
      .slice()
      .reverse()
      .find((r) => r.rule && r.rule === rule) || null;
  }

  // Removes a section or item (`ref` from claudeMd.refOf) from CLAUDE.md. With `restore`, the
  // memories joined into it go back to their projects.
  async remove(ref, { restore = false } = {}) {
    return this.store.update(async (d) => {
      const text = md.readClaudeMd(this.paths);
      const next = md.removeBlock(text, ref);
      if (next == null) throw new Error('o CLAUDE.md mudou; a lista foi atualizada, tente de novo');
      await md.writeClaudeMd(this.paths, this.switcherDir, ref.kind === 'item' ? md.dropEmptyPrefs(next) : next);
      if (!restore || ref.kind !== 'item') return { restored: 0 };
      const rule = md.normalizeRule(ref.key);
      const record = d.merged.slice().reverse().find((r) => r.rule === rule);
      if (!record) return { restored: 0 };
      return this.giveBack(d, record);
    });
  }

  // The joined memories go back to their projects, and the suggestion back to the panel.
  // Runs inside store.update(), after CLAUDE.md was edited.
  async giveBack(d, record) {
    for (const saved of record.files) await mem.restoreMemory(this.paths, saved);
    d.merged = d.merged.filter((r) => r !== record);
    if (d.analysis && record.group && !d.analysis.groups.some((g) => g.key === record.group.key)) {
      d.analysis.groups.push(record.group);
      // Fresh again if nothing else changed: the memories and CLAUDE.md are as analyzed.
      const hash = this.snapshot().hash;
      if (record.analyzedHash === hash) d.analysis.inputHash = hash;
    }
    return { restored: record.files.length };
  }

  // Takes a join back: the rule leaves CLAUDE.md and the memories return.
  async undo(id) {
    return this.store.update(async (d) => {
      const record = d.merged.find((r) => r.id === id);
      if (!record) throw new Error('não há mais o que desfazer');
      if (record.rule) {
        const text = md.readClaudeMd(this.paths);
        const doc = md.parseClaudeMd(text);
        const item = doc.blocks.find((b) => b.kind === 'item' && md.normalizeRule(b.text) === record.rule);
        if (item) {
          const next = md.removeBlock(text, md.refOf(item));
          if (next != null) await md.writeClaudeMd(this.paths, this.switcherDir, md.dropEmptyPrefs(next));
        }
      }
      return this.giveBack(d, record);
    });
  }
}

module.exports = { Curator };
