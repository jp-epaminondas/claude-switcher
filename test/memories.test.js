'use strict';

// Memories: the global CLAUDE.md as removable pieces, the MEMORY.md index, and joining the
// preferences repeated across projects into CLAUDE.md (and undoing it).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup } = require('./helpers');
const md = require('../src/core/claudeMd');
const mem = require('../src/core/memories');
const { Curator } = require('../src/core/curator');

const GRAPHIFY = [
  '# graphify',
  '- **graphify** (`~/.claude/skills/graphify/SKILL.md`) - any input to knowledge graph. Trigger: `/graphify`',
  'When the user types `/graphify`, use the installed graphify skill.',
  '',
].join('\n');

test('CLAUDE.md: sections and items, a rule added and removed', () => {
  const doc = md.parseClaudeMd(GRAPHIFY);
  assert.deepEqual(
    doc.blocks.map((b) => [b.kind, b.start, b.end]),
    [
      ['section', 0, 3],
      ['item', 1, 2], // the lazy line under the list item belongs to it
    ],
  );
  assert.equal(doc.blocks[1].parent, doc.blocks[0]);

  const one = md.addRule(GRAPHIFY, 'Responda em português do Brasil.');
  assert.equal(one, `${GRAPHIFY}\n# Preferências\n\n- Responda em português do Brasil.\n`);
  const two = md.addRule(one, '  Nunca  adicione Co-Authored-By.\n');
  assert.ok(two.endsWith('- Responda em português do Brasil.\n- Nunca adicione Co-Authored-By.\n'));
  assert.equal(md.addRule(two, '- Nunca adicione Co-Authored-By.'), two, 'the same rule only once');

  const item = md.parseClaudeMd(two).blocks.find((b) => b.text === '- Responda em português do Brasil.');
  const less = md.removeBlock(two, md.refOf(item));
  assert.ok(!less.includes('português') && less.includes('Co-Authored-By'));
  const last = md.parseClaudeMd(less).blocks.find((b) => b.text.includes('Co-Authored-By'));
  assert.equal(md.dropEmptyPrefs(md.removeBlock(less, md.refOf(last))), GRAPHIFY, 'back to how it was');

  const section = md.parseClaudeMd(two).blocks[0];
  assert.ok(md.removeBlock(two, md.refOf(section)).startsWith('# Preferências'), 'a section goes with what is under it');
  assert.equal(md.removeBlock(GRAPHIFY, { kind: 'item', start: 1, key: 'gone' }), null);
});

test('CLAUDE.md: CRLF, code blocks and paragraphs', () => {
  const text = ['Intro line', 'still intro', '', '```', '# not a heading', '```', '', '## Sub', '1. one', '   more of one', '2. two', ''].join('\r\n');
  const doc = md.parseClaudeMd(text);
  assert.deepEqual(
    doc.blocks.map((b) => [b.kind, b.start, b.end]),
    [
      ['item', 0, 1],
      ['item', 3, 5],
      ['section', 7, 11],
      ['item', 8, 9],
      ['item', 10, 10],
    ],
  );
  const out = md.addRule(text, 'Regra');
  assert.ok(out.includes('\r\n# Preferências\r\n\r\n- Regra\r\n'));
  assert.ok(!/[^\r]\n/.test(out), 'line breaks stay CRLF');
});

test('MEMORY.md: a link comes out and goes back', () => {
  const index = [
    '- [Sem coautor](sem-coautor.md) — nunca adicionar Co-Authored-By',
    '- Servidor: [acesso](acesso.md), [sem coautor de novo](./x.md), [crons](crons.md)',
    '- **[Responder em português](pt.md)**',
    '',
  ].join('\n');
  let r = mem.unlinkFromIndex(index, 'sem-coautor.md');
  assert.equal(r.text, index.split('\n').slice(1).join('\n'));
  r = mem.unlinkFromIndex(r.text, 'x.md');
  assert.ok(r.text.startsWith('- Servidor: [acesso](acesso.md), [crons](crons.md)\n'));
  r = mem.unlinkFromIndex(r.text, 'pt.md');
  assert.ok(!r.text.includes('pt.md'));
  assert.deepEqual(mem.unlinkFromIndex(index, 'missing.md').edits, []);

  // Undone in reverse order, the index is whole again.
  const a = mem.unlinkFromIndex(index, 'sem-coautor.md');
  const b = mem.unlinkFromIndex(a.text, 'x.md');
  assert.equal(mem.relinkIndex(mem.relinkIndex(b.text, b.edits), a.edits), index);
});

test('frontmatter, labels and which memories are preferences', () => {
  const { meta, body } = mem.parseFrontmatter('---\nname: x\ndescription: "Never add \\"Co-Authored-By\\""\nmetadata:\n  type: feedback\n---\n\nCorpo\n');
  assert.deepEqual(meta, { name: 'x', description: 'Never add "Co-Authored-By"', type: 'feedback' });
  assert.equal(body, 'Corpo');
  assert.equal(mem.labelOf('c--wamp64-www-Rota7-web', 'C:/wamp64/www/Rota7/web'), 'Rota7/web');
  assert.equal(mem.labelOf('c--wamp64-www-claude-switcher', 'c:/wamp64/www/claude-switcher'), 'claude-switcher');
  assert.equal(mem.labelOf('c--Users-Ana-Desktop-game-galo', null), 'game-galo');
  assert.equal(mem.labelOf('c--r7-tools-x', null), 'r7-tools-x');
});

// Three projects: the same "no co-author" rule in alpha (English) and beta (Portuguese),
// "answer in Portuguese" in beta and gamma, plus things that must not move.
function world() {
  const t = setup();
  const gc = { projects: { 'C:/work/alpha': {}, 'C:/work/beta': {}, 'C:/www/gamma': {} } };
  fs.writeFileSync(t.paths.globalConfig, JSON.stringify(gc));
  const write = (project, name, type, description, body = description) => {
    const dir = path.join(mem.projectsDir(t.paths), mem.encodeProject(project), 'memory');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), `---\nname: ${name.replace('.md', '')}\ndescription: ${JSON.stringify(description)}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`);
    return dir;
  };
  const alpha = write('C:/work/alpha', 'no-coauthor.md', 'feedback', 'Never add Co-Authored-By: Claude');
  write('C:/work/alpha', 'deploy.md', 'project', 'deploy via ssh');
  fs.writeFileSync(path.join(alpha, 'MEMORY.md'), '- [No co-author](no-coauthor.md) — never\n- [Deploy](deploy.md)\n');
  const beta = write('C:/work/beta', 'sem-coautor.md', 'feedback', 'Não colocar coautor do Claude nos commits');
  write('C:/work/beta', 'pt.md', 'feedback', 'Responder em português');
  fs.writeFileSync(path.join(beta, 'MEMORY.md'), '- Git: [sem coautor](sem-coautor.md), [outra](outra.md)\n- [Português](pt.md)\n');
  write('C:/www/gamma', 'responder-pt.md', 'user', 'Answer in Brazilian Portuguese');
  fs.writeFileSync(path.join(t.paths.configDir, 'CLAUDE.md'), GRAPHIFY);

  const calls = [];
  // Stands in for Claude: finds the refs by memory name in the prompt.
  const run = async ({ prompt, schema }) => {
    calls.push(prompt);
    assert.ok(schema.properties.groups);
    const ref = (name) => new RegExp(`### (m\\d+)\\nprojeto: [^\\n]*\\nnome: ${name}\\n`).exec(prompt)[1];
    return {
      groups: [
        { title: 'Sem coautor', rule: 'Nunca adicione Co-Authored-By: Claude nos commits.', inGlobal: false, ids: [ref('no-coauthor'), ref('sem-coautor')] },
        { title: 'Português', rule: 'Responda em português do Brasil.', inGlobal: false, ids: [ref('pt'), ref('responder-pt')] },
        { title: 'Só um projeto', rule: 'x', inGlobal: false, ids: [ref('pt')] }, // dropped: pt is taken and one project only
        { title: 'Inventado', rule: 'y', inGlobal: false, ids: ['m99', 'm98'] }, // dropped: unknown ids
      ],
    };
  };
  const curator = new Curator({ paths: t.paths, switcherDir: path.join(t.root, '.claude-switcher'), run });
  const exists = (project, name) => fs.existsSync(path.join(mem.projectsDir(t.paths), mem.encodeProject(project), 'memory', name));
  const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
  return { t, curator, calls, alpha, beta, exists, read, claudeMd: () => read(t.paths.configDir, 'CLAUDE.md') };
}

test('memories repeated across projects are suggested once, and only when something changed', async () => {
  const w = world();
  let v = w.curator.view();
  assert.equal(v.stale, true);
  assert.equal(v.preferenceCount, 4, 'project facts are left out');
  assert.equal(v.projectCount, 3);

  await w.curator.analyze();
  assert.equal(w.calls.length, 1);
  assert.ok(!w.calls[0].includes('deploy via ssh'));
  assert.ok(w.calls[0].includes('projeto: work/alpha') && w.calls[0].includes('# graphify'));
  v = w.curator.view();
  assert.equal(v.stale, false);
  assert.deepEqual(
    v.suggestions.map((s) => [s.title, s.members.map((m) => m.projectLabel)]),
    [
      ['Sem coautor', ['work/alpha', 'work/beta']],
      ['Português', ['work/beta', 'gamma']],
    ],
  );

  await w.curator.analyze();
  assert.equal(w.calls.length, 1, 'nothing changed: no new run');
  await w.curator.analyze({ force: true });
  assert.equal(w.calls.length, 2);

  await w.curator.ignore(v.suggestions[1].key);
  assert.deepEqual(w.curator.view().suggestions.map((s) => s.title), ['Sem coautor']);
  assert.equal(w.curator.view().ignoredCount, 1);
  await w.curator.clearIgnored();
  assert.equal(w.curator.view().suggestions.length, 2);
});

test('joining writes the rule, deletes the copies with a backup, and can be undone', async () => {
  const w = world();
  await w.curator.analyze();
  const [coauthor] = w.curator.view().suggestions;
  const indexBefore = w.read(w.beta, 'MEMORY.md');

  const r = await w.curator.merge(coauthor.key, 'Nunca adicione Co-Authored-By: Claude nos commits nem nos PRs.');
  assert.equal(r.removed, 2);
  assert.ok(w.claudeMd().endsWith('# Preferências\n\n- Nunca adicione Co-Authored-By: Claude nos commits nem nos PRs.\n'));
  assert.ok(!w.exists('C:/work/alpha', 'no-coauthor.md') && !w.exists('C:/work/beta', 'sem-coautor.md'));
  assert.ok(w.exists('C:/work/alpha', 'deploy.md'));
  assert.equal(w.read(w.alpha, 'MEMORY.md'), '- [Deploy](deploy.md)\n');
  assert.equal(w.read(w.beta, 'MEMORY.md'), '- Git: [outra](outra.md)\n- [Português](pt.md)\n');
  assert.ok(fs.existsSync(path.join(r.backupDir, 'C--work-alpha', 'memory', 'no-coauthor.md')));
  const v = w.curator.view();
  assert.equal(v.stale, false, 'our own edit needs no new analysis');
  assert.deepEqual(v.suggestions.map((s) => s.title), ['Português']);

  await w.curator.undo(r.id);
  assert.equal(w.claudeMd(), GRAPHIFY);
  assert.ok(w.exists('C:/work/alpha', 'no-coauthor.md') && w.exists('C:/work/beta', 'sem-coautor.md'));
  assert.equal(w.read(w.beta, 'MEMORY.md'), indexBefore);
  const back = w.curator.view();
  assert.equal(back.stale, false);
  assert.deepEqual(back.suggestions.map((s) => s.title).sort(), ['Português', 'Sem coautor']);
  assert.equal(w.calls.length, 1);
});

test('removing from CLAUDE.md: any item, and a joined rule can bring its memories back', async () => {
  const w = world();
  await w.curator.analyze();
  const [, pt] = w.curator.view().suggestions;
  await w.curator.merge(pt.key, pt.rule);
  assert.ok(!w.exists('C:/www/gamma', 'responder-pt.md'));

  const blocks = () => md.parseClaudeMd(w.claudeMd()).blocks;
  const rule = blocks().find((b) => b.text === '- Responda em português do Brasil.');
  assert.ok(w.curator.mergedFor(rule.text));
  const r = await w.curator.remove(md.refOf(rule), { restore: true });
  assert.equal(r.restored, 2);
  assert.equal(w.claudeMd(), GRAPHIFY, 'the empty Preferências section goes too');
  assert.ok(w.exists('C:/www/gamma', 'responder-pt.md') && w.exists('C:/work/beta', 'pt.md'));
  assert.equal(w.curator.mergedFor(rule.text), null);

  // Something the user wrote by hand.
  const graphify = blocks().find((b) => b.kind === 'item');
  await w.curator.remove(md.refOf(graphify));
  assert.equal(w.claudeMd(), '# graphify\n');
  await assert.rejects(w.curator.remove(md.refOf(graphify)), /mudou/);
  assert.equal(fs.readdirSync(path.join(w.t.root, '.claude-switcher', 'memory-backup', 'CLAUDE.md')).length, 3, 'one copy per write');
});

test('a failed analysis is reported until something changes', async () => {
  const w = world();
  w.curator.run = async () => {
    throw new Error('sem rede');
  };
  await assert.rejects(w.curator.analyze(), /sem rede/);
  assert.equal(w.curator.view().error, 'sem rede');
  fs.appendFileSync(path.join(w.alpha, 'no-coauthor.md'), 'mais\n');
  assert.equal(w.curator.view().error, null);
});

test('a new instruction: Claude words it, it lands in its section, replacing what it contradicts', async () => {
  const w = world();
  fs.writeFileSync(path.join(w.t.paths.configDir, 'CLAUDE.md'), `${GRAPHIFY}\n# Preferências\n\n- Responder em inglês.\n`);
  const prompts = [];
  w.curator.run = async ({ prompt, schema }) => {
    prompts.push(prompt);
    assert.deepEqual(schema.required, ['rule', 'section', 'replaces', 'projectOnly', 'note']);
    return { rule: '- Responda sempre em português do Brasil.', section: '# preferências', replaces: 'Responder em inglês.', projectOnly: false, note: 'Troca a regra do idioma.' };
  };
  const draft = await w.curator.draftInstruction('quero respostas em português');
  assert.ok(prompts[0].includes('quero respostas em português') && prompts[0].includes('- Responder em inglês.'));
  assert.deepEqual(draft, {
    rule: 'Responda sempre em português do Brasil.',
    section: 'Preferências', // the existing title, as written in the file
    newSection: false,
    replaces: 'Responder em inglês.',
    projectOnly: false,
    note: 'Troca a regra do idioma.',
  });
  const done = await w.curator.addInstruction(draft);
  assert.equal(w.claudeMd(), `${GRAPHIFY}\n# Preferências\n\n- Responda sempre em português do Brasil.\n`);
  assert.equal(await w.curator.addInstruction(draft), null, 'already there');

  await w.curator.undoInstruction(done);
  assert.ok(w.claudeMd().includes('- Responder em inglês.'));
  await assert.rejects(w.curator.undoInstruction(done), /mudou/);

  // A section that doesn't exist yet is created; a "replaces" that isn't in the file is ignored.
  w.curator.run = async () => ({ rule: 'Antes de deploy, conferir commits pendentes.', section: 'Deploy', replaces: 'não existe', projectOnly: true, note: '' });
  const d2 = await w.curator.draftInstruction('deploy');
  assert.equal(d2.newSection, true);
  assert.equal(d2.replaces, null);
  await w.curator.addInstruction(d2);
  assert.ok(w.claudeMd().endsWith('# Deploy\n\n- Antes de deploy, conferir commits pendentes.\n'));
});
