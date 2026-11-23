'use strict';

// Side bar page "Configurações": every setting of the switcher in one place (core/settings.js).
// A switch is a checkbox; a number or a choice opens a list. Changes go to VS Code's global
// settings, so they hold in every window and project; a project with a value of its own in
// .vscode/settings.json keeps it, and the row says so.
const vscode = require('vscode');
const pkg = require('../../package.json');
const { SECTION, GROUPS, schemaOf, settingOf, parseNumber, projectValue } = require('../core/settings');

const { Expanded, None } = vscode.TreeItemCollapsibleState;
const { Checked, Unchecked } = vscode.TreeItemCheckboxState;
const { Global } = vscode.ConfigurationTarget;
const icon = (id) => new vscode.ThemeIcon(id);

function createSettingsView(app, sidebar) {
  const { log } = app;
  let changing = Promise.resolve(); // one checkbox at a time

  const page = sidebar.page('settings', 'Configurações', {
    getChildren: (element) => (element ? element.children || [] : [...GROUPS.filter((g) => !g.permission || app.access.can(g.permission)).map(group), editorRow()]),
    onShow: () => page.refresh(),
    onCheck(items) {
      for (const [item, state] of items) if (item.settingKey) changing = changing.then(() => setSwitch(item.settingKey, state === Checked));
    },
  });

  // The global value (what the page changes) and the project's own, if it has one.
  function read(key) {
    const i = app.config().inspect(key);
    return { global: i.globalValue !== undefined ? i.globalValue : i.defaultValue, project: projectValue(i) };
  }

  const show = (s, v) => (typeof v === 'boolean' ? (v ? 'ligado' : 'desligado') : s.fmt(v));

  function group(g) {
    const t = new vscode.TreeItem(g.label, Expanded);
    t.id = `settings:${g.id}`;
    t.iconPath = icon(g.icon);
    t.children = g.items.map(row);
    return t;
  }

  function row(s) {
    const { global, project } = read(s.key);
    const t = new vscode.TreeItem(s.label, None);
    t.id = `settings:${s.key}`;
    const here = project !== undefined ? `neste projeto: ${show(s, project)}` : '';
    if (typeof global === 'boolean') {
      t.settingKey = s.key;
      t.checkboxState = { state: global ? Checked : Unchecked, tooltip: global ? 'Desligar' : 'Ligar' };
      t.description = here;
    } else {
      t.description = [s.fmt(global), here].filter(Boolean).join(' · ');
      t.command = { command: 'claudeSwitcher.settings.edit', title: 'Mudar', arguments: [s.key] };
    }
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${s.label}** · ${show(s, global)}\n\n`);
    tip.appendText(schemaOf(s.key).description);
    tip.appendMarkdown(`\n\n\`${SECTION}.${s.key}\`, nas configurações globais do VS Code: vale em todas as janelas e projetos.`);
    if (here) tip.appendMarkdown(`\n\nEste projeto tem um valor próprio no .vscode/settings.json (${show(s, project)}), que vale aqui no lugar do global.`);
    t.tooltip = tip;
    return t;
  }

  function editorRow() {
    const t = new vscode.TreeItem('Abrir no editor de configurações do VS Code', None);
    t.id = 'settings:editor';
    t.iconPath = icon('go-to-file');
    t.command = { command: 'workbench.action.openSettings', title: 'Abrir', arguments: [`@ext:${pkg.publisher}.${pkg.name}`] };
    return t;
  }

  // A switch with a hook in Claude Code goes through its toggle, which also says how it went.
  async function setSwitch(key, on) {
    const s = settingOf(key);
    try {
      if (!s || read(key).global === on) return;
      if (s.toggle && app.config().get(key) !== on) await vscode.commands.executeCommand(s.toggle);
      else await app.config().update(key, on, Global);
    } catch (e) {
      log(`configurações: ${e.stack || e.message}`);
      vscode.window.showErrorMessage(`Claude Switcher: não consegui mudar "${s.label}" (${e.message}).`);
    } finally {
      page.refresh(); // the checkbox shows what was saved
    }
  }

  // A number from a short list, or any other the schema allows.
  async function edit(key) {
    const s = settingOf(key);
    if (!s) return;
    if (s.pick) return vscode.commands.executeCommand(s.pick);
    const current = read(key).global;
    const items = s.choices.map((v) => ({ label: `${v === current ? '$(check) ' : ''}${s.fmt(v)}`, value: v }));
    if (!s.choices.includes(current)) items.unshift({ label: `$(check) ${s.fmt(current)}`, value: current });
    items.push({ label: 'Outro valor…', value: null });
    const picked = await vscode.window.showQuickPick(items, { title: s.label, placeHolder: `Hoje: ${s.fmt(current)}` });
    if (!picked) return;
    let value = picked.value;
    if (value == null) {
      const { minimum = 1, maximum } = schemaOf(key);
      const range = maximum ? `de ${minimum} a ${maximum}` : `a partir de ${minimum}`;
      const typed = await vscode.window.showInputBox({
        title: s.label,
        prompt: `Um número ${range}.`,
        value: String(current),
        validateInput: (t) => (parseNumber(key, t) == null ? `Um número ${range}` : null),
      });
      if (typed === undefined) return;
      value = parseNumber(key, typed);
    }
    if (value !== current) await app.config().update(key, value, Global);
  }

  const disposables = [
    app.access.command('claudeSwitcher.settings.edit', async (key) => {
      try {
        await edit(key);
      } catch (e) {
        log(`configurações: ${e.stack || e.message}`);
        vscode.window.showErrorMessage(`Claude Switcher: ${e.message}`);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration(SECTION) && page.refresh()),
  ];

  return {
    // The groups follow the permissions.
    onAccess: () => page.refresh(),
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}

module.exports = { createSettingsView };
