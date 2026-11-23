'use strict';

// What the Configurações page shows: every claudeSwitcher.* setting, grouped by subject, each
// group behind the permission of the page it belongs to. The values stay in VS Code's global
// settings. A switch that installs a hook in Claude Code goes through its own command
// (`toggle`), and so does a value that already had a picker elsewhere (`pick`), so a change
// does the same wherever it is made. Numbers offer `choices`, plus any value the schema allows.
const pkg = require('../../package.json');

const SECTION = 'claudeSwitcher';

// 90 -> "1 h 30 min"
const fmtMinutes = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);

const ALERTS = { notify: 'aviso no canto da janela', page: 'abre a página Aprovações', none: 'não avisa' };

const GROUPS = [
  {
    id: 'contas',
    label: 'Contas e autoswitcher',
    icon: 'account',
    permission: 'contas.usar',
    items: [
      { key: 'autoSwitch', label: 'Autoswitcher', toggle: 'claudeSwitcher.toggleAutoSwitch' },
      { key: 'switchAtPercent', label: 'Trocar de conta em', fmt: (v) => (v >= 100 ? '100% (só quando esgota)' : `${v}% do limite`), choices: [90, 95, 97, 98, 99, 100] },
      { key: 'maxWaitMinutes', label: 'Tempo máximo sem o Claude', fmt: fmtMinutes, choices: [5, 10, 20, 30, 60, 120] },
      { key: 'pollIntervalMinutes', label: 'Consultar o uso a cada', fmt: fmtMinutes, choices: [1, 2, 3, 5, 10, 15] },
      { key: 'showStatusBar', label: 'Conta em uso na barra de status' },
    ],
  },
  {
    id: 'avisos',
    label: 'Avisos',
    icon: 'bell',
    permission: 'contas.usar',
    items: [
      { key: 'notifyPace', label: 'Previsão: pausas e contas para esgotar' },
      { key: 'notifyWhenBack', label: 'Conta esgotada que voltou' },
      { key: 'notifyBurn', label: 'Uso prestes a vencer (🔥)' },
      { key: 'burnWindowHours', label: '🔥 quando faltam', fmt: (h) => `${h} h para a semana renovar`, choices: [6, 12, 24, 48, 72] },
    ],
  },
  {
    id: 'conversas',
    label: 'Conversas',
    icon: 'comment-discussion',
    permission: null,
    items: [
      { key: 'topicGuard', label: 'Aviso de assunto novo', toggle: 'claudeSwitcher.toggleTopicGuard' },
      { key: 'topicGuardMinContextK', label: 'Assunto novo a partir de', fmt: (k) => `${k} mil tokens de contexto`, choices: [50, 100, 150, 200, 300] },
      { key: 'sameProject', label: 'Conversas no mesmo projeto', toggle: 'claudeSwitcher.toggleSameProject' },
    ],
  },
  {
    id: 'aprovacoes',
    label: 'Aprovações',
    icon: 'shield',
    permission: 'aprovacoes',
    items: [
      { key: 'approvals', label: 'Pedidos de permissão no painel', toggle: 'claudeSwitcher.toggleApprovals' },
      { key: 'approvalsReveal', label: 'Pedido novo', fmt: (v) => ALERTS[v] || v, pick: 'claudeSwitcher.approvalsAlert' },
    ],
  },
  {
    id: 'credenciais',
    label: 'Credenciais',
    icon: 'key',
    permission: 'credenciais.gerenciar',
    items: [{ key: 'credentials.lockMinutes', label: 'Pedir a senha mestra de novo depois de', fmt: fmtMinutes, pick: 'claudeSwitcher.cred.lockTime' }],
  },
  {
    id: 'skills',
    label: 'Skills',
    icon: 'sparkle',
    permission: 'skills',
    items: [{ key: 'skills.autoAnalyze', label: 'Procurar sozinho tarefas que viram skill' }],
  },
];

const schemaOf = (key) => pkg.contributes.configuration.properties[`${SECTION}.${key}`];
const settingOf = (key) => GROUPS.flatMap((g) => g.items).find((s) => s.key === key);

// What was typed, as a whole number the schema allows; null otherwise.
function parseNumber(key, text) {
  const { minimum = 1, maximum = Infinity } = schemaOf(key);
  const t = String(text).trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= minimum && n <= maximum ? n : null;
}

// The value a project's (or folder's) own settings put over the global one, if any.
const projectValue = (inspected) => (inspected?.workspaceFolderValue !== undefined ? inspected.workspaceFolderValue : inspected?.workspaceValue);

module.exports = { SECTION, GROUPS, fmtMinutes, schemaOf, settingOf, parseNumber, projectValue };
