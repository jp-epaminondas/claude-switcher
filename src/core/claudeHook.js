'use strict';

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./fsutil');

const SCRIPT = 'limit-hook.js';
const SOURCE = path.join(__dirname, '..', 'hook', SCRIPT);

const settingsFile = (paths) => path.join(paths.configDir, 'settings.json');
const isOurs = (h) => !!h && [h.command, ...(Array.isArray(h.args) ? h.args : [])].some((s) => typeof s === 'string' && s.endsWith(SCRIPT));

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

// Puts the autoswitcher's StopFailure hook into Claude Code's user settings, or takes it out,
// leaving the rest of the file as it was. Claude Code picks the change up in open sessions
// too. Returns true when settings.json changed.
async function syncHook(paths, switcherDir, { enabled, nodePath = null }) {
  const file = settingsFile(paths);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  let settings = {};
  if (text.trim()) {
    try {
      settings = JSON.parse(text.replace(/^﻿/, ''));
    } catch (e) {
      throw new Error(`${file} não é um JSON válido (${e.message})`);
    }
  }
  const before = JSON.stringify(settings);
  const script = path.join(switcherDir, SCRIPT);
  if (enabled) {
    if (!nodePath) throw new Error('Node.js não encontrado no PATH');
    copyIfChanged(SOURCE, script);
  }

  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const groups = [];
  for (const g of Array.isArray(hooks.StopFailure) ? hooks.StopFailure : []) {
    const kept = g && Array.isArray(g.hooks) ? g.hooks.filter((h) => !isOurs(h)) : null;
    if (kept && !kept.length && g.hooks.length) continue; // it held only ours
    groups.push(kept ? { ...g, hooks: kept } : g);
  }
  if (enabled) {
    groups.push({
      matcher: 'rate_limit',
      hooks: [{ type: 'command', command: nodePath, args: [script], asyncRewake: true, timeout: 120 }],
    });
  }
  if (groups.length) hooks.StopFailure = groups;
  else delete hooks.StopFailure;
  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;

  if (JSON.stringify(settings) === before) return false;
  await writeFileAtomic(file, JSON.stringify(settings, null, 2) + (text && !text.endsWith('\n') ? '' : '\n'));
  return true;
}

function copyIfChanged(from, to) {
  const text = fs.readFileSync(from, 'utf8');
  try {
    if (fs.readFileSync(to, 'utf8') === text) return;
  } catch {}
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, text, 'utf8');
}

module.exports = { syncHook, findNode, settingsFile };
