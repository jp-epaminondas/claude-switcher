'use strict';

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./fsutil');

const LEFTOVER_MS = 5 * 60 * 1000;

// Mailbox shared with the StopFailure hook (src/hook/limit-hook.js): the hook drops
// "<id>.req" and waits for "<id>.res". The hook only asks while .alive is fresh, that is,
// while some VS Code window is listening.
class LimitQueue {
  constructor(switcherDir) {
    this.dir = path.join(switcherDir, 'limits');
    this.alivePath = path.join(this.dir, '.alive');
  }

  heartbeat() {
    fs.mkdirSync(this.dir, { recursive: true });
    const now = new Date();
    try {
      fs.utimesSync(this.alivePath, now, now);
    } catch {
      fs.writeFileSync(this.alivePath, '');
    }
  }

  // Requests nobody has answered yet. Renaming one claims it, so with several windows open
  // only one of them handles it.
  take() {
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      if (!name.endsWith('.req')) {
        this.dropLeftover(file, name);
        continue;
      }
      const id = name.slice(0, -'.req'.length);
      const claimed = path.join(this.dir, `${id}.taken`);
      try {
        fs.renameSync(file, claimed);
      } catch {
        continue; // another window got it first
      }
      let req = null;
      try {
        req = JSON.parse(fs.readFileSync(claimed, 'utf8'));
      } catch {}
      try {
        fs.unlinkSync(claimed);
      } catch {}
      if (req) out.push({ id, req });
    }
    return out;
  }

  async answer(id, res) {
    await writeFileAtomic(path.join(this.dir, `${id}.res`), JSON.stringify(res));
  }

  // Answers the hook gave up waiting for, and temp files of a crashed write.
  dropLeftover(file, name) {
    if (name === '.alive') return;
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > LEFTOVER_MS) fs.unlinkSync(file);
    } catch {}
  }
}

module.exports = { LimitQueue };
