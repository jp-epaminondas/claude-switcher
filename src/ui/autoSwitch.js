'use strict';

// Autoswitcher: when the account in use runs out, move to the next one and let Claude Code
// carry on by itself. Two hooks in Claude Code's settings report to this side: Stop at the
// end of every turn (switch between two messages once the account reaches switchAtPercent),
// and StopFailure the moment a turn stops on the limit (switch and tell the hook to resume).
const vscode = require('vscode');
const { LimitQueue } = require('../core/limitQueue');
const { syncHook, findNode, settingsFile } = require('../core/claudeHook');
const { fmtClock, fmtIn } = require('../core/usage');
const { soonestBack } = require('../core/advisor');

const POLL_MS = 1000;
const HEARTBEAT_MS = 15 * 1000;
const USAGE_FRESH_MS = 20 * 1000;

function createAutoSwitch(app) {
  const { paths, sw, store, log } = app;
  const queue = new LimitQueue(app.switcherDir);
  const enabled = () => !!app.config().get('autoSwitch', false);
  const switchAt = () => Math.min(100, Math.max(50, Number(app.config().get('switchAtPercent')) || 99));
  let hookProblem = null; // why sessions can't resume by themselves, while enabled
  let syncing = Promise.resolve();
  let polling = false;
  let lastBeat = 0;

  // Serialized: the toggle and the configuration event both land here.
  function syncClaudeHook() {
    syncing = syncing.then(async () => {
      const on = enabled();
      try {
        const changed = await syncHook(paths, app.switcherDir, { enabled: on, nodePath: on ? findNode() : null });
        if (changed) log(`hook do autoswitcher ${on ? 'instalado em' : 'removido de'} ${settingsFile(paths)}`);
        hookProblem = null;
      } catch (e) {
        hookProblem = on ? e.message : null;
        log(`hook do autoswitcher: ${e.message}`);
      }
      app.render();
    });
    return syncing;
  }

  async function toggle() {
    const on = !enabled();
    await app.config().update('autoSwitch', on, vscode.ConfigurationTarget.Global);
    await syncClaudeHook();
    if (!on) return;
    if (hookProblem) {
      vscode.window.showWarningMessage(
        `Autoswitcher ligado, mas o Claude não vai continuar sozinho: ${hookProblem}. A conta ainda troca sozinha; depois da troca, digite "continue".`,
      );
    } else {
      vscode.window.showInformationMessage('Autoswitcher ligado. Quando a conta em uso esgotar, o switcher troca para a próxima e o Claude continua sozinho.');
    }
  }

  async function poll() {
    if (polling || !enabled()) return;
    polling = true;
    try {
      if (Date.now() - lastBeat > HEARTBEAT_MS) {
        queue.heartbeat();
        lastBeat = Date.now();
      }
      for (const { id, req } of queue.take()) await handle(id, req);
      if (queue.takeTurns().length) await atTurnEnd();
    } catch (e) {
      log(`autoswitcher: ${e.stack || e.message}`);
    } finally {
      polling = false;
    }
  }

  async function handle(id, req) {
    let r;
    try {
      r = await sw.onLimit({ sessionId: req.sessionId, at: req.at });
    } catch (e) {
      log(`autoswitcher: troca falhou: ${e.stack || e.message}`);
      await queue.answer(id, { resume: false });
      vscode.window.showErrorMessage(`Claude Switcher: a conta esgotou e não consegui trocar (${e.message}).`);
      return;
    }
    await queue.answer(id, { resume: r.resume, message: r.resume ? resumeMessage(r) : undefined });
    app.render();
    const from = r.from ? r.from.label : 'A conta em uso';
    if (r.switched) {
      log(`limite atingido em ${from}: trocado para ${r.account.label} (${r.account.email}), sessão ${req.sessionId} continua`);
      vscode.window.showInformationMessage(`${from} esgotou. Agora usando ${r.account.label}; o Claude continua sozinho.`);
      const ids = [r.account.id, r.from && r.from.id].filter(Boolean);
      sw.refreshUsage({ force: true, only: ids }).then(app.render, (e) => log(`uso após troca: ${e.message}`));
    } else if (r.resume) {
      log(`limite atingido na sessão ${req.sessionId} logo depois de trocar para ${r.account.label}: continua nela`);
    } else if (r.reason === 'none') {
      const soon = soonestBack(store.load());
      const when = soon ? ` A primeira a voltar é ${soon.account.label}, ${fmtClock(soon.until)} (${fmtIn(soon.until)}).` : '';
      vscode.window
        .showWarningMessage(`${from} esgotou e nenhuma outra conta está disponível agora.${when}`, 'Ver contas')
        .then((choice) => choice && vscode.commands.executeCommand('claudeSwitcher.accounts.focus'));
    } else {
      log(`sessão ${req.sessionId} esgotou várias contas seguidas; parei de continuar sozinho`);
      vscode.window.showWarningMessage('Claude Switcher: a conversa bateu no limite em várias contas seguidas, então parei de continuar sozinho.');
    }
  }

  // A turn ended: with the account in use at the threshold, the next message already goes out
  // on another one. Usage is fetched fresh, at most every USAGE_FRESH_MS with many sessions.
  async function atTurnEnd() {
    const threshold = switchAt();
    if (threshold >= 100) return;
    const data = store.load();
    const active = data.accounts.find((a) => a.id === data.activeId);
    if (!active) return;
    if (Date.now() - ((active.usage && active.usage.fetchedAt) || 0) > USAGE_FRESH_MS) {
      await sw.refreshUsage({ force: true, only: [active.id] }).catch((e) => log(`uso no fim do turno: ${e.message}`));
    }
    const r = await sw.onTurnEnd({ threshold });
    if (!r) return;
    app.render();
    log(`${r.from.label} chegou a ${threshold}%: trocado para ${r.account.label} (${r.account.email}) entre duas mensagens`);
    vscode.window.showInformationMessage(`${r.from.label} chegou a ${threshold}% do limite. Agora usando ${r.account.label}; a próxima mensagem já vai por ela.`);
    sw.refreshUsage({ force: true, only: [r.account.id] }).then(app.render, (e) => log(`uso após troca: ${e.message}`));
  }

  const timer = setInterval(poll, POLL_MS);
  syncClaudeHook();

  return {
    toggle,
    enabled,
    threshold: switchAt,
    hookProblem: () => hookProblem,
    onConfigChanged: syncClaudeHook,
    dispose: () => clearInterval(timer),
  };
}

// What the model reads when Claude Code wakes it after the hook.
function resumeMessage(r) {
  const what = r.switched
    ? `o limite de uso da ${r.from ? r.from.label : 'conta anterior'} acabou e o Claude Switcher trocou para a ${r.account.label}`
    : `o Claude Switcher já trocou para a ${r.account.label}`;
  return `Não é um erro: ${what}. Continue a tarefa exatamente de onde parou.`;
}

module.exports = { createAutoSwitch };
