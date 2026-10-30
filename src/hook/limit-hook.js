'use strict';

// Claude Code runs this on two hooks:
// - StopFailure (matcher "rate_limit", asyncRewake): a turn stopped on the usage limit. It
//   asks the Claude Switcher extension to move to the next account and waits for the answer.
//   Exit code 2 makes Claude Code wake the model with stderr as a new message, so the task
//   carries on; exit 0 leaves the session stopped.
// - Stop (async): a turn ended normally. It only tells the extension, which can switch
//   accounts between two messages when the one in use is almost full.
//
// The extension copies this file next to accounts.json, so it must not require anything else.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'limits');
const WAIT_MS = 90 * 1000; // under the hook's 120s timeout
const ALIVE_MS = 60 * 1000; // a listening window touches .alive more often than this
const POLL_MS = 250;

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
  // Written aside and renamed, so the extension never reads half a request.
  fs.writeFileSync(`${req}.tmp`, JSON.stringify({ sessionId: hook.session_id || null, error: hook.error || null, at: Date.now() }));
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
      if (answer.resume && answer.message) {
        process.stderr.write(answer.message);
        process.exitCode = 2;
      }
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

function turnEnded(hook) {
  const file = path.join(dir, `${Date.now()}-${process.pid}.turn`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ sessionId: hook.session_id || null, at: Date.now() }));
  fs.renameSync(`${file}.tmp`, file);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  let hook = {};
  try {
    hook = JSON.parse(input);
  } catch {}
  if (hook.error && hook.error !== 'rate_limit') return;
  if (!listening()) return; // no VS Code window with the switcher open
  try {
    if (hook.hook_event_name === 'Stop') turnEnded(hook);
    else ask(hook);
  } catch {}
});
