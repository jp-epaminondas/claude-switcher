'use strict';

// Topic guard: a UserPromptSubmit hook in Claude Code's settings asks this side about every
// prompt. In a conversation whose context is past topicGuardMinContextK, a prompt that starts
// a new subject is held back and sent in a new conversation instead.
const { execFile } = require('child_process');
const vscode = require('vscode');
const { LimitQueue } = require('../core/limitQueue');
const { syncTopicHook, findNode, settingsFile } = require('../core/claudeHook');
const { readConversation, quickVerdict, classification, blockReason, fmtK, TopicState } = require('../core/topic');

const POLL_MS = 250;
const HEARTBEAT_MS = 15 * 1000;
const CLASSIFY_MS = 25 * 1000; // the hook waits 30s
const SEND_FIRST_MS = 1500; // the new conversation takes a moment to show the prompt
const SEND_EVERY_MS = 1500;
const SEND_TRIES = 8;

const normalize = (s) => String(s).trim().replace(/\s+/g, ' ');

const activeTab = () => vscode.window.tabGroups.activeTabGroup.activeTab;
const isClaudePanel = (tab) => tab?.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('claudeVSCodePanel');

// Presses Enter in whatever has the keyboard: there is no command that sends a prompt.
function pressEnter() {
  const run =
    process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "(New-Object -ComObject WScript.Shell).SendKeys('~')"]]
      : process.platform === 'darwin'
        ? ['osascript', ['-e', 'tell application "System Events" to key code 36']]
        : ['xdotool', ['key', 'Return']];
  return new Promise((resolve, reject) => {
    execFile(run[0], run[1], { windowsHide: true, timeout: 10 * 1000 }, (e) => (e ? reject(e) : resolve()));
  });
}

function createTopicGuard(app) {
  const { paths, log } = app;
  const queue = new LimitQueue(app.switcherDir, 'topics');
  const state = new TopicState(queue.dir);
  const enabled = () => !!app.config().get('topicGuard', true);
  const minTokens = () => Math.max(20, Number(app.config().get('topicGuardMinContextK')) || 150) * 1000;
  const pending = new Set(); // prompts being sent in a new conversation
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
        ? `Aviso de assunto novo ligado. Numa conversa com mais de ${fmtK(minTokens())} tokens de contexto, um pedido de outro assunto vai para uma conversa nova.`
        : 'Aviso de assunto novo desligado.',
    );
  }

  function poll() {
    if (!enabled() || !app.access.open()) return;
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
    arrived(req);
    let verdict = { block: false };
    try {
      verdict = await judge(req);
    } catch (e) {
      log(`aviso de assunto novo: ${e.message}`);
    }
    await queue.answer(id, verdict.block ? { block: true, reason: verdict.reason } : { block: false }).catch((e) => log(`aviso de assunto novo: ${e.message}`));
    if (verdict.block) moveToNewConversation(req, verdict).catch((e) => log(`aviso de assunto novo: ${e.message}`));
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

  // Opens a new conversation with the prompt and sends it. Claude Code only types an initial
  // prompt in, so Enter is pressed for it until the new conversation's hook reports the prompt.
  async function moveToNewConversation(req, { conv, subject }) {
    const from = `Assunto novo (${subject}) numa conversa que já tem ${fmtK(conv.contextTokens)} tokens de contexto`;
    const before = activeTab();
    try {
      // (sessionId, initialPrompt): no session id opens a new conversation with the prompt typed in.
      await vscode.commands.executeCommand('claude-vscode.editor.open', undefined, req.prompt);
    } catch (e) {
      log(`aviso de assunto novo: não abri a conversa nova (${e.message})`);
      await vscode.env.clipboard.writeText(req.prompt);
      vscode.window.showWarningMessage(`${from}. Não consegui abrir uma conversa nova. O pedido foi copiado: abra uma conversa e cole.`);
      return;
    }
    // The new conversation's tab, never the old one: its input may hold the prompt again.
    const tab = activeTab();
    const sent = tab !== before && isClaudePanel(tab) && (await sendTyped(req, tab));
    log(`sessão ${req.sessionId}: pedido ${sent ? 'enviado' : 'digitado'} numa conversa nova`);
    vscode.window.showInformationMessage(
      sent
        ? `${from}: mandei o pedido para uma conversa nova. Para mantê-lo na anterior, envie o mesmo pedido de novo lá.`
        : `${from}: abri uma conversa nova com o pedido digitado. Aperte Enter nela para enviar.`,
    );
  }

  function sendTyped(req, tab) {
    return new Promise((resolve) => {
      let tries = 0;
      let timer;
      const p = { prompt: normalize(req.prompt), from: req.sessionId };
      p.done = (ok) => {
        clearTimeout(timer);
        pending.delete(p);
        resolve(ok);
      };
      const step = () => {
        if (tries++ >= SEND_TRIES) return p.done(false);
        // Only into the new conversation's input: Enter anywhere else would land in a file.
        // An Enter too early finds the input empty and does nothing.
        if (vscode.window.state.focused && activeTab() === tab) pressEnter().catch((e) => log(`aviso de assunto novo: Enter (${e.message})`));
        timer = setTimeout(step, SEND_EVERY_MS);
      };
      pending.add(p);
      timer = setTimeout(step, SEND_FIRST_MS);
    });
  }

  // A prompt from another conversation that one of the pending sends is waiting for.
  function arrived(req) {
    const p = [...pending].find((x) => x.from !== req.sessionId && x.prompt === normalize(req.prompt));
    if (p) p.done(true);
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
