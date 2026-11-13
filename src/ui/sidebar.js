'use strict';

// The side bar panel, one page at a time: Contas or Memórias, picked from the panel's "…"
// menu. Each page brings its rows, its description and its badge; only the page on screen
// shows them.
const vscode = require('vscode');

const VIEW = 'claudeSwitcher.accounts';
const CONTEXT = 'claudeSwitcher.page';

function createSidebar() {
  const changed = new vscode.EventEmitter();
  const pages = new Map();
  let current = null;

  const provider = {
    onDidChangeTreeData: changed.event,
    getTreeItem: (item) => item,
    getChildren: (element) => (current ? current.getChildren(element) : []),
  };
  const view = vscode.window.createTreeView(VIEW, { treeDataProvider: provider });

  function apply() {
    view.title = current.title;
    view.description = current.description;
    view.badge = current.badge;
  }

  function show(name) {
    const page = pages.get(name);
    if (!page) return;
    const switched = page !== current;
    current = page;
    vscode.commands.executeCommand('setContext', CONTEXT, name);
    apply();
    if (switched) changed.fire();
    if (view.visible) page.onShow();
  }

  // Registers a page. `getChildren` builds its rows; `onShow` runs whenever it comes on screen.
  function page(name, title, { getChildren, onShow = () => {} }) {
    const p = {
      name,
      title,
      getChildren,
      onShow,
      description: '',
      badge: undefined,
      refresh: () => p === current && changed.fire(),
      decorate({ description = p.description, badge = p.badge } = {}) {
        p.description = description;
        p.badge = badge;
        if (p === current) apply();
      },
      shown: () => p === current && view.visible,
    };
    pages.set(name, p);
    if (!current) show(name);
    return p;
  }

  // Opens the side bar on a page.
  async function focus(name) {
    show(name);
    await vscode.commands.executeCommand(`${VIEW}.focus`);
  }

  const disposables = [
    view,
    changed,
    view.onDidChangeVisibility((e) => e.visible && current && current.onShow()),
    // Each page twice: plain, and with ✓ for the "…" menu while it is the page on screen.
    ...[
      ['Accounts', 'accounts'],
      ['Memories', 'memories'],
      ['Credentials', 'credentials'],
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
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}

module.exports = { createSidebar };
