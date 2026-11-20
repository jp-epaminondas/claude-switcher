'use strict';

// Entry point: builds the pieces, registers the commands and runs the refresh loop.
const vscode = require('vscode');
const fs = require('fs');
const { claudePaths, switcherDir } = require('./core/paths');
const { Store } = require('./core/store');
const { Switcher } = require('./core/switcher');
const { mtime } = require('./core/fsutil');
const { adviseWithPlan } = require('./core/planner');
const { Curator } = require('./core/curator');
const { SkillCurator } = require('./core/skillCurator');
const { runClaude } = require('./core/claudeCli');
const { createActions, claudeExecutable } = require('./ui/actions');
const { createSidebar } = require('./ui/sidebar');
const { createAccountsView } = require('./ui/accountsView');
const { createMenu } = require('./ui/menu');
const { createStatusBar } = require('./ui/statusBar');
const { createAutoSwitch } = require('./ui/autoSwitch');
const { createTopicGuard } = require('./ui/topicGuard');
const { createSameProject } = require('./ui/sameProject');
const { createApprovals } = require('./ui/approvalsView');
const { createMemoriesView } = require('./ui/memoriesView');
const { createSkillsView } = require('./ui/skillsView');
const { createCredentialsView } = require('./ui/credentialsView');

const MINUTE = 60 * 1000;

function activate(context) {
  const output = vscode.window.createOutputChannel('Claude Switcher');
  const config = () => vscode.workspace.getConfiguration('claudeSwitcher');
  const adviceOptions = () => ({
    burnWindowHours: Math.max(1, Number(config().get('burnWindowHours')) || 24),
    maxWaitMin: Math.max(1, Number(config().get('maxWaitMinutes')) || 20),
    notifyPace: config().get('notifyPace', true),
  });
  const rank = (data, now) => adviseWithPlan(data, now, adviceOptions());
  const log = (msg) => output.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
  const paths = claudePaths();
  const dir = switcherDir();
  const store = new Store(dir);

  // Shared by every UI module.
  const app = {
    paths,
    switcherDir: dir,
    store,
    sw: new Switcher({ paths, store, switcherDir: dir, log, rank }),
    log,
    config,
    advise: rank,
    render: () => render(),
    tick: (opts) => tick(opts),
  };
  // Questions to Claude run from the switcher's own folder, which has no project settings or memories.
  app.askClaude = (q) => {
    fs.mkdirSync(dir, { recursive: true });
    return runClaude({ exe: claudeExecutable(), cwd: dir, ...q });
  };
  app.curator = new Curator({ paths, switcherDir: dir, log, run: app.askClaude });
  app.skillCurator = new SkillCurator({ paths, switcherDir: dir, log, run: app.askClaude });
  const actions = createActions(app);
  const menu = createMenu(app, actions);
  const sidebar = createSidebar();
  const accountsView = createAccountsView(app, sidebar); // first page: the one that opens
  const statusBar = createStatusBar(app);
  const autoSwitch = (app.autoSwitch = createAutoSwitch(app));
  const topicGuard = (app.topicGuard = createTopicGuard(app));
  const sameProject = (app.sameProject = createSameProject(app));
  const approvals = (app.approvals = createApprovals(app, sidebar));
  const memoriesView = createMemoriesView(app, sidebar);
  const skillsView = createSkillsView(app, sidebar);
  const credentialsView = createCredentialsView(app, sidebar);

  context.subscriptions.push(
    output,
    sidebar,
    statusBar,
    autoSwitch,
    topicGuard,
    sameProject,
    approvals,
    memoriesView,
    skillsView,
    credentialsView,
    vscode.commands.registerCommand('claudeSwitcher.menu', menu.show),
    vscode.commands.registerCommand('claudeSwitcher.switchNext', actions.switchNext),
    vscode.commands.registerCommand('claudeSwitcher.addAccount', actions.addAccount),
    vscode.commands.registerCommand('claudeSwitcher.refresh', () => tick({ force: true })),
    vscode.commands.registerCommand('claudeSwitcher.toggleAutoSwitch', autoSwitch.toggle),
    vscode.commands.registerCommand('claudeSwitcher.toggleTopicGuard', topicGuard.toggle),
    vscode.commands.registerCommand('claudeSwitcher.toggleSameProject', sameProject.toggle),
    vscode.commands.registerCommand('claudeSwitcher.toggleApprovals', approvals.toggle),
    vscode.commands.registerCommand('claudeSwitcher.useAccount', (arg) => actions.withAccount(arg, actions.pickAccount)),
    vscode.commands.registerCommand('claudeSwitcher.renameAccount', (arg) => actions.withAccount(arg, actions.renameAccount)),
    vscode.commands.registerCommand('claudeSwitcher.removeAccount', (arg) => actions.withAccount(arg, actions.removeAccount)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeSwitcher.autoSwitch') || e.affectsConfiguration('claudeSwitcher.switchAtPercent')) {
        autoSwitch.onConfigChanged();
      }
      else if (e.affectsConfiguration('claudeSwitcher.topicGuard')) topicGuard.onConfigChanged();
      else if (e.affectsConfiguration('claudeSwitcher.sameProject')) sameProject.onConfigChanged();
      else if (e.affectsConfiguration('claudeSwitcher.approvals')) approvals.onConfigChanged();
      else if (e.affectsConfiguration('claudeSwitcher')) render();
    }),
  );

  function render() {
    let data;
    try {
      data = store.load();
    } catch (e) {
      statusBar.showError(e);
      accountsView.refresh();
      return;
    }
    const now = Date.now();
    accountsView.refresh(data, now);
    statusBar.update(data, app.advise(data, now), now);
    menu.refresh();
  }

  // One pass: follow logins/refreshes, pick up usage, report accounts that ran out or came back.
  let ticking = false;
  let tickAgain = false;
  let forceAgain = false;
  let lastCredMtime = -1;
  let lastConfigMtime = -1;
  let lastSyncAt = 0;

  async function tick({ force = false } = {}) {
    if (ticking) {
      tickAgain = true;
      forceAgain = forceAgain || force;
      return;
    }
    ticking = true;
    try {
      const credMtime = mtime(paths.credentials);
      if (force || credMtime !== lastCredMtime || Date.now() - lastSyncAt > 5 * MINUTE) {
        lastCredMtime = credMtime;
        lastSyncAt = Date.now();
        const added = await app.sw.syncLive();
        if (added) vscode.window.showInformationMessage(`Claude Switcher: ${added.label} salva (${added.email}).`);
      }
      const configMtime = mtime(paths.globalConfig);
      if (configMtime !== lastConfigMtime) {
        lastConfigMtime = configMtime;
        await app.sw.absorbClaudeCache();
      }
      const activeEveryMs = Math.max(1, Number(config().get('pollIntervalMinutes')) || 3) * MINUTE;
      await app.sw.refreshUsage({ force, activeEveryMs });
      for (const ev of await app.sw.collectEvents(adviceOptions())) actions.onEvent(ev);
    } catch (e) {
      lastCredMtime = -1; // retry the sync on the next tick
      log(`erro: ${e.stack || e.message}`);
    } finally {
      ticking = false;
      render();
      if (tickAgain) {
        const f = forceAgain;
        tickAgain = forceAgain = false;
        tick({ force: f });
      }
    }
  }

  // Claude Code rewrites the first two when it refreshes a token or someone logs in; other
  // VS Code windows rewrite the store. Polling stat() is cheap and dependable on Windows.
  const watched = [
    [paths.credentials, 2000, () => tick()],
    [paths.globalConfig, 5000, () => tick()],
    [store.file, 2000, () => render()],
  ];
  for (const [file, interval, fn] of watched) fs.watchFile(file, { interval }, fn);
  const timer = setInterval(() => tick(), 30 * 1000);
  context.subscriptions.push({
    dispose() {
      clearInterval(timer);
      for (const [file] of watched) fs.unwatchFile(file);
    },
  });

  render();
  tick();
}

function deactivate() {}

module.exports = { activate, deactivate };
