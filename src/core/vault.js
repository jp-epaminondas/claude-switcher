'use strict';

// The credentials vault: one file, AES-256-GCM, key derived from the user's master password
// with scrypt. The master password is never stored; while unlocked, only the derived key sits
// in memory, and lock() wipes it. Next to the ciphertext the file keeps a catalog with the
// names of the entries and fields (no values), so the page and `segredo lista` can show what
// exists while locked.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./fsutil');

const FILE = 'credenciais.vault';
const KDF = { N: 2 ** 16, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

const vaultPath = (switcherDir) => path.join(switcherDir, FILE);

// Async, so the ~0.2 s it takes doesn't freeze VS Code.
function deriveKey(master, kdf) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(String(master).normalize('NFC'), Buffer.from(kdf.salt, 'base64'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: KDF.maxmem }, (e, key) =>
      e ? reject(e) : resolve(key),
    ),
  );
}

function encrypt(key, data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

function decrypt(key, box) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  const text = Buffer.concat([decipher.update(Buffer.from(box.ct, 'base64')), decipher.final()]).toString('utf8');
  return JSON.parse(text);
}

// "SERVER SSH" -> "server-ssh": what `segredo` refers to.
const slug = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'item';

// Gives every entry and field a ref that is unique and stable while its name doesn't change.
// An account (an entry with parentId) is "<parent ref>-<account>": "phpmyadmin-master".
function withRefs(data) {
  const taken = new Set();
  const unique = (base, used) => {
    let ref = base;
    for (let n = 2; used.has(ref); n++) ref = `${base}-${n}`;
    used.add(ref);
    return ref;
  };
  const byId = new Map(data.entries.map((e) => [e.id, e]));
  // One level only: an account whose parent is gone, or is an account itself, stands alone.
  for (const e of data.entries) {
    const parent = e.parentId && byId.get(e.parentId);
    if (e.parentId && (!parent || parent.parentId || parent === e)) delete e.parentId;
  }
  // Parents first, so their refs don't depend on where their accounts sit in the list.
  for (const e of [...data.entries.filter((x) => !x.parentId), ...data.entries.filter((x) => x.parentId)]) {
    e.ref = unique(e.parentId ? `${byId.get(e.parentId).ref}-${slug(e.title)}` : slug(e.title), taken);
    const fieldsTaken = new Set();
    for (const f of e.fields) f.ref = unique(slug(f.name), fieldsTaken);
  }
  return data;
}

// Names only: safe to keep in the clear and to hand to Claude.
const catalogOf = (data) => ({
  entries: data.entries.map((e) => ({
    id: e.id,
    ref: e.ref,
    title: e.title,
    ...(e.parentId ? { parentId: e.parentId } : {}),
    fields: e.fields.map((f) => ({ id: f.id, ref: f.ref, name: f.name, secret: !!f.secret })),
  })),
});

const newId = () => crypto.randomBytes(6).toString('hex');

class Vault {
  constructor(switcherDir) {
    this.file = vaultPath(switcherDir);
    this.key = null;
    this.data = null;
    this.kdf = null;
  }

  exists() {
    return fs.existsSync(this.file);
  }

  readFile() {
    return JSON.parse(fs.readFileSync(this.file, 'utf8'));
  }

  get unlocked() {
    return !!this.key;
  }

  // What exists, without values; works locked too.
  catalog() {
    if (this.unlocked) return catalogOf(this.data);
    if (!this.exists()) return { entries: [] };
    return this.readFile().catalog || { entries: [] };
  }

  async create(master) {
    if (this.exists()) throw new Error('o cofre já existe');
    if (!master || String(master).length < 8) throw new Error('a senha mestra precisa de pelo menos 8 caracteres');
    this.kdf = { alg: 'scrypt', salt: crypto.randomBytes(16).toString('base64'), N: KDF.N, r: KDF.r, p: KDF.p };
    this.key = await deriveKey(master, this.kdf);
    this.data = { entries: [] };
    await this.save();
  }

  // Throws "senha mestra errada" when the password doesn't open it.
  async unlock(master) {
    const file = this.readFile();
    const key = await deriveKey(master, file.kdf);
    let data;
    try {
      data = decrypt(key, file);
    } catch {
      key.fill(0);
      throw new Error('senha mestra errada');
    }
    this.lock();
    this.key = key;
    this.kdf = file.kdf;
    this.data = withRefs(data);
  }

  lock() {
    if (this.key) this.key.fill(0);
    this.key = null;
    this.data = null;
  }

  // The derived key, for another VS Code window to unlock without asking again.
  exportKey() {
    if (!this.unlocked) throw new Error('o cofre está trancado');
    return Buffer.from(this.key).toString('base64');
  }

  // Unlocks with a key from exportKey(); false when it doesn't open this vault.
  adoptKey(b64) {
    const file = this.readFile();
    const key = Buffer.from(String(b64), 'base64');
    let data;
    try {
      data = decrypt(key, file);
    } catch {
      key.fill(0);
      return false;
    }
    this.lock();
    this.key = key;
    this.kdf = file.kdf;
    this.data = withRefs(data);
    return true;
  }

  // Picks up edits saved by another window (same key).
  reload() {
    if (this.unlocked && this.exists()) this.data = withRefs(decrypt(this.key, this.readFile()));
  }

  async save() {
    if (!this.unlocked) throw new Error('o cofre está trancado');
    withRefs(this.data);
    const out = { v: 1, kdf: this.kdf, ...encrypt(this.key, { entries: this.data.entries }), catalog: catalogOf(this.data), updatedAt: Date.now() };
    await writeFileAtomic(this.file, JSON.stringify(out, null, 2));
  }

  // Changes the master password: same data, new salt and key.
  async changeMaster(master) {
    if (!this.unlocked) throw new Error('o cofre está trancado');
    if (!master || String(master).length < 8) throw new Error('a senha mestra precisa de pelo menos 8 caracteres');
    this.key.fill(0);
    this.kdf = { alg: 'scrypt', salt: crypto.randomBytes(16).toString('base64'), N: KDF.N, r: KDF.r, p: KDF.p };
    this.key = await deriveKey(master, this.kdf);
    await this.save();
  }

  // --- edits (unlocked only) ---------------------------------------------------------------

  entries() {
    if (!this.unlocked) throw new Error('o cofre está trancado');
    return this.data.entries;
  }

  entry(id) {
    const e = this.entries().find((x) => x.id === id);
    if (!e) throw new Error('credencial não encontrada');
    return e;
  }

  // The accounts inside an entry (PHPMYADMIN -> master, cliente X), in order.
  accountsOf(id) {
    return this.entries().filter((e) => e.parentId === id);
  }

  // With parentId, an account inside that entry.
  async addEntry(title, fields = [], parentId = null) {
    if (parentId) this.checkParent(parentId);
    const e = { id: newId(), title: String(title).trim() || 'Sem nome', fields: fields.map((f) => ({ id: newId(), name: f.name, value: f.value, secret: !!f.secret })) };
    if (parentId) e.parentId = parentId;
    this.entries().push(e);
    await this.save();
    return e;
  }

  checkParent(parentId) {
    if (this.entry(parentId).parentId) throw new Error('uma conta não pode ter contas dentro');
  }

  async renameEntry(id, title) {
    this.entry(id).title = String(title).trim() || 'Sem nome';
    await this.save();
  }

  // Takes its accounts with it.
  async removeEntry(id) {
    this.data.entries = this.entries().filter((e) => e.id !== id && e.parentId !== id);
    await this.save();
  }

  // Puts an entry inside another, as one of its accounts, or (parentId null) back on its own.
  async setParent(id, parentId) {
    const e = this.entry(id);
    if (parentId) {
      if (parentId === id) throw new Error('uma credencial não pode ficar dentro dela mesma');
      this.checkParent(parentId);
      if (this.accountsOf(id).length) throw new Error(`"${e.title}" tem contas dentro; tire as contas antes`);
      e.parentId = parentId;
    } else {
      delete e.parentId;
    }
    await this.save();
  }

  // Moves fields between entries, keeping their order (the values that turn into an account).
  async moveFields(fromId, toId, fieldIds) {
    const from = this.entry(fromId);
    const to = this.entry(toId);
    const ids = new Set(fieldIds);
    to.fields.push(...from.fields.filter((f) => ids.has(f.id)));
    from.fields = from.fields.filter((f) => !ids.has(f.id));
    await this.save();
  }

  async setField(entryId, fieldId, { name, value, secret }) {
    const e = this.entry(entryId);
    let f = fieldId && e.fields.find((x) => x.id === fieldId);
    if (!f) e.fields.push((f = { id: newId(), name: 'Campo', value: '', secret: true }));
    if (name !== undefined) f.name = String(name).trim() || 'Campo';
    if (value !== undefined) f.value = String(value);
    if (secret !== undefined) f.secret = !!secret;
    await this.save();
    return f;
  }

  async removeField(entryId, fieldId) {
    const e = this.entry(entryId);
    e.fields = e.fields.filter((f) => f.id !== fieldId);
    await this.save();
  }

  // "server-ssh.senha" -> the field, or an error that says what exists.
  resolve(ref) {
    const [er, fr] = String(ref).split('.');
    const e = this.entries().find((x) => x.ref === er);
    if (!e) throw new Error(`não existe a credencial "${er}" (veja segredo lista)`);
    const f = e.fields.find((x) => x.ref === fr);
    if (!f) {
      // "phpmyadmin.senha" once the password moved into the accounts: point at them.
      const inAccounts = this.accountsOf(e.id).filter((a) => a.fields.some((x) => x.ref === fr));
      const has = e.fields.length ? `; tem: ${e.fields.map((x) => x.ref).join(', ')}` : '';
      const accounts = inAccounts.length ? `. Está nas contas: ${inAccounts.map((a) => `${a.ref}.${fr}`).join(', ')}` : '';
      throw new Error(`"${er}" não tem o campo "${fr}"${has}${accounts}`);
    }
    return { entry: e, field: f };
  }
}

module.exports = { Vault, vaultPath, slug, withRefs, catalogOf };
