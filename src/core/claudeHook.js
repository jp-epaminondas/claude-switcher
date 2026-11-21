'use strict';

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./fsutil');

const LIMIT_SCRIPT = 'limit-hook.js';
const TOPIC_SCRIPT = 'topic-hook.js';
const PEER_SCRIPT = 'peer-hook.js';
const APPROVAL_SCRIPT = 'approval-hook.js';

const settingsFile = (paths) => path.join(paths.configDir, 'settings.json');
const isOurs = (h, script) => !!h && [h.command, ...(Array.isArray(h.args) ? h.args : [])].some((s) => typeof s === 'string' && s.endsWith(script));

// The node executable the hook runs with (null when Node.js isn't installed). VS Code's own
// process.execPath is Electron, not node.
function findNode(env = process.env, platform = process.platform) {
  const exe = platform === 'win32' ? 'node.exe' : 'node';
  const dirs = (env.PATH || '').split(path.delimiter).map((d) => d.replace(/^"|"$/g, ''));
  if (platform === 'win32' && env.ProgramFiles) dirs.push(path.join(env.ProgramFiles, 'nodejs'));
  for (const dir of dirs) {
    if (!dir) continue;
    const file = path.join(dir, exe);
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}

// Puts the autoswitcher's hooks into Claude Code's user settings, or takes them out,
// leaving the rest of the file as it was. Claude Code picks the change up in open sessions
// too. Returns true when settings.json changed.
function syncHook(paths, switcherDir, { enabled, nodePath = null }) {
  return syncScript(paths, switcherDir, LIMIT_SCRIPT, { enabled, nodePath }, (command, script) => ({
    // A turn stopped on the usage limit: switch, then wake the model so it carries on.
    StopFailure: { matcher: 'rate_limit', hooks: [{ type: 'command', command, args: [script], asyncRewake: true, timeout: 120 }] },
    // A turn ended normally: a chance to switch between two messages.
    Stop: { hooks: [{ type: 'command', command, args: [script], async: true, timeout: 30 }] },
  }));
}

// The topic guard's hook: every prompt waits for it before reaching the model.
function syncTopicHook(paths, switcherDir, { enabled, nodePath = null }) {
  return syncScript(paths, switcherDir, TOPIC_SCRIPT, { enabled, nodePath }, (command, script) => ({
    UserPromptSubmit: { hooks: [{ type: 'command', command, args: [script], timeout: 40 }] },
  }));
}

// Conversations in the same project: each one tells the others what it is doing.
const EDIT_TOOLS = 'Edit|Write|MultiEdit|NotebookEdit';
function syncPeerHook(paths, switcherDir, { enabled, nodePath = null }) {
  return syncScript(paths, switcherDir, PEER_SCRIPT, { enabled, nodePath }, (command, script) => {
    const hook = (extra = {}) => ({ type: 'command', command, args: [script], timeout: 10, ...extra });
    return {
      UserPromptSubmit: { hooks: [hook()] },
      PreToolUse: { matcher: `${EDIT_TOOLS}|Bash`, hooks: [hook()] },
      PostToolUse: { matcher: EDIT_TOOLS, hooks: [hook({ async: true })] },
      Stop: { hooks: [hook({ async: true })] },
      SessionEnd: { hooks: [hook()] },
    };
  });
}

// Aprovações: every permission request waits for an answer from the panel, while the dialog in
// the conversation shows too. The hook waits up to an hour, so its timeout is that long.
function syncApprovalHook(paths, switcherDir, { enabled, nodePath = null }) {
  return syncScript(paths, switcherDir, APPROVAL_SCRIPT, { enabled, nodePath }, (command, script) => ({
    PermissionRequest: { hooks: [{ type: 'command', command, args: [script], timeout: 3600 }] },
  }));
}

function syncScript(paths, switcherDir, scriptName, { enabled, nodePath }, entries) {
  return updateSettings(paths, (settings) => {
    const script = path.join(switcherDir, scriptName);
    if (enabled) {
      if (!nodePath) throw new Error('Node.js não encontrado no PATH');
      copyIfChanged(path.join(__dirname, '..', 'hook', scriptName), script);
    }

    const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
    const ours = entries(nodePath, script);
    for (const event of Object.keys(ours)) {
      const groups = [];
      for (const g of Array.isArray(hooks[event]) ? hooks[event] : []) {
        const kept = g && Array.isArray(g.hooks) ? g.hooks.filter((h) => !isOurs(h, scriptName)) : null;
        if (kept && !kept.length && g.hooks.length) continue; // it held only ours
        groups.push(kept ? { ...g, hooks: kept } : g);
      }
      if (enabled) groups.push(ours[event]);
      if (groups.length) hooks[event] = groups;
      else delete hooks[event];
    }
    if (Object.keys(hooks).length) settings.hooks = hooks;
    else delete settings.hooks;
  });
}

// Claude Code's user settings as an object ({} when the file doesn't exist yet), and its text.
function readSettings(paths) {
  const file = settingsFile(paths);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (!text.trim()) return { settings: {}, text };
  try {
    return { settings: JSON.parse(text.replace(/^﻿/, '')), text };
  } catch (e) {
    throw new Error(`${file} não é um JSON válido (${e.message})`);
  }
}

// The features rewrite the same settings.json, so one write at a time. `change` edits the
// settings in place; the file is written only when that changed something. Returns true then.
let writing = Promise.resolve();
function updateSettings(paths, change) {
  const run = writing.then(async () => {
    const { settings, text } = readSettings(paths);
    const before = JSON.stringify(settings);
    change(settings);
    if (JSON.stringify(settings) === before) return false;
    await writeFileAtomic(settingsFile(paths), JSON.stringify(settings, null, 2) + (text && !text.endsWith('\n') ? '' : '\n'));
    return true;
  });
  writing = run.catch(() => {});
  return run;
}

function copyIfChanged(from, to) {
  const text = fs.readFileSync(from, 'utf8');
  try {
    if (fs.readFileSync(to, 'utf8') === text) return;
  } catch {}
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, text, 'utf8');
}

module.exports = { syncHook, syncTopicHook, syncPeerHook, syncApprovalHook, findNode, settingsFile, readSettings, updateSettings, copyIfChanged };
