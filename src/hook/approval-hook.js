'use strict';

// Claude Code runs this when a tool call needs the user's permission. In the VS Code extension
// the permission dialog shows in the conversation's tab at the same time, and whichever answers
// first wins: that dialog, or the Aprovações panel of the Claude Switcher in any VS Code window.
// The hook drops "<id>.req" in approvals/ and waits for "<id>.res". It stops waiting, with no
// decision, when the tool's result shows up in the transcript (answered in the tab), when the
// conversation moves on, when the extension takes the request away, or after WAIT_MS.
// In the terminal the dialog only shows once this hook is done, so there it does nothing.
//
// The extension copies this file next to accounts.json, so it must not require anything else.
const fs = require('fs');
const path = require('path');

const WAIT_MS = 59 * 60 * 1000; // under the hook's 3600s timeout
const ALIVE_MS = 60 * 1000; // a listening window touches .alive more often than this
const POLL_MS = 200;
const TRANSCRIPT_EVERY_MS = 1000;
const TAIL_BYTES = 512 * 1024;
const TEXT_MAX = 4000; // per string in the request: it is only shown
const SAID_MAX = 600;
const PROMPT_MAX = 300;

// Tools whose dialog the panel can answer only with the tool's own input sent back.
const NEEDS_INPUT = new Set(['ExitPlanMode']);
// Tools the panel only points to: the answer has to be typed in the tab.
const ANSWER_IN_TAB = new Set(['AskUserQuestion']);

// Conversations of the VS Code extension (and Claude Desktop), where the dialog shows alongside.
const hosted = (env = process.env) => /^claude-(vscode|desktop)$/.test(env.CLAUDE_CODE_ENTRYPOINT || '');

function listening(dir) {
  try {
    return Date.now() - fs.statSync(path.join(dir, '.alive')).mtimeMs < ALIVE_MS;
  } catch {
    return false;
  }
}

// --- the transcript: what the conversation is about, and whether the call got an answer ---

function readFrom(file, start, end) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function entries(text, cutStart) {
  const lines = text.split('\n');
  if (cutStart) lines.shift();
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

const blocks = (o) => (o.message && Array.isArray(o.message.content) ? o.message.content : []);

// What the user typed, or null for tool results, reminders and other entries Claude Code adds.
function promptOf(o) {
  if (o.type !== 'user' || !o.message || o.isMeta || o.isCompactSummary || o.isSidechain || o.toolUseResult) return null;
  const c = o.message.content;
  const parts = typeof c === 'string' ? [c] : blocks(o).filter((b) => b.type === 'text').map((b) => b.text);
  const text = parts
    .map((t) => String(t).trim())
    .filter((t) => t && !t.startsWith('<') && !/^\[Request interrupted/.test(t))
    .join('\n');
  return text || null;
}

// The field that tells two calls of the same tool apart.
const keyField = (input) => {
  if (!input || typeof input !== 'object') return '';
  const v = input.command ?? input.file_path ?? input.notebook_path ?? input.url ?? input.pattern ?? input.query;
  return typeof v === 'string' ? v : JSON.stringify(input);
};
const sameCall = (block, hook) => block.name === hook.tool_name && keyField(block.input) === keyField(hook.tool_input);

const short = (text, max) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

// Follows the transcript from where the request was made.
class Transcript {
  constructor(file, hook) {
    this.file = file;
    this.hook = hook;
    this.offset = 0;
    this.useId = null; // the tool_use this request is about, once it is in the file
    this.answered = new Set(); // tool_use ids that already have a result
    this.title = null;
    this.prompt = null;
    this.said = null;
  }

  // The end of the file: title, last prompt, what the model said before the call.
  start() {
    let size;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return this;
    }
    const from = Math.max(0, size - TAIL_BYTES);
    this.offset = size;
    this.read(entries(readFrom(this.file, from, size), from > 0), true);
    return this;
  }

  read(list, first) {
    let moved = false;
    for (const o of list) {
      if (o.type === 'ai-title' && o.aiTitle) this.title = o.aiTitle;
      else if (o.type === 'custom-title' && o.customTitle) this.title = o.customTitle;
      if (o.isSidechain) continue;
      const p = promptOf(o);
      if (p) {
        this.prompt = p;
        this.said = null;
        if (!first) moved = true; // a new prompt: the call is over
      }
      for (const b of blocks(o)) {
        if (o.type === 'assistant' && b.type === 'text' && b.text.trim()) this.said = b.text;
        if (o.type === 'assistant' && b.type === 'tool_use' && sameCall(b, this.hook) && !this.answered.has(b.id)) this.useId = b.id;
        if (b.type === 'tool_result') {
          this.answered.add(b.tool_use_id);
          if (b.tool_use_id === this.useId) {
            if (first) this.useId = null; // an earlier call with the same input
            else moved = true;
          }
        }
      }
    }
    return moved;
  }

  // True once the call got its answer some other way, or the conversation moved past it.
  over() {
    let size;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return false;
    }
    if (size <= this.offset) return false;
    const text = readFrom(this.file, this.offset, size);
    const end = text.lastIndexOf('\n') + 1; // a line still being written waits for next time
    if (!end) return false;
    this.offset += Buffer.byteLength(text.slice(0, end));
    return this.read(entries(text.slice(0, end), false), false);
  }
}

// --- the request ---

// The git repository the folder is in, or the folder itself.
function projectRoot(cwd) {
  const start = path.resolve(cwd);
  for (let d = start; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return start;
  }
}

// Long strings cut short: the request is only for showing.
function trim(v, depth = 0) {
  if (typeof v === 'string') return v.length > TEXT_MAX ? `${v.slice(0, TEXT_MAX)}…` : v;
  if (Array.isArray(v)) return depth > 4 ? '[…]' : v.slice(0, 50).map((x) => trim(x, depth + 1));
  if (v && typeof v === 'object') {
    if (depth > 4) return '{…}';
    const out = {};
    for (const k of Object.keys(v).slice(0, 50)) out[k] = trim(v[k], depth + 1);
    return out;
  }
  return v;
}

function request(hook, transcript, env = process.env, now = Date.now()) {
  return {
    id: `${now}-${process.pid}`,
    at: now,
    pid: process.pid,
    window: typeof env.CLAUDE_SWITCHER_WINDOW === 'string' ? env.CLAUDE_SWITCHER_WINDOW : null,
    session: hook.session_id || null,
    cwd: hook.cwd || null,
    root: hook.cwd ? projectRoot(hook.cwd) : null,
    mode: hook.permission_mode || null,
    tool: hook.tool_name,
    input: trim(hook.tool_input || {}),
    mcp: hook.mcp_server ? trim(hook.mcp_server) : null,
    suggestions: Array.isArray(hook.permission_suggestions) ? trim(hook.permission_suggestions) : [],
    answerInTab: ANSWER_IN_TAB.has(hook.tool_name),
    title: transcript.title ? short(transcript.title, 120) : null,
    prompt: transcript.prompt ? short(transcript.prompt, PROMPT_MAX) : null,
    said: transcript.said ? short(transcript.said, SAID_MAX) : null,
  };
}

// The answer from the panel, as Claude Code wants it. Only what the hook itself was given goes
// back to Claude Code: a rule to keep comes from its own suggestions, picked by position.
function decisionOf(answer, hook) {
  if (!answer || typeof answer !== 'object') return null;
  const out = (decision, extra = {}) => ({ ...extra, hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
  if (answer.behavior === 'allow') {
    if (ANSWER_IN_TAB.has(hook.tool_name)) return null;
    const decision = { behavior: 'allow' };
    if (NEEDS_INPUT.has(hook.tool_name)) decision.updatedInput = hook.tool_input;
    const all = Array.isArray(hook.permission_suggestions) ? hook.permission_suggestions : [];
    if (Number.isInteger(answer.suggestion) && all[answer.suggestion]) decision.updatedPermissions = [all[answer.suggestion]];
    return out(decision);
  }
  if (answer.behavior === 'deny') {
    const said = typeof answer.message === 'string' ? answer.message.trim().slice(0, 2000) : '';
    const decision = {
      behavior: 'deny',
      message: said ? `O usuário negou pelo painel Aprovações do Claude Switcher e disse: ${said}` : 'O usuário negou pelo painel Aprovações do Claude Switcher.',
    };
    if (answer.interrupt === true) decision.interrupt = true;
    return out(decision, { systemMessage: `Claude Switcher: ${answer.interrupt === true ? 'negado e parado' : 'negado'} no painel Aprovações.` });
  }
  return null;
}

// Drops the request and waits. Resolves with the output for Claude Code, or null for none.
function ask(hook, dir, { env = process.env, waitMs = WAIT_MS } = {}) {
  const transcript = new Transcript(hook.transcript_path || '', hook);
  if (hook.transcript_path) transcript.start();
  const req = request(hook, transcript, env);
  const reqFile = path.join(dir, `${req.id}.req`);
  const resFile = path.join(dir, `${req.id}.res`);
  fs.mkdirSync(dir, { recursive: true });
  // Written aside and renamed, so the extension never reads half a request.
  fs.writeFileSync(`${reqFile}.tmp`, JSON.stringify(req));
  fs.renameSync(`${reqFile}.tmp`, reqFile);

  return new Promise((resolve) => {
    const started = Date.now();
    let checkedAt = started;
    const done = (out) => {
      clearInterval(timer);
      for (const f of [reqFile, resFile]) {
        try {
          fs.unlinkSync(f);
        } catch {}
      }
      resolve(out);
    };
    const timer = setInterval(() => {
      let answer = null;
      try {
        answer = JSON.parse(fs.readFileSync(resFile, 'utf8'));
      } catch {}
      if (answer) return done(decisionOf(answer, hook));
      if (!fs.existsSync(reqFile)) return done(null); // the extension took it away
      const now = Date.now();
      if (now - started > waitMs) return done(null);
      if (hook.transcript_path && now - checkedAt >= TRANSCRIPT_EVERY_MS) {
        checkedAt = now;
        try {
          if (transcript.over()) done(null);
        } catch {}
      }
    }, POLL_MS);
  });
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => (input += chunk));
  process.stdin.on('end', async () => {
    let hook = {};
    try {
      hook = JSON.parse(input);
    } catch {}
    const dir = path.join(__dirname, 'approvals');
    if (hook.hook_event_name !== 'PermissionRequest' || typeof hook.tool_name !== 'string') return;
    if (!hosted() || !listening(dir)) return;
    try {
      const out = await ask(hook, dir);
      if (out) process.stdout.write(JSON.stringify(out));
    } catch {}
  });
}

module.exports = { ask, request, decisionOf, Transcript, hosted, listening, keyField };
