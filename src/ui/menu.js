'use strict';

// Quick menu opened from the status bar: pick an account or run an action.
const vscode = require('vscode');
const { reason } = require('../core/advisor');
const { accountState, usageSummary, flagOf } = require('./present');

function createMenu(app, actions) {
  let fill = null; // set while the menu is open

  function show() {
    const qp = vscode.window.createQuickPick();
    qp.title = 'Contas do Claude';
    qp.placeholder = 'Escolha a conta que o Claude Code vai usar';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    const keyOf = (item) => (item.account ? item.account.id : item.action);
    const flags = { best: '⭐ recomendada  ·  ', burn: '🔥 vai perder uso  ·  ' };

    fill = () => {
      let data;
      try {
        data = app.store.load();
      } catch (e) {
        qp.items = [{ label: `$(error) ${e.message}` }];
        return;
      }
      const now = Date.now();
      const advice = app.advise(data, now);
      const next = advice.next;
      const items = [
        ...data.accounts.map((a) => {
          const s = accountState(a, data, now);
          return {
            label: `$(${s.icon}) ${a.label}`,
            description: a.email,
            detail: `${flags[flagOf(a, advice)] || ''}${s.situation}  ·  ${usageSummary(a, now)}`,
            account: a,
            buttons: [
              { iconPath: new vscode.ThemeIcon('edit'), tooltip: 'Renomear', action: 'rename' },
              { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Remover do switcher', action: 'remove' },
            ],
          };
        }),
        { label: 'Ações', kind: vscode.QuickPickItemKind.Separator },
        {
          label: '$(arrow-swap) Trocar para a próxima disponível',
          description: next ? `→ ${next.acc.label}` : 'nenhuma disponível agora',
          detail: next ? reason(next, now) : undefined,
          action: 'next',
        },
        app.autoSwitch && app.autoSwitch.enabled()
          ? { label: '$(sync) Desligar autoswitcher', description: 'ligado: troca e continua sozinho', action: 'auto' }
          : { label: '$(sync-ignored) Ligar autoswitcher', description: 'troca e continua sozinho quando a conta esgota', action: 'auto' },
        { label: '$(add) Adicionar conta…', action: 'add' },
        { label: '$(refresh) Atualizar uso agora', action: 'refresh' },
      ];
      // Keep the highlighted row when the list refreshes underneath the user.
      const activeKey = qp.activeItems[0] && keyOf(qp.activeItems[0]);
      qp.items = items;
      const again = activeKey && items.find((i) => keyOf(i) === activeKey);
      if (again) qp.activeItems = [again];
    };

    qp.onDidTriggerItemButton(({ item, button }) => {
      qp.hide();
      if (button.action === 'rename') actions.renameAccount(item.account);
      else if (button.action === 'remove') actions.removeAccount(item.account);
    });
    qp.onDidAccept(() => {
      const item = qp.selectedItems[0];
      qp.hide();
      if (!item) return;
      if (item.action === 'next') actions.switchNext();
      else if (item.action === 'auto') app.autoSwitch.toggle();
      else if (item.action === 'add') actions.addAccount();
      else if (item.action === 'refresh') app.tick({ force: true });
      else if (item.account) actions.pickAccount(item.account);
    });
    qp.onDidHide(() => {
      fill = null;
      qp.dispose();
    });

    fill();
    qp.show();
  }

  return { show, refresh: () => fill && fill() };
}

module.exports = { createMenu };
