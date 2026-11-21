'use strict';

// The side bar panel, one page at a time: Contas, Memórias, Skills, Credenciais, Aprovações or Travas, picked
// from the panel's "…" menu. Each page brings its rows, its description and its badge; only the
// page on screen shows them, except a badgeAlways page's badge, shown while the page on screen
// has none. A page can bring its own view instead of rows (Aprovações is a webview): the
// "when" of each view in package.json shows the tree or that view, by the page on screen.
const vscode = require('vscode');

const VIEW = 'claudeSwitcher.accounts';
const CONTEXT = 'claudeSwitcher.page';

function createSidebar() {
  const changed = new vscode.EventEmitter();
  const pages = new Map();
  let current = null;

  // A page with collapseOnShow gets new ids each time it comes on screen, so VS Code forgets
  // what was expanded and every row starts collapsed. Children are built with their parent,
  // so prefixing the whole tree from the top is enough.
  const prefixIds = (items, prefix) => {
    for (const it of items) {
      if (it.id) it.id = prefix + it.id;
      if (Array.isArray(it.children)) prefixIds(it.children, prefix);
    }
    return items;
  };
  const provider = {
    onDidChangeTreeData: changed.event,
    getTreeItem: (item) => item,
    getChildren(element) {
      if (!current) return [];
      if (element || !current.collapseOnShow) return current.getChildren(element);
      return prefixIds(current.getChildren(), `${current.shownCount}:`);
    },
  };
  const view = vscode.window.createTreeView(VIEW, { treeDataProvider: provider });

  function apply() {
    view.title = current.title;
    view.description = current.description;
    view.badge = current.badge || [...pages.values()].find((p) => p.badgeAlways && p.badge)?.badge;
  }

  // The page comes on screen: collapsed again if it asks for it, then its onShow.
  function shown(page) {
    if (page.collapseOnShow) {
      page.shownCount++;
      changed.fire();
    }
    page.onShow();
  }

  function show(name) {
    const page = pages.get(name);
    if (!page) return Promise.resolve();
    const switched = page !== current;
    current = page;
    const set = vscode.commands.executeCommand('setContext', CONTEXT, name);
    apply();
    if (switched) changed.fire();
    if (view.visible) shown(page);
    return set;
  }

  // Registers a page. `getChildren` builds its rows; `onShow` runs whenever it comes on screen;
  // `onCheck` gets the [row, state] pairs whose checkbox was clicked; `collapseOnShow` makes
  // every row start collapsed each time; `badgeAlways` shows its badge on other pages too;
  // `viewId` is the page's own view, shown in place of the tree.
  function page(name, title, { getChildren = () => [], onShow = () => {}, onCheck = () => {}, collapseOnShow = false, badgeAlways = false, viewId = VIEW }) {
    const p = {
      name,
      title,
      getChildren,
      onShow,
      onCheck,
      collapseOnShow,
      badgeAlways,
      viewId,
      shownCount: 0,
      description: '',
      badge: undefined,
      refresh: () => p === current && changed.fire(),
      // A field left out stays; one given as undefined is cleared (no badge any more).
      decorate(fields = {}) {
        if ('description' in fields) p.description = fields.description;
        if ('badge' in fields) p.badge = fields.badge;
        if (p === current || (current && p.badgeAlways)) apply();
      },
      shown: () => p === current && view.visible,
    };
    pages.set(name, p);
    if (!current) show(name);
    return p;
  }

  // Opens the side bar on a page.
  async function focus(name) {
    await show(name); // the page's view only exists once the context says so
    await vscode.commands.executeCommand(`${pages.get(name)?.viewId || VIEW}.focus`);
  }

  const disposables = [
    view,
    changed,
    view.onDidChangeVisibility((e) => e.visible && current && shown(current)),
    view.onDidChangeCheckboxState((e) => current && current.onCheck(e.items)),
    // Each page twice: plain, and with ✓ for the "…" menu while it is the page on screen.
    ...[
      ['Accounts', 'accounts'],
      ['Memories', 'memories'],
      ['Skills', 'skills'],
      ['Credentials', 'credentials'],
      ['Approvals', 'approvals'],
      ['Locks', 'locks'],
    ].flatMap(([cmd, name]) => [
      vscode.commands.registerCommand(`claudeSwitcher.show${cmd}`, () => focus(name)),
      vscode.commands.registerCommand(`claudeSwitcher.show${cmd}Current`, () => focus(name)),
    ]),
  ];

  return {
    VIEW,
    page,
    show,
    focus,
    visible: () => view.visible,
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}

module.exports = { createSidebar };
