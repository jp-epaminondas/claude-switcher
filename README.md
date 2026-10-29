# Claude Account Switcher

Extensão do VS Code para trocar a conta do Claude Code com um clique quando a atual atinge o limite, e para ver quando uma conta esgotada volta.

## Como usar

**Ícone na barra lateral esquerda:** é o ícone de uma pessoa com duas setas circulares, que abre o painel **Contas**.
- Cada conta aparece com o uso das 5h e da semana. Uma conta esgotada mostra quando volta, por exemplo `esgotada · volta 15:30 (em 2h10)`.
- O ícone de cada conta indica o estado: 🟢 em uso, 🔴 esgotada, 🟡 precisa de login, ⚪ disponível.
- **Clique numa conta para passar a usá-la.** Ao passar o mouse aparecem os botões de renomear e remover.
- No topo do painel ficam três botões: ⇄ trocar para a próxima disponível, ＋ adicionar conta e ⟳ atualizar o uso.
- O ícone da barra lateral ganha um número quando há contas esgotadas.

**Barra de status (lado esquerdo):** mostra a conta em uso e o uso das 5h, por exemplo `Conta 1 · 41%`.
- Fica amarela a partir de 80% e vermelha quando a conta esgota.
- `· 2 fora` indica quantas outras contas estão esgotadas.
- Clique para abrir um menu rápido de troca. Para esconder esse indicador, use `claudeSwitcher.showStatusBar`.

**Avisos:**
- Quando a conta em uso esgota, aparece *"Conta 1 esgotou. Volta 15:30. [Trocar para Conta 2]"*. Um clique troca de conta.
- Quando uma conta esgotada volta, aparece *"✅ Conta 3 voltou e já está disponível. [Usar Conta 3]"*.

**Comandos (Ctrl+Shift+P → "Claude Switcher"):** Contas, Trocar para a próxima conta disponível, Adicionar conta, Atualizar uso.

### Qual conta usar (⭐ e 🔥)

No topo do painel aparece sempre uma frase com a melhor conta para usar agora, por exemplo:

> ⭐ Continue na Conta 5: sobram 61% da semana (≈ 5 sessões de 5h) e ela renova amanhã 03:59 (em 15h08), use antes que perca.

**Regra:** use primeiro a conta cuja semana renova antes. O que sobra nela é perdido na renovação, enquanto as outras guardam o saldo para depois. Esse é o melhor critério para não desperdiçar limite, e funciona melhor do que reagir só no último dia, quando o limite de 5h e as horas de sono já não deixam gastar tudo. Algumas regras complementam essa:
- Contas esgotadas, quase vazias (menos de 5% da semana) ou com a semana ainda não iniciada vão para o fim da fila.
- Se a conta em uso renova até 3h depois da melhor, a recomendação é continuar nela. Não vale trocar por tão pouco.
- O botão ⇄, o aviso de "esgotou" e o `autoSwitch` usam essa mesma ordem.

**🔥 Vai perder uso:** marca a conta que ainda tem pelo menos 10% da semana sobrando e se encaixa num destes casos:
- falta até 24h para a semana dela renovar (ajuste em `claudeSwitcher.burnWindowHours`);
- sobra mais do que daria para gastar até a renovação, mesmo usando essa conta metade do tempo.

Se a conta recomendada tem 🔥 e não é a que está em uso, chega um aviso com o botão para trocar, uma vez por semana por conta.

**Aprendizado:** a extensão observa quanto da semana cada sessão de 5h consome nas suas contas. Com isso ela mostra quantas sessões ainda sobram e detecta mais cedo uma conta que não vai dar tempo de gastar. Esse número aparece depois que a extensão acompanha pelo menos uma sessão de 5h com uso real.

### Adicionar as contas

1. Na primeira vez, a conta que já está logada é salva sozinha como **Conta 1**.
2. No painel, clique em **＋ (Adicionar conta)**. Abre um terminal com `claude auth login`: faça login no navegador com a outra conta. Quando o login terminar, ela aparece na lista.
3. Repita até ter as 5 contas.

> Para trocar de conta use sempre o switcher, **nunca o Logout** do Claude Code.

### Configurações

| Configuração | Padrão | O que faz |
|---|---|---|
| `claudeSwitcher.autoSwitch` | `false` | Troca sozinho quando a conta em uso esgota, sem esperar o clique |
| `claudeSwitcher.pollIntervalMinutes` | `3` | Intervalo, em minutos, entre consultas de uso da conta em uso |
| `claudeSwitcher.notifyWhenBack` | `true` | Avisa quando uma conta esgotada volta |
| `claudeSwitcher.burnWindowHours` | `24` | Quantas horas antes da renovação semanal uma conta com saldo ganha 🔥 |
| `claudeSwitcher.notifyBurn` | `true` | Avisa quando a conta recomendada tem uso prestes a vencer |
| `claudeSwitcher.showStatusBar` | `true` | Também mostra a conta em uso na barra de status |

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
code --install-extension claude-switcher-0.2.0.vsix
```

Testado no Windows com o Claude Code 2.1.281. No macOS o Claude Code guarda o login no Keychain, e esta extensão não cobre esse caso.
