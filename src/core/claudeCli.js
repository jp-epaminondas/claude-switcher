'use strict';

// One-shot question to Claude Code in print mode, answered as JSON that follows `schema`.
// It runs on whatever account is logged in, like any other Claude Code session. No tools, no
// saved session, and only project settings (none in `cwd`), so the user's hooks don't fire.
const { spawn } = require('child_process');

// `effort` (low…max) bounds how long the model thinks before answering; left out, the CLI's default.
function runClaude({ exe, cwd, prompt, system, schema, model = 'haiku', effort = null, timeoutMs = 5 * 60 * 1000 }) {
  const args = [
    '-p',
    '--model', model,
    ...(effort ? ['--effort', effort] : []),
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
    '--system-prompt', system,
    '--tools', '',
    '--no-session-persistence',
    '--setting-sources', 'project',
  ];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(notFound(e, exe));
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`o Claude não respondeu em ${Math.round(timeoutMs / 60000)} min`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(notFound(e, exe));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let out = null;
      try {
        out = JSON.parse(stdout.trim());
      } catch {}
      if (out && !out.is_error && out.structured_output) return resolve(out.structured_output);
      const why = (out && (out.result || out.subtype)) || stderr.trim().split(/\r?\n/).pop() || `saiu com código ${code}`;
      reject(new Error(`o Claude não conseguiu responder: ${String(why).slice(0, 300)}`));
    });
    child.stdin.on('error', () => {}); // a process that died early closes stdin; the close handler reports it
    child.stdin.end(prompt);
  });
}

const notFound = (e, exe) => (e.code === 'ENOENT' ? new Error(`não achei o Claude Code (${exe})`) : e);

module.exports = { runClaude };
