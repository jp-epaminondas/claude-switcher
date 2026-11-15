# Claude Account Switcher

Extensão do VS Code para trocar a conta do Claude Code com um clique quando a atual atinge o limite e para ver quando uma conta esgotada volta. Ela também junta no `CLAUDE.md` global as preferências que o Claude salvou de novo em cada projeto.

## Como usar

**Ícone na barra lateral esquerda:** é o ícone de uma pessoa com duas setas circulares, que abre o painel **Contas**.
- Cada conta aparece com o uso das 5h e da semana. Uma conta esgotada mostra quando volta, por exemplo `esgotada · volta 15:30 (em 2h10)`.
- O ícone de cada conta indica o estado: 🟢 em uso, 🔴 esgotada, 🟡 precisa de login, ⚪ disponível.
- **Clique numa conta para passar a usá-la.** Ao passar o mouse aparecem os botões de renomear e remover.
- O painel tem três páginas, uma de cada vez: **Contas**, **Memórias** e **Credenciais**. Para trocar, abra o menu **…** no título do painel e escolha a página; a atual aparece com ✓. Ele sempre abre em Contas.
- No título da página Contas ficam também ＋ adicionar conta e ⟳ atualizar o uso. Trocar para a próxima disponível fica no menu da barra de status e no Ctrl+Shift+P.
- O ícone da barra lateral ganha um número quando há contas esgotadas.

**Barra de status (lado esquerdo):** mostra a conta em uso e o uso das 5h, por exemplo `Conta 1 · 41%`.
- Fica amarela a partir de 80% e vermelha quando a conta esgota.
- `· 2 fora` indica quantas outras contas estão esgotadas.
- Clique para abrir um menu rápido de troca. Para esconder esse indicador, use `claudeSwitcher.showStatusBar`.

**Avisos:**
- Quando a conta em uso esgota, aparece *"Conta 1 esgotou. Volta 15:30. [Trocar para Conta 2]"*. Um clique troca de conta.
- Quando uma conta esgotada volta, aparece *"✅ Conta 3 voltou e já está disponível. [Usar Conta 3]"*.

**Comandos (Ctrl+Shift+P → "Claude Switcher"):** Contas, Trocar para a próxima conta disponível, Adicionar conta, Atualizar uso, Ligar/desligar o autoswitcher, Ligar/desligar o aviso de assunto novo, Ligar/desligar conversas no mesmo projeto, Ligar/desligar as aprovações, Analisar as memórias de novo, Abrir o CLAUDE.md global.

### Autoswitcher

Com o autoswitcher ligado, quando a conta em uso esgota no meio de uma tarefa, o switcher troca para a próxima conta disponível e o Claude Code **continua sozinho**, sem você precisar trocar de conta e digitar "continue".

Para ligar, clique em **Autoswitcher** no fim do painel Contas, ou use o menu da barra de status, ou o comando "Ligar/desligar o autoswitcher". O item mostra `ligado` ou `desligado`. Vale para as conversas já abertas, sem reabrir nada.

Como funciona:
- **Troca antecipada:** ao fim de cada resposta do Claude, o switcher confere o uso da conta. Se ela chegou a 99% da janela de 5h ou da semana, ele já troca, e a próxima mensagem vai pela conta nova. Assim o limite nem chega a cortar uma resposta, e a troca entre mensagens também gasta menos, porque o cache do prompt se perde em toda troca. A conta que ficou nesse limite passa a contar como esgotada até a janela zerar, então nem a troca automática nem a recomendação voltam para ela. Ajuste em `claudeSwitcher.switchAtPercent`; 100 desliga.
- Ao ligar, a extensão instala dois hooks em `~/.claude/settings.json`: `Stop`, para o fim de cada resposta, e `StopFailure`, para quando o limite estoura. Ao desligar, remove os dois e deixa o resto do arquivo como estava. Os hooks precisam do Node.js instalado.
- Quando um turno para por limite de uso, o Claude Code roda o hook `StopFailure`. Ele avisa a extensão, que troca para a próxima conta na mesma ordem do ⭐.
- Em seguida o hook libera o Claude Code, que manda ao modelo uma mensagem dizendo que a conta foi trocada e que ele deve continuar de onde parou. Na conversa ela aparece como "Stop hook feedback".
- Se várias conversas batem no limite ao mesmo tempo, a troca acontece uma vez só e todas continuam na conta nova.
- Se não houver outra conta disponível, a conversa fica parada e aparece um aviso dizendo qual conta volta primeiro. Se a mesma conversa bater no limite em várias contas seguidas, o switcher para de continuar sozinho.
- Se o limite estourar no meio de uma resposta mesmo assim, entra a troca com "continue" descrita acima.
- O autoswitcher também troca de conta quando a consulta de uso mostra que a conta em uso esgotou antes de alguma conversa bater no limite.
- O hook só age enquanto alguma janela do VS Code com o switcher estiver aberta. Ele vale também para o `claude` rodando no terminal.

### Aviso de assunto novo

Cada resposta do Claude relê a conversa inteira. Numa conversa de 500k tokens, até um "ok, roda os testes" relê 500k, e é aí que vai a maior parte do uso. Para um assunto novo, uma conversa nova sai bem mais barata.

Com o aviso ligado (padrão), antes de cada pedido ir para o modelo o switcher olha o tamanho da conversa:
- Abaixo de 150k tokens de contexto (`claudeSwitcher.topicGuardMinContextK`), o pedido segue direto, sem pergunta nenhuma.
- Acima disso, o Haiku compara o pedido com os últimos pedidos da conversa, numa pergunta curta que leva de 5 a 10 s. Respostas curtas ("sim", "continue") e comandos (`/compact`) seguem direto.
- Se for outro assunto, o pedido não entra nessa conversa: o switcher abre uma conversa nova do Claude Code e já envia o pedido nela, sem perguntar. Aparece *"Assunto novo (instalador do bloqueio) numa conversa que já tem 520k tokens de contexto: mandei o pedido para uma conversa nova."*
- O Claude Code só deixa abrir a conversa com o pedido digitado, então o switcher aperta Enter por você, e só enquanto a aba nova estiver na frente. Se você tiver ido para outra janela, o pedido fica digitado na conversa nova e é só apertar Enter.
- Para manter o pedido na conversa antiga, envie o mesmo pedido de novo lá. Depois disso o switcher só olha de novo quando a conversa crescer mais 150k.
- Na dúvida, ou se o Haiku não responder a tempo, o pedido segue.

Ao ligar, a extensão instala um hook `UserPromptSubmit` em `~/.claude/settings.json`, e o remove ao desligar. Liga e desliga pelo menu da barra de status ou pelo comando "Ligar/desligar o aviso de assunto novo".

### Conversas no mesmo projeto

Duas conversas do Claude Code no mesmo projeto ao mesmo tempo, em duas abas ou duas janelas, costumam se atrapalhar. Uma vê no `git status` mudanças que não fez, ou um Edit falha porque o arquivo mudou desde a leitura, e ela perde tempo investigando quem mexeu. Às vezes ela até "conserta" ou faz commit do trabalho da outra.

Com esta opção ligada (padrão), as conversas do mesmo projeto contam umas às outras o que estão fazendo:
- **No pedido:** quando há outra conversa no projeto, o Claude recebe junto com o seu pedido quem é a outra, o que pediram a ela, se está trabalhando ou parada, e quais arquivos ela mudou e ainda não foram para commit. Recebe também as regras para não atrapalhar: não reverter nem consertar o que não fez, reler o arquivo e aplicar só a sua parte, fazer commit só dos seus arquivos e não trocar de branch. As regras vão uma vez. Depois, só o que mudou na outra conversa, e quando ela termina, um aviso de que agora só ele mexe no projeto.
- **O que você vê:** esse aviso vai para o Claude, não para você. Na conversa aparece só uma linha quando outra conversa entra no projeto, como *"Claude Switcher: outra conversa está trabalhando neste projeto (pedido: "…"). Avisei o Claude para não atrapalhar."*, e outra quando ela termina. Quando um comando git é segurado, aparece *"Claude Switcher: segurei `git add -A`, que levaria para o commit mudanças da outra conversa."*
- **Antes de um Edit:** se o arquivo foi mudado pela outra conversa, o Claude é avisado antes de editar, uma vez por mudança dela. O Edit não é bloqueado.
- **Antes de um comando git:** `git add -A`, `git add .`, `git commit -a`, `git stash`, `git checkout -- .`, `git restore`, `git reset --hard` e `git clean -f` são segurados quando levariam para o commit, apagariam ou esconderiam mudanças da outra conversa que ainda não foram para commit. Também são segurados um `git commit` com arquivos dela no índice e uma troca de branch enquanto ela trabalha. O Claude recebe o motivo e o que fazer no lugar, como `git add` só dos arquivos dele. Se o pedido era mesmo esse, ele manda o mesmo comando de novo em até 10 min e o comando passa.
- **Projeto:** é o repositório git da pasta da conversa (ou a própria pasta, fora do git), então conversas em subpastas do mesmo repositório também se enxergam.
- Um arquivo que esta conversa mudou depois da outra passa a contar como dela. Uma conversa sem sinal há mais de 3h fica de fora, e a que fecha sai na hora.
- Só entram as mudanças feitas pelo Edit e pelo Write. Um arquivo mudado por um comando no terminal (um formatador, um script) não aparece como da outra conversa.

Ao ligar, a extensão instala hooks `UserPromptSubmit`, `PreToolUse` (Edit, Write e Bash), `PostToolUse` (Edit e Write), `Stop` e `SessionEnd` em `~/.claude/settings.json`, e os remove ao desligar. Cada conversa guarda o que é dela em `~/.claude-switcher/sessions/`, e os hooks conversam por lá, sem depender de uma janela do VS Code aberta. Por isso vale também para o `claude` no terminal. Cada Edit e Bash espera o hook, que leva cerca de 0,1 s. No menu da barra de status aparece quantas conversas estão no projeto aberto agora. Liga e desliga por esse menu ou pelo comando "Ligar/desligar conversas no mesmo projeto".

### Aprovações

Com várias conversas do Claude Code abertas, em várias abas e janelas, cada pedido de permissão fica esperando na aba dele, e é preciso passar por todas para ver qual está parada. Com esta opção ligada (padrão), os pedidos de todas as conversas, de todas as janelas, vão também para o painel **Aprovações**, abaixo de Contas na barra lateral do switcher.

- **Cada pedido é um cartão** que mostra:
  - de onde ele veio: **Esta janela** ou **Outra janela: Rota7**, em laranja;
  - o título da conversa (o mesmo da aba), o projeto e o último pedido que você fez a ela;
  - o que o Claude quer fazer: o comando com a descrição, o arquivo com as linhas que saem e as que entram, a página, a ferramenta do MCP com os parâmetros;
  - o que o Claude disse logo antes, recolhido.
- **Botões:** **Aprovar**; **Sempre permitir…**, com a regra que o próprio Claude Code sugere, como `Sempre permitir Bash(npm test) neste projeto, só para você`; **Negar**, com um campo opcional para dizer ao Claude o que fazer no lugar; **Parar**, que nega e para o Claude naquela conversa; e **Ir para a conversa**, que traz para a frente a janela e a aba da conversa.
- **A janela em que você está:** todas as janelas mostram os mesmos pedidos, mas só a que está com o foco (ou a última que esteve, se você estiver em outro programa) abre o painel sozinha quando chega um pedido. O cursor fica onde estava. Para não abrir sozinho, desligue `claudeSwitcher.approvalsReveal`.
- A barra de status mostra `🔔 2 aprovações` enquanto houver pedidos esperando, e o ícone do painel ganha o número.
- **O pedido continua na aba também.** Vale a primeira resposta: respondido no painel, o diálogo da aba some; respondido na aba, o cartão some em 1 ou 2 s.
- Uma pergunta do Claude com opções (`AskUserQuestion`) aparece no painel só para avisar, com o botão para ir até a conversa: a resposta precisa ser dada na aba. A aprovação de um plano (`ExitPlanMode`) dá para dar pelo painel.
- **De qual janela veio:** cada janela se marca no ambiente do VS Code, e as conversas que ela abre levam essa marca. Uma conversa aberta antes da extensão carregar é ligada à janela pela pasta. Se nenhuma janela aberta tiver a pasta dela, o cartão diz *Janela não identificada*.
- Só vale para as conversas da extensão do Claude Code no VS Code, onde o diálogo aparece junto. No `claude` do terminal o diálogo só aparece depois do hook, então lá ele não faz nada.

Ao ligar, a extensão instala um hook `PermissionRequest` em `~/.claude/settings.json` e o remove ao desligar. O hook deixa o pedido em `~/.claude-switcher/approvals/` e espera a resposta por até 1 h, só enquanto alguma janela do VS Code com o switcher estiver aberta. Liga e desliga pelo menu da barra de status ou pelo comando "Ligar/desligar as aprovações".

### Qual conta usar (⭐ e 🔥)

No final da lista de contas aparece sempre a melhor conta para usar agora, por exemplo:

```
⭐ Continue na Conta 5
     sobram 61% da semana (≈ 5 sessões de 5h)
     renova amanhã 03:59 (em 15h08)
     use antes que perca
```

Quando a recomendada não é a conta em uso, clique nela na lista para trocar.

**Regra:** use primeiro a conta cuja semana renova antes. O que sobra nela é perdido na renovação, enquanto as outras guardam o saldo para depois. Esse é o melhor critério para não desperdiçar limite, e funciona melhor do que reagir só no último dia, quando o limite de 5h e as horas de sono já não deixam gastar tudo. Algumas regras complementam essa:
- Contas esgotadas, quase vazias (menos de 5% da semana) ou com a semana ainda não iniciada vão para o fim da fila.
- Se a conta em uso renova até 3h depois da melhor, a recomendação é continuar nela. Não vale trocar por tão pouco.
- "Trocar para a próxima conta", o aviso de "esgotou" e o autoswitcher usam essa mesma ordem.

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

**Qual conta usar:** o ⭐ continua seguindo a regra de não desperdiçar a semana. Ele só muda quando outra conta melhora a previsão (de "não aguenta" para "aguenta", ou sem precisar de pausas) ou evita pelo menos 15 min de espera nas próximas 24h. Nesse caso o motivo aparece no próprio ⭐. "Trocar para a próxima conta" e o autoswitcher usam a mesma escolha.

A previsão supõe que todas as contas são do mesmo plano, como as 5 Pro de hoje.

### Memórias: uma regra só, no CLAUDE.md global

As memórias do Claude Code já valem para todas as contas, porque ficam em `~/.claude` e não na conta. Elas ficam presas a cada projeto, porém. Quando você corrige o Claude num projeto (por exemplo, "não coloque coautor nos commits"), ele salva isso na memória daquele projeto. Em outro projeto, ele não sabe e salva de novo.

A página **Memórias** (no menu **…** do painel) só lê as memórias e só gasta tokens quando você clica para analisar. Ela junta essas repetições no `~/.claude/CLAUDE.md`, que vale para todos os projetos:

```
Repetidas nos projetos                        2 para juntar
  ⑂ Responder sempre em português             game-galomovido, profanity-filter, Rota7/web
  ⑂ Sem Co-Authored-By: Claude nos commits    dreamcore, Rota7/web, claude-switcher
Memórias Globais                              3 itens
  graphify
  Preferências
    ⑂ Uma conferência rápida, depois parar    juntada
```

- **Análise:** ao clicar no ⟳ do título, o Claude (modelo Haiku, pelo `claude -p`) lê as memórias de preferência de todos os projetos e agrupa as que dizem a mesma coisa, mesmo com outras palavras ou em outra língua. Entram só as memórias dos tipos `feedback` e `user`. Fatos de um projeto, como servidores e telas, ficam onde estão. A análise usa um pouco do limite da conta em uso e só roda quando você clica. Quando alguma memória ou o `CLAUDE.md` muda depois da última análise, aparece o aviso "As memórias mudaram desde a análise", que também analisa ao ser clicado.
- **Juntar (⑂):** mostra a regra para você editar, grava na seção `# Preferências` do `CLAUDE.md` global e apaga as cópias dos projetos, com os links delas no `MEMORY.md`. A notificação tem **Desfazer**. Se a regra já estava no `CLAUDE.md`, Juntar só apaga as cópias.
- **Ignorar (✕):** some com a sugestão. Clique em "sugestões ignoradas" para mostrar de novo.
- **Nova instrução (＋):** escreva do seu jeito o que o Claude deve fazer, como "quando eu pedir deploy, confere antes se tem commit pendente". O Claude escreve a instrução, escolhe a seção (ou cria uma), diz se ela substitui um item que já existe e avisa quando o pedido parece ser de um projeto só. Nada é gravado antes de você ver a prévia, e dá para editar o texto e desfazer.
- **Remover (🗑):** qualquer seção ou item do `CLAUDE.md` global sai por aqui. Se a regra veio de uma junção, dá para remover e devolver as memórias aos projetos.
- Clique numa memória ou num item para abri-lo no editor.
- **Memórias Projeto (<nome>):** o terceiro grupo mostra o projeto aberto no VS Code agora (a pasta do arquivo no editor) e muda sozinho quando você troca de projeto. Ele traz:
  - o `CLAUDE.md` do projeto (`CLAUDE.md` na raiz e `.claude/CLAUDE.md`), em seções e itens com 🗑;
  - **Nova instrução do projeto…**, igual à global, mas grava no arquivo do projeto e avisa quando o pedido parece valer para todos os projetos;
  - as memórias que o Claude salvou neste projeto, separadas em preferências, fatos e referências. Clique para abrir; o 🗑 apaga (com Desfazer).
- Tudo que sai fica guardado em `~/.claude-switcher/memory-backup/`: as memórias apagadas e as últimas 20 versões do `CLAUDE.md`.

### Credenciais: senhas que o Claude usa sem ver

A página **Credenciais** (no menu **…** do painel) é um cofre criptografado para senhas, chaves e tokens, como os do `server.md`. O Claude usa os valores nos comandos sem nunca vê-los.

- **Cofre:** fica em `~/.claude-switcher/credenciais.vault`, criptografado com AES-256-GCM. A chave sai da sua **senha mestra** pelo scrypt, e a senha mestra não fica guardada em lugar nenhum: sem ela, o cofre não abre. Os nomes das credenciais e dos campos ficam visíveis; os valores, não.
- **Trancado e destrancado:** a senha mestra destranca por 60 min (`claudeSwitcher.credentials.lockMinutes`), em todas as janelas do VS Code ao mesmo tempo. Depois o cofre tranca sozinho. O cadeado no título tranca na hora.
- **Importar:** o botão de importar lê um arquivo como o `server.md` (um título, depois um valor por linha), dá nome a cada valor pelo formato (Host, Usuário, Senha, Chave…) e no fim oferece apagar o original.
- **Na lista:** clique num campo para copiar o valor, que some da área de transferência em 30 s. O 👁 mostra um valor secreto na própria lista por 30 s (ou até clicar de novo, ou o cofre trancar). Os botões editam, renomeiam e apagam. No botão direito, **Mover para cima/para baixo** muda a ordem de um campo, de uma conta ou de uma credencial. O ícone mostra o tipo do campo (usuário, e-mail, URL, host, porta, caminho, banco). Campos não secretos (host, usuário, caminho) mostram o valor quando o cofre está destrancado.
- **Contas:** para ter mais de uma conta no mesmo serviço, use o botão 👤+ da credencial. Na primeira vez, você marca o que cada conta tem o seu (Usuário, Senha). Os valores que já estavam ali viram a primeira conta. O que fica desmarcado (o Host, por exemplo) continua na credencial e vale para todas as contas. Depois cada conta pode ter os campos que você quiser, pelo + dela. A referência de um campo de conta junta os dois nomes: `{{phpmyadmin-master.senha}}`. Quando uma mudança troca alguma referência, a extensão mostra a antiga e a nova. Pelo botão direito, **Mover** põe uma credencial dentro de outra como conta, ou tira uma conta de lá.

**Como o Claude usa:** pelo `segredo`, que a extensão instala em `~/.claude-switcher/segredo.js`:

```sh
node ~/.claude-switcher/segredo.js lista        # nomes, nunca valores
node ~/.claude-switcher/segredo.js exec -- plink -batch -pwfile {{arquivo:server-ssh.senha}} root@host "uptime"
node ~/.claude-switcher/segredo.js exec --env MYSQL_PWD=phpmyadmin.senha -- mysql -u master ...
```

- `{{credencial.campo}}` vira o valor, e `{{arquivo:credencial.campo}}` vira um arquivo temporário com o valor, apagado no fim. `--env` põe o valor numa variável de ambiente.
- Se o cofre estiver trancado, o VS Code mostra qual comando quer qual credencial e pede a senha mestra. Se você negar, o comando não roda.
- O que o comando imprime passa por uma máscara: se um valor aparecer, sai como `••••`. O comando que aparece na conversa só tem a referência, nunca o valor.
- A página mostra os últimos usos (qual credencial, qual comando, quando).

### Adicionar as contas

1. Na primeira vez, a conta que já está logada é salva sozinha como **Conta 1**.
2. No painel, clique em **＋ (Adicionar conta)**. Abre um terminal com `claude auth login`: faça login no navegador com a outra conta. Quando o login terminar, ela aparece na lista.
3. Repita até ter as 5 contas.

> Para trocar de conta use sempre o switcher, **nunca o Logout** do Claude Code.

### Configurações

| Configuração | Padrão | O que faz |
|---|---|---|
| `claudeSwitcher.autoSwitch` | `false` | Autoswitcher: troca sozinho quando a conta em uso esgota e o Claude continua a tarefa |
| `claudeSwitcher.topicGuard` | `true` | Aviso de assunto novo: numa conversa longa, manda o pedido de outro assunto para uma conversa nova |
| `claudeSwitcher.topicGuardMinContextK` | `150` | O aviso de assunto novo só olha conversas com pelo menos estes milhares de tokens de contexto |
| `claudeSwitcher.sameProject` | `true` | Conversas no mesmo projeto: cada conversa sabe o que a outra faz e não leva nem apaga as mudanças dela no git |
| `claudeSwitcher.approvals` | `true` | Aprovações: os pedidos de permissão de todas as conversas, de todas as janelas, num painel só |
| `claudeSwitcher.approvalsReveal` | `true` | Abre o painel Aprovações sozinho, na janela em que você está, quando chega um pedido |
| `claudeSwitcher.switchAtPercent` | `99` | Com o autoswitcher ligado, troca no fim de uma resposta quando a conta chega a esta % (100 desliga) |
| `claudeSwitcher.maxWaitMinutes` | `20` | Tempo máximo, em minutos, que você aceita ficar sem poder usar de uma vez; a previsão planeja contas e pausas por ele |
| `claudeSwitcher.notifyPace` | `true` | Avisos da previsão: pausa, todas as contas para esgotar, contas que não aguentam |
| `claudeSwitcher.pollIntervalMinutes` | `3` | Intervalo, em minutos, entre consultas de uso da conta em uso |
| `claudeSwitcher.notifyWhenBack` | `true` | Avisa quando uma conta esgotada volta |
| `claudeSwitcher.burnWindowHours` | `24` | Quantas horas antes da renovação semanal uma conta com saldo ganha 🔥 |
| `claudeSwitcher.notifyBurn` | `true` | Avisa quando a conta recomendada tem uso prestes a vencer |
| `claudeSwitcher.showStatusBar` | `true` | Também mostra a conta em uso na barra de status |
| `claudeSwitcher.credentials.lockMinutes` | `60` | Minutos que o cofre de credenciais fica destrancado depois da senha mestra |

## Como funciona

- O Claude Code guarda o login em `~/.claude/.credentials.json`. Para trocar de conta, a extensão grava ali o login salvo da conta escolhida, mexendo só no campo `claudeAiOauth`. Também atualiza o `oauthAccount` em `~/.claude.json`, que é o e-mail mostrado no `/status`.
- O Claude Code relê esse arquivo antes de cada requisição. Por isso as conversas abertas passam a usar a conta nova **na próxima mensagem**, sem reiniciar nem recarregar nada.
- O uso vem do mesmo endpoint do `/usage` do Claude Code (`/api/oauth/usage`). A conta em uso é consultada a cada 3 minutos. As outras são consultadas a cada 15 minutos e também na hora exata em que o limite delas zera. A extensão também aproveita as consultas que o próprio Claude Code já faz.
- As memórias são lidas de `~/.claude/projects/<projeto>/memory/`. O estado da página Memórias (análise, ignoradas, junções que dá para desfazer) fica em `~/.claude-switcher/memories.json`.
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
    curator.js       página Memórias: analisa, junta, ignora, remove e desfaz
    memories.js      lê as memórias dos projetos, edita o MEMORY.md e monta a análise
    claudeMd.js      o CLAUDE.md global em seções e itens; adiciona e remove regras
    claudeCli.js     pergunta ao Claude pelo `claude -p`, com resposta em JSON
    vault.js         cofre de credenciais criptografado (AES-256-GCM + scrypt)
    secretBus.js     canal local entre o segredo e as janelas do VS Code
    serverMd.js      importa um arquivo de credenciais em texto (como o server.md)
    usage.js         leitura do /api/oauth/usage e formatação de horários
    api.js           chamadas à API (perfil, uso, renovação de token)
    claudeFiles.js   leitura e escrita dos arquivos do Claude Code
    claudeHook.js    instala e remove os hooks do autoswitcher, do aviso de assunto novo, das conversas no mesmo projeto e das aprovações no settings.json do Claude Code
    limitQueue.js    fila de pedidos entre um hook e a extensão (~/.claude-switcher/limits/ e topics/)
    approvals.js     aprovações: os pedidos de permissão em ~/.claude-switcher/approvals/, as janelas abertas e como cada pedido aparece
    topic.js         aviso de assunto novo: lê o fim da conversa e monta a pergunta ao Haiku
    store.js         accounts.json e memories.json compartilhados entre janelas
    fsutil.js        escrita atômica e lock
    paths.js         onde ficam os arquivos
  hook/
    limit-hook.js    roda dentro do Claude Code no fim de cada resposta e quando o limite estoura (copiado para ~/.claude-switcher/)
    topic-hook.js    roda dentro do Claude Code antes de cada pedido ir para o modelo (copiado para ~/.claude-switcher/)
    peer-hook.js     roda dentro de cada conversa e conta às outras do mesmo projeto o que ela faz; segura o git que levaria o trabalho delas (copiado para ~/.claude-switcher/)
    approval-hook.js roda dentro do Claude Code a cada pedido de permissão e espera a resposta do painel Aprovações (copiado para ~/.claude-switcher/)
    uninstall.js     tira os hooks do settings.json quando a extensão é desinstalada
    segredo.js       o comando que o Claude usa para rodar algo com uma credencial (copiado para ~/.claude-switcher/)
  ui/                tudo que aparece no VS Code
    sidebar.js       o painel da barra lateral, uma página de cada vez
    accountsView.js  página Contas
    memoriesView.js  página Memórias
    credentialsView.js  página Credenciais
    statusBar.js     indicador na barra de status
    menu.js          menu rápido
    actions.js       trocar, adicionar, renomear, remover e as notificações
    autoSwitch.js    liga/desliga o autoswitcher e atende os pedidos do hook
    topicGuard.js    liga/desliga o aviso de assunto novo, atende o hook e manda o pedido para uma conversa nova
    sameProject.js   liga/desliga as conversas no mesmo projeto e conta quantas há no projeto aberto
    approvalsView.js painel Aprovações: marca a janela, mostra os pedidos e manda as respostas
    present.js       textos de cada conta, compartilhados pelas telas
test/                testes do core (pasta temporária, API e Claude falsos, sem rede)
media/               ícone da barra lateral e a página do painel Aprovações
```

```sh
npm test          # roda os testes
npm run package   # gera dist/claude-switcher-<versão>.vsix
code --install-extension dist/claude-switcher-0.10.1.vsix
```

Testado no Windows com o Claude Code 2.1.281. No macOS o Claude Code guarda o login no Keychain, e esta extensão não cobre esse caso.
