'use strict';

// Topic guard: before a prompt goes into a long conversation, tells whether it starts a new
// subject. Every reply re-reads the whole context, so in a long conversation that is where most
// tokens go, and a new subject costs much less in a new conversation.
const fs = require('fs');
const path = require('path');

const HEAD_BYTES = 256 * 1024; // the first prompt
const TAIL_BYTES = 2 * 1024 * 1024; // the latest prompts and the size of the context
const RECENT = 8;
const SHORT_PROMPT = 25; // "sim", "pode fazer", "continue": always about what came before

// What the guard needs from a transcript (.jsonl), without reading all of it: a long
// conversation's file runs into tens of MB.
function readConversation(file) {
  const size = fs.statSync(file).size;
  const head = entriesOf(readSlice(file, 0, Math.min(size, HEAD_BYTES)), false, size > HEAD_BYTES);
  const tail = size > HEAD_BYTES ? entriesOf(readSlice(file, Math.max(0, size - TAIL_BYTES), Math.min(size, TAIL_BYTES)), size > TAIL_BYTES, false) : head;

  let contextTokens = 0;
  let lastReply = '';
  const recent = [];
  for (const o of tail) {
    if (o.isSidechain) continue;
    const m = o.message;
    if (o.type === 'assistant' && m) {
      const u = m.usage;
      if (u) contextTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      const text = (Array.isArray(m.content) ? m.content : []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      if (text) lastReply = text;
    }
    const p = promptOf(o);
    if (p) recent.push(p);
  }
  const first = head.map(promptOf).find(Boolean) || null;
  return { contextTokens, first, recent: recent.slice(-RECENT), lastReply };
}

function readSlice(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

// One JSON object per line. A slice can start or end in the middle of one.
function entriesOf(text, cutStart, cutEnd) {
  const lines = text.split('\n');
  if (cutStart) lines.shift();
  if (cutEnd) lines.pop();
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

// What the user typed, or null for tool results, reminders and other entries Claude Code adds.
function promptOf(o) {
  if (o.type !== 'user' || !o.message || o.isMeta || o.isCompactSummary || o.isSidechain || o.toolUseResult) return null;
  const c = o.message.content;
  const parts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text) : [];
  const text = parts
    .map((t) => String(t).trim())
    .filter((t) => t && !t.startsWith('<') && !/^\[Request interrupted/.test(t))
    .join('\n');
  return text || null;
}

const normalize = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();

// Decides without asking anyone, when it can. 'ask' means only the model can tell.
function quickVerdict({ prompt, conv, minTokens, state = {} }) {
  const p = String(prompt || '').trim();
  if (!p || p.startsWith('/')) return 'allow';
  if (conv.contextTokens < minTokens) return 'allow';
  if (state.blocked && normalize(state.blocked) === normalize(p)) return 'insisted';
  if (state.mutedAt != null && conv.contextTokens < state.mutedAt + minTokens) return 'allow';
  if (p.length < SHORT_PROMPT || !conv.recent.length) return 'allow';
  return 'ask';
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

const SYSTEM = [
  'Você decide se um novo pedido do usuário continua a conversa que ele já tem com um assistente de programação ou começa um assunto novo e independente.',
  'Continua: depende do que foi feito ou discutido. Ajustes, correções, o próximo passo, perguntas sobre o resultado e referências como "isso", "aquele botão" ou "agora faz o mesmo em".',
  'Novo: outra tarefa, que daria para fazer numa conversa limpa sem perder nada importante, mesmo sendo no mesmo projeto.',
  'Na dúvida, responda que continua. Em "assunto", dê um nome curto (até 6 palavras, em português) para o assunto do novo pedido.',
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: { novo: { type: 'boolean' }, assunto: { type: 'string' } },
  required: ['novo', 'assunto'],
  additionalProperties: false,
};

// The question for the model: the conversation in a few lines, then the new prompt.
function classification(conv, prompt) {
  const lines = ['Conversa até agora (só os pedidos do usuário):'];
  if (conv.first && !conv.recent.includes(conv.first)) lines.push(`- (primeiro) ${clip(conv.first, 400)}`, '- …');
  for (const p of conv.recent) lines.push(`- ${clip(p, 400)}`);
  if (conv.lastReply) lines.push('', `Última resposta do assistente: ${clip(conv.lastReply, 600)}`);
  lines.push('', `Novo pedido: ${clip(String(prompt).trim(), 1500)}`);
  return { system: SYSTEM, schema: SCHEMA, prompt: lines.join('\n') };
}

const fmtK = (tokens) => `${Math.round(tokens / 1000)}k`;

// What Claude Code shows in place of the blocked prompt.
function blockReason(conv, subject) {
  const what = subject ? `um assunto novo (${subject})` : 'um assunto novo';
  return (
    `Claude Switcher: isto parece ${what}, e esta conversa já carrega ${fmtK(conv.contextTokens)} tokens de contexto, relidos a cada resposta. ` +
    'Abra uma conversa nova para ele: o aviso do switcher tem um botão que já leva o pedido. Para continuar aqui mesmo, envie o mesmo pedido de novo.'
  );
}

// What the guard remembers per conversation: the prompt it held back, and whether the user
// chose to stay (it then waits for the context to grow by minTokens before asking again).
class TopicState {
  constructor(dir) {
    this.dir = path.join(dir, 'sessions');
  }

  file(sessionId) {
    return /^[\w-]+$/.test(String(sessionId || '')) ? path.join(this.dir, `${sessionId}.json`) : null;
  }

  get(sessionId) {
    const file = this.file(sessionId);
    try {
      return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    } catch {
      return {};
    }
  }

  set(sessionId, state) {
    const file = this.file(sessionId);
    if (!file) return;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...state, at: Date.now() }));
  }
}

module.exports = { readConversation, promptOf, quickVerdict, classification, blockReason, fmtK, TopicState };
