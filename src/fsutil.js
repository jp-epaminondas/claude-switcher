'use strict';

const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RENAME_RETRY = new Set(['EPERM', 'EBUSY', 'EACCES']);

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  return JSON.parse(text.replace(/^﻿/, ''));
}

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// Temp file + rename, so a reader (Claude Code, another window) never sees half a file.
async function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  let lastError;
  for (let i = 0; i < 20; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      lastError = e;
      // Windows briefly refuses to replace a file that another process has open.
      if (!RENAME_RETRY.has(e.code)) break;
      await sleep(50);
    }
  }
  try {
    fs.writeFileSync(file, text, 'utf8');
  } catch {
    throw lastError;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

// mkdir-based lock, the same scheme as the proper-lockfile package Claude Code uses, so the
// two can coordinate on the same lock path. A lock whose mtime stops moving is stale.
async function withDirLock(lockPath, fn, { staleMs = 10000, timeoutMs = 15000 } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) {
          fs.rmdirSync(lockPath);
          continue;
        }
      } catch {}
      if (Date.now() - start > timeoutMs) {
        throw new Error(`tempo esgotado esperando o lock ${path.basename(lockPath)}`);
      }
      await sleep(100 + Math.random() * 100);
    }
  }
  const keepAlive = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(lockPath, now, now);
    } catch {}
  }, staleMs / 2);
  try {
    return await fn();
  } finally {
    clearInterval(keepAlive);
    try {
      fs.rmdirSync(lockPath);
    } catch {}
  }
}

module.exports = { readJson, mtime, writeFileAtomic, withDirLock, sleep };
