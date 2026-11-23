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

const { Collapsed, None } = vscode.TreeItemCollapsibleState;
const SCRIPT = 'segredo.js';
const CLIPBOARD_MS = 30 * 1000;
const REVEAL_MS = 30 * 1000;
const KEEP_USES = 20;
const DEFAULT_IMPORT = 'C:\\wamp64\\www\\Rota7\\.specs\\server.md';

const LOCK_CHOICES = [5, 15, 30, 60, 120, 240, 480, 720];

const icon = (id, color) => new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// 90 -> "1 h 30 min"
const fmtMinutes = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);

// What a non-secret field holds, by its name.
const FIELD_ICONS = [
  [/^(usu[aá]rio|user|login|conta)/i, 'person'],
  [/(e-?mail)/i, 'mail'],
  [/^(url|link|site|endere[cç]o|painel)/i, 'link'],
  [/^(host|servidor|server|ip|dom[ií]nio)/i, 'server'],
  [/^(porta|port)\b/i, 'plug'],
  [/^(caminho|pasta|path|dir)/i, 'folder'],
  [/^(banco|database|db|schema)\b/i, 'database'],
];
const fieldIcon = (name) => (FIELD_ICONS.find(([re]) => re.test(name)) || [])[1] || 'symbol-field';

function createCredentialsView(app, sidebar) {
  const { switcherDir, log } = app;
  const vault = new Vault(switcherDir);
  const lockMinutes = () => Math.min(720, Math.max(1, Number(app.config().get('credentials.lockMinutes')) || 60));
  const script = path.join(switcherDir, SCRIPT);
  let lockTimer = null;
  let lockAt = 0;
  let unlocking = null; // one prompt at a time
  const uses = [];
  const revealed = new Map(); // fieldId -> timer: secret fields shown in the list for a while

  const page = sidebar.page('credentials', 'Credenciais', { getChildren, collapseOnShow: true });
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

  function hideAll() {
    for (const t of revealed.values()) clearTimeout(t);
    revealed.clear();
  }

  function lockHere() {
    clearTimeout(lockTimer);
    lockTimer = null;
    hideAll();
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
    const op = msg && msg.op;
    if ((op === 'list' || op === 'resolve') && !app.access.can('credenciais.usar')) return { ok: false, error: app.access.why('credenciais.usar') };
    switch (op) {
      case 'list':
        return { ok: true, locked: !vault.unlocked, entries: vault.catalog().entries };
      case 'resolve':
        return resolveFor(msg);
      // Also reaches the windows already unlocked: after a master password change elsewhere
      // they would otherwise save with the old key and bring the old password back.
      case 'sync-unlock':
        if (msg.until > Date.now() && vault.exists() && !(vault.unlocked && msg.key === vault.exportKey()) && vault.adoptKey(msg.key)) {
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
    const items = [statusItem(), lockTimeItem()];
    const values = vault.unlocked ? new Map(vault.entries().map((e) => [e.id, e])) : null;
    const entries = vault.catalog().entries;
    for (const e of entries.filter((x) => !x.parentId)) {
      items.push(entryItem(e, values, entries.filter((x) => x.parentId === e.id)));
    }
    if (!entries.length) {
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

  function lockTimeItem() {
    return Object.assign(new vscode.TreeItem('Pedir a senha de novo depois de', None), {
      id: 'cred.lockTime',
      iconPath: icon('clock'),
      description: `${fmtMinutes(lockMinutes())} · clique para mudar`,
      tooltip: 'Quanto tempo o cofre fica destrancado depois da senha mestra, em todas as janelas.',
      command: { command: 'claudeSwitcher.cred.lockTime', title: 'Mudar o tempo' },
    });
  }

  // An entry: its own fields (shared by all its accounts), then its accounts.
  function entryItem(e, values, accounts = null) {
    const t = new vscode.TreeItem(e.title, Collapsed);
    t.id = `cred.e.${e.id}`;
    t.entryId = e.id;
    t.contextValue = accounts ? 'credEntry' : 'credAccount';
    t.iconPath = icon(accounts ? 'key' : 'account');
    const counts = [];
    if (e.fields.length || !accounts || !accounts.length) counts.push(plural(e.fields.length, 'campo', 'campos'));
    if (accounts && accounts.length) counts.push(plural(accounts.length, 'conta', 'contas'));
    t.description = counts.join(' · ');
    t.tooltip = `${e.title}\n{{${e.ref}.…}}${accounts && accounts.length ? '\n\nOs campos daqui valem para todas as contas.' : ''}`;
    const full = values && values.get(e.id);
    t.children = [...e.fields.map((f) => fieldItem(e, f, full)), ...(accounts || []).map((a) => entryItem(a, values))];
    return t;
  }

  function fieldItem(e, f, full) {
    const value = full && (full.fields.find((x) => x.id === f.id) || {}).value;
    const c = new vscode.TreeItem(f.name, None);
    c.id = `cred.f.${e.id}.${f.id}`;
    c.entryId = e.id;
    c.fieldId = f.id;
    const shown = value != null && (!f.secret || revealed.has(f.id));
    // credField, credFieldSecret or credFieldSecret.revealed: the eye shows on secret ones.
    c.contextValue = f.secret ? (revealed.has(f.id) ? 'credFieldSecret.revealed' : 'credFieldSecret') : 'credField';
    c.iconPath = icon(f.secret ? (revealed.has(f.id) ? 'eye' : 'lock-small') : fieldIcon(f.name));
    c.description = shown ? clip(value, 60) : '••••••••';
    c.tooltip = `${f.name}${f.secret ? ' (secreto)' : ''}\nNo segredo: {{${e.ref}.${f.ref}}}\n\nClique para copiar o valor (some da área de transferência em 30 s).`;
    c.command = { command: 'claudeSwitcher.cred.copy', title: 'Copiar', arguments: [c] };
    return c;
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
    const title = await vscode.window.showInputBox({ title: e.parentId ? 'Renomear conta' : 'Renomear credencial', value: e.title, ignoreFocusOut: true });
    if (!title) return;
    const before = refs();
    await vault.renameEntry(e.id, title);
    await edited();
    refsChanged(before);
  }

  // fieldId -> "credencial.campo", to tell the user when an edit changes what Claude has to use.
  const refs = () => new Map(vault.catalog().entries.flatMap((e) => e.fields.map((f) => [f.id, `${e.ref}.${f.ref}`])));

  function refsChanged(before) {
    const changed = [...refs()].filter(([id, ref]) => before.has(id) && before.get(id) !== ref).map(([id, ref]) => `{{${before.get(id)}}} → {{${ref}}}`);
    if (!changed.length) return;
    const shown = changed.slice(0, 4).join(', ') + (changed.length > 4 ? ` e mais ${changed.length - 4}` : '');
    vscode.window.showInformationMessage(`As referências mudaram: ${shown}. Atualize onde elas estiverem escritas (CLAUDE.md, memórias, scripts).`);
  }

  // A new account inside an entry (PHPMYADMIN -> master, cliente X). The first time, the
  // values already in the entry become its first account; the fields left out stay in the
  // entry, shared by every account (a Host, say).
  async function addAccount(item) {
    if (!item || !(await ensureUnlocked())) return;
    const group = vault.entry(item.entryId);
    if (group.parentId) return addAccount({ entryId: group.parentId });
    const before = refs();
    let template = vault.accountsOf(group.id).map((a) => a.fields)[0] || [];
    let changed = false;
    try {
      if (!vault.accountsOf(group.id).length && group.fields.length) {
        const perAccount = await vscode.window.showQuickPick(
          group.fields.map((f) => ({ label: f.name, description: f.secret ? '🔒' : clip(f.value, 40), picked: !/^(host|servidor|url|porta|endere)/i.test(f.name), field: f })),
          {
            title: `${group.title}: o que cada conta tem o seu?`,
            placeHolder: 'Marcados: cada conta tem o seu (Usuário, Senha). Desmarcados: valem para todas (Host).',
            canPickMany: true,
            ignoreFocusOut: true,
          },
        );
        if (!perAccount) return;
        if (perAccount.length) {
          const user = group.fields.find((f) => !f.secret && /^(usu[aá]rio|user|login)/i.test(f.name));
          const name = await vscode.window.showInputBox({
            title: `${group.title}: nome da conta que já está aí`,
            prompt: `Os valores atuais de ${perAccount.map((p) => p.label).join(', ')} viram esta conta.`,
            value: user ? user.value : 'principal',
            ignoreFocusOut: true,
          });
          if (!name) return;
          const first = await vault.addEntry(name, [], group.id);
          await vault.moveFields(group.id, first.id, perAccount.map((p) => p.field.id));
          changed = true;
          template = perAccount.map((p) => p.field);
        }
      }

      const title = await vscode.window.showInputBox({ title: `${group.title}: nova conta`, prompt: 'Nome da conta (ex.: cliente X, só leitura)', ignoreFocusOut: true });
      if (!title) return;
      let fields = template;
      if (template.length) {
        const chosen = await vscode.window.showQuickPick(
          template.map((f) => ({ label: f.name, description: f.secret ? '🔒' : '', picked: true, field: f })),
          { title: `${title}: quais campos esta conta tem?`, placeHolder: 'Dá para adicionar outros depois, pelo + da conta', canPickMany: true, ignoreFocusOut: true },
        );
        if (!chosen) return;
        fields = chosen.map((c) => c.field);
      }
      const values = [];
      for (const f of fields) {
        const value = await vscode.window.showInputBox({ title: `${title}: ${f.name}`, password: f.secret, ignoreFocusOut: true });
        if (value == null) return;
        values.push({ name: f.name, value, secret: f.secret });
      }
      const account = await vault.addEntry(title, values, group.id);
      changed = true;
      if (!values.length) {
        await edited();
        await addField({ entryId: account.id });
      }
    } finally {
      if (changed) {
        await edited();
        refsChanged(before);
      }
    }
  }

  // A field one place up or down inside its entry; an entry or account among its siblings.
  async function shift(item, delta) {
    if (!item || !(await ensureUnlocked())) return;
    const before = refs();
    const moved = item.fieldId ? await vault.shiftField(item.entryId, item.fieldId, delta) : await vault.shiftEntry(item.entryId, delta);
    if (!moved) return;
    await edited();
    refsChanged(before); // two fields with the same name swap "senha" and "senha-2"
  }

  // Puts an entry inside another one as an account, or takes an account out on its own.
  async function moveEntry(item) {
    if (!item || !(await ensureUnlocked())) return;
    const e = vault.entry(item.entryId);
    if (vault.accountsOf(e.id).length) {
      vscode.window.showWarningMessage(`"${e.title}" tem contas dentro, então não entra em outra credencial.`);
      return;
    }
    const targets = vault.entries().filter((x) => !x.parentId && x.id !== e.id && x.id !== e.parentId);
    const picks = [
      ...(e.parentId ? [{ label: '$(key) Fora de qualquer credencial', description: 'vira uma credencial sozinha', parentId: null }] : []),
      ...targets.map((x) => ({ label: `$(account) Conta de ${x.title}`, parentId: x.id })),
    ];
    if (!picks.length) return;
    const to = await vscode.window.showQuickPick(picks, { title: `Mover "${e.title}"`, ignoreFocusOut: true });
    if (!to) return;
    const before = refs();
    await vault.setParent(e.id, to.parentId);
    await edited();
    refsChanged(before);
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
    const accounts = vault.accountsOf(e.id).length;
    const ok = await vscode.window.showWarningMessage(
      `Apagar ${e.parentId ? 'a conta' : 'a credencial'} "${e.title}"?`,
      { modal: true, detail: `Sai do cofre com todos os campos${accounts ? ` e ${plural(accounts, 'conta', 'contas')}` : ''}. Não dá para desfazer.` },
      'Apagar',
    );
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

  // Shows a secret value in the list for REVEAL_MS (or until hidden, or the vault locks).
  async function reveal(item) {
    if (!item || !(await ensureUnlocked('Destrancar para ver.'))) return;
    clearTimeout(revealed.get(item.fieldId));
    revealed.set(
      item.fieldId,
      setTimeout(() => {
        revealed.delete(item.fieldId);
        refresh();
      }, REVEAL_MS),
    );
    refresh();
  }

  function hide(item) {
    if (!item) return;
    clearTimeout(revealed.get(item.fieldId));
    revealed.delete(item.fieldId);
    refresh();
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

  // Every window hears the setting change and re-arms itself (onLockMinutesChanged).
  async function lockTime() {
    const current = lockMinutes();
    const items = LOCK_CHOICES.map((m) => ({ label: `${m === current ? '$(check) ' : ''}${fmtMinutes(m)}`, minutes: m }));
    if (!LOCK_CHOICES.includes(current)) items.unshift({ label: `$(check) ${fmtMinutes(current)}`, minutes: current });
    items.push({ label: 'Outro tempo…', minutes: null });
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Tempo até o cofre trancar sozinho',
      placeHolder: `Hoje: ${fmtMinutes(current)} depois de destrancar`,
    });
    if (!picked) return;
    let minutes = picked.minutes;
    if (minutes == null) {
      const typed = await vscode.window.showInputBox({
        title: 'Tempo até o cofre trancar sozinho',
        prompt: 'Em minutos, de 1 a 720 (12 h).',
        value: String(current),
        validateInput: (v) => (/^\d+$/.test(v.trim()) && +v >= 1 && +v <= 720 ? null : 'Um número de 1 a 720'),
      });
      if (!typed) return;
      minutes = Number(typed.trim());
    }
    if (minutes === current) return;
    await app.config().update('credentials.lockMinutes', minutes, vscode.ConfigurationTarget.Global);
    onLockMinutesChanged();
    vscode.window.showInformationMessage(
      `O cofre agora tranca ${fmtMinutes(minutes)} depois de destrancar.${vault.unlocked ? ` Aberto agora, ele tranca às ${fmtClock(lockAt)}.` : ''}`,
    );
  }

  // An open vault starts counting the new time from now.
  function onLockMinutesChanged() {
    if (vault.unlocked) arm(Date.now() + lockMinutes() * 60 * 1000);
    refresh();
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
    addAccount,
    moveEntry,
    moveUp: (item) => shift(item, -1),
    moveDown: (item) => shift(item, 1),
    renameField,
    toggleSecret,
    removeEntry,
    removeField,
    copy,
    copyRef,
    reveal,
    hide,
    changeMaster,
    lockTime,
  };
  const disposables = [
    vscode.window.onDidChangeWindowState((s) => s.focused && host.touch(true)),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('claudeSwitcher.credentials.lockMinutes') && onLockMinutesChanged()),
    ...Object.entries(commands).map(([name, fn]) => app.access.command(`claudeSwitcher.cred.${name}`, guarded(fn))),
  ];

  return {
    // Without the permission any more, an open vault closes here.
    onAccess() {
      if (!app.access.can('credenciais.usar') && vault.unlocked) lockHere();
      else refresh();
    },
    dispose() {
      clearTimeout(lockTimer);
      hideAll();
      vault.lock();
      host.stop();
      for (const d of disposables) d.dispose();
    },
  };
}

module.exports = { createCredentialsView };
