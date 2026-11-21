'use strict';

// VS Code runs this once the extension is uninstalled: takes the autoswitcher's, the topic
// guard's, the same-project and the approvals hooks back out of Claude Code's settings, and
// locks again whatever was released on the Travas page, which won't be there to lock it.
const { claudePaths, switcherDir } = require('../core/paths');
const { syncHook, syncTopicHook, syncPeerHook, syncApprovalHook, updateSettings } = require('../core/claudeHook');
const { setReleased } = require('../core/locks');

syncHook(claudePaths(), switcherDir(), { enabled: false })
  .catch(() => {})
  .then(() => syncTopicHook(claudePaths(), switcherDir(), { enabled: false }))
  .catch(() => {})
  .then(() => syncPeerHook(claudePaths(), switcherDir(), { enabled: false }))
  .catch(() => {})
  .then(() => syncApprovalHook(claudePaths(), switcherDir(), { enabled: false }))
  .catch(() => {})
  .then(() => updateSettings(claudePaths(), (s) => setReleased(s, new Set())))
  .catch(() => {});
