'use strict';

// VS Code runs this once the extension is uninstalled: takes the autoswitcher's, the topic
// guard's, the same-project and the approvals hooks back out of Claude Code's settings.
const { claudePaths, switcherDir } = require('../core/paths');
const { syncHook, syncTopicHook, syncPeerHook, syncApprovalHook } = require('../core/claudeHook');

syncHook(claudePaths(), switcherDir(), { enabled: false })
  .catch(() => {})
  .then(() => syncTopicHook(claudePaths(), switcherDir(), { enabled: false }))
  .catch(() => {})
  .then(() => syncPeerHook(claudePaths(), switcherDir(), { enabled: false }))
  .catch(() => {})
  .then(() => syncApprovalHook(claudePaths(), switcherDir(), { enabled: false }))
  .catch(() => {});
