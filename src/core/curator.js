'use strict';

// Joins preferences that Claude Code saved again and again, once per project, into the global
// CLAUDE.md, where they count for every project and every account. Claude finds the repeats
// (see memories.js); joining writes the rule and deletes the copies, with a backup, and both
// can be undone. State shared by every window lives in memories.json.
const path = require('path');
const { Store } = require('./store');
const md = require('./claudeMd');
const mem = require('./memories');

const KEEP_MERGED = 50;

class Curator {
  // `run({ prompt, system, schema })` asks Claude and resolves to the structured answer.
  constructor({ paths, switcherDir, run, log = () => {} }) {
    this.paths = paths;
    this.switcherDir = switcherDir;
    this.run = run;
    this.log = log;
    this.store = new Store(switcherDir, { name: 'memories', defaults: { analysis: null, error: null, ignored: [], merged: [] } });
    this.running = null;
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
