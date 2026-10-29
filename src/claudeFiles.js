'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, writeFileAtomic, withDirLock } = require('./fsutil');

// The OAuth tokens Claude Code is using right now (null when logged out).
function readLiveOauth(paths) {
  const data = readJson(paths.credentials);
  const oauth = data && data.claudeAiOauth;
  return oauth && oauth.accessToken ? oauth : null;
}

// Claude Code holds "<configDir>.lock" while it refreshes a token. Holding it too means a
// refresh already in flight can't write the old account back over the one we put in place.
function refreshLockPath(paths) {
  let dir = paths.configDir;
  try {
    dir = fs.realpathSync(dir);
  } catch {}
  return `${dir}.lock`;
}

async function writeLiveOauth(paths, oauth) {
  await withDirLock(refreshLockPath(paths), async () => {
    const data = readJson(paths.credentials) || {};
    data.claudeAiOauth = oauth; // mcpOAuth and any other keys stay as they are
    await writeFileAtomic(paths.credentials, JSON.stringify(data, null, 2));
  });
}

// ~/.claude.json is rewritten by Claude Code all the time; a read that lands mid-write fails
// to parse, and the next tick simply tries again.
function readGlobalConfig(paths) {
  try {
    return readJson(paths.globalConfig);
  } catch {
    return null;
  }
}

// Only the oauthAccount block changes; it is what /status and the extension show as the
// logged-in account.
async function writeOauthAccount(paths, oauthAccount) {
  await withDirLock(`${paths.globalConfig}.lock`, async () => {
    const text = fs.readFileSync(paths.globalConfig, 'utf8');
    const data = JSON.parse(text.replace(/^﻿/, ''));
    data.oauthAccount = oauthAccount;
    const out = JSON.stringify(data, null, 2) + (text.endsWith('\n') ? '\n' : '');
    await writeFileAtomic(paths.globalConfig, out);
  });
}

// One-time copy of the original files, taken before the first switch ever touches them.
function backupOnce(paths, switcherDir) {
  const dir = path.join(switcherDir, 'backup');
  fs.mkdirSync(dir, { recursive: true });
  for (const file of [paths.credentials, paths.globalConfig]) {
    const dest = path.join(dir, `${path.basename(file)}.orig`);
    if (fs.existsSync(file) && !fs.existsSync(dest)) fs.copyFileSync(file, dest);
  }
}

module.exports = { readLiveOauth, writeLiveOauth, readGlobalConfig, writeOauthAccount, backupOnce };
