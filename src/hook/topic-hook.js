'use strict';

// Claude Code runs this on UserPromptSubmit, before a prompt reaches the model. It asks the
// Claude Switcher extension whether the prompt starts a new subject in a conversation that is
// already long. If so it blocks the prompt with the reason, and the extension offers to open a
// new conversation with it. No window listening, or no answer in time: the prompt goes through.
//
// The extension copies this file next to accounts.json, so it must not require anything else.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'topics');
const WAIT_MS = 30 * 1000; // under the hook's 40s timeout
const ALIVE_MS = 60 * 1000; // a listening window touches .alive more often than this
const POLL_MS = 100;

function listening() {
  try {
    return Date.now() - fs.statSync(path.join(dir, '.alive')).mtimeMs < ALIVE_MS;
  } catch {
    return false;
  }
}

function ask(hook) {
  const id = `${Date.now()}-${process.pid}`;
  const req = path.join(dir, `${id}.req`);
  const res = path.join(dir, `${id}.res`);
  const body = { sessionId: hook.session_id || null, transcriptPath: hook.transcript_path || null, cwd: hook.cwd || null, prompt: hook.prompt, at: Date.now() };
  // Written aside and renamed, so the extension never reads half a request.
  fs.writeFileSync(`${req}.tmp`, JSON.stringify(body));
  fs.renameSync(`${req}.tmp`, req);

  const started = Date.now();
  const timer = setInterval(() => {
    let answer = null;
    try {
      answer = JSON.parse(fs.readFileSync(res, 'utf8'));
    } catch {}
    if (answer) {
      clearInterval(timer);
      try {
        fs.unlinkSync(res);
      } catch {}
      if (answer.block && answer.reason) process.stdout.write(JSON.stringify({ decision: 'block', reason: answer.reason }));
      return;
    }
    if (Date.now() - started > WAIT_MS) {
      clearInterval(timer);
      try {
        fs.unlinkSync(req);
      } catch {}
    }
  }, POLL_MS);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  let hook = {};
  try {
    hook = JSON.parse(input);
  } catch {}
  if (typeof hook.prompt !== 'string' || !hook.prompt.trim()) return;
  if (!listening()) return; // no VS Code window with the switcher open
  try {
    ask(hook);
  } catch {}
});
