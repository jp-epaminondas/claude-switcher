'use strict';

// Side bar page "Travas": what Claude Code's auto mode won't do until the user asks for it in
// so many words, released or locked again by a checkbox. The state is read back from
// ~/.claude/settings.json each time (see core/locks.js), so every window shows the same.
const vscode = require('vscode');
const { LOCKS, released, setReleased, entryOf } = require('../core/locks');
const { readSettings, updateSettings, settingsFile } = require('../core/claudeHook');

const { None } = vscode.TreeItemCollapsibleState;
const { Checked, Unchecked } = vscode.TreeItemCheckboxState;

function createLocksView(app, sidebar) {
  const { paths, log } = app;
  let open = new Set(); // ids released, as shown
  let checking = Promise.resolve(); // one confirmation at a time

  const page = sidebar.page('locks', 'Travas', {
    getChildren() {
      try {
        open = new Set(released(readSettings(paths).settings));
      } catch (e) {
        return [new vscode.TreeItem(e.message)];
      }
      page.decorate({ description: open.size ? `${open.size} ${open.size === 1 ? 'liberada' : 'liberadas'}` : '' });
      return [intro(paths), ...LOCKS.map((l) => row(l, open.has(l.id)))];
    },
    onShow: () => page.refresh(),
    onCheck(items) {
      for (const [item, state] of items) if (item.lockId) checking = checking.then(() => set(item.lockId, state === Checked));
    },
  });

  async function set(id, on) {
    const lock = LOCKS.find((l) => l.id === id);
    if (!lock || open.has(id) === on) return page.refresh();
    if (on) {
      const ok = await vscode.window.showWarningMessage(
        `Liberar no modo automático: ${lock.label}?`,
        {
          modal: true,
          detail: `O modo automático passa a ${lock.what}, em todas as conversas. Nos outros modos o Claude continua pedindo aprovação.\n\nVai para autoMode.allow em ${settingsFile(paths)}. Para travar de novo, desmarque aqui.`,
        },
        'Liberar',
      );
      if (ok !== 'Liberar') return page.refresh(); // the checkbox goes back
    }
    try {
      // Read again inside the write: another window may have changed the others meanwhile.
      await updateSettings(paths, (s) => {
        const ids = new Set(released(s));
        if (on) ids.add(id);
        else ids.delete(id);
        setReleased(s, ids);
      });
      log(`trava ${id} ${on ? 'liberada' : 'travada'} em ${settingsFile(paths)}`);
    } catch (e) {
      log(`travas: ${e.stack || e.message}`);
      vscode.window.showErrorMessage(`Claude Switcher: não consegui ${on ? 'liberar' : 'travar'} ${lock.label} (${e.message}).`);
    }
    page.refresh();
  }

  // A newer wording of a released lock replaces the old one in settings.json.
  updateSettings(paths, (s) => setReleased(s, new Set(released(s))))
    .then((changed) => changed && log(`travas: texto das liberações atualizado em ${settingsFile(paths)}`))
    .catch((e) => log(`travas: ${e.message}`));

  return { dispose() {} };
}

function intro(paths) {
  const item = new vscode.TreeItem('Só valem no modo automático', None);
  item.id = 'lock:intro';
  item.iconPath = new vscode.ThemeIcon('info');
  item.tooltip =
    'No modo automático, o Claude Code segura estas ações até você pedir com todas as letras na mensagem. ' +
    'Liberada aqui, a ação passa sem isso, em todas as conversas. ' +
    `Nos outros modos (editar, plano, normal) o Claude continua pedindo aprovação como antes. Fica em autoMode.allow, no ${settingsFile(paths)}.`;
  return item;
}

function row(lock, on) {
  const item = new vscode.TreeItem(lock.label, None);
  item.id = `lock:${lock.id}`;
  item.lockId = lock.id;
  item.description = on ? 'liberado' : 'travado';
  item.iconPath = on ? new vscode.ThemeIcon('unlock', new vscode.ThemeColor('list.warningForeground')) : new vscode.ThemeIcon('lock');
  item.checkboxState = { state: on ? Checked : Unchecked, tooltip: on ? 'Travar de novo' : 'Liberar no modo automático' };
  const tip = new vscode.MarkdownString();
  tip.appendMarkdown(`**${lock.label}** · ${on ? 'liberado' : 'travado'}\n\n`);
  tip.appendText(`Liberado, o modo automático passa a ${lock.what}.\n\nO que vai para autoMode.allow:\n\n${entryOf(lock)}`);
  item.tooltip = tip;
  return item;
}

module.exports = { createLocksView };
