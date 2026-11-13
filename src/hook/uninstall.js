'use strict';

// VS Code runs this once the extension is uninstalled: takes the autoswitcher's and the topic
// guard's hooks back out of Claude Code's settings.
const { claudePaths, switcherDir } = require('../core/paths');
const { syncHook, syncTopicHook } = require('../core/claudeHook');

syncHook(claudePaths(), switcherDir(), { enabled: false })
  .catch(() => {})
  .then(() => syncTopicHook(claudePaths(), switcherDir(), { enabled: false }))
  .catch(() => {});
