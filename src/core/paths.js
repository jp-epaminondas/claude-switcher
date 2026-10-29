'use strict';

const os = require('os');
const path = require('path');

// Same locations Claude Code itself uses (CLAUDE_CONFIG_DIR moves both files).
function claudePaths() {
  const custom = process.env.CLAUDE_CONFIG_DIR;
  const configDir = custom || path.join(os.homedir(), '.claude');
  return {
    configDir,
    credentials: path.join(configDir, '.credentials.json'),
    globalConfig: custom ? path.join(custom, '.claude.json') : path.join(os.homedir(), '.claude.json'),
  };
}

function switcherDir() {
  return process.env.CLAUDE_SWITCHER_DIR || path.join(os.homedir(), '.claude-switcher');
}

module.exports = { claudePaths, switcherDir };
