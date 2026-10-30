'use strict';

// VS Code runs this once the extension is uninstalled: takes the autoswitcher hook back out
// of Claude Code's settings.
const { claudePaths, switcherDir } = require('../core/paths');
const { syncHook } = require('../core/claudeHook');

syncHook(claudePaths(), switcherDir(), { enabled: false }).catch(() => {});
