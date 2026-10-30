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

**Comandos (Ctrl+Shift+P → "Claude Switcher"):** Contas, Trocar para a próxima conta disponível, Adicionar conta, Atualizar uso, Ligar/desligar o autoswitcher.

### Autoswitcher

Com o autoswitcher ligado, quando a conta em uso esgota no meio de uma tarefa, o switcher troca para a próxima conta disponível e o Claude Code **continua sozinho**, sem você precisar trocar de conta e digitar "continue".

Para ligar, clique em **Autoswitcher** no fim do painel Contas, ou use o menu da barra de status, ou o comando "Ligar/desligar o autoswitcher". O item mostra `ligado` ou `desligado`. Vale para as conversas já abertas, sem reabrir nada.

Como funciona:
- Ao ligar, a extensão instala um hook `StopFailure` em `~/.claude/settings.json`. Ao desligar, remove o hook e deixa o resto do arquivo como estava. O hook precisa do Node.js instalado.
- Quando um turno para por limite de uso, o Claude Code roda o hook. Ele avisa a extensão, que troca para a próxima conta na mesma ordem do ⭐.
- Em seguida o hook libera o Claude Code, que manda ao modelo uma mensagem dizendo que a conta foi trocada e que ele deve continuar de onde parou. Na conversa ela aparece como "Stop hook feedback".
- Se várias conversas batem no limite ao mesmo tempo, a troca acontece uma vez só e todas continuam na conta nova.
- Se não houver outra conta disponível, a conversa fica parada e aparece um aviso dizendo qual conta volta primeiro. Se a mesma conversa bater no limite em várias contas seguidas, o switcher para de continuar sozinho.
- O autoswitcher também troca de conta quando a consulta de uso mostra que a conta em uso esgotou antes de alguma conversa bater no limite.
- O hook só age enquanto alguma janela do VS Code com o switcher estiver aberta. Ele vale também para o `claude` rodando no terminal.

### Qual conta usar (⭐ e 🔥)

No final da lista de contas aparece sempre a melhor conta para usar agora, por exemplo:

```
⭐ Continue na Conta 5
     sobram 61% da semana (≈ 5 sessões de 5h)
     renova amanhã 03:59 (em 15h08)
     use antes que perca
```

Quando a recomendada não é a conta em uso, passe o mouse no item ⭐ para ver o botão → que troca para ela.

**Regra:** use primeiro a conta cuja semana renova antes. O que sobra nela é perdido na renovação, enquanto as outras guardam o saldo para depois. Esse é o melhor critério para não desperdiçar limite, e funciona melhor do que reagir só no último dia, quando o limite de 5h e as horas de sono já não deixam gastar tudo. Algumas regras complementam essa:
- Contas esgotadas, quase vazias (menos de 5% da semana) ou com a semana ainda não iniciada vão para o fim da fila.
- Se a conta em uso renova até 3h depois da melhor, a recomendação é continuar nela. Não vale trocar por tão pouco.
- O botão ⇄, o aviso de "esgotou" e o autoswitcher usam essa mesma ordem.

**🔥 Vai perder uso:** marca a conta que ainda tem pelo menos 10% da semana sobrando e se encaixa num destes casos:
- falta até 24h para a semana dela renovar (ajuste em `claudeSwitcher.burnWindowHours`);
- sobra mais do que daria para gastar até a renovação, mesmo usando essa conta metade do tempo.

Se a conta recomendada tem 🔥 e não é a que está em uso, chega um aviso com o botão para trocar, uma vez por semana por conta.

**Aprendizado:** a extensão observa quanto da semana cada sessão de 5h consome nas suas contas. Com isso ela mostra quantas sessões ainda sobram e detecta mais cedo uma conta que não vai dar tempo de gastar. Esse número aparece depois que a extensão acompanha pelo menos uma sessão de 5h com uso real.

### Previsão: nunca ficar sem conta

A extensão aprende o seu ritmo de uso e prevê se as contas aguentam. No painel, abaixo do ⭐, aparece um destes:

```
✅ Previsão: as contas aguentam        nenhuma espera nos próximos 7 dias
⏸ Previsão: faça pausas               pausa de 10 min a cada ~50min de uso
                                        sem pausas: 4h30 parado qui 16:30
⚠ Previsão: as contas não aguentam    ~6h sem poder usar até dom 19:00
                                        adicione 1 conta para dar
```

**Tempo máximo de espera** (`claudeSwitcher.maxWaitMinutes`, padrão 20 min): quanto tempo você aceita ficar sem poder usar o Claude de uma vez. Para mudar, clique na Previsão.

**Pausas:** pausar não devolve uso, porque a janela de 5h zera num horário fixo, 5h depois da primeira mensagem. O tempo total parado é o mesmo com ou sem pausa. A pausa serve para você escolher quando esperar, em pedaços menores que o seu limite, em vez de ser cortado no meio de uma tarefa por mais tempo. Por exemplo, em vez de travar 1h, você faz algumas pausas de 10 min.

**Avisos** (desligue em `claudeSwitcher.notifyPace`):
- *"⏸ Faça uma pausa de 10 min agora"*: aparece depois de ~50 min de uso contínuo, quando o plano pede pausas.
- *"⏳ No ritmo atual, todas as contas esgotam em 25min…"*: aparece antes de todas acabarem ao mesmo tempo.
- *"⚠ No seu ritmo as contas não aguentam… Aumente o tempo de espera ou adicione 1 conta a mais"*: aparece no máximo uma vez por dia. Ele diz quantas contas a mais resolveriam, até 3.

**Como aprende:** a cada consulta de uso, a extensão anota quanto da janela de 5h foi gasto, hora a hora, e guarda os seus últimos 35 dias. Ela não supõe rotina semanal, porque tem dia de trabalhar o dia todo e dia de quase nada, sem regra de dia da semana.
- **Semanas sorteadas:** para prever, ela monta 40 semanas possíveis sorteando dias reais do seu histórico. Os dias recentes pesam mais, então uma mudança de hábito aparece logo.
- **Planejado pelo caso ruim provável:** o plano segue a pior de cada 5 semanas, não a média. Assim os dias puxados ficam cobertos. A Previsão também mostra em quantas de 10 semanas as contas aguentam sem pausas.
- **Hoje entra no cálculo:** se o dia está sendo puxado até agora, o resto dele segue os dias passados que começaram parecidos. Na próxima hora, o ritmo atual pesa mais.
- **Começo:** a previsão da semana começa depois de 3 dias com dados. Antes disso, ela só prevê as próximas 2h pelo ritmo atual. Dias com o VS Code fechado quase o tempo todo (menos de 6h observadas) ficam de fora.

**Qual conta usar:** o ⭐ continua seguindo a regra de não desperdiçar a semana. Ele só muda quando outra conta melhora a previsão (de "não aguenta" para "aguenta", ou sem precisar de pausas) ou evita pelo menos 15 min de espera nas próximas 24h. Nesse caso o motivo aparece no próprio ⭐. O botão ⇄ e o autoswitcher usam a mesma escolha.

A previsão supõe que todas as contas são do mesmo plano, como as 5 Pro de hoje.

### Adicionar as contas

1. Na primeira vez, a conta que já está logada é salva sozinha como **Conta 1**.
2. No painel, clique em **＋ (Adicionar conta)**. Abre um terminal com `claude auth login`: faça login no navegador com a outra conta. Quando o login terminar, ela aparece na lista.
3. Repita até ter as 5 contas.

> Para trocar de conta use sempre o switcher, **nunca o Logout** do Claude Code.

### Configurações

| Configuração | Padrão | O que faz |
|---|---|---|
| `claudeSwitcher.autoSwitch` | `false` | Autoswitcher: troca sozinho quando a conta em uso esgota e o Claude continua a tarefa |
| `claudeSwitcher.maxWaitMinutes` | `20` | Tempo máximo, em minutos, que você aceita ficar sem poder usar de uma vez; a previsão planeja contas e pausas por ele |
| `claudeSwitcher.notifyPace` | `true` | Avisos da previsão: pausa, todas as contas para esgotar, contas que não aguentam |
| `claudeSwitcher.pollIntervalMinutes` | `3` | Intervalo, em minutos, entre consultas de uso da conta em uso |
| `claudeSwitcher.notifyWhenBack` | `true` | Avisa quando uma conta esgotada volta |
| `claudeSwitcher.burnWindowHours` | `24` | Quantas horas antes da renovação semanal uma conta com saldo ganha 🔥 |
| `claudeSwitcher.notifyBurn` | `true` | Avisa quando a conta recomendada tem uso prestes a vencer |
| `claudeSwitcher.showStatusBar` | `true` | Também mostra a conta em uso na barra de status |

## Como funciona

- O Claude Code guarda o login em `~/.claude/.credentials.json`. Para trocar de conta, a extensão grava ali o login salvo da conta escolhida, mexendo só no campo `claudeAiOauth`. Também atualiza o `oauthAccount` em `~/.claude.json`, que é o e-mail mostrado no `/status`.
- O Claude Code relê esse arquivo antes de cada requisição. Por isso as conversas abertas passam a usar a conta nova **na próxima mensagem**, sem reiniciar nem recarregar nada.
- O uso vem do mesmo endpoint do `/usage` do Claude Code (`/api/oauth/usage`). A conta em uso é consultada a cada 3 minutos. As outras são consultadas a cada 15 minutos e também na hora exata em que o limite delas zera. A extensão também aproveita as consultas que o próprio Claude Code já faz.
- Os logins ficam em `~/.claude-switcher/accounts.json`, um arquivo compartilhado entre todas as janelas do VS Code. Na primeira troca é feita uma cópia dos arquivos originais em `~/.claude-switcher/backup/`.

### Segurança dos tokens

- O token da conta em uso pertence ao Claude Code: a extensão **nunca** renova esse token. Um refresh token pode valer uma vez só, e renová-lo por fora derrubaria o login do Claude Code.
- A extensão só renova o token de uma conta que comprovadamente não está em uso. Ela confirma isso pela API de perfil antes de cada renovação e, na dúvida, não renova.
- A troca respeita o lock que o Claude Code usa ao renovar o token (`~/.claude.lock`). Assim, uma renovação em andamento não sobrescreve a conta recém-trocada.
- `accounts.json` guarda os tokens em texto puro, exatamente como o próprio Claude Code faz com o `.credentials.json`. Não compartilhe esse arquivo.

Diagnóstico: painel **Output → Claude Switcher**.

## Desenvolvimento

```
src/
  extension.js       ponto de entrada: monta as peças, registra os comandos, loop de atualização
  core/              lógica sem dependência do VS Code (coberta pelos testes)
    switcher.js      salvar, identificar e trocar contas; consultar uso
    advisor.js       qual conta usar (⭐/🔥) e aprendizado do custo de uma sessão
    demand.js        guarda os seus dias de uso, hora a hora, e sorteia semanas possíveis
    planner.js       simula os próximos 7 dias: esperas, pausas e se as contas aguentam
    usage.js         leitura do /api/oauth/usage e formatação de horários
    api.js           chamadas à API (perfil, uso, renovação de token)
    claudeFiles.js   leitura e escrita dos arquivos do Claude Code
    claudeHook.js    instala e remove o hook do autoswitcher no settings.json do Claude Code
    limitQueue.js    fila de pedidos entre o hook e a extensão (~/.claude-switcher/limits/)
    store.js         accounts.json compartilhado entre janelas
    fsutil.js        escrita atômica e lock
    paths.js         onde ficam os arquivos
  hook/
    limit-hook.js    roda dentro do Claude Code quando o limite estoura (copiado para ~/.claude-switcher/)
    uninstall.js     tira o hook do settings.json quando a extensão é desinstalada
  ui/                tudo que aparece no VS Code
    accountsView.js  painel da barra lateral
    statusBar.js     indicador na barra de status
    menu.js          menu rápido
    actions.js       trocar, adicionar, renomear, remover e as notificações
    autoSwitch.js    liga/desliga o autoswitcher e atende os pedidos do hook
    present.js       textos de cada conta, compartilhados pelas telas
test/                testes do core (pasta temporária + API falsa, sem rede)
media/               ícone da barra lateral
```

```sh
npm test          # roda os testes
npm run package   # gera dist/claude-switcher-<versão>.vsix
code --install-extension dist/claude-switcher-0.5.0.vsix
```

Testado no Windows com o Claude Code 2.1.281. No macOS o Claude Code guarda o login no Keychain, e esta extensão não cobre esse caso.
