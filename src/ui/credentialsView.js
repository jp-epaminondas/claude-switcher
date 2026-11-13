'use strict';

// Side bar page "Credenciais": the encrypted vault (vault.js). Locked, it shows only names;
// the master password unlocks it for `credentials.lockMinutes`, in every VS Code window at
// once, and then it locks itself. Claude never sees a value: it runs `segredo exec`, which
// asks this window over a local pipe (secretBus.js), and the window asks the user first
// whenever the vault is locked.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Vault } = require('../core/vault');
const { SecretHost } = require('../core/secretBus');
const { parseServerMd } = require('../core/serverMd');
const { copyIfChanged } = require('../core/claudeHook');
const { fmtClock } = require('../core/usage');

const { Collapsed, Expanded, None } = vscode.TreeItemCollapsibleState;
const SCRIPT = 'segredo.js';
const CLIPBOARD_MS = 30 * 1000;
const KEEP_USES = 20;
const DEFAULT_IMPORT = 'C:\\wamp64\\www\\Rota7\\.specs\\server.md';

const icon = (id, color) => new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function createCredentialsView(app, sidebar) {
  const { switcherDir, log } = app;
  const vault = new Vault(switcherDir);
  const lockMinutes = () => Math.min(720, Math.max(1, Number(app.config().get('credentials.lockMinutes')) || 60));
  const script = path.join(switcherDir, SCRIPT);
  let lockTimer = null;
  let lockAt = 0;
  let unlocking = null; // one prompt at a time
  const uses = [];

  const page = sidebar.page('credentials', 'Credenciais', { getChildren });
  const refresh = () => {
    page.decorate({ description: !vault.exists() ? '' : vault.unlocked ? `🔓 até ${fmtClock(lockAt)}` : '🔒 trancado' });
    vscode.commands.executeCommand('setContext', 'claudeSwitcher.vaultUnlocked', vault.unlocked);
    vscode.commands.executeCommand('setContext', 'claudeSwitcher.vaultExists', vault.exists());
    page.refresh();
  };

  // --- lock state --------------------------------------------------------------------------

  function arm(until) {
    clearTimeout(lockTimer);
    lockAt = until;
    lockTimer = setTimeout(lockHere, Math.max(0, until - Date.now()));
  }

  function lockHere() {
    clearTimeout(lockTimer);
    lockTimer = null;
    if (vault.unlocked) log('credenciais trancadas');
    vault.lock();
    refresh();
  }

  function lockAll() {
    lockHere();
    host.broadcast({ op: 'sync-lock' });
  }

  // Asks for the master password (up to 3 tries). `why` says who wants it.
  function unlock(why) {
    if (vault.unlocked) return Promise.resolve(true);
    if (unlocking) return unlocking;
    unlocking = (async () => {
      const min = lockMinutes();
      for (let i = 0; i < 3; i++) {
        const pw = await vscode.window.showInputBox({
          title: '🔒 Destrancar as credenciais',
          prompt: `${i ? 'Senha mestra errada. ' : ''}${why} Fica destrancado por ${min} min, em todas as janelas.`,
          placeHolder: 'senha mestra',
          password: true,
          ignoreFocusOut: true,
        });
        if (!pw) return false;
        try {
          await vault.unlock(pw);
        } catch (e) {
          if (e.message === 'senha mestra errada') continue;
          throw e;
        }
        const until = Date.now() + min * 60 * 1000;
        arm(until);
        log(`credenciais destrancadas até ${fmtClock(until)}`);
        host.broadcast({ op: 'sync-unlock', key: vault.exportKey(), until });
        refresh();
        return true;
      }
      vscode.window.showWarningMessage('Claude Switcher: senha mestra errada 3 vezes; o cofre continua trancado.');
      return false;
    })().finally(() => (unlocking = null));
    return unlocking;
  }

  const ensureUnlocked = (why = 'Destrancar para ver e editar.') => unlock(why);

  // --- requests from segredo and from the other windows ------------------------------------

  async function resolveFor(msg) {
    if (!vault.exists()) return { ok: false, error: 'o cofre ainda não foi criado (página Credenciais do Claude Switcher)' };
    const refs = Array.isArray(msg.refs) ? msg.refs.map(String) : [];
    if (!vault.unlocked) {
      // A native dialog first: it gets noticed even with the window in the background.
      const choice = await vscode.window.showWarningMessage(
        `O Claude quer usar ${refs.join(', ')}`,
        { modal: true, detail: `Para rodar:\n${clip(String(msg.command || ''), 400)}\n\nEm: ${msg.cwd || '?'}\n\nO cofre está trancado. Destrancar fica valendo por ${lockMinutes()} min.` },
        'Destrancar',
      );
      if (choice !== 'Destrancar' || !(await unlock('O Claude está esperando.'))) {
        log(`segredo negado: ${refs.join(', ')} para ${clip(String(msg.command || ''), 120)}`);
        return { ok: false, error: 'o usuário não liberou o cofre' };
      }
    }
    const values = {};
    for (const ref of refs) values[ref] = vault.resolve(ref).field.value;
    const cmd = clip(String(msg.command || '').split(/\s+/)[0] || '', 40);
    uses.unshift({ refs, command: clip(String(msg.command || ''), 300), cwd: msg.cwd, at: Date.now() });
    uses.length = Math.min(uses.length, KEEP_USES);
    log(`segredo: ${refs.join(', ')} usada por ${clip(String(msg.command || ''), 160)}`);
    vscode.window.setStatusBarMessage(`$(key) ${refs.join(', ')} usada por ${path.basename(cmd)}`, 5000);
    refresh();
    return { ok: true, values };
  }

  async function handle(msg) {
    switch (msg && msg.op) {
      case 'list':
        return { ok: true, locked: !vault.unlocked, entries: vault.catalog().entries };
      case 'resolve':
        return resolveFor(msg);
      case 'sync-unlock':
        if (!vault.unlocked && msg.until > Date.now() && vault.exists() && vault.adoptKey(msg.key)) {
          arm(msg.until);
          refresh();
        }
        return { ok: true };
      case 'sync-lock':
        lockHere();
        return { ok: true };
      case 'sync-reload':
        vault.reload();
        refresh();
        return { ok: true };
      default:
        return { ok: false, error: 'pedido desconhecido' };
    }
  }

  const host = new SecretHost({ switcherDir, handle, log });

  // Saves happen in vault.js; this tells the other unlocked windows to re-read.
  async function edited() {
    refresh();
    await host.broadcast({ op: 'sync-reload' });
  }

  // --- the page ----------------------------------------------------------------------------

  function getChildren(element) {
    if (element) return element.children || [];
    if (!vault.exists()) {
      return [
        Object.assign(new vscode.TreeItem('Criar o cofre', None), {
          id: 'cred.create',
          iconPath: icon('add'),
          description: 'escolha a senha mestra',
          tooltip: 'Cria o cofre criptografado. Só a senha mestra abre, e ela não fica guardada em lugar nenhum.',
          command: { command: 'claudeSwitcher.cred.create', title: 'Criar o cofre' },
        }),
      ];
    }
    const items = [statusItem()];
    const values = vault.unlocked ? new Map(vault.entries().map((e) => [e.id, e])) : null;
    for (const e of vault.catalog().entries) items.push(entryItem(e, values && values.get(e.id)));
    if (!vault.catalog().entries.length) {
      items.push(
        Object.assign(new vscode.TreeItem('Importar um arquivo (como o server.md)', None), {
          id: 'cred.importHint',
          iconPath: icon('desktop-download'),
          command: { command: 'claudeSwitcher.cred.import', title: 'Importar' },
        }),
      );
    }
    if (uses.length) items.push(usesItem());
    return items;
  }

  function statusItem() {
    const t = new vscode.TreeItem(vault.unlocked ? 'Destrancado' : 'Trancado', None);
    t.id = 'cred.status';
    if (vault.unlocked) {
      t.iconPath = icon('unlock', 'charts.yellow');
      t.description = `tranca sozinho ${fmtClock(lockAt)} · clique para trancar já`;
      t.command = { command: 'claudeSwitcher.cred.lock', title: 'Trancar' };
    } else {
      t.iconPath = icon('lock', 'charts.green');
      t.description = 'clique para destrancar';
      t.command = { command: 'claudeSwitcher.cred.unlock', title: 'Destrancar' };
    }
    t.tooltip = `O Claude usa as credenciais pelo segredo, sem ver os valores:\nnode ${script} lista\nnode ${script} exec -- comando {{credencial.campo}}`;
    return t;
  }

  function entryItem(e, full) {
    const t = new vscode.TreeItem(e.title, Collapsed);
    t.id = `cred.e.${e.id}`;
    t.entryId = e.id;
    t.contextValue = 'credEntry';
    t.iconPath = icon('key');
    t.description = plural(e.fields.length, 'campo', 'campos');
    t.tooltip = `${e.title}\n{{${e.ref}.…}}`;
    t.children = e.fields.map((f) => {
      const value = full && (full.fields.find((x) => x.id === f.id) || {}).value;
      const c = new vscode.TreeItem(f.name, None);
      c.id = `cred.f.${e.id}.${f.id}`;
      c.entryId = e.id;
      c.fieldId = f.id;
      c.contextValue = 'credField';
      c.iconPath = icon(f.secret ? 'lock-small' : 'symbol-field');
      c.description = !f.secret && value != null ? clip(value, 60) : '••••••••';
      c.tooltip = `${f.name}${f.secret ? ' (secreto)' : ''}\nNo segredo: {{${e.ref}.${f.ref}}}\n\nClique para copiar o valor (some da área de transferência em 30 s).`;
      c.command = { command: 'claudeSwitcher.cred.copy', title: 'Copiar', arguments: [c] };
      return c;
    });
    return t;
  }

  function usesItem() {
    const t = new vscode.TreeItem('Usos recentes pelo Claude', Collapsed);
    t.id = 'cred.uses';
    t.iconPath = icon('history');
    t.description = `${uses.length}`;
    t.children = uses.map((u, i) =>
      Object.assign(new vscode.TreeItem(u.refs.join(', '), None), {
        id: `cred.use.${i}.${u.at}`,
        iconPath: icon('terminal'),
        description: `${fmtClock(u.at)} · ${clip(u.command, 60)}`,
        tooltip: `${u.command}\n\nEm: ${u.cwd || '?'}`,
      }),
    );
    return t;
  }

  // --- commands ----------------------------------------------------------------------------

  async function askMaster(title) {
    const first = await vscode.window.showInputBox({
      title,
      prompt: 'Pelo menos 8 caracteres. Ela não fica guardada em lugar nenhum: sem ela, o cofre não abre.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.length >= 8 ? null : 'Pelo menos 8 caracteres'),
    });
    if (!first) return null;
    const again = await vscode.window.showInputBox({ title, prompt: 'Digite de novo para confirmar.', password: true, ignoreFocusOut: true });
    if (again !== first) {
      vscode.window.showWarningMessage('As duas senhas não batem.');
      return null;
    }
    return first;
  }

  async function create() {
    if (vault.exists()) return refresh();
    const master = await askMaster('Senha mestra do cofre de credenciais');
    if (!master) return;
    await vault.create(master);
    arm(Date.now() + lockMinutes() * 60 * 1000);
    host.broadcast({ op: 'sync-unlock', key: vault.exportKey(), until: lockAt });
    refresh();
    const choice = await vscode.window.showInformationMessage('Cofre criado e destrancado. Importar um arquivo de credenciais agora?', 'Importar', 'Depois');
    if (choice === 'Importar') importFile();
  }

  async function importFile() {
    if (!vault.exists()) return create();
    if (!(await ensureUnlocked('Destrancar para importar.'))) return;
    const picked = await vscode.window.showOpenDialog({
      title: 'Arquivo de credenciais para importar',
      defaultUri: vscode.Uri.file(fs.existsSync(DEFAULT_IMPORT) ? DEFAULT_IMPORT : os.homedir()),
      canSelectMany: false,
      filters: { 'Texto': ['md', 'txt'], 'Todos': ['*'] },
    });
    if (!picked || !picked.length) return;
    const file = picked[0].fsPath;
    const entries = parseServerMd(fs.readFileSync(file, 'utf8'));
    if (!entries.length) {
      vscode.window.showWarningMessage('Não achei credenciais nesse arquivo.');
      return;
    }
    const chosen = await vscode.window.showQuickPick(
      entries.map((e) => ({ label: e.title, description: e.fields.map((f) => f.name + (f.secret ? ' 🔒' : '')).join(' · '), picked: true, entry: e })),
      { title: 'O que entra no cofre (dá para renomear tudo depois)', canPickMany: true, ignoreFocusOut: true },
    );
    if (!chosen || !chosen.length) return;
    for (const c of chosen) await vault.addEntry(c.entry.title, c.entry.fields);
    await edited();
    log(`importadas ${chosen.length} credenciais de ${file}`);
    const del = await vscode.window.showWarningMessage(
      `${plural(chosen.length, 'credencial importada', 'credenciais importadas')}. Apagar o arquivo original?`,
      { modal: true, detail: `${file}\n\nOs valores agora estão no cofre. Enquanto o arquivo existir, eles continuam em texto puro no disco.` },
      'Apagar o arquivo',
    );
    if (del) {
      fs.writeFileSync(file, Buffer.alloc(fs.statSync(file).size));
      fs.unlinkSync(file);
      log(`apagado ${file}`);
      vscode.window.showInformationMessage('Arquivo original apagado.');
    }
  }

  async function addEntry() {
    if (!(await ensureUnlocked())) return;
    const title = await vscode.window.showInputBox({ title: 'Nova credencial', prompt: 'Nome (ex.: Servidor produção, Banco, API OpenRouter)', ignoreFocusOut: true });
    if (!title) return;
    const e = await vault.addEntry(title);
    await edited();
    await addField({ entryId: e.id });
  }

  async function addField(item) {
    if (!item || !(await ensureUnlocked())) return;
    const name = await vscode.window.showInputBox({ title: 'Novo campo', prompt: 'Nome do campo (ex.: Senha, Usuário, Host, Chave)', value: 'Senha', ignoreFocusOut: true });
    if (!name) return;
    const kind = await vscode.window.showQuickPick(
      [
        { label: '$(lock) Secreto', description: 'senha, chave, token: aparece como ••••', secret: true },
        { label: '$(symbol-field) Não secreto', description: 'host, usuário, caminho: aparece na lista', secret: false },
      ],
      { title: name, ignoreFocusOut: true },
    );
    if (!kind) return;
    const value = await vscode.window.showInputBox({ title: `${name}: valor`, password: kind.secret, ignoreFocusOut: true });
    if (value == null) return;
    await vault.setField(item.entryId, null, { name, value, secret: kind.secret });
    await edited();
  }

  async function editField(item) {
    if (!item || !(await ensureUnlocked())) return;
    const f = vault.entry(item.entryId).fields.find((x) => x.id === item.fieldId);
    if (!f) return refresh();
    const value = await vscode.window.showInputBox({
      title: `${f.name}: novo valor`,
      prompt: f.secret ? 'O valor atual não aparece. Deixe vazio para manter.' : undefined,
      value: f.secret ? '' : f.value,
      password: f.secret,
      ignoreFocusOut: true,
    });
    if (value == null || (f.secret && value === '')) return;
    await vault.setField(item.entryId, item.fieldId, { value });
    await edited();
  }

  async function renameEntry(item) {
    if (!item || !(await ensureUnlocked())) return;
    const e = vault.entry(item.entryId);
    const title = await vscode.window.showInputBox({ title: 'Renomear credencial', value: e.title, ignoreFocusOut: true });
    if (!title) return;
    await vault.renameEntry(e.id, title);
    await edited();
  }

  async function renameField(item) {
    if (!item || !(await ensureUnlocked())) return;
    const f = vault.entry(item.entryId).fields.find((x) => x.id === item.fieldId);
    if (!f) return;
    const name = await vscode.window.showInputBox({ title: 'Renomear campo', value: f.name, ignoreFocusOut: true });
    if (!name) return;
    await vault.setField(item.entryId, item.fieldId, { name });
    await edited();
  }

  async function toggleSecret(item) {
    if (!item || !(await ensureUnlocked())) return;
    const f = vault.entry(item.entryId).fields.find((x) => x.id === item.fieldId);
    if (!f) return;
    await vault.setField(item.entryId, item.fieldId, { secret: !f.secret });
    await edited();
  }

  async function removeEntry(item) {
    if (!item || !(await ensureUnlocked())) return;
    const e = vault.entry(item.entryId);
    const ok = await vscode.window.showWarningMessage(`Apagar a credencial "${e.title}"?`, { modal: true, detail: 'Sai do cofre com todos os campos. Não dá para desfazer.' }, 'Apagar');
    if (!ok) return;
    await vault.removeEntry(e.id);
    await edited();
  }

  async function removeField(item) {
    if (!item || !(await ensureUnlocked())) return;
    const e = vault.entry(item.entryId);
    const f = e.fields.find((x) => x.id === item.fieldId);
    if (!f) return;
    const ok = await vscode.window.showWarningMessage(`Apagar o campo "${f.name}" de "${e.title}"?`, { modal: true, detail: 'Não dá para desfazer.' }, 'Apagar');
    if (!ok) return;
    await vault.removeField(e.id, f.id);
    await edited();
  }

  async function copy(item) {
    if (!item || !(await ensureUnlocked('Destrancar para copiar.'))) return;
    const f = vault.entry(item.entryId).fields.find((x) => x.id === item.fieldId);
    if (!f) return;
    await vscode.env.clipboard.writeText(f.value);
    vscode.window.setStatusBarMessage(`$(copy) ${f.name} copiado; some da área de transferência em 30 s`, 5000);
    const value = f.value;
    setTimeout(async () => {
      if ((await vscode.env.clipboard.readText()) === value) await vscode.env.clipboard.writeText('');
    }, CLIPBOARD_MS);
  }

  async function copyRef(item) {
    if (!item) return;
    const e = vault.catalog().entries.find((x) => x.id === item.entryId);
    const f = e && e.fields.find((x) => x.id === item.fieldId);
    if (!f) return;
    await vscode.env.clipboard.writeText(`{{${e.ref}.${f.ref}}}`);
    vscode.window.setStatusBarMessage(`$(copy) {{${e.ref}.${f.ref}}} copiado`, 4000);
  }

  async function changeMaster() {
    if (!(await ensureUnlocked('Destrancar para trocar a senha mestra.'))) return;
    const master = await askMaster('Nova senha mestra');
    if (!master) return;
    await vault.changeMaster(master);
    host.broadcast({ op: 'sync-unlock', key: vault.exportKey(), until: lockAt });
    vscode.window.showInformationMessage('Senha mestra trocada.');
  }

  // A failing command shows its error instead of disappearing silently.
  const guarded = (fn) => async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      log(`credenciais: ${e.stack || e.message}`);
      vscode.window.showErrorMessage(`Claude Switcher: ${e.message}`);
      refresh();
    }
  };

  try {
    copyIfChanged(path.join(__dirname, '..', 'hook', SCRIPT), script);
  } catch (e) {
    log(`segredo: não consegui instalar ${script}: ${e.message}`);
  }
  host.start(vscode.window.state.focused);
  refresh();

  const commands = {
    create,
    unlock: () => ensureUnlocked(),
    lock: lockAll,
    import: importFile,
    addEntry,
    addField,
    editField,
    renameEntry,
    renameField,
    toggleSecret,
    removeEntry,
    removeField,
    copy,
    copyRef,
    changeMaster,
  };
  const disposables = [
    vscode.window.onDidChangeWindowState((s) => s.focused && host.touch(true)),
    ...Object.entries(commands).map(([name, fn]) => vscode.commands.registerCommand(`claudeSwitcher.cred.${name}`, guarded(fn))),
  ];

  return {
    dispose() {
      clearTimeout(lockTimer);
      vault.lock();
      host.stop();
      for (const d of disposables) d.dispose();
    },
  };
}

module.exports = { createCredentialsView };
