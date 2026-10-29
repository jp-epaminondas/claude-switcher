'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, writeFileAtomic, withDirLock } = require('./fsutil');

// Saved accounts live in one file shared by every VS Code window (each window runs its own
// copy of the extension), always read fresh from disk.
class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'accounts.json');
    this.lockPath = path.join(dir, 'accounts.lock');
  }

  load() {
    let data;
    try {
      data = readJson(this.file);
    } catch (e) {
      throw new Error(`não consegui ler ${this.file}: ${e.message}`);
    }
    return { version: 1, activeId: null, accounts: [], ignored: [], ...(data || {}) };
  }

  // Read-modify-write under a lock, so two windows never clobber each other's tokens.
  async update(fn) {
    fs.mkdirSync(this.dir, { recursive: true });
    return withDirLock(
      this.lockPath,
      async () => {
        const data = this.load();
        const before = JSON.stringify(data);
        const result = await fn(data);
        const after = JSON.stringify(data, null, 2);
        if (JSON.stringify(data) !== before) await writeFileAtomic(this.file, after);
        return result;
      },
      { staleMs: 20000, timeoutMs: 60000 },
    );
  }
}

module.exports = { Store };
