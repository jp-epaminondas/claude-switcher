'use strict';

// Side bar page "Skills": tasks the user keeps asking for in the conversations, that a skill
// would teach Claude once; the user's skills (global) and the open project's, with how often
// each was used. Drafts open in the editor, where the title bar installs them.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { fmtClock } = require('../core/usage');
const { samePath } = require('../core/skills');
const { currentRoot } = require('./memoriesView');

const { Collapsed, None } = vscode.TreeItemCollapsibleState;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const BACKUP_NOTE = 'Fica uma cópia em ~/.claude-switcher/memory-backup/skills.';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const icon = (id, color) => new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const fmtDay = (t) => new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

function line(id, label, iconId, extra = {}) {
  return Object.assign(new vscode.TreeItem(label, None), { id, iconPath: iconId ? icon(iconId) : undefined }, extra);
}

const whereOf = (x) => (x.scope === 'project' && x.project ? `projeto ${x.project.label}` : 'global');

function createSkillsView(app, sidebar) {
  const { skillCurator: curator, log, config } = app;
  let root = currentRoot();
  let indexing = null; // { done, total } while reading the conversations
  const writing = new Set(); // suggestion keys being drafted in this window

  const page = sidebar.page('skills', 'Skills', {
    getChildren(element) {
      if (element) return element.children || [];
      let state;
      try {
        state = curator.view(root);
      } catch (e) {
        return [new vscode.TreeItem(e.message)];
      }
      const n = state.suggestions.length;
      page.decorate({
        description: n ? `${n} para criar` : '',
        badge: n ? { value: n, tooltip: `${plural(n, 'tarefa repetida', 'tarefas repetidas')} que pode${n === 1 ? '' : 'm'} virar skill` } : undefined,
      });
      const ctx = { indexing, writing, root };
      return [suggestionsNode(state, ctx), userNode(state), projectNode(state, root)];
    },
    // Coming to the page reads what is new in the conversations (no tokens).
    onShow: () => {
      refresh();
      readConversations().catch(() => {});
    },
    collapseOnShow: true,
  });
  const refresh = page.refresh;

  async function readConversations() {
    const first = !curator.indexed();
    const job = curator.refreshIndex({
      onProgress: (p) => {
        if (!first) return;
        indexing = p;
        refresh();
      },
    });
    try {
      if (first) await vscode.window.withProgress({ location: { viewId: sidebar.VIEW } }, () => job);
      else await job;
    } catch (e) {
      log(`skills: ${e.message}`);
    } finally {
      indexing = null;
      refresh();
    }
  }

  async function analyze() {
    const running = curator.analyze();
    refresh();
    try {
      await vscode.window.withProgress({ location: { viewId: sidebar.VIEW } }, () => running);
    } catch {} // the error shows up in the list
    refresh();
  }

  // --- drafts --------------------------------------------------------------------------------

  async function openDraft(draft) {
    await vscode.window.showTextDocument(vscode.Uri.file(draft.file), { preview: false });
  }

  // After a draft is written: open it, and say how to install it.
  async function presentDraft(draft) {
    refresh();
    await openDraft(draft);
    const notes = [];
    if (draft.redacted) notes.push(`Tirei ${plural(draft.redacted, 'trecho que parecia', 'trechos que pareciam')} senha ou token.`);
    if (draft.note) notes.push(draft.note);
    const where = draft.scope === 'project' ? `no projeto ${draft.project.label}` : 'para todos os projetos';
    const msg = `Rascunho da skill "${draft.name}" (${where}) aberto no editor. Revise, edite se quiser e instale. ${notes.join(' ')}`.trim();
    const choice = await vscode.window.showInformationMessage(msg, 'Instalar', 'Revisar com o Claude');
    if (choice === 'Instalar') install(draft);
    else if (choice) review(draft);
  }

  async function create(item) {
    const g = curator.view(root).suggestions.find((x) => x.key === (item && item.key));
    if (!g) return refresh();
    if (g.draft && fs.existsSync(g.draft.file)) {
      const again = await vscode.window.showInformationMessage(`Já existe um rascunho de "${g.title}".`, 'Abrir o rascunho', 'Escrever de novo');
      if (again === 'Abrir o rascunho') return openDraft(g.draft);
      if (!again) return;
    }
    writing.add(g.key);
    refresh();
    let draft;
    try {
      draft = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `O Claude está escrevendo a skill "${g.title}" a partir de ${plural(Math.min(g.evidence.length, 5), 'conversa', 'conversas')}…` },
        () => curator.draft(g.key),
      );
    } catch (e) {
      log(`skills: rascunho de ${g.name}: ${e.message}`);
      vscode.window.showErrorMessage(`Claude Switcher: não consegui escrever a skill (${e.message}).`);
      return;
    } finally {
      writing.delete(g.key);
      refresh();
    }
    log(`skills: rascunho de ${draft.name} em ${draft.file}`);
    presentDraft(draft);
  }

  // "Nova skill…": the user says what it does; Claude writes it, with the conversations that
  // look like the request as examples.
  async function add(scope) {
    let project = null;
    if (scope === 'project') {
      if (!root) return vscode.window.showWarningMessage('Abra uma pasta de projeto no VS Code primeiro.');
      project = { path: root, label: path.basename(root) };
    }
    const request = await vscode.window.showInputBox({
      title: project ? `Nova skill do projeto ${project.label}` : 'Nova skill global',
      prompt: 'Diga do seu jeito o que a skill faz e quando o Claude deve usar. Ele escreve a SKILL.md, usando as conversas parecidas como exemplo, e abre para você revisar antes de instalar.',
      placeHolder: project ? 'ex.: gerar a versão: sobe o número, roda os testes, empacota o vsix e instala' : 'ex.: subir em commits separados, um por etapa, no padrão Conventional Commits',
      ignoreFocusOut: true,
    });
    if (!request || !request.trim()) return;
    await readConversations();
    let draft;
    try {
      draft = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'O Claude está escrevendo a skill…' }, () =>
        curator.draftFree(request, { scope: project ? 'project' : 'global', project }),
      );
    } catch (e) {
      log(`skills: nova skill: ${e.message}`);
      vscode.window.showErrorMessage(`Claude Switcher: não consegui escrever a skill (${e.message}).`);
      return;
    }
    presentDraft(draft);
  }

  // The draft a command is about: a row of the page, the file in the editor, or the active one.
  function draftFrom(arg) {
    if (arg && arg.draft) return arg.draft;
    const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
    return uri ? curator.draftOf(uri.fsPath) : null;
  }

  async function closeEditors(file) {
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input && t.input.uri && samePath(t.input.uri.fsPath, file));
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
  }

  async function install(arg) {
    const draft = draftFrom(arg);
    if (!draft) return vscode.window.showWarningMessage('Claude Switcher: esse rascunho não existe mais.');
    // Unsaved edits count: the file is installed as it is on screen.
    const doc = vscode.workspace.textDocuments.find((d) => samePath(d.uri.fsPath, draft.file));
    if (doc && doc.isDirty) await doc.save();
    let r;
    try {
      r = await curator.install(draft.id);
    } catch (e) {
      if (e.code !== 'EEXIST') {
        vscode.window.showErrorMessage(`Claude Switcher: não instalei a skill (${e.message}).`);
        return;
      }
      const ok = await vscode.window.showWarningMessage(
        `${e.message[0].toUpperCase()}${e.message.slice(1)}. Substituir?`,
        { modal: true, detail: `${e.file}\n\nA skill atual sai e fica guardada. ${BACKUP_NOTE}` },
        'Substituir',
      );
      if (!ok) return;
      try {
        r = await curator.install(draft.id, { overwrite: true });
      } catch (err) {
        vscode.window.showErrorMessage(`Claude Switcher: não instalei a skill (${err.message}).`);
        return;
      }
    }
    await closeEditors(draft.file);
    refresh();
    log(`skills: ${r.name} instalada em ${r.file}${r.replaced ? ' (substituiu a anterior)' : ''}`);
    const where = draft.scope === 'project' ? `no projeto ${draft.project.label}` : 'para todos os projetos';
    const choice = await vscode.window.showInformationMessage(
      `Skill "${r.name}" ${r.replaced ? 'atualizada' : 'instalada'} ${where}. O Claude Code passa a usá-la quando um pedido combinar com a descrição.`,
      'Abrir',
      'Desfazer',
    );
    if (choice === 'Abrir') vscode.window.showTextDocument(vscode.Uri.file(r.file));
    else if (choice === 'Desfazer') {
      try {
        await curator.undoInstall(r.id);
        vscode.window.showInformationMessage(r.replaced ? 'Desfeito: a skill voltou a como estava.' : 'Desfeito: a skill saiu.');
      } catch (e) {
        vscode.window.showErrorMessage(`Claude Switcher: ${e.message}`);
      }
      refresh();
    }
  }

  async function discard(arg) {
    const draft = draftFrom(arg);
    if (!draft) return;
    const ok = await vscode.window.showWarningMessage(`Descartar o rascunho da skill "${draft.name}"?`, { modal: true }, 'Descartar');
    if (!ok) return;
    await closeEditors(draft.file);
    await curator.discard(draft.id);
    refresh();
  }

  // A conversation with Claude, in this window, that checks the draft against the project and
  // fixes it in place. Installing stays with the user.
  async function review(arg) {
    const draft = draftFrom(arg);
    if (!draft) return;
    const project = draft.scope === 'project' ? ` Ela é do projeto em "${draft.project.path}": confira lá se os comandos, caminhos e scripts citados existem e estão certos.` : ' Confira se os comandos e caminhos citados existem e estão certos.';
    const prompt =
      `Revise o rascunho de skill do Claude Code em "${draft.file}". As conversas de onde ela saiu estão em "${draft.evidenceFile}".${project} ` +
      'Corrija o rascunho no mesmo arquivo, mantendo o cabeçalho name/description, e me diga o que mudou. Não instale a skill: eu instalo pelo Claude Switcher.';
    try {
      // (sessionId, initialPrompt): a new conversation with the prompt typed in, for the user to send.
      await vscode.commands.executeCommand('claude-vscode.editor.open', undefined, prompt);
      vscode.window.showInformationMessage('Abri uma conversa nova com o pedido de revisão digitado. Aperte Enter nela para enviar.');
    } catch (e) {
      log(`skills: não abri a conversa de revisão (${e.message})`);
      await vscode.env.clipboard.writeText(prompt);
      vscode.window.showWarningMessage('Claude Switcher: não consegui abrir uma conversa do Claude Code. O pedido de revisão foi copiado: abra uma conversa e cole.');
    }
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
    if (!item || !item.skill) return;
    const s = item.skill;
    const ok = await vscode.window.showWarningMessage(
      `Apagar a skill "${s.name}"?`,
      { modal: true, detail: `${s.dir}\n\nSai a pasta inteira da skill. ${BACKUP_NOTE}` },
      'Apagar',
    );
    if (!ok) return;
    let saved;
    try {
      saved = await curator.removeSkill(s.dir);
    } catch (e) {
      vscode.window.showErrorMessage(`Claude Switcher: ${e.message}`);
      return refresh();
    }
    refresh();
    const undo = await vscode.window.showInformationMessage(`Skill "${s.name}" apagada.`, 'Desfazer');
    if (undo) {
      try {
        await curator.restoreSkill(saved);
      } catch (e) {
        vscode.window.showErrorMessage(`Claude Switcher: ${e.message}`);
      }
      refresh();
    }
  }

  async function openConversation(item) {
    try {
      await vscode.commands.executeCommand('claude-vscode.editor.open', item.session);
    } catch (e) {
      log(`skills: não abri a conversa ${item.session} (${e.message})`);
    }
  }

  // --- automatic analysis ----------------------------------------------------------------

  // Once a week at most, when enough new conversations came in, one window looks for repeats
  // and tells about the new ones.
  async function autoCheck() {
    if (!app.access.can('skills')) return;
    if (!config().get('skills.autoAnalyze', true)) return;
    try {
      await curator.refreshIndex();
      if (!(await curator.claimAuto())) return;
      const before = new Set(curator.view().suggestions.map((s) => s.key));
      log('skills: análise automática das conversas');
      const running = curator.analyze();
      refresh();
      await running;
      refresh();
      const fresh = curator.view().suggestions.filter((s) => !before.has(s.key));
      if (!fresh.length) return;
      const [g] = fresh;
      const msg =
        fresh.length === 1
          ? `Claude Switcher: "${g.title}" se repete em ${plural(g.evidence.length, 'conversa', 'conversas')}. Uma skill ensinaria o Claude a fazer isso de uma vez.`
          : `Claude Switcher: ${fresh.length} tarefas se repetem nas suas conversas e podem virar skills, como "${g.title}".`;
      const buttons = fresh.length === 1 ? ['Criar skill', 'Ver'] : ['Ver'];
      const choice = await vscode.window.showInformationMessage(msg, ...buttons);
      if (choice === 'Criar skill') create({ key: g.key });
      else if (choice === 'Ver') sidebar.focus('skills');
    } catch (e) {
      log(`skills: análise automática: ${e.message}`);
      refresh();
    }
  }
  // A different moment in each window: the first one to read the conversations saves the others the work.
  const autoTimer = setTimeout(autoCheck, (2 + Math.random() * 3) * MINUTE);
  const autoInterval = setInterval(autoCheck, 6 * HOUR);

  const watched = [path.join(app.switcherDir, 'skills.json')];
  for (const file of watched) fs.watchFile(file, { interval: 3000 }, refresh);

  function track() {
    const next = currentRoot();
    if (next === root) return;
    root = next;
    refresh();
  }

  const disposables = [
    app.access.command('claudeSwitcher.skills.analyze', analyze),
    app.access.command('claudeSwitcher.skills.create', create),
    app.access.command('claudeSwitcher.skills.ignore', ignore),
    app.access.command('claudeSwitcher.skills.clearIgnored', clearIgnored),
    app.access.command('claudeSwitcher.skills.install', install),
    app.access.command('claudeSwitcher.skills.discard', discard),
    app.access.command('claudeSwitcher.skills.review', review),
    app.access.command('claudeSwitcher.skills.openDraft', (item) => item && item.draft && openDraft(item.draft)),
    app.access.command('claudeSwitcher.skills.add', () => add('global')),
    app.access.command('claudeSwitcher.skills.addProject', () => add('project')),
    app.access.command('claudeSwitcher.skills.remove', remove),
    app.access.command('claudeSwitcher.skills.openConversation', openConversation),
    vscode.window.onDidChangeActiveTextEditor(track),
    vscode.workspace.onDidChangeWorkspaceFolders(track),
  ];

  return {
    refresh,
    dispose() {
      clearTimeout(autoTimer);
      clearInterval(autoInterval);
      for (const file of watched) fs.unwatchFile(file);
      for (const d of disposables) d.dispose();
    },
  };
}

// "Repetidas nas conversas": what Claude found, and how fresh that is.
function suggestionsNode(s, ctx) {
  const n = s.suggestions.length;
  const node = new vscode.TreeItem('Repetidas nas conversas', Collapsed);
  node.id = 'skillSuggestions';
  node.iconPath = icon('lightbulb', n ? 'charts.yellow' : undefined);
  node.description = s.running ? 'analisando…' : n ? `${n} para criar` : '';
  node.tooltip =
    'Tarefas que você pediu em várias conversas e que o Claude refaz do zero a cada vez. Uma skill ensina o procedimento uma vez só: o Claude Code carrega ela sozinho quando o pedido combina.';
  const analyzeCmd = { command: 'claudeSwitcher.skills.analyze', title: 'Analisar' };
  const children = [];
  if (ctx.indexing) {
    const { done, total } = ctx.indexing;
    children.push(line('skillSuggestions.indexing', 'Lendo as conversas…', 'loading~spin', { description: total ? `${done} de ${total}` : '' }));
  }
  if (s.running) {
    children.push(line('skillSuggestions.running', 'O Claude está lendo as conversas…', 'loading~spin', { tooltip: 'Leva de 1 a 3 min.' }));
  } else {
    if (s.error) {
      children.push(
        line('skillSuggestions.error', 'Não consegui analisar', 'warning', { description: s.error, tooltip: `${s.error}\n\nClique para tentar de novo.`, command: analyzeCmd }),
      );
    }
    children.push(...s.suggestions.map((g) => suggestionItem(g, ctx)));
    if (s.analyzedAt && !n && !s.error) {
      children.push(line('skillSuggestions.none', 'Nenhuma tarefa repetida', 'pass', { tooltip: 'Nada nas conversas pede uma skill nova agora.' }));
    }
    if (!s.analyzedAt || s.newSince) {
      children.push(
        line('skillSuggestions.stale', s.analyzedAt ? plural(s.newSince, 'conversa nova desde a análise', 'conversas novas desde a análise') : 'Ainda não analisado', 'refresh', {
          tooltip: 'Clique para analisar. Usa um pouco do limite da conta em uso (modelo Sonnet, uma pergunta só).',
          command: analyzeCmd,
        }),
      );
    }
  }
  children.push(...s.drafts.map(draftItem));
  if (s.indexed) {
    children.push(
      line('skillSuggestions.count', `${plural(s.convCount, 'conversa', 'conversas')} em ${plural(s.projectCount, 'projeto', 'projetos')}`, 'info', {
        description: s.analyzedAt ? `analisado ${fmtClock(s.analyzedAt)}` : '',
        tooltip: 'O que entra na análise: os pedidos que você fez, os comandos que rodaram e as skills usadas, das conversas dos últimos 120 dias.',
      }),
    );
  }
  if (s.ignoredCount) {
    children.push(
      line('skillSuggestions.ignored', plural(s.ignoredCount, 'sugestão ignorada', 'sugestões ignoradas'), 'eye-closed', {
        tooltip: 'Clique para mostrar de novo na próxima análise.',
        command: { command: 'claudeSwitcher.skills.clearIgnored', title: 'Mostrar ignoradas' },
      }),
    );
  }
  node.children = children;
  return node;
}

function suggestionItem(g, ctx) {
  const writing = ctx.writing.has(g.key);
  const item = new vscode.TreeItem(g.title, Collapsed);
  item.id = `skillSuggestion.${g.key}`;
  item.key = g.key;
  item.contextValue = g.draft ? 'skillSuggestionDraft' : 'skillSuggestion';
  item.iconPath = icon(g.improves ? 'edit' : 'sparkle', 'charts.yellow');
  item.description = [g.improves ? `melhorar ${g.name}` : whereOf(g), plural(g.evidence.length, 'conversa', 'conversas'), writing ? 'escrevendo…' : g.draft ? 'rascunho pronto' : '']
    .filter(Boolean)
    .join(' · ');
  const tip = new vscode.MarkdownString('', true);
  tip.appendMarkdown(`**${g.title}** · \`${g.name}\` · ${whereOf(g)}\n\n`);
  if (g.why) tip.appendText(`${g.why}\n\n`);
  if (g.when) tip.appendMarkdown(`_Quando usar:_ `).appendText(`${g.when}\n\n`);
  if (g.steps.length) tip.appendText(g.steps.map((x, i) => `${i + 1}. ${x}`).join('\n')).appendMarkdown('\n\n');
  tip.appendMarkdown(
    g.improves
      ? '_Criar escreve uma versão nova dessa skill a partir das conversas. Você revisa antes de instalar, e a atual fica guardada._'
      : '_Criar escreve a SKILL.md a partir dessas conversas: os comandos que funcionaram, os erros que aconteceram e as suas correções. Você revisa antes de instalar._',
  );
  item.tooltip = tip;
  const children = [];
  if (writing) children.push(line(`${item.id}.writing`, 'O Claude está escrevendo a skill…', 'loading~spin'));
  else if (g.draft) children.push(draftItem(g.draft, `${item.id}.`));
  g.steps.forEach((x, i) => children.push(line(`${item.id}.step.${i}`, `${i + 1}. ${clip(x, 90)}`, 'circle-small', { tooltip: x })));
  for (const x of g.evidence) {
    const e = x.entry;
    const p = e.prompts[x.prompt - 1];
    const t = new vscode.MarkdownString('', true);
    t.appendMarkdown(`**${e.titleShown || 'Conversa'}** · ${e.label} · ${e.start ? fmtDay(e.start) : ''}\n\n`);
    e.prompts.slice(Math.max(0, x.prompt - 1), x.prompt + 3).forEach((q) => t.appendText(`• ${clip(q.t, 300)}\n`));
    const session = path.basename(e.key, '.jsonl');
    const here = ctx.root && samePath(e.cwd, ctx.root);
    children.push(
      line(`${item.id}.conv.${e.key}`, clip(e.titleShown || (p && p.t) || e.key, 70), 'comment-discussion', {
        description: `${e.label}${e.start ? ` · ${fmtDay(e.start)}` : ''}`,
        tooltip: t,
        session,
        // Only conversations of the project open here can be reopened in this window.
        command: here ? { command: 'claudeSwitcher.skills.openConversation', title: 'Abrir a conversa', arguments: [{ session }] } : undefined,
      }),
    );
  }
  item.children = children;
  return item;
}

function draftItem(d, prefix = 'skillDraft.') {
  return line(`${prefix}${d.id}`, `Rascunho: ${d.name}`, 'file-text', {
    description: `${whereOf(d)} · revise e instale`,
    tooltip: `${d.file}\n\nClique para abrir. O ✓ instala a skill como o arquivo estiver.`,
    contextValue: 'skillDraft',
    draft: d,
    command: { command: 'claudeSwitcher.skills.openDraft', title: 'Abrir o rascunho', arguments: [{ draft: d }] },
  });
}

function usageText(u) {
  if (!u || !u.count) return 'nunca usada';
  return `usada ${u.count}×${u.lastAt ? ` · última ${fmtDay(u.lastAt)}` : ''}`;
}

function skillItem(s, idPrefix, ctx) {
  const t = new vscode.MarkdownString('', true);
  t.appendMarkdown(`**${s.id}**\n\n`);
  t.appendText(clip(s.description, 900));
  t.appendMarkdown(`\n\n${s.file}`);
  return line(`${idPrefix}.${s.id}`, s.id, s.editable ? 'wand' : s.source === 'plugin' ? 'extensions' : 'cloud', {
    description: usageText(s.usage),
    tooltip: t,
    contextValue: ctx,
    skill: { name: s.name, dir: s.dir, file: s.file },
    command: fs.existsSync(s.file) ? { command: 'vscode.open', title: 'Abrir a skill', arguments: [vscode.Uri.file(s.file)] } : undefined,
  });
}

// "Skills Globais": the user's own, then plugins' and claude.ai's (read only).
function userNode(s) {
  const node = new vscode.TreeItem('Skills Globais', Collapsed);
  node.id = 'userSkills';
  node.iconPath = icon('library');
  node.description = plural(s.user.length, 'skill', 'skills');
  node.tooltip = 'As suas skills, em ~/.claude/skills: valem em todos os projetos e todas as contas.';
  const children = [
    line('userSkills.add', 'Nova skill…', 'add', {
      description: 'diga o que ela faz',
      tooltip: 'O Claude escreve a SKILL.md, usando as conversas parecidas como exemplo, e abre para você revisar antes de instalar.',
      command: { command: 'claudeSwitcher.skills.add', title: 'Nova skill' },
    }),
    ...s.user.map((x) => skillItem(x, 'userSkills', 'userSkill')),
  ];
  if (s.others.length) {
    const others = new vscode.TreeItem('De plugins e do claude.ai', Collapsed);
    others.id = 'userSkills.others';
    others.iconPath = icon('extensions');
    others.description = `${s.others.length}`;
    others.tooltip = 'Vêm instaladas com os plugins e sincronizadas do claude.ai. Só leitura.';
    others.children = s.others.map((x) => skillItem(x, 'userSkills.others', 'otherSkill'));
    children.push(others);
  }
  node.children = children;
  return node;
}

// "Skills Projeto (<nome>)": <root>/.claude/skills of the project open in VS Code.
function projectNode(s, root) {
  const label = root ? path.basename(root) : null;
  const node = new vscode.TreeItem(label ? `Skills Projeto (${label})` : 'Skills Projeto', Collapsed);
  node.id = 'projectSkills';
  node.iconPath = icon('folder-opened');
  if (!root) {
    node.description = 'nenhum aberto';
    node.children = [line('projectSkills.none', 'Nenhuma pasta aberta no VS Code', 'info')];
    return node;
  }
  node.description = plural(s.project.length, 'skill', 'skills');
  node.tooltip = `${path.join(root, '.claude', 'skills')}\n\nValem só neste projeto. Muda sozinho quando você troca de projeto.`;
  node.children = [
    line('projectSkills.add', 'Nova skill do projeto…', 'add', {
      description: 'diga o que ela faz',
      tooltip: 'O Claude escreve a SKILL.md, usando as conversas deste projeto como exemplo, e abre para você revisar antes de instalar.',
      command: { command: 'claudeSwitcher.skills.addProject', title: 'Nova skill do projeto' },
    }),
    ...s.project.map((x) => skillItem(x, 'projectSkills', 'projectSkill')),
  ];
  return node;
}

module.exports = { createSkillsView };
