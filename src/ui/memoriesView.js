'use strict';

// Side bar page "Memórias": preferences Claude Code saved again in several projects, to join
// into the global CLAUDE.md; that CLAUDE.md piece by piece; and the project open in VS Code,
// with its own CLAUDE.md and the memories Claude saved for it.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const md = require('../core/claudeMd');
const { fmtClock } = require('../core/usage');

const { Collapsed, None } = vscode.TreeItemCollapsibleState;
const BACKUP_NOTE = 'Fica uma cópia de tudo em ~/.claude-switcher/memory-backup.';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const icon = (id, color) => new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function line(id, label, iconId, extra = {}) {
  return Object.assign(new vscode.TreeItem(label, None), { id, iconPath: iconId ? icon(iconId) : undefined }, extra);
}

// The project the user is working on: the folder of the file in the editor, else the first one.
function currentRoot() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) return null;
  const editor = vscode.window.activeTextEditor;
  const folder = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri);
  return (folder || folders[0]).uri.fsPath;
}

function createMemoriesView(app, sidebar) {
  const { curator, paths, log } = app;
  let state = null; // what the list shows right now
  let project = null; // curator.projectView() of the project open, as shown
  let root = currentRoot();

  const page = sidebar.page('memories', 'Memórias', {
    getChildren(element) {
      if (element) return element.children || [];
      try {
        state = curator.view();
      } catch (e) {
        return [new vscode.TreeItem(e.message)];
      }
      const n = state.suggestions.length;
      page.decorate({
        description: n ? `${n} para juntar` : '',
        badge: n ? { value: n, tooltip: `${plural(n, 'preferência repetida', 'preferências repetidas')} para juntar` } : undefined,
      });
      try {
        project = root ? curator.projectView(root) : null;
      } catch (e) {
        log(`projeto: ${e.message}`);
        project = null;
      }
      return [suggestionsNode(state), claudeMdNode(state, paths), projectNode(project, root)];
    },
    // Coming to the page only re-reads the files; the analysis (tokens) runs on a click.
    onShow: () => page.refresh(),
    collapseOnShow: true,
  });
  const refresh = page.refresh;

  async function analyze(force = false) {
    const running = curator.analyze({ force });
    refresh();
    try {
      await vscode.window.withProgress({ location: { viewId: sidebar.VIEW } }, () => running);
    } catch {} // the error shows up in the list
    refresh();
  }

  async function merge(item) {
    const g = state && state.suggestions.find((x) => x.key === item.key);
    if (!g) return refresh();
    const projects = [...new Set(g.members.map((m) => m.projectLabel))].join(', ');
    const n = g.members.length;
    let rule = g.rule;
    if (g.inGlobal) {
      const ok = await vscode.window.showWarningMessage(
        `Apagar ${plural(n, 'cópia', 'cópias')} de "${g.title}"?`,
        { modal: true, detail: `A regra já está no CLAUDE.md global:\n\n${g.rule}\n\nAs cópias saem de: ${projects}. ${BACKUP_NOTE}` },
        'Apagar cópias',
      );
      if (!ok) return;
    } else {
      rule = await vscode.window.showInputBox({
        title: `Juntar no CLAUDE.md global: ${g.title}`,
        prompt: `Vai para a seção ${md.PREFS_TITLE} e vale para todos os projetos. As ${n} memórias repetidas (${projects}) saem dos projetos. Edite o texto se quiser.`,
        value: g.rule,
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? null : 'Escreva a regra'),
      });
      if (!rule) return;
    }
    let r;
    try {
      r = await curator.merge(g.key, rule);
    } catch (e) {
      log(`juntar memórias: ${e.stack || e.message}`);
      vscode.window.showErrorMessage(`Claude Switcher: não consegui juntar (${e.message}).`);
      return refresh();
    }
    refresh();
    log(`memórias juntadas: "${g.title}", ${r.removed} cópias apagadas, backup em ${r.backupDir}`);
    const msg = r.rule
      ? `"${g.title}" agora está no CLAUDE.md global; ${plural(r.removed, 'cópia saiu', 'cópias saíram')} dos projetos.`
      : `${plural(r.removed, 'cópia apagada', 'cópias apagadas')}; a regra continua no CLAUDE.md global.`;
    const choice = await vscode.window.showInformationMessage(msg, 'Abrir CLAUDE.md', 'Desfazer');
    if (choice === 'Desfazer') undo(r.id);
    else if (choice) openClaudeMd();
  }

  async function undo(id) {
    try {
      const r = await curator.undo(id);
      vscode.window.showInformationMessage(`Desfeito: ${plural(r.restored, 'memória voltou', 'memórias voltaram')} para os projetos.`);
    } catch (e) {
      vscode.window.showErrorMessage(`Claude Switcher: não consegui desfazer (${e.message}).`);
    }
    refresh();
  }

  async function ignore(item) {
    await curator.ignore(item.key);
    refresh();
  }

  async function clearIgnored() {
    await curator.clearIgnored();
    refresh();
  }

  async function remove(item) {
    if (!item || !item.ref) return;
    const section = item.ref.kind === 'section';
    const merged = !section && curator.mergedFor(item.blockText);
    let detail = section ? `Sai o título "${item.label}" e tudo o que está abaixo dele.` : clip(item.blockText, 600);
    if (merged) {
      detail += `\n\nEssa regra juntou ${plural(merged.files.length, 'memória', 'memórias')} dos projetos. "Remover e devolver" põe elas de volta onde estavam.`;
    }
    detail += `\n\n${BACKUP_NOTE}`;
    const back = 'Remover e devolver as memórias';
    const buttons = merged ? [back, 'Só remover'] : ['Remover'];
    const choice = await vscode.window.showWarningMessage(
      section ? 'Remover esta seção do CLAUDE.md global?' : 'Remover do CLAUDE.md global?',
      { modal: true, detail },
      ...buttons,
    );
    if (!choice) return;
    try {
      const r = await curator.remove(item.ref, { restore: choice === back });
      if (r.restored) vscode.window.showInformationMessage(`${plural(r.restored, 'memória voltou', 'memórias voltaram')} para os projetos.`);
    } catch (e) {
      vscode.window.showErrorMessage(`Claude Switcher: ${e.message}`);
    }
    refresh();
  }

  // "Nova instrução": the user writes what they want, Claude words it and picks the section,
  // and nothing is written before the user sees it. `target`: the project file, or global.
  async function addInstruction(target = null) {
    const where = target ? `CLAUDE.md do projeto ${target.label}` : 'CLAUDE.md global';
    const request = await vscode.window.showInputBox({
      title: `Nova instrução no ${where}`,
      prompt: target
        ? `Escreva do seu jeito o que o Claude deve fazer, ou nunca fazer, neste projeto. Ele escreve a instrução e mostra antes de gravar.`
        : 'Escreva do seu jeito o que o Claude deve fazer, ou nunca fazer, em todos os projetos. Ele escreve a instrução e mostra antes de gravar.',
      placeHolder: target ? 'ex.: os testes rodam com npm test, sempre rodar antes de commitar' : 'ex.: quando eu pedir deploy, confere antes se tem commit pendente',
      ignoreFocusOut: true,
    });
    if (!request || !request.trim()) return;
    let draft;
    try {
      draft = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'O Claude está escrevendo a instrução…' },
        () => curator.draftInstruction(request, target),
      );
    } catch (e) {
      log(`nova instrução: ${e.message}`);
      vscode.window.showErrorMessage(`Claude Switcher: não consegui escrever a instrução (${e.message}).`);
      return;
    }
    const parts = [`Seção: ${draft.section}${draft.newSection ? ' (nova)' : ''}`, '', `- ${draft.rule}`];
    if (draft.replaces) parts.push('', 'Substitui:', `- ${draft.replaces}`);
    if (draft.note) parts.push('', draft.note);
    if (target) parts.push('', target.file);
    let question = `Adicionar ao ${where}?`;
    if (draft.wrongScope) {
      question = target
        ? 'Isso parece valer para todos os projetos. Pôr só neste projeto mesmo assim?'
        : 'Isso parece ser de um projeto só. Pôr no CLAUDE.md global mesmo assim?';
    }
    const choice = await vscode.window.showInformationMessage(question, { modal: true, detail: parts.join('\n') }, 'Adicionar', 'Editar o texto');
    if (!choice) return;
    let rule = draft.rule;
    if (choice === 'Editar o texto') {
      rule = await vscode.window.showInputBox({ title: `Instrução (seção ${draft.section})`, value: draft.rule, ignoreFocusOut: true, validateInput: (v) => (v.trim() ? null : 'Escreva a instrução') });
      if (!rule) return;
    }
    let done;
    try {
      done = await curator.addInstruction({ rule, section: draft.section, replaces: draft.replaces }, target);
    } catch (e) {
      vscode.window.showErrorMessage(`Claude Switcher: ${e.message}`);
      return refresh();
    }
    refresh();
    if (!done) {
      vscode.window.showInformationMessage(`Essa instrução já está no ${where}.`);
      return;
    }
    log(`instrução adicionada em "${draft.section}" (${target ? target.file : 'global'}): ${rule}`);
    const next = await vscode.window.showInformationMessage(`Instrução adicionada em "${draft.section}".`, 'Abrir o arquivo', 'Desfazer');
    if (next === 'Abrir o arquivo') {
      if (target) openFile(target.file);
      else openClaudeMd();
    } else if (next === 'Desfazer') {
      try {
        await curator.undoInstruction(done);
        vscode.window.showInformationMessage('Desfeito: o arquivo voltou a como estava.');
      } catch (e) {
        vscode.window.showErrorMessage(`Claude Switcher: ${e.message}`);
      }
      refresh();
    }
  }

  // --- the project open in VS Code ---------------------------------------------------------

  function addProjectInstruction() {
    if (!project) return vscode.window.showWarningMessage('Abra uma pasta de projeto no VS Code primeiro.');
    return addInstruction({ file: project.target, label: project.label });
  }

  async function removeProjectBlock(item) {
    if (!item || !item.ref || !item.file) return;
    const section = item.ref.kind === 'section';
    const name = path.relative(project ? project.root : path.dirname(item.file), item.file) || item.file;
    const ok = await vscode.window.showWarningMessage(
      section ? `Remover esta seção do ${name}?` : `Remover do ${name}?`,
      { modal: true, detail: `${section ? `Sai o título "${item.label}" e tudo o que está abaixo dele.` : clip(item.blockText, 600)}\n\n${BACKUP_NOTE}` },
      'Remover',
    );
    if (!ok) return;
    try {
      await curator.removeFromFile(item.file, item.ref);
    } catch (e) {
      vscode.window.showErrorMessage(`Claude Switcher: ${e.message}`);
    }
    refresh();
  }

  async function deleteProjectMemory(item) {
    if (!item || !item.memoryId) return;
    const ok = await vscode.window.showWarningMessage(
      'Apagar esta memória do projeto?',
      { modal: true, detail: `${item.memoryName}\n${item.memoryDescription || ''}\n\nO Claude deixa de lembrar disso neste projeto. ${BACKUP_NOTE}` },
      'Apagar',
    );
    if (!ok) return;
    let saved;
    try {
      saved = await curator.deleteMemory(item.memoryId);
    } catch (e) {
      vscode.window.showErrorMessage(`Claude Switcher: ${e.message}`);
      return refresh();
    }
    refresh();
    const undo = await vscode.window.showInformationMessage('Memória apagada.', 'Desfazer');
    if (undo) {
      await curator.restoreMemory(saved);
      refresh();
    }
  }

  async function openFile(file) {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '');
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  }

  async function openClaudeMd() {
    const file = md.claudeMdPath(paths);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '');
    }
    await vscode.window.showTextDocument(vscode.Uri.file(file));
  }

  const watched = [md.claudeMdPath(paths), path.join(app.switcherDir, 'memories.json')];
  for (const file of watched) fs.watchFile(file, { interval: 3000 }, refresh);

  // The project's own files are watched while it is the one open.
  let projectWatched = [];
  function watchProject() {
    for (const f of projectWatched) fs.unwatchFile(f);
    projectWatched = root ? md.projectMdPaths(root) : [];
    for (const f of projectWatched) fs.watchFile(f, { interval: 3000 }, refresh);
  }
  function track() {
    const next = currentRoot();
    if (next === root) return;
    root = next;
    watchProject();
    refresh();
  }
  watchProject();

  const disposables = [
    vscode.commands.registerCommand('claudeSwitcher.memories.analyze', () => analyze(true)),
    vscode.commands.registerCommand('claudeSwitcher.memories.openClaudeMd', openClaudeMd),
    vscode.commands.registerCommand('claudeSwitcher.memories.merge', merge),
    vscode.commands.registerCommand('claudeSwitcher.memories.ignore', ignore),
    vscode.commands.registerCommand('claudeSwitcher.memories.clearIgnored', clearIgnored),
    vscode.commands.registerCommand('claudeSwitcher.memories.remove', remove),
    vscode.commands.registerCommand('claudeSwitcher.memories.addInstruction', () => addInstruction()),
    vscode.commands.registerCommand('claudeSwitcher.memories.addProjectInstruction', addProjectInstruction),
    vscode.commands.registerCommand('claudeSwitcher.memories.removeProjectBlock', removeProjectBlock),
    vscode.commands.registerCommand('claudeSwitcher.memories.deleteProjectMemory', deleteProjectMemory),
    vscode.commands.registerCommand('claudeSwitcher.memories.openProjectFile', (item) => item && item.file && openFile(item.file)),
    vscode.window.onDidChangeActiveTextEditor(track),
    vscode.workspace.onDidChangeWorkspaceFolders(track),
  ];

  return {
    refresh,
    dispose() {
      for (const file of [...watched, ...projectWatched]) fs.unwatchFile(file);
      for (const d of disposables) d.dispose();
    },
  };
}

// "Repetidas nos projetos": what Claude found, plus how fresh that is.
function suggestionsNode(s) {
  const n = s.suggestions.length;
  const node = new vscode.TreeItem('Repetidas nos projetos', Collapsed);
  node.id = 'suggestions';
  node.iconPath = icon('lightbulb', n ? 'charts.yellow' : undefined);
  node.description = s.running ? 'analisando…' : n ? `${n} para juntar` : '';
  node.tooltip =
    'Preferências e correções que o Claude Code salvou de novo em cada projeto. Juntar põe a regra no CLAUDE.md global, que vale para todos os projetos e todas as contas, e apaga as cópias.';
  const analyzeCmd = { command: 'claudeSwitcher.memories.analyze', title: 'Analisar de novo' };
  const children = [];
  if (s.running) {
    children.push(line('suggestions.running', 'Analisando as memórias com o Claude…', 'loading~spin'));
  } else {
    if (s.error) {
      children.push(
        line('suggestions.error', 'Não consegui analisar', 'warning', {
          description: s.error,
          tooltip: `${s.error}\n\nClique para tentar de novo.`,
          command: analyzeCmd,
        }),
      );
    }
    children.push(...s.suggestions.map(suggestionItem));
    if (s.analyzedAt && !n && !s.error) {
      children.push(line('suggestions.none', 'Nenhuma preferência repetida', 'pass', { tooltip: 'Nenhuma preferência aparece em mais de um projeto.' }));
    }
  }
  if (!s.running && s.stale && !s.error) {
    children.push(
      line('suggestions.stale', s.analyzedAt ? 'As memórias mudaram desde a análise' : 'Ainda não analisado', 'refresh', {
        tooltip: 'Clique para analisar. Usa um pouco do limite da conta em uso (modelo Haiku).',
        command: analyzeCmd,
      }),
    );
  }
  children.push(
    line('suggestions.count', `${plural(s.preferenceCount, 'preferência', 'preferências')} em ${plural(s.projectCount, 'projeto', 'projetos')}`, 'info', {
      description: s.analyzedAt ? `analisado ${fmtClock(s.analyzedAt)}` : '',
      tooltip: 'Memórias dos tipos feedback e user: o que você pediu ou corrigiu. As que só descrevem um projeto não entram.',
    }),
  );
  if (s.ignoredCount) {
    children.push(
      line('suggestions.ignored', plural(s.ignoredCount, 'sugestão ignorada', 'sugestões ignoradas'), 'eye-closed', {
        tooltip: 'Clique para mostrar de novo.',
        command: { command: 'claudeSwitcher.memories.clearIgnored', title: 'Mostrar ignoradas' },
      }),
    );
  }
  node.children = children;
  return node;
}

function suggestionItem(g) {
  const projects = [...new Set(g.members.map((m) => m.projectLabel))];
  const item = new vscode.TreeItem(g.title, Collapsed);
  item.id = `suggestion.${g.key}`;
  item.key = g.key;
  item.contextValue = 'suggestion';
  item.iconPath = icon(g.inGlobal ? 'copy' : 'merge', 'charts.yellow');
  item.description = g.inGlobal ? `já no CLAUDE.md · ${plural(g.members.length, 'cópia', 'cópias')}` : projects.join(', ');
  const tip = new vscode.MarkdownString('', true);
  tip.appendMarkdown(`**${g.title}**\n\n`);
  tip.appendText(g.rule);
  tip.appendMarkdown(`\n\n$(folder) ${projects.join(', ')}\n\n`);
  tip.appendMarkdown(
    g.inGlobal ? '_Já está no CLAUDE.md global: juntar só apaga as cópias._' : '_Juntar põe a regra no CLAUDE.md global e apaga as cópias dos projetos._',
  );
  item.tooltip = tip;
  item.children = g.members.map((m) => {
    const child = line(`${item.id}.${m.id}`, m.projectLabel, 'note', {
      description: m.description,
      command: { command: 'vscode.open', title: 'Abrir memória', arguments: [vscode.Uri.file(m.file)] },
    });
    const t = new vscode.MarkdownString('', true);
    t.appendMarkdown(`**${m.name}** · ${m.projectPath || m.project}\n\n`);
    t.appendText(clip(m.body, 800));
    child.tooltip = t;
    return child;
  });
  return item;
}

// The sections and items of a CLAUDE.md as rows, each one removable. `ctx`: the contextValue
// (claudeBlock for the global file, projectBlock for a project's); `joinedRules`: rules that
// came from joining memories.
function mdTree(text, file, idPrefix, ctx, joinedRules = new Set()) {
  const doc = md.parseClaudeMd(text);
  const uri = vscode.Uri.file(file);
  const toItem = (b) => {
    const kids = doc.blocks.filter((x) => x.parent === b);
    const t = new vscode.TreeItem(b.kind === 'section' ? b.title : summary(b.text), b.kind === 'section' ? (kids.length ? Collapsed : None) : None);
    t.id = `${idPrefix}.${b.start}.${b.kind}`;
    t.ref = md.refOf(b);
    t.blockText = b.text;
    t.file = file;
    t.contextValue = ctx;
    const last = doc.lines[b.end] || '';
    t.command = { command: 'vscode.open', title: 'Abrir no arquivo', arguments: [uri, { selection: new vscode.Range(b.start, 0, b.end, last.length) }] };
    const tip = new vscode.MarkdownString();
    tip.appendCodeblock(clip(b.text, 1500), 'markdown');
    t.tooltip = tip;
    if (b.kind === 'section') {
      t.iconPath = icon('symbol-namespace');
      t.description = plural(kids.length, 'item', 'itens');
      t.children = kids.map(toItem);
    } else {
      const joined = joinedRules.has(md.normalizeRule(b.text));
      t.iconPath = joined ? icon('merge', 'charts.green') : icon(/^ {0,3}(```|~~~)/.test(b.text) ? 'code' : 'circle-small-filled');
      const extra = b.end - b.start;
      t.description = [joined ? 'juntada' : '', extra ? `+${plural(extra, 'linha', 'linhas')}` : ''].filter(Boolean).join(' · ');
    }
    return t;
  };
  return {
    items: doc.blocks.filter((b) => b.kind === 'item').length,
    rows: doc.blocks.filter((b) => !b.parent).map(toItem),
  };
}

// "Memórias Globais": the global CLAUDE.md, every section and item, each one removable.
function claudeMdNode(s, paths) {
  const file = md.claudeMdPath(paths);
  const tree = mdTree(s.claudeMd, file, 'claudeMd', 'claudeBlock', new Set(s.merged.map((r) => r.rule).filter(Boolean)));
  const node = new vscode.TreeItem('Memórias Globais', Collapsed);
  node.id = 'claudeMd';
  node.contextValue = 'claudeMdRoot';
  node.iconPath = icon('book');
  node.description = plural(tree.items, 'item', 'itens');
  node.tooltip = `O CLAUDE.md global: ${file}\n\nVale para todos os projetos e todas as contas. Remova aqui o que não quer mais.`;
  const add = line('claudeMd.add', 'Nova instrução…', 'add', {
    description: 'escreva do seu jeito',
    tooltip: 'Diga o que o Claude deve fazer (ou nunca fazer). O Claude escreve a instrução, escolhe a seção e mostra antes de gravar.',
    command: { command: 'claudeSwitcher.memories.addInstruction', title: 'Nova instrução' },
  });
  node.children = [add, ...tree.rows];
  return node;
}

const MEMORY_GROUPS = [
  ['pref', 'Preferências e correções', 'feedback', (t) => t === 'feedback' || t === 'user'],
  ['project', 'Fatos do projeto', 'project', (t) => t === 'project'],
  ['reference', 'Referências', 'link', (t) => t === 'reference'],
  ['other', 'Outras', 'note', () => true],
];

// "Memórias Projeto (<nome>)": the project open in VS Code, its CLAUDE.md files and memories.
function projectNode(p, root) {
  const node = new vscode.TreeItem(p ? `Memórias Projeto (${p.label})` : 'Memórias Projeto', Collapsed);
  node.id = 'project';
  node.iconPath = icon('folder-opened');
  if (!p) {
    node.description = 'nenhum aberto';
    node.children = [line('project.none', root ? 'Não consegui ler o projeto' : 'Nenhuma pasta aberta no VS Code', 'info')];
    return node;
  }
  node.description = `${plural(p.memories.length, 'memória', 'memórias')}`;
  node.tooltip = `${p.root}\n\nO projeto aberto no VS Code agora (a pasta do arquivo no editor). Muda sozinho quando você troca de projeto.`;
  const children = [
    line('project.add', 'Nova instrução do projeto…', 'add', {
      description: 'escreva do seu jeito',
      tooltip: `O Claude escreve a instrução e mostra antes de gravar em ${p.target}.`,
      command: { command: 'claudeSwitcher.memories.addProjectInstruction', title: 'Nova instrução do projeto' },
    }),
  ];
  const existing = p.files.filter((f) => f.exists);
  for (const f of existing) {
    const rel = f.file.slice(p.root.length).replace(/^[\\/]+/, '');
    const tree = mdTree(f.text, f.file, `project.md.${rel}`, 'projectBlock');
    children.push(
      Object.assign(new vscode.TreeItem(rel, tree.rows.length ? Collapsed : None), {
        id: `project.file.${rel}`,
        file: f.file,
        contextValue: 'projectMdFile',
        iconPath: icon('book'),
        description: plural(tree.items, 'item', 'itens'),
        tooltip: `${f.file}\n\nVale só neste projeto.`,
        children: tree.rows,
      }),
    );
  }
  if (!existing.length) {
    children.push(line('project.noMd', 'Sem CLAUDE.md neste projeto', 'info', { tooltip: `"Nova instrução do projeto" cria ${p.target}.` }));
  }
  const mems = new vscode.TreeItem('Memórias do projeto', p.memories.length ? Collapsed : None);
  mems.id = 'project.memories';
  mems.iconPath = icon('database');
  mems.description = `${p.memories.length}`;
  mems.tooltip = `O que o Claude Code salvou sozinho sobre este projeto.\n${p.memoryDir}`;
  const taken = new Set();
  mems.children = MEMORY_GROUPS.map(([key, title, ic, test]) => {
    const list = p.memories.filter((m) => !taken.has(m.id) && test(m.type));
    list.forEach((m) => taken.add(m.id));
    if (!list.length) return null;
    return Object.assign(new vscode.TreeItem(title, Collapsed), {
      id: `project.memories.${key}`,
      iconPath: icon(ic),
      description: `${list.length}`,
      children: list.map((m) => {
        const t = new vscode.MarkdownString('', true);
        t.appendMarkdown(`**${m.name}**\n\n`);
        t.appendText(clip(m.body, 800));
        return line(`project.mem.${m.id}`, clip(m.description || m.name, 90), 'note', {
          memoryId: m.id,
          memoryName: m.name,
          memoryDescription: m.description,
          contextValue: 'projectMemory',
          tooltip: t,
          command: { command: 'vscode.open', title: 'Abrir memória', arguments: [vscode.Uri.file(m.file)] },
        });
      }),
    });
  }).filter(Boolean);
  children.push(mems);
  node.children = children;
  return node;
}

// First line of an item as plain text: no list marker, emphasis, code ticks or link targets.
function summary(text) {
  const first = text.split('\n').find((l) => l.trim()) || '';
  const plain = first
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*(```|~~~)\s*/, 'código ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`)/g, '')
    .trim();
  return clip(plain || '(vazio)', 90);
}

module.exports = { createMemoriesView };
