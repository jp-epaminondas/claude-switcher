'use strict';

// What the buttons do: switch, add, rename, remove, plus the notifications that offer them.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { outStatus, fmtClock, fmtIn } = require('../core/usage');
const { reason, soonestBack } = require('../core/advisor');

function createActions(app) {
  const { store, sw, log } = app;

  const showAccounts = () => vscode.commands.executeCommand('claudeSwitcher.accounts.focus');

  async function doSwitch(id, prefix = '') {
    let result;
    try {
      result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Trocando conta do Claude…' },
        () => sw.switchTo(id),
      );
    } catch (e) {
      log(`troca falhou: ${e.stack || e.message}`);
      vscode.window.showErrorMessage(`Claude Switcher: não consegui trocar de conta (${e.message}).`);
      return;
    } finally {
      app.render();
    }
    const acc = result.account;
    if (result.needsLogin) {
      vscode.window
        .showWarningMessage(`${acc.label} (${acc.email}) precisa fazer login de novo.`, 'Fazer login')
        .then((choice) => choice && addAccount());
      return;
    }
    if (result.already) {
      vscode.window.showInformationMessage(`${acc.label} já é a conta em uso.`);
      return;
    }
    log(`trocado para ${acc.label} (${acc.email})`);
    vscode.window
      .showInformationMessage(
        `${prefix}Agora usando ${acc.label} (${acc.email}). O Claude Code passa a usar essa conta na próxima mensagem.`,
        'Recarregar janela',
      )
      .then((choice) => choice && vscode.commands.executeCommand('workbench.action.reloadWindow'));
    sw.refreshUsage({ force: true, only: [id] }).then(app.render, (e) => log(`uso após troca: ${e.message}`));
  }

  async function switchNext() {
    let data;
    try {
      data = store.load();
    } catch (e) {
      vscode.window.showErrorMessage(`Claude Switcher: ${e.message}`);
      return;
    }
    if (!data.accounts.length) return addAccount();
    const next = sw.pickNext(data);
    if (next) return doSwitch(next.id);
    const soon = soonestBack(data);
    const when = soon ? ` A primeira a voltar é ${soon.account.label}, ${fmtClock(soon.until)} (${fmtIn(soon.until)}).` : '';
    vscode.window
      .showWarningMessage(`Nenhuma outra conta disponível agora.${when}`, 'Ver contas')
      .then((choice) => choice && showAccounts());
  }

  async function addAccount() {
    try {
      await sw.syncLive(); // make sure the current account is saved before its tokens get replaced
    } catch (e) {
      log(`sync antes do login: ${e.message}`);
    }
    const choice = await vscode.window.showInformationMessage(
      'Adicionar outra conta do Claude',
      {
        modal: true,
        detail:
          'Vou abrir um terminal com "claude auth login". Faça login no navegador com a outra conta.\n\n' +
          'Quando o login terminar, o switcher salva a conta sozinho. A conta atual já está salva e continua na lista.\n\n' +
          'Para trocar de conta use sempre o switcher, nunca o Logout do Claude Code.',
      },
      'Abrir login',
    );
    if (choice !== 'Abrir login') return;
    sw.captureNext = true;
    const terminal = vscode.window.createTerminal({ name: 'Claude: login', shellPath: claudeExecutable(), shellArgs: ['auth', 'login'] });
    terminal.show();
  }

  async function pickAccount(acc) {
    const data = store.load();
    if (acc.id === data.activeId) {
      vscode.window.showInformationMessage(`${acc.label} já é a conta em uso.`);
      return;
    }
    if (acc.needsLogin) {
      const choice = await vscode.window.showWarningMessage(`${acc.label} (${acc.email}) precisa fazer login de novo.`, 'Fazer login');
      if (choice) addAccount();
      return;
    }
    const st = outStatus(acc.usage);
    if (st.out) {
      const until = st.until ? ` até ${fmtClock(st.until)}` : '';
      const choice = await vscode.window.showWarningMessage(`${acc.label} está esgotada${until}. Trocar mesmo assim?`, 'Trocar');
      if (!choice) return;
    }
    return doSwitch(acc.id);
  }

  async function renameAccount(acc) {
    const label = await vscode.window.showInputBox({
      title: 'Renomear conta',
      prompt: acc.email,
      value: acc.label,
      validateInput: (v) => (v.trim() ? null : 'Digite um nome'),
    });
    if (label) await sw.rename(acc.id, label.trim());
    app.render();
  }

  async function removeAccount(acc) {
    const ok = await vscode.window.showWarningMessage(
      `Remover ${acc.label} (${acc.email}) do switcher?`,
      { modal: true, detail: 'O login dessa conta deixa de ficar salvo aqui. Para trazê-la de volta, use "Adicionar conta".' },
      'Remover',
    );
    if (ok) await sw.remove(acc.id);
    app.render();
  }

  // Commands invoked from the side bar get a tree item; from code, an account id.
  function withAccount(arg, fn) {
    const id = typeof arg === 'string' ? arg : arg && arg.accountId;
    const acc = id && store.load().accounts.find((a) => a.id === id);
    return acc ? fn(acc) : undefined;
  }

  function onEvent(ev) {
    const data = store.load();
    const acc = data.accounts.find((a) => a.id === ev.id);
    if (!acc) return;
    if (ev.type === 'out' && ev.active) {
      onActiveOut(data, acc, ev.until);
    } else if (ev.type === 'burn' && app.config().get('notifyBurn', true)) {
      const x = app.advise(data, Date.now()).byId.get(acc.id);
      if (!x || !x.burn) return;
      vscode.window
        .showInformationMessage(`🔥 Use a ${acc.label} agora: ${reason(x)}.`, `Usar ${acc.label}`)
        .then((choice) => choice && doSwitch(acc.id));
    } else if (ev.type === 'back' && app.config().get('notifyWhenBack', true)) {
      if (ev.active) {
        vscode.window.showInformationMessage(`✅ ${acc.label} voltou: o limite zerou.`);
      } else {
        vscode.window
          .showInformationMessage(`✅ ${acc.label} voltou e já está disponível.`, `Usar ${acc.label}`)
          .then((choice) => choice && doSwitch(acc.id));
      }
    }
  }

  function onActiveOut(data, acc, until) {
    const back = until ? ` Volta ${fmtClock(until)} (${fmtIn(until)}).` : '';
    const next = sw.pickNext(data);
    if (!next) {
      vscode.window
        .showWarningMessage(`${acc.label} esgotou.${back} Nenhuma outra conta disponível agora.`, 'Ver contas')
        .then((choice) => choice && showAccounts());
      return;
    }
    if (app.config().get('autoSwitch', false)) {
      doSwitch(next.id, `${acc.label} esgotou. `);
      return;
    }
    vscode.window.showWarningMessage(`${acc.label} esgotou.${back}`, `Trocar para ${next.label}`, 'Ver contas').then((choice) => {
      if (choice === 'Ver contas') showAccounts();
      else if (choice) doSwitch(next.id);
    });
  }

  return { switchNext, addAccount, pickAccount, renameAccount, removeAccount, withAccount, onEvent };
}

// Prefer the binary bundled with the Claude Code extension: it is the one VS Code runs.
function claudeExecutable() {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  if (ext) {
    const bundled = path.join(ext.extensionPath, 'resources', 'native-binary', exe);
    if (fs.existsSync(bundled)) return bundled;
  }
  return exe;
}

module.exports = { createActions };
