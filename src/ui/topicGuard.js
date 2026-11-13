'use strict';

// Topic guard: a UserPromptSubmit hook in Claude Code's settings asks this side about every
// prompt. In a conversation whose context is past topicGuardMinContextK, a prompt that starts
// a new subject is held back, and a notice offers to open a new conversation with it.
const vscode = require('vscode');
const { LimitQueue } = require('../core/limitQueue');
const { syncTopicHook, findNode, settingsFile } = require('../core/claudeHook');
const { readConversation, quickVerdict, classification, blockReason, fmtK, TopicState } = require('../core/topic');

const POLL_MS = 250;
const HEARTBEAT_MS = 15 * 1000;
const CLASSIFY_MS = 25 * 1000; // the hook waits 30s

function createTopicGuard(app) {
  const { paths, log } = app;
  const queue = new LimitQueue(app.switcherDir, 'topics');
  const state = new TopicState(queue.dir);
  const enabled = () => !!app.config().get('topicGuard', true);
  const minTokens = () => Math.max(20, Number(app.config().get('topicGuardMinContextK')) || 150) * 1000;
  let syncing = Promise.resolve();
  let lastBeat = 0;

  function syncClaudeHook() {
    syncing = syncing.then(async () => {
      const on = enabled();
      try {
        const changed = await syncTopicHook(paths, app.switcherDir, { enabled: on, nodePath: on ? findNode() : null });
        if (changed) log(`hook do aviso de assunto novo ${on ? 'instalado em' : 'removido de'} ${settingsFile(paths)}`);
      } catch (e) {
        log(`hook do aviso de assunto novo: ${e.message}`);
        if (on) vscode.window.showWarningMessage(`Claude Switcher: não consegui ligar o aviso de assunto novo (${e.message}).`);
      }
    });
    return syncing;
  }

  async function toggle() {
    const on = !enabled();
    await app.config().update('topicGuard', on, vscode.ConfigurationTarget.Global);
    await syncClaudeHook();
    vscode.window.showInformationMessage(
      on
        ? `Aviso de assunto novo ligado. Numa conversa com mais de ${fmtK(minTokens())} tokens de contexto, um pedido de outro assunto é segurado e o switcher oferece uma conversa nova.`
        : 'Aviso de assunto novo desligado.',
    );
  }

  function poll() {
    if (!enabled()) return;
    try {
      if (Date.now() - lastBeat > HEARTBEAT_MS) {
        queue.heartbeat();
        lastBeat = Date.now();
      }
      // Each one on its own: a question to the model must not hold up other conversations.
      for (const { id, req } of queue.take()) handle(id, req);
    } catch (e) {
      log(`aviso de assunto novo: ${e.stack || e.message}`);
    }
  }

  async function handle(id, req) {
    let verdict = { block: false };
    try {
      verdict = await judge(req);
    } catch (e) {
      log(`aviso de assunto novo: ${e.message}`);
    }
    await queue.answer(id, verdict.block ? { block: true, reason: verdict.reason } : { block: false }).catch((e) => log(`aviso de assunto novo: ${e.message}`));
    if (verdict.block) offer(req, verdict);
  }

  async function judge(req) {
    if (!req.transcriptPath) return { block: false };
    let conv;
    try {
      conv = readConversation(req.transcriptPath);
    } catch {
      return { block: false }; // a brand new conversation has no transcript yet
    }
    const remembered = state.get(req.sessionId);
    const quick = quickVerdict({ prompt: req.prompt, conv, minTokens: minTokens(), state: remembered });
    if (quick === 'insisted') {
      state.set(req.sessionId, { mutedAt: conv.contextTokens });
      log(`sessão ${req.sessionId}: pedido reenviado, continua na conversa de ${fmtK(conv.contextTokens)}`);
    }
    if (quick !== 'ask') return { block: false };

    const started = Date.now();
    const answer = await app.askClaude({ ...classification(conv, req.prompt), timeoutMs: CLASSIFY_MS });
    log(`sessão ${req.sessionId} (${fmtK(conv.contextTokens)}): ${answer.novo ? `assunto novo, ${answer.assunto}` : 'mesmo assunto'} em ${Date.now() - started} ms`);
    if (!answer.novo) return { block: false };
    state.set(req.sessionId, { ...remembered, blocked: req.prompt });
    return { block: true, reason: blockReason(conv, answer.assunto), conv, subject: answer.assunto };
  }

  async function offer(req, { conv, subject }) {
    const open = 'Abrir nova conversa';
    const stay = 'Continuar nesta';
    const choice = await vscode.window.showWarningMessage(
      `Assunto novo (${subject}) numa conversa que já tem ${fmtK(conv.contextTokens)} tokens de contexto, relidos a cada resposta. O pedido não foi enviado.`,
      open,
      stay,
    );
    if (choice === open) {
      await vscode.env.clipboard.writeText(req.prompt);
      try {
        // (sessionId, initialPrompt): no session id opens a new conversation with the prompt typed in.
        await vscode.commands.executeCommand('claude-vscode.editor.open', undefined, req.prompt);
      } catch (e) {
        log(`aviso de assunto novo: não abri a conversa nova (${e.message})`);
        vscode.window.showInformationMessage('Não consegui abrir uma conversa nova. O pedido foi copiado: abra uma conversa e cole.');
      }
    } else if (choice === stay) {
      state.set(req.sessionId, { mutedAt: conv.contextTokens });
      await vscode.env.clipboard.writeText(req.prompt);
      vscode.window.showInformationMessage('Pedido copiado. Cole e envie de novo nessa conversa; o switcher não pergunta mais até ela crescer bastante.');
    }
  }

  const timer = setInterval(poll, POLL_MS);
  syncClaudeHook();

  return {
    toggle,
    enabled,
    onConfigChanged: syncClaudeHook,
    dispose: () => clearInterval(timer),
  };
}

module.exports = { createTopicGuard };
