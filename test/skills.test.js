'use strict';

// Skills: the conversations read down to prompts and commands (and only their new bytes after
// that), secrets taken out, Claude pointing at tasks that come back, and a draft written,
// installed and undone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup } = require('./helpers');
const conv = require('../src/core/conversations');
const sk = require('../src/core/skills');
const mem = require('../src/core/memories');
const { SkillCurator, AUTO_MIN_NEW } = require('../src/core/skillCurator');

const DAY = 24 * 3600 * 1000;

// A transcript the way Claude Code writes it, one JSON object per line.
function transcript(cwd, session, start = Date.now() - 3 * DAY) {
  const lines = [];
  let t = start;
  let n = 0;
  const base = () => ({ cwd, sessionId: session, timestamp: new Date((t += 60000)).toISOString() });
  const api = {
    lines,
    user(text) {
      lines.push({ type: 'user', ...base(), message: { role: 'user', content: text } });
      return api;
    },
    run(command, { error } = {}) {
      const id = `tool${n++}`;
      lines.push({ type: 'assistant', ...base(), message: { role: 'assistant', content: [{ type: 'text', text: 'Vou rodar.' }, { type: 'tool_use', id, name: 'Bash', input: { command } }] } });
      lines.push({ type: 'user', ...base(), toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: error || 'ok', is_error: !!error }] } });
      return api;
    },
    skill(name) {
      lines.push({ type: 'assistant', ...base(), message: { role: 'assistant', content: [{ type: 'tool_use', id: `s${n++}`, name: 'Skill', input: { skill: name } }] } });
      return api;
    },
    title(text) {
      lines.push({ type: 'ai-title', aiTitle: text, sessionId: session });
      return api;
    },
    text: () => lines.map((o) => `${JSON.stringify(o)}\n`).join(''),
  };
  return api;
}

function world() {
  const t = setup();
  const switcherDir = path.join(t.root, '.claude-switcher');
  const alpha = path.join(t.root, 'work', 'alpha');
  const beta = path.join(t.root, 'work', 'beta');
  fs.mkdirSync(alpha, { recursive: true });
  fs.mkdirSync(beta, { recursive: true });
  const write = (cwd, session, tr) => {
    const dir = path.join(mem.projectsDir(t.paths), mem.encodeProject(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${session}.jsonl`);
    fs.writeFileSync(file, tr.text());
    return file;
  };
  // alpha: "release" asked twice, with the same commands, one failure and one correction.
  const a1 = write(
    alpha,
    'a1',
    transcript(alpha, 'a1')
      .title('Gerar versão')
      .user('gera a versão nova e instala')
      .user('ok')
      .run('cd C:/work/alpha && npm test && npm run package')
      .run('code --install-extension dist/alpha-1.2.0.vsix', { error: 'arquivo não encontrado' })
      .user('o vsix fica em dist/, confere o nome antes')
      .run('plink -batch -pw S3nhaF0rte root@10.0.0.1 "systemctl restart alpha"'),
  );
  const a2 = write(alpha, 'a2', transcript(alpha, 'a2').user('arruma o botão da tela de login').user('agora gera a versão e instala').run('npm run package').run('code --install-extension dist/alpha-1.3.0.vsix'));
  write(
    beta,
    'b1',
    transcript(beta, 'b1').user('publica a página de regras').skill('publicar-pagina').run('git status').run('git commit -m "x"').user('a senha do painel é senha: Pa55word!x'),
  );
  const curator = new SkillCurator({ paths: t.paths, switcherDir, run: async () => ({ suggestions: [] }) });
  return { t, switcherDir, alpha, beta, a1, a2, curator, write };
}

test('conversations: prompts, commands and skills, read again only where the file grew', async () => {
  const w = world();
  assert.deepEqual(await w.curator.refreshIndex(), { read: 3 });
  const byKey = (k) => w.curator.index.entries().find((e) => e.key.endsWith(k));
  let a1 = byKey('a1.jsonl');
  assert.equal(a1.titleShown, 'Gerar versão');
  assert.equal(a1.cwd, w.alpha);
  assert.equal(a1.label, 'work/alpha');
  assert.deepEqual(a1.prompts.map((p) => p.t), ['gera a versão nova e instala', 'o vsix fica em dist/, confere o nome antes'], '"ok" is no task');
  assert.deepEqual(a1.commands, { 'npm test': 1, 'npm run package': 1, 'code --install-extension': 1, plink: 1 }, 'cd is left out');
  const b1 = byKey('b1.jsonl');
  assert.deepEqual(b1.skills, { 'publicar-pagina': 1 });
  assert.deepEqual(b1.commands, { 'git commit': 1 }, 'git status says nothing');

  assert.deepEqual(await w.curator.refreshIndex(), { read: 0 }, 'nothing changed');

  // A line still being written waits; once it ends, only the new bytes are read.
  const more = JSON.stringify({ type: 'user', cwd: w.alpha, timestamp: new Date().toISOString(), message: { role: 'user', content: 'sobe também a 1.2.1' } });
  fs.appendFileSync(w.a1, more.slice(0, 20));
  await w.curator.refreshIndex();
  assert.equal(byKey('a1.jsonl').prompts.length, 2);
  fs.appendFileSync(w.a1, `${more.slice(20)}\n`);
  assert.deepEqual(await w.curator.refreshIndex(), { read: 1 });
  a1 = byKey('a1.jsonl');
  assert.equal(a1.prompts.length, 3);
  assert.equal(a1.commands.plink, 1, 'counted once, not read twice');

  // A file that shrank was rewritten: read from the start.
  fs.writeFileSync(w.a2, transcript(w.alpha, 'a2').user('outra coisa').text());
  await w.curator.refreshIndex();
  assert.deepEqual(byKey('a2.jsonl').prompts.map((p) => p.t), ['outra coisa']);
  fs.unlinkSync(w.a2);
  await w.curator.refreshIndex();
  assert.equal(byKey('a2.jsonl'), undefined);
});

test('command families and pasted text', () => {
  const f = conv.familyOf;
  assert.equal(f('git commit -m "feat: x"'), 'git commit');
  assert.equal(f('git status'), null);
  assert.equal(f('grep -rn foo src'), null);
  assert.equal(f('node "C:/Users/x/.claude-switcher/segredo.js" exec -- plink'), 'node segredo.js');
  assert.equal(f('MSYS_NO_PATHCONV=1 plink -batch root@host'), 'plink');
  assert.equal(f('npm run package'), 'npm run package');
  assert.equal(f('"C:/php/php.exe" artisan migrate --force'), 'php artisan migrate');
  assert.equal(f('C:\\tools\\adb.exe devices'), 'adb devices');
  assert.deepEqual(conv.families('cd x && npm test | tail -5; npx vsce package'), ['npm test', 'npx vsce']);
  // Only the command line itself: heredocs, scripts and SQL after it are not commands.
  assert.deepEqual(conv.families('for f in a b; do echo $f; done'), []);
  assert.deepEqual(conv.families("python - <<'EOF'\nimport os\nfrom x import y\nEOF"), []);
  assert.deepEqual(conv.families('mysql -u root -e "select 1; select 2"'), ['mysql']);
  assert.deepEqual(conv.families('npm test && \\\n  npm run package'), ['npm test', 'npm run package']);
  assert.deepEqual(conv.families('npm test &&\n  npm run package'), ['npm test', 'npm run package']);
  assert.deepEqual(conv.families('node ~/.claude-switcher/segredo.js exec -- plink -batch root@h "a; b"'), ['node segredo.js', 'plink']);
  assert.deepEqual(conv.families('git -C Etapas-Logistica commit -m x'), ['git commit']);
  assert.deepEqual(conv.families('sudo systemctl restart nginx'), ['systemctl restart']);
  assert.deepEqual(conv.families('S="C:/tmp x"; FILES="app/a.php console/b.php" && md5sum $FILES'), ['md5sum']);
  assert.deepEqual(conv.families("PX='cloudflared.exe access ssh' && C=$(git rev-parse HEAD) && git cherry-pick $C"), ['git cherry-pick']);
  assert.deepEqual(conv.families('FILES=$(git show --name-only x | sort -u) && PX="a \\"b; select\\" c" && pscp $FILES h:/x'), ['pscp']);
  assert.equal(conv.cleanPrompt('continue isso <pasted_content id="x">muito\ntexto</pasted_content> por favor'), 'continue isso [texto colado] por favor');
  assert.equal(conv.isTask('ok'), false);
  assert.equal(conv.isTask('Pode seguir!'), false);
  assert.equal(conv.isTask('suba'), true);
});

test('secrets are taken out, vault references and paths stay', () => {
  const r = (s) => conv.redact(s).text;
  assert.equal(r('plink -batch -pw S3nh@Forte root@1.2.3.4'), 'plink -batch -pw [segredo] root@1.2.3.4');
  assert.equal(r('MYSQL_PWD=abc123 mysql -u root'), 'MYSQL_PWD=[segredo] mysql -u root');
  assert.equal(r('git clone https://joao:tok3n@github.com/x.git'), 'git clone https://joao:[segredo]@github.com/x.git');
  assert.equal(r('curl -H "Authorization: Bearer abc.def-ghi"'), 'curl -H "Authorization: Bearer [segredo]"');
  assert.equal(r('token = ghp_ABCDEFGHIJKLMNOPQRSTUV123456'), 'token = [segredo]');
  assert.equal(r('a chave é sk-ant-api03-abcdefghijklmnop'), 'a chave é [segredo]');
  assert.equal(r('"password": "duas palavras"'), '"password": [segredo]');
  assert.equal(r('id 9fK2xQ7LmP4vR8sT1uW3yZ6aB5cD0eFgH'), 'id [segredo]');
  const keep = [
    'node ~/.claude-switcher/segredo.js exec -- plink -batch -pwfile {{arquivo:server-ssh.senha}} root@host "uptime"',
    'node ~/.claude-switcher/segredo.js exec --env MYSQL_PWD=phpmyadmin.senha -- mysql -u master',
    'senha={{phpmyadmin-master.senha}}',
    'C:/wamp64/www/Rota7/web/Etapas-Logistica/public/assets/js/pages/planilha',
    'git show 3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39',
  ];
  for (const s of keep) assert.equal(r(s), s);
  assert.equal(conv.redact('x -pw a y -pw b').count, 2);
});

test('skills: the user\'s, the project\'s, plugins\' and claude.ai\'s, with how often each was used', async () => {
  const w = world();
  const skill = (dir, name, description) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n`);
  };
  skill(sk.userSkillsDir(w.t.paths), 'graphify', 'Grafo do código: isto tem dois pontos');
  skill(sk.projectSkillsDir(w.beta), 'publicar-pagina', 'Publica uma página');
  const plugin = path.join(w.t.root, 'plugin-cache', 'postman');
  skill(path.join(plugin, 'skills'), 'bootstrap', 'Liga o Postman');
  fs.mkdirSync(path.join(w.t.paths.configDir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(w.t.paths.configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'postman@official': [{ installPath: plugin }] } }));
  const bucket = path.join(sk.userSkillsDir(w.t.paths), 'synced', 'b1');
  fs.mkdirSync(bucket, { recursive: true });
  fs.writeFileSync(path.join(bucket, 'manifest.json'), JSON.stringify({ skills: [{ name: 'xlsx', description: 'Planilhas' }] }));

  await w.curator.refreshIndex();
  const v = w.curator.view(w.beta);
  assert.deepEqual(v.user.map((s) => [s.name, s.description]), [['graphify', 'Grafo do código: isto tem dois pontos']], 'synced/ is not a skill');
  assert.deepEqual(v.project.map((s) => [s.name, s.usage.count]), [['publicar-pagina', 1]]);
  assert.deepEqual(v.others.map((s) => s.id), ['postman:bootstrap', 'anthropic-skills:xlsx']);
  assert.equal(v.convCount, 3);
  assert.equal(v.projectCount, 2);
  assert.equal(v.analyzedAt, null);
});

test('the SKILL.md: composed, read back and checked before installing', () => {
  const text = sk.composeSkill({ name: 'publicar-versao', description: 'Gera a versão: sobe o número.\nUse quando…', body: '\n# Publicar\n\n1. Rode `npm test`.\n' });
  assert.equal(text, '---\nname: publicar-versao\ndescription: "Gera a versão: sobe o número. Use quando…"\n---\n\n# Publicar\n\n1. Rode `npm test`.\n');
  assert.deepEqual(sk.checkSkillText(text), { name: 'publicar-versao', description: 'Gera a versão: sobe o número. Use quando…' });
  assert.match(sk.checkSkillText(text.replace('publicar-versao', 'Publicar Versão')).error, /não serve/);
  assert.match(sk.checkSkillText(text.replace(/description: .*\n/, '')).error, /description/);
  assert.match(sk.checkSkillText('# sem cabeçalho').error, /cabeçalho/);
  assert.equal(sk.slug('Publicar versão!  da extensão'), 'publicar-versao-da-extensao');
});

// Stands in for Claude: finds the refs in the digest by the first prompt of each conversation.
function analyst(w, extra = []) {
  const calls = [];
  w.curator.run = async ({ prompt, schema, model, effort }) => {
    calls.push(prompt);
    assert.equal(model, 'sonnet');
    assert.equal(effort, 'medium', 'at the default effort it thinks for more than 10 min');
    assert.ok(schema.properties.suggestions);
    const ref = (first) => new RegExp(`### (c\\d+) ·[^\\n]*\\n1\\. ${first}`).exec(prompt)[1];
    return {
      suggestions: [
        {
          name: 'Gerar Versão',
          title: 'Gerar e instalar a versão',
          scope: 'project',
          project: 'work/alpha',
          why: 'Pedido em duas conversas, com os mesmos comandos.',
          when: 'gera a versão, instala',
          steps: ['npm test', 'npm run package', 'code --install-extension'],
          evidence: [`${ref('gera a versão')}.1`, `${ref('arruma o botão')}.2`, 'c99'],
          improves: '',
        },
        { name: 'so-uma', title: 'Só uma conversa', scope: 'global', project: '', why: '', when: '', steps: [], evidence: [ref('publica a página'), ref('publica a página')], improves: '' },
        { name: 'inventada', title: 'Inventada', scope: 'global', project: '', why: '', when: '', steps: [], evidence: ['c97', 'c98'], improves: '' },
        ...extra.map((f) => f(ref)),
      ],
    };
  };
  return calls;
}

test('analysis: conversations numbered for Claude, and only suggestions that hold up stay', async () => {
  const w = world();
  fs.mkdirSync(path.join(sk.userSkillsDir(w.t.paths), 'publicar'), { recursive: true });
  fs.writeFileSync(path.join(sk.userSkillsDir(w.t.paths), 'publicar', 'SKILL.md'), '---\nname: publicar\ndescription: Publica\n---\n\nx\n');
  const calls = analyst(w, [
    (ref) => ({ name: 'publicar', title: 'Publicar melhor', scope: 'global', project: '', why: 'w', when: '', steps: [], evidence: [ref('publica a página'), ref('gera a versão')], improves: '' }),
  ]);
  await w.curator.analyze();
  const prompt = calls[0];
  assert.match(prompt, /## Skills que já existem\n\n- publicar \(global\): Publica/);
  assert.match(prompt, /### c\d+ · work\/alpha · \d{4}-\d\d-\d\d · Gerar versão\n1\. gera a versão nova e instala\n2\. o vsix fica em dist\/, confere o nome antes\ncomandos: npm test, npm run package, code --install-extension, plink/);
  assert.ok(!prompt.includes('S3nhaF0rte') && !prompt.includes('ok\n'));
  assert.ok(prompt.includes('a senha do painel é senha: [segredo]') && !prompt.includes('Pa55word'), 'a password typed in a prompt');

  const v = w.curator.view();
  assert.deepEqual(
    v.suggestions.map((s) => [s.name, s.scope, s.project && s.project.label, s.evidence.length, !!s.improves]),
    [
      ['gerar-versao', 'project', 'work/alpha', 2, false],
      ['publicar', 'global', null, 2, true], // same name as a user skill: it improves that one
    ],
  );
  const [release] = v.suggestions;
  assert.equal(release.project.path, w.alpha);
  assert.deepEqual(release.evidence.map((x) => x.prompt), [1, 2]);
  assert.equal(v.newSince, 0);

  await w.curator.ignore(release.key);
  assert.deepEqual(w.curator.view().suggestions.map((s) => s.name), ['publicar']);
  await w.curator.analyze();
  assert.match(calls[1], /## Sugestões que o usuário recusou \(não sugira de novo\)\n\n- Gerar e instalar a versão: Pedido em duas conversas/);
  assert.equal(w.curator.view().suggestions.length, 1, 'still ignored after a new analysis: same key');
  await w.curator.clearIgnored();
  assert.equal(w.curator.view().suggestions.length, 2);
});

test('a draft from the conversations, installed into the project and undone', async () => {
  const w = world();
  analyst(w);
  await w.curator.analyze();
  const [g] = w.curator.view().suggestions;
  const prompts = [];
  w.curator.run = async ({ prompt, system, schema }) => {
    prompts.push(prompt);
    assert.deepEqual(schema.required, ['name', 'description', 'body', 'note']);
    assert.match(system, /Nunca escreva senhas/);
    return { name: 'outro-nome', description: 'Gera a versão: testa, empacota e instala. Use quando pedirem "gera a versão".', body: '# Gerar versão\n\n1. `npm test`\n2. senha=abc123\n', note: 'Cobre o vsix.' };
  };
  const draft = await w.curator.draft(g.key);
  const p = prompts[0];
  assert.match(p, /nome: gerar-versao/);
  assert.match(p, /onde: projeto work\/alpha/);
  assert.match(p, /USUÁRIO: gera a versão nova e instala/);
  assert.match(p, /\$ code --install-extension dist\/alpha-1\.2\.0\.vsix\n {2}✗ arquivo não encontrado/);
  assert.match(p, /USUÁRIO: o vsix fica em dist\/, confere o nome antes/);
  assert.match(p, /-pw \[segredo\] root@10\.0\.0\.1/);
  assert.ok(!p.includes('S3nhaF0rte'));
  assert.match(p, /USUÁRIO: agora gera a versão e instala/, 'the second conversation from its prompt 2');
  assert.ok(!p.includes('arruma o botão'), 'what came before the task stays out');

  assert.equal(draft.name, 'gerar-versao', 'the suggestion names it');
  assert.equal(draft.redacted, 1);
  const text = fs.readFileSync(draft.file, 'utf8');
  assert.ok(text.startsWith('---\nname: gerar-versao\ndescription: "Gera a versão'));
  assert.ok(text.includes('senha=[segredo]') && !text.includes('abc123'));
  assert.ok(fs.readFileSync(draft.evidenceFile, 'utf8').includes('USUÁRIO: gera a versão'));
  assert.equal(w.curator.view().suggestions[0].draft.id, draft.id);
  assert.equal(w.curator.draftOf(draft.file).id, draft.id);

  // The user edits the draft in the editor; that is what gets installed.
  fs.writeFileSync(draft.file, text.replace('# Gerar versão', '# Gerar a versão'));
  const r = await w.curator.install(draft.id);
  const target = path.join(w.alpha, '.claude', 'skills', 'gerar-versao', 'SKILL.md');
  assert.equal(r.file, target);
  assert.ok(fs.readFileSync(target, 'utf8').includes('# Gerar a versão'));
  assert.equal(fs.existsSync(path.dirname(draft.file)), false, 'the draft is gone');
  assert.equal(w.curator.view().suggestions.length, 0);
  assert.deepEqual(w.curator.view(w.alpha).project.map((s) => s.name), ['gerar-versao']);

  await w.curator.undoInstall(r.id);
  assert.equal(fs.existsSync(path.dirname(target)), false);
  assert.equal(w.curator.view().suggestions.length, 1, 'the suggestion comes back');
  await assert.rejects(w.curator.undoInstall(r.id), /não há mais/);
});

test('installing over a skill that exists asks first, keeps a copy and undoes back to it', async () => {
  const w = world();
  analyst(w);
  await w.curator.analyze();
  const [g] = w.curator.view().suggestions;
  w.curator.run = async () => ({ name: 'x', description: 'Nova.', body: '# Nova\n', note: '' });
  const target = path.join(w.alpha, '.claude', 'skills', 'gerar-versao', 'SKILL.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '---\nname: gerar-versao\ndescription: Antiga\n---\n\n# Antiga\n');
  // Made after the analysis, so the suggestion doesn't know it improves this one.
  const draft = await w.curator.draft(g.key);
  await assert.rejects(w.curator.install(draft.id), (e) => e.code === 'EEXIST' && e.file === target);
  const r = await w.curator.install(draft.id, { overwrite: true });
  assert.equal(r.replaced, true);
  assert.ok(fs.readFileSync(target, 'utf8').includes('# Nova'));
  const backups = path.join(w.switcherDir, 'memory-backup', 'skills');
  assert.equal(fs.readdirSync(backups).length, 1);
  await w.curator.undoInstall(r.id);
  assert.ok(fs.readFileSync(target, 'utf8').includes('# Antiga'));

  // A skill that changed after it was installed is not undone over.
  const d2 = await w.curator.draft(g.key);
  const r2 = await w.curator.install(d2.id, { overwrite: true });
  fs.appendFileSync(target, 'mais\n');
  await assert.rejects(w.curator.undoInstall(r2.id), /mudou/);
});

test('a skill removed with its folder comes back', async () => {
  const w = world();
  const dir = path.join(sk.userSkillsDir(w.t.paths), 'publicar');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: publicar\ndescription: P\n---\n\nx\n');
  fs.writeFileSync(path.join(dir, 'publicar.php'), '<?php');
  const saved = await w.curator.removeSkill(dir);
  assert.equal(fs.existsSync(dir), false);
  await assert.rejects(w.curator.removeSkill(dir), /não existe mais/);
  await w.curator.restoreSkill(saved);
  assert.equal(fs.readFileSync(path.join(dir, 'publicar.php'), 'utf8'), '<?php');
});

test('a skill the user describes takes the conversations that look like it as examples', async () => {
  const w = world();
  await w.curator.refreshIndex();
  const prompts = [];
  w.curator.run = async ({ prompt }) => {
    prompts.push(prompt);
    return { name: 'Instalar Versão', description: 'Instala.', body: '# Instalar\n', note: '' };
  };
  const draft = await w.curator.draftFree('instalar a versão nova da extensão', { scope: 'global' });
  assert.match(prompts[0], /pedido do usuário: instalar a versão nova da extensão/);
  assert.match(prompts[0], /USUÁRIO: gera a versão nova e instala/);
  assert.ok(!prompts[0].includes('publica a página'));
  assert.equal(draft.name, 'instalar-versao');
  assert.equal(draft.scope, 'global');
  assert.deepEqual(w.curator.view().drafts.map((d) => d.id), [draft.id], 'shown on its own: no suggestion for it');
  await w.curator.discard(draft.id);
  assert.equal(fs.existsSync(path.dirname(draft.file)), false);
  assert.equal(w.curator.view().drafts.length, 0);

  // Nothing like it in the conversations: Claude is told not to make commands up.
  await w.curator.draftFree('organizar fotos de viagem', { scope: 'project', project: { path: w.beta, label: 'beta' } });
  assert.match(prompts[1], /Não achei conversas sobre isso/);
});

test('automatic analysis: at most once a week, after enough new conversations, in one window', async () => {
  const w = world();
  await w.curator.refreshIndex();
  assert.equal(w.curator.autoDue(), false, 'only 3 conversations');
  const more = (from, at) => {
    for (let i = from; i < from + AUTO_MIN_NEW; i++) w.write(w.beta, `n${i}`, transcript(w.beta, `n${i}`, at).user(`tarefa ${i}`));
  };
  more(0, Date.now() - DAY);
  await w.curator.refreshIndex();
  assert.equal(w.curator.autoDue(), true);
  const other = new SkillCurator({ paths: w.t.paths, switcherDir: w.switcherDir, run: w.curator.run });
  assert.equal(await w.curator.claimAuto(), true);
  assert.equal(await other.claimAuto(), false, 'the other window leaves it');
  await w.curator.analyze();

  const later = Date.now() + 8 * DAY;
  assert.equal(w.curator.autoDue(later), false, 'a week later, but nothing new since the analysis');
  more(100, Date.now() + DAY);
  await w.curator.refreshIndex();
  assert.equal(w.curator.autoDue(later), true);
  assert.equal(w.curator.autoDue(Date.now() + 2 * DAY), false, 'not before a week');
});
