'use strict';

// Conversations in the same project: hooks in Claude Code's settings let every conversation
// tell the others in the same project what it is doing, so they don't get in each other's way.
// The hooks talk among themselves through ~/.claude-switcher/sessions/; this side only puts
// them in or takes them out, and counts the conversations for the menu.
const path = require('path');
const vscode = require('vscode');
const { syncPeerHook, findNode, settingsFile } = require('../core/claudeHook');
const { Sessions, projectRoot, keyOf, lookup, changedIn } = require('../hook/peer-hook');

function createSameProject(app) {
  const { paths, log } = app;
  const sessions = new Sessions(path.join(app.switcherDir, 'sessions'));
  const enabled = () => !!app.config().get('sameProject', true);
  let syncing = Promise.resolve();

  function syncClaudeHook() {
    syncing = syncing.then(async () => {
      const on = enabled();
      try {
        const changed = await syncPeerHook(paths, app.switcherDir, { enabled: on, nodePath: on ? findNode() : null });
        if (changed) log(`hooks de conversas no mesmo projeto ${on ? 'instalados em' : 'removidos de'} ${settingsFile(paths)}`);
      } catch (e) {
        log(`conversas no mesmo projeto: ${e.message}`);
        if (on) vscode.window.showWarningMessage(`Claude Switcher: não consegui ligar as conversas no mesmo projeto (${e.message}).`);
      }
    });
    return syncing;
  }

  async function toggle() {
    const on = !enabled();
    await app.config().update('sameProject', on, vscode.ConfigurationTarget.Global);
    await syncClaudeHook();
    vscode.window.showInformationMessage(
      on
        ? 'Conversas no mesmo projeto ligado. Duas conversas do Claude Code no mesmo projeto passam a saber o que a outra está fazendo, e uma não leva nem apaga as mudanças da outra no git. Vale a partir da próxima mensagem de cada conversa.'
        : 'Conversas no mesmo projeto desligado.',
    );
  }

  // How many conversations changed files in the project open in this window, lately.
  function countHere() {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) return 0;
    try {
      const repo = keyOf(projectRoot(folder));
      const look = lookup();
      return sessions.peers(null).filter((p) => changedIn(p, repo, look)).length;
    } catch {
      return 0;
    }
  }

  syncClaudeHook();

  return { toggle, enabled, countHere, onConfigChanged: syncClaudeHook, dispose() {} };
}

module.exports = { createSameProject };
