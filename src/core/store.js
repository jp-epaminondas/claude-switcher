'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, writeFileAtomic, withDirLock } = require('./fsutil');

const ACCOUNTS = { version: 1, activeId: null, accounts: [], ignored: [] };

// Saved accounts live in one file shared by every VS Code window (each window runs its own
// copy of the extension), always read fresh from disk. Other state (`name`) uses the same scheme.
class Store {
  constructor(dir, { name = 'accounts', defaults = ACCOUNTS } = {}) {
    this.dir = dir;
    this.defaults = defaults;
    this.file = path.join(dir, `${name}.json`);
    this.lockPath = path.join(dir, `${name}.lock`);
  }

  load() {
    let data;
    try {
      data = readJson(this.file);
    } catch (e) {
      throw new Error(`não consegui ler ${this.file}: ${e.message}`);
    }
    return { ...structuredClone(this.defaults), ...(data || {}) };
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
