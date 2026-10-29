# Claude Account Switcher

Extensão do VS Code para trocar a conta do Claude Code com um clique quando a atual atinge o limite, e para ver quando uma conta esgotada volta.

## Como usar

**Barra de status (canto inferior direito):** mostra a conta em uso e o uso das últimas 5h, por exemplo `Conta 1 · 41%`.
- Fica amarela a partir de 80% e vermelha quando a conta esgota (`Conta 1 esgotada · volta 15:30`).
- `· 2 fora` indica quantas outras contas estão esgotadas.
- Passe o mouse para ver a tabela de todas as contas e clique para abrir o menu.

**Menu:** lista as contas com o uso de 5h e da semana e quando cada esgotada volta. Clique numa conta para trocar para ela. Os ícones ✏️ e 🗑️ renomeiam e removem a conta.

**Avisos:**
- Quando a conta em uso esgota, aparece *"Conta 1 esgotou. Volta 15:30. [Trocar para Conta 2]"*. Um clique troca de conta.
- Quando uma conta esgotada volta, aparece *"✅ Conta 3 voltou e já está disponível. [Usar Conta 3]"*.

**Comandos (Ctrl+Shift+P → "Claude Switcher"):** Contas, Trocar para a próxima conta disponível, Adicionar conta, Atualizar uso.

### Adicionar as contas

1. Na primeira vez, a conta que já está logada é salva sozinha como **Conta 1**.
2. Abra o menu e clique em **Adicionar conta…**. Abre um terminal com `claude auth login`: faça login no navegador com a outra conta. Quando o login terminar, ela aparece na lista.
3. Repita até ter as 5 contas.

> Para trocar de conta use sempre o switcher, **nunca o Logout** do Claude Code.

### Configurações

| Configuração | Padrão | O que faz |
|---|---|---|
| `claudeSwitcher.autoSwitch` | `false` | Troca sozinho quando a conta em uso esgota, sem esperar o clique |
| `claudeSwitcher.pollIntervalMinutes` | `3` | Intervalo, em minutos, entre consultas de uso da conta em uso |
| `claudeSwitcher.notifyWhenBack` | `true` | Avisa quando uma conta esgotada volta |

## Como funciona

- O Claude Code guarda o login em `~/.claude/.credentials.json`. Para trocar de conta, a extensão grava ali o login salvo da conta escolhida, mexendo só no campo `claudeAiOauth`. Também atualiza o `oauthAccount` em `~/.claude.json`, que é o e-mail mostrado no `/status`.
- O Claude Code relê esse arquivo antes de cada requisição. Por isso as conversas abertas passam a usar a conta nova **na próxima mensagem**, sem reiniciar nada. Se precisar, use o botão "Recarregar janela" que aparece depois da troca.
- O uso vem do mesmo endpoint do `/usage` do Claude Code (`/api/oauth/usage`). A conta em uso é consultada a cada 3 minutos. As outras são consultadas a cada 15 minutos e também na hora exata em que o limite delas zera. A extensão também aproveita as consultas que o próprio Claude Code já faz.
- Os logins ficam em `~/.claude-switcher/accounts.json`, um arquivo compartilhado entre todas as janelas do VS Code. Na primeira troca é feita uma cópia dos arquivos originais em `~/.claude-switcher/backup/`.

### Segurança dos tokens

- O token da conta em uso pertence ao Claude Code: a extensão **nunca** renova esse token. Um refresh token pode valer uma vez só, e renová-lo por fora derrubaria o login do Claude Code.
- A extensão só renova o token de uma conta que comprovadamente não está em uso. Ela confirma isso pela API de perfil antes de cada renovação e, na dúvida, não renova.
- A troca respeita o lock que o Claude Code usa ao renovar o token (`~/.claude.lock`). Assim, uma renovação em andamento não sobrescreve a conta recém-trocada.
- `accounts.json` guarda os tokens em texto puro, exatamente como o próprio Claude Code faz com o `.credentials.json`. Não compartilhe esse arquivo.

Diagnóstico: painel **Output → Claude Switcher**.

## Desenvolvimento

```sh
npm test          # testes do núcleo (pasta temporária + API falsa, sem rede)
npm run package   # gera o .vsix
code --install-extension claude-switcher-0.1.0.vsix
```

Testado no Windows com o Claude Code 2.1.281. No macOS o Claude Code guarda o login no Keychain, e esta extensão não cobre esse caso.
