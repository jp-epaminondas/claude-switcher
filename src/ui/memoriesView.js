'use strict';

// Side bar list "Memórias": preferences Claude Code saved again in several projects, to join
// into the global CLAUDE.md, and that CLAUDE.md piece by piece, to take things out of it.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const md = require('../core/claudeMd');
const { fmtClock } = require('../core/usage');

const VIEW = 'claudeSwitcher.memories';
const { Collapsed, Expanded, None } = vscode.TreeItemCollapsibleState;
const BACKUP_NOTE = 'Fica uma cópia de tudo em ~/.claude-switcher/memory-backup.';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const icon = (id, color) => new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function line(id, label, iconId, extra = {}) {
  return Object.assign(new vscode.TreeItem(label, None), { id, iconPath: iconId ? icon(iconId) : undefined }, extra);
}

function createMemoriesView(app) {
  const { curator, paths, log } = app;
  const changed = new vscode.EventEmitter();
  const refresh = () => changed.fire();
  let state = null; // what the list shows right now

  const provider = {
    onDidChangeTreeData: changed.event,
    getTreeItem: (item) => item,
    getChildren(element) {
      if (element) return element.children || [];
      try {
        state = curator.view();
      } catch (e) {
        return [new vscode.TreeItem(e.message)];
      }
      const n = state.suggestions.length;
      view.badge = n ? { value: n, tooltip: `${plural(n, 'preferência repetida', 'preferências repetidas')} para juntar` } : undefined;
      return [suggestionsNode(state), claudeMdNode(state, paths)];
    },
  };
  const view = vscode.window.createTreeView(VIEW, { treeDataProvider: provider });

  async function analyze(force = false) {
    const running = curator.analyze({ force });
    refresh();
    try {
      await vscode.window.withProgress({ location: { viewId: VIEW } }, () => running);
    } catch {} // the error shows up in the list
    refresh();
  }

  // Opening the panel analyzes again when the memories changed. A failure waits for a click,
  // so a broken Claude isn't asked over and over.
  function analyzeIfStale() {
    let v;
    try {
      v = curator.view();
    } catch {
      return;
    }
    if (v.stale && !v.running && !v.error) analyze();
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

  const disposables = [
    view,
    changed,
    view.onDidChangeVisibility((e) => e.visible && analyzeIfStale()),
    vscode.commands.registerCommand('claudeSwitcher.memories.analyze', () => analyze(true)),
    vscode.commands.registerCommand('claudeSwitcher.memories.openClaudeMd', openClaudeMd),
    vscode.commands.registerCommand('claudeSwitcher.memories.merge', merge),
    vscode.commands.registerCommand('claudeSwitcher.memories.ignore', ignore),
    vscode.commands.registerCommand('claudeSwitcher.memories.clearIgnored', clearIgnored),
    vscode.commands.registerCommand('claudeSwitcher.memories.remove', remove),
  ];
  if (view.visible) analyzeIfStale();

  return {
    refresh,
    dispose() {
      for (const file of watched) fs.unwatchFile(file);
      for (const d of disposables) d.dispose();
    },
  };
}

// "Repetidas nos projetos": what Claude found, plus how fresh that is.
function suggestionsNode(s) {
  const n = s.suggestions.length;
  const node = new vscode.TreeItem('Repetidas nos projetos', Expanded);
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

// "CLAUDE.md global": every section and item, each one removable.
function claudeMdNode(s, paths) {
  const file = md.claudeMdPath(paths);
  const doc = md.parseClaudeMd(s.claudeMd);
  const rules = new Set(s.merged.map((r) => r.rule).filter(Boolean));
  const uri = vscode.Uri.file(file);
  const items = doc.blocks.filter((b) => b.kind === 'item').length;

  const toItem = (b) => {
    const kids = doc.blocks.filter((x) => x.parent === b);
    const t = new vscode.TreeItem(b.kind === 'section' ? b.title : summary(b.text), b.kind === 'section' ? (kids.length ? Expanded : None) : None);
    t.id = `claudeMd.${b.start}.${b.kind}`;
    t.ref = md.refOf(b);
    t.blockText = b.text;
    t.contextValue = 'claudeBlock';
    const last = doc.lines[b.end] || '';
    t.command = { command: 'vscode.open', title: 'Abrir no CLAUDE.md', arguments: [uri, { selection: new vscode.Range(b.start, 0, b.end, last.length) }] };
    const tip = new vscode.MarkdownString();
    tip.appendCodeblock(clip(b.text, 1500), 'markdown');
    t.tooltip = tip;
    if (b.kind === 'section') {
      t.iconPath = icon('symbol-namespace');
      t.description = plural(kids.length, 'item', 'itens');
      t.children = kids.map(toItem);
    } else {
      const joined = rules.has(md.normalizeRule(b.text));
      t.iconPath = joined ? icon('merge', 'charts.green') : icon(/^ {0,3}(```|~~~)/.test(b.text) ? 'code' : 'circle-small-filled');
      const extra = b.end - b.start;
      t.description = [joined ? 'juntada' : '', extra ? `+${plural(extra, 'linha', 'linhas')}` : ''].filter(Boolean).join(' · ');
    }
    return t;
  };

  const node = new vscode.TreeItem('CLAUDE.md global', Expanded);
  node.id = 'claudeMd';
  node.contextValue = 'claudeMdRoot';
  node.iconPath = icon('book');
  node.description = plural(items, 'item', 'itens');
  node.tooltip = `${file}\n\nVale para todos os projetos e todas as contas. Remova aqui o que não quer mais.`;
  const top = doc.blocks.filter((b) => !b.parent);
  node.children = top.length
    ? top.map(toItem)
    : [line('claudeMd.empty', 'Vazio', 'info', { tooltip: 'Junte uma sugestão acima para começar, ou abra o arquivo e escreva.' })];
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
