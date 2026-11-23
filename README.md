# Claude Account Switcher

Extensão do VS Code para trocar a conta do Claude Code com um clique quando a atual atinge o limite e para ver quando uma conta esgotada volta. Ela também junta no `CLAUDE.md` global as preferências que o Claude salvou de novo em cada projeto.

## Como usar

**Na primeira vez**, o painel abre na página **Acesso**, e nada mais funciona até você escolher: **Entrar sem login** (tudo liberado, como sempre foi) ou **Entrar em um grupo** (a sua organização confere o login e diz o que cada nível pode usar). Veja [Acesso](#acesso-sem-login-ou-em-um-grupo).

**Ícone na barra lateral esquerda:** é o ícone de uma pessoa com duas setas circulares, que abre o painel **Contas**.
- Cada conta aparece com o uso das 5h e da semana. Uma conta esgotada mostra quando volta, por exemplo `esgotada · volta 15:30 (em 2h10)`.
- O ícone de cada conta indica o estado: 🟢 em uso, 🔴 esgotada, 🟡 precisa de login, ⚪ disponível.
- **Clique numa conta para passar a usá-la.** Ao passar o mouse aparecem os botões de renomear e remover.
- O painel tem sete páginas, uma de cada vez: **Contas**, **Memórias**, **Skills**, **Credenciais**, **Aprovações**, **Travas** e **Acesso**. Para trocar, abra o menu **…** no título do painel e escolha a página; a atual aparece com ✓. Ele sempre abre em Contas. Num grupo, só aparecem as páginas que o seu nível permite.
- No título da página Contas ficam também ＋ adicionar conta e ⟳ atualizar o uso. Trocar para a próxima disponível fica no menu da barra de status e no Ctrl+Shift+P.
- O ícone da barra lateral ganha um número quando há contas esgotadas.

**Barra de status (lado esquerdo):** mostra a conta em uso e o uso das 5h, por exemplo `Conta 1 · 41%`.
- Fica amarela a partir de 80% e vermelha quando a conta esgota.
- `· 2 fora` indica quantas outras contas estão esgotadas.
- Clique para abrir um menu rápido de troca. Para esconder esse indicador, use `claudeSwitcher.showStatusBar`.

**Avisos:**
- Quando a conta em uso esgota, aparece *"Conta 1 esgotou. Volta 15:30. [Trocar para Conta 2]"*. Um clique troca de conta.
- Quando uma conta esgotada volta, aparece *"✅ Conta 3 voltou e já está disponível. [Usar Conta 3]"*.

**Comandos (Ctrl+Shift+P → "Claude Switcher"):** Acesso, Contas, Trocar para a próxima conta disponível, Adicionar conta, Atualizar uso, Ligar/desligar o autoswitcher, Ligar/desligar o aviso de assunto novo, Ligar/desligar conversas no mesmo projeto, Ligar/desligar as aprovações, Analisar as memórias de novo, Abrir o CLAUDE.md global, Procurar tarefas repetidas para virar skills, Nova skill.

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
- **No pedido:** quando outra conversa tem mudanças fora de commit no projeto, o Claude recebe junto com o seu pedido quem é a outra, o que pediram a ela, se está trabalhando ou parada, e quais arquivos ela mudou e ainda não foram para commit. Recebe também as regras para não atrapalhar: não reverter nem consertar o que não fez, reler o arquivo e aplicar só a sua parte, fazer commit só dos seus arquivos e não trocar de branch. As regras vão uma vez. Depois, só o que mudou na outra conversa, e quando ela faz commit ou termina, um aviso de que as mudanças dela saíram do caminho.
- **O que você vê:** esse aviso vai para o Claude, não para você. Na conversa aparece só uma linha na primeira vez que outra conversa tem mudanças no projeto, como *"Claude Switcher: outra conversa tem mudanças neste projeto (pedido: "…"). Avisei o Claude para não atrapalhar."*, e outra quando ela termina. Quando um comando git é segurado, aparece *"Claude Switcher: segurei `git add -A`, que levaria para o commit mudanças da outra conversa."*
- **Antes de um Edit:** se o arquivo foi mudado pela outra conversa, o Claude é avisado antes de editar, uma vez por mudança dela. Também é avisado na primeira vez que edita um repositório fora da pasta da conversa onde outra tem mudanças. O Edit não é bloqueado.
- **Antes de um comando git:** `git add -A`, `git add .`, `git commit -a`, `git stash`, `git checkout -- .`, `git restore`, `git reset --hard` e `git clean -f` são segurados quando levariam para o commit, apagariam ou esconderiam mudanças da outra conversa que ainda não foram para commit. Também são segurados um `git commit` com arquivos dela no índice e uma troca de branch enquanto ela trabalha e já mudou arquivos naquele repositório. Cada comando conta no repositório em que roda (`cd` e `git -C` entram na conta). O Claude recebe o motivo e o que fazer no lugar, como `git add` só dos arquivos dele. Se o pedido era mesmo esse, ele manda o mesmo comando de novo em até 10 min e o comando passa.
- **Projeto:** estar aberta na mesma pasta não basta. Duas conversas estão no mesmo projeto quando uma mudou arquivos num repositório git em que a outra trabalha: o da pasta da conversa (ou a própria pasta, fora do git) ou um em que ela também mudou arquivos. Assim, uma aba nova na mesma janela só é avisada quando a outra tem mudanças ali, e uma conversa de outra janela que mexe nos arquivos deste repositório também entra.
- Um arquivo que esta conversa mudou depois da outra passa a contar como dela. Uma conversa sem sinal há mais de 3h fica de fora, e a que fecha sai na hora.
- Só entram as mudanças feitas pelo Edit e pelo Write. Um arquivo mudado por um comando no terminal (um formatador, um script) não aparece como da outra conversa.

Ao ligar, a extensão instala hooks `UserPromptSubmit`, `PreToolUse` (Edit, Write e Bash), `PostToolUse` (Edit e Write), `Stop` e `SessionEnd` em `~/.claude/settings.json`, e os remove ao desligar. Cada conversa guarda o que é dela em `~/.claude-switcher/sessions/`, e os hooks conversam por lá, sem depender de uma janela do VS Code aberta. Por isso vale também para o `claude` no terminal. Cada Edit e Bash espera o hook, que leva cerca de 0,1 s. No menu da barra de status aparece quantas conversas ativas mudaram arquivos do projeto aberto. Liga e desliga por esse menu ou pelo comando "Ligar/desligar conversas no mesmo projeto".

### Aprovações

Com várias conversas do Claude Code abertas, em várias abas e janelas, cada pedido de permissão fica esperando na aba dele, e é preciso passar por todas para ver qual está parada. Com esta opção ligada (padrão), os pedidos de todas as conversas, de todas as janelas, vão também para a página **Aprovações** do painel do switcher (menu **…** no título do painel).

- **Cada pedido é um cartão** que mostra:
  - de onde ele veio: **Esta janela** ou **Outra janela: Rota7**, em laranja;
  - o título da conversa (o mesmo da aba), o projeto e o último pedido que você fez a ela;
  - o que o Claude quer fazer: o comando com a descrição, o arquivo com as linhas que saem e as que entram, a página, a ferramenta do MCP com os parâmetros;
  - o que o Claude disse logo antes, recolhido.
- **Botões:** **Aprovar**; **Sempre permitir…**, com a regra que o próprio Claude Code sugere, como `Sempre permitir Bash(npm test) neste projeto, só para você`; **Negar**, com um campo opcional para dizer ao Claude o que fazer no lugar; **Parar**, que nega e para o Claude naquela conversa; e **Ir para a conversa**, que traz para a frente a janela e a aba da conversa.
- **A janela em que você está:** todas as janelas mostram os mesmos pedidos, mas só a que está com o foco (ou a última que esteve, se você estiver em outro programa) avisa quando chega um pedido. Você escolhe como ela avisa em `claudeSwitcher.approvalsReveal` ou no menu **…** da página, em "Como avisar dos pedidos de permissão…":
  - **aviso no canto da janela** (padrão), com os botões **Ver** e **Ir para a conversa**. A página não abre sozinha, e o aviso não aparece se a página já estiver aberta;
  - **abrir a página Aprovações**, sem tirar o cursor de onde ele está;
  - **não avisar**: fica só o número da barra de status e do ícone do painel.
- A barra de status mostra `🔔 2 aprovações` enquanto houver pedidos esperando, e o ícone do painel ganha o número mesmo com outra página aberta.
- **O pedido continua na aba também.** Vale a primeira resposta: respondido na página, o diálogo da aba some; respondido na aba, o cartão some em 1 ou 2 s.
- Uma pergunta do Claude com opções (`AskUserQuestion`) aparece na página só para avisar, com o botão para ir até a conversa: a resposta precisa ser dada na aba. A aprovação de um plano (`ExitPlanMode`) dá para dar pela página.
- **De qual janela veio:** cada janela se marca no ambiente do VS Code, e as conversas que ela abre levam essa marca. Uma conversa aberta antes da extensão carregar é ligada à janela pela pasta. Se nenhuma janela aberta tiver a pasta dela, o cartão diz *Janela não identificada*.
- Só vale para as conversas da extensão do Claude Code no VS Code, onde o diálogo aparece junto. No `claude` do terminal o diálogo só aparece depois do hook, então lá ele não faz nada.

Ao ligar, a extensão instala um hook `PermissionRequest` em `~/.claude/settings.json` e o remove ao desligar. O hook deixa o pedido em `~/.claude-switcher/approvals/` e espera a resposta por até 1 h, só enquanto alguma janela do VS Code com o switcher estiver aberta. Liga e desliga pelo menu da barra de status ou pelo comando "Ligar/desligar as aprovações".

### Travas: o que o modo automático pode fazer

No modo automático, o Claude Code segura algumas ações até você pedir com todas as letras na mensagem. Um deploy em produção, por exemplo, só passa se você nomear o servidor. Na página **Travas** (menu **…** do painel), cada uma dessas ações se libera de uma vez, para todas as conversas, e trava de novo com um clique:

- **Deploy em produção:** o deploy e as migrations do banco de produção, junto com os comandos por ssh ou plink que fazem o deploy (git pull, cópia de arquivos, dependências, cache, reiniciar o serviço).
- **Ler o servidor de produção:** logs, status, crontab, arquivos de código e consultas só de leitura no banco, por ssh ou plink.
- **Mudar o servidor de produção:** comandos por ssh ou plink que mudam arquivos, crontab, configuração e serviços.
- **Git destrutivo:** `git push --force`, apagar branches e tags remotas e reescrever o histórico já enviado, no repositório da conversa.

Como funciona:
- Todas começam **travadas**, que é o padrão do Claude Code. Para liberar, marque a caixa; o switcher pergunta antes. Para travar de novo, desmarque, sem pergunta.
- **Só o modo automático muda.** Nos modos editar, plano e normal, o Claude continua pedindo aprovação como antes.
- Algumas ações continuam travadas mesmo assim: apagar dados ou pastas de produção, abrir sessão interativa ou túnel no servidor, mostrar senhas e segredos e mandar dados para fora.
- Liberar põe uma exceção em `autoMode.allow` no `~/.claude/settings.json`, depois das regras que o Claude Code já traz (`"$defaults"`). Travar tira a exceção, e o resto do arquivo fica como estava. Ao passar o mouse na linha, aparece o texto exato. O estado fica só nesse arquivo, então todas as janelas mostram o mesmo, e as conversas abertas passam a valer na próxima ação. Para conferir: `claude auto-mode config`.
- O Claude não se libera sozinho: no modo automático, mudar as próprias permissões sem você pedir é uma das ações seguradas.

### Acesso: sem login ou em um grupo

Antes de a extensão abrir de fato, a página **Acesso** pergunta como você quer usá-la. Até a escolha, nada roda: nem troca de conta, nem hooks, nem cofre.

- **Entrar sem login:** tudo liberado neste computador, inclusive a configuração. É o jeito de sempre.
- **Entrar em um grupo:** você cola a URL de login que a sua organização passou. A próxima tela mostra para onde os seus dados vão e pede o que o login do grupo pede: e-mail e senha, se ele não disser outra coisa. Depois de entrar, só aparece o que o seu acesso permite. As páginas que ele não permite somem do menu **…**, e os comandos dizem *"o seu acesso no grupo Empresa X (OPERADOR) não permite …"*.

A extensão não conhece os níveis, perfis ou papéis de sistema nenhum. Ela só pergunta quais das permissões dela a pessoa tem, e traduzir o jeito de cada sistema para essa lista é trabalho do sistema. Um sistema sem níveis só faz o login, e quem entra tem tudo. A extensão não tem servidor nem banco de dados próprios: ela guarda a URL de login, o formulário e a última resposta (o token e as permissões, nunca a senha) no armazenamento seguro do VS Code. A escolha vale para todas as janelas.

- **A sessão** vale até o token vencer. Depois disso, a extensão trava e pede o login de novo.
- **Conferência:** se o login devolver uma URL de permissões, a extensão pergunta de novo a cada 5 minutos, ou quando você clica em **Conferir agora**. Uma mudança lá vale sem login novo, e um 401 trava na hora. Sem internet, ela segue com as últimas permissões até o token vencer.
- **Para sair do grupo**, use **Sair do grupo** na página Acesso. A extensão volta a perguntar como você quer usar.
- **Limite:** quem bloqueia é a própria extensão, no computador de cada pessoa. Quem escolhe "Entrar sem login" tem tudo, e quem edita o código instalado ou o `settings.json` do VS Code à mão consegue se liberar. O grupo serve para organizar o acesso de uma equipe, não como proteção contra quem quer burlar.

**Permissões que o login pode devolver** (`*` dá todas):

| Permissão | O que libera |
|---|---|
| `contas.usar` | ver as contas e trocar de conta (página Contas, barra de status, menu rápido) |
| `contas.gerenciar` | adicionar, renomear e remover contas |
| `memorias` | a página Memórias |
| `skills` | a página Skills e a análise automática |
| `credenciais.usar` | destrancar o cofre, copiar a referência e deixar o Claude usar os segredos pelo `segredo` |
| `credenciais.gerenciar` | criar, editar, ver, copiar e apagar credenciais, importar e trocar a senha mestra |
| `aprovacoes` | a página Aprovações e responder os pedidos |
| `travas` | a página Travas |
| `configuracao` | ligar e desligar o autoswitcher, o aviso de assunto novo, as conversas no mesmo projeto e as aprovações |

**O contrato com o login do grupo.** Só o token é obrigatório. A URL é `https://` (`http://` só em `localhost`, para testes), e a extensão não segue redirecionamentos. O que vem depois do `?` são campos fixos do login, como a chave de uma aplicação: a extensão tira da URL e manda no corpo.

```
GET  {url}      opcional: o formulário do login
                → 200 { "nome": "Empresa X",
                        "campos": [ { "nome": "usuario", "rotulo": "Usuário" },
                                    { "nome": "password", "rotulo": "Senha", "tipo": "password" } ] }
                qualquer outra resposta (404, uma página): e-mail e senha

POST {url}      os campos do formulário e os campos fixos, em JSON
                → 200 { "token": "…",                       ou "access_token"
                        "usuario": { "nome": "Maria", "nivel": "OPERADOR" },
                        "permissoes": ["contas.usar", "aprovacoes"],
                        "expira_em": "2026-11-23T08:00:00Z",  ou "expires_in" em segundos
                        "permissoes_url": "https://…" }
                → 401 { "erro": "Usuário ou senha inválidos." }
                → 429   muitas tentativas

GET  {permissoes_url}   opcional, com Authorization: Bearer <token>
                → 200 { "permissoes": [ … ] }
                → 401   a sessão acabou
```

- `tipo` de um campo é `text`, `email` ou `password`. A extensão aceita até 6 campos.
- **Sem `permissoes`, a pessoa tem tudo.** Uma lista vazia não dá nada. Uma permissão que a extensão não conhece é ignorada.
- **A validade:** `expira_em`, `expires_in`, a validade escrita no próprio token (o `exp` de um JWT) ou, sem nada disso, 12 horas.
- **O erro:** o `erro` aparece para a pessoa como está, então não ponha detalhes técnicos nele. Sem `erro`, aparece *"Não foi possível entrar com esses dados"*, com o `tipo_erro` quando houver.
- A `permissoes_url` precisa estar no mesmo site do login.

**No Rota7**, o login padrão do Gerenciador já serve, com a chave da aplicação na URL:

```
https://www.rota7solutions.com.br/Gerenciador/api/v1/autenticar?chave_aplicacao=<APLICACAO.CHAVE>
```

- O Gerenciador recusa quem não tem acesso à aplicação daquela chave, e quem tem entra com tudo, porque o login ainda não devolve `permissoes`.
- Os erros vêm com o código do Rota7, como *"Não foi possível entrar com esses dados (código 0103)"*.
- Para o acesso depender do nível, o Gerenciador precisa devolver as `permissoes` da aplicação no login, e, para valer sem login novo, uma `permissoes_url`.
- A chave da aplicação não é segredo: o Gerenciador já a publica em toda página do painel.

**Para testar sem a API de verdade:** `node test/grupoFalso.js` sobe dois logins de teste:
- **O login padrão de um Gerenciador**, em `http://localhost:7318/Gerenciador/api/v1/autenticar?chave_aplicacao=chave-de-teste`. Os usuários são `comum@exemplo.com` e `semacesso@exemplo.com`, com a senha `teste`.
- **Um sistema com formulário próprio e permissões**, em `http://localhost:7317/auth/login`. Os usuários são `admin` e `operador`, com a senha `teste` e o código `123456`.

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
  - **por subprojeto**, quando a pasta reúne vários repositórios (como `Rota7/web`, com `WA/`, `Automacao-Smart/`, `Etapas-Logistica/`…, cada um com seu `.git`). O Claude Code guarda as memórias de todos eles numa pasta só, porque a conversa começa na raiz. A linha **Separar por subprojeto** pede ao Claude (Haiku) que diga de qual subprojeto cada memória trata, pelo nome, pela descrição e pelo começo do README de cada subprojeto, ou se ela vale para todos (**Geral**). Dentro de cada subprojeto continuam as preferências, fatos e referências. A resposta fica guardada: depois só as memórias novas vão para o Claude, na linha **Separar N memórias novas**. O ⟳ ao lado de "Memórias do projeto" separa tudo de novo. Para corrigir uma, clique com o botão direito → **Mover para outro subprojeto…**. O que você move à mão não muda quando separa de novo.
- Tudo que sai fica guardado em `~/.claude-switcher/memory-backup/`: as memórias apagadas e as últimas 20 versões do `CLAUDE.md`.

### Skills: o que você pede de novo e de novo

Uma skill é um arquivo `SKILL.md` que ensina um procedimento ao Claude Code: os passos, os comandos e caminhos certos, as conferências e os erros a evitar. O Claude Code lê só a descrição de cada skill e carrega a skill sozinho quando um pedido combina com ela. Sem a skill, ele redescobre o procedimento a cada conversa, e você corrige as mesmas coisas de novo.

A página **Skills** (no menu **…** do painel) acha essas repetições nas suas conversas:

```
Repetidas nas conversas                       2 para criar
  ✨ Gerar e instalar a versão                 projeto claude-switcher · 5 conversas
  ✨ Subir em commits separados                global · 3 conversas
Skills Globais                                1 skill
  ＋ Nova skill…
  graphify                                    usada 12× · última 18/11
  De plugins e do claude.ai                   33
Skills Projeto (Rota7/web)                    1 skill
  ＋ Nova skill do projeto…
  publicar-pagina                             usada 4× · última 20/11
```

- **Leitura das conversas:** a extensão lê as conversas que o Claude Code salva em `~/.claude/projects/` e guarda só o que interessa: o que você pediu, o tipo de cada comando que rodou (`plink`, `npm run package`, `git cherry-pick`, sem os argumentos) e as skills usadas. Cada conversa é lida uma vez, e depois só o que cresceu. A primeira leitura leva alguns segundos. Essa parte não gasta tokens.
- **Análise:** o Claude (modelo Sonnet, pelo `claude -p`) recebe um resumo das conversas dos últimos 120 dias e aponta as tarefas que voltam, mesmo com outras palavras, e que têm um procedimento que se repete. Ficam de fora as preferências de uma linha (essas vão para o `CLAUDE.md`, pela página Memórias), o trabalho que muda a cada vez e o que uma skill existente já cobre. Quando uma skill existe mas você continua corrigindo o procedimento, ele sugere melhorá-la. Cada sugestão diz se é global ou de um projeto, por que vale, os passos e as conversas de onde saiu.
- **Quando roda:** pelo ⟳ do título, ou sozinha, no máximo uma vez por semana e só quando houver pelo menos 10 conversas novas. Aí chega um aviso com as sugestões novas. Cada análise usa um pouco do limite da conta em uso. Para rodar só pelo botão, desligue `claudeSwitcher.skills.autoAnalyze`.
- **Criar (✨):** o Claude lê os trechos dessas conversas (o que você pediu, o que ele rodou, o que deu erro e o que você corrigiu) e escreve a `SKILL.md`: os comandos que funcionaram, uma seção de cuidados e uma descrição com as palavras que você usa nos pedidos. O rascunho abre no editor. Revise, edite o que quiser e clique em ✓ **Instalar a skill** no título do editor. Nada é instalado antes disso.
- **Revisar com o Claude:** o botão no título do rascunho abre uma conversa nova do Claude Code com o pedido de revisão já digitado; é só apertar Enter. Nela o Claude confere no projeto se os comandos e caminhos existem e corrige o rascunho no mesmo arquivo. Quem instala continua sendo você.
- **Onde fica:** uma skill global vai para `~/.claude/skills/<nome>/SKILL.md` e vale em todos os projetos. Uma de projeto vai para `<projeto>/.claude/skills/<nome>/SKILL.md`. Se já existe uma skill com esse nome, o switcher pergunta antes de substituir. A notificação tem **Desfazer**.
- **Senhas e tokens:** antes de ir para o Claude, o que parece senha, token ou chave nos trechos vira `[segredo]`. As referências do cofre (`{{credencial.campo}}`) ficam. A skill pronta passa pelo mesmo filtro e, com o cofre de credenciais criado, usa o `segredo` nos comandos que precisam de uma credencial.
- **Nova skill (＋):** diga do seu jeito o que a skill faz. O Claude escreve usando como exemplo as conversas parecidas.
- **Ignorar (✕):** a sugestão some, e o Claude é avisado para não sugerir de novo.
- Cada skill mostra quantas vezes foi usada e quando. Uma skill que nunca é usada pode estar com a descrição vaga. O 🗑 apaga a pasta da skill (com Desfazer). As de plugins e do claude.ai só aparecem na lista.
- Tudo que sai fica guardado em `~/.claude-switcher/memory-backup/skills/`. O estado da página fica em `~/.claude-switcher/skills.json`, o resumo das conversas em `conversations.json` e os rascunhos em `skill-drafts/`.

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
| `claudeSwitcher.approvalsReveal` | `notify` | Como a janela em que você está avisa de um pedido novo: `notify` (aviso no canto), `page` (abre a página Aprovações) ou `none` (só o número) |
| `claudeSwitcher.switchAtPercent` | `99` | Com o autoswitcher ligado, troca no fim de uma resposta quando a conta chega a esta % (100 desliga) |
| `claudeSwitcher.maxWaitMinutes` | `20` | Tempo máximo, em minutos, que você aceita ficar sem poder usar de uma vez; a previsão planeja contas e pausas por ele |
| `claudeSwitcher.notifyPace` | `true` | Avisos da previsão: pausa, todas as contas para esgotar, contas que não aguentam |
| `claudeSwitcher.pollIntervalMinutes` | `3` | Intervalo, em minutos, entre consultas de uso da conta em uso |
| `claudeSwitcher.notifyWhenBack` | `true` | Avisa quando uma conta esgotada volta |
| `claudeSwitcher.burnWindowHours` | `24` | Quantas horas antes da renovação semanal uma conta com saldo ganha 🔥 |
| `claudeSwitcher.notifyBurn` | `true` | Avisa quando a conta recomendada tem uso prestes a vencer |
| `claudeSwitcher.showStatusBar` | `true` | Também mostra a conta em uso na barra de status |
| `claudeSwitcher.credentials.lockMinutes` | `60` | Minutos que o cofre de credenciais fica destrancado depois da senha mestra |
| `claudeSwitcher.skills.autoAnalyze` | `true` | Procura sozinha, no máximo uma vez por semana, as tarefas repetidas nas conversas que podem virar skill |

## Como funciona

- O Claude Code guarda o login em `~/.claude/.credentials.json`. Para trocar de conta, a extensão grava ali o login salvo da conta escolhida, mexendo só no campo `claudeAiOauth`. Também atualiza o `oauthAccount` em `~/.claude.json`, que é o e-mail mostrado no `/status`.
- O Claude Code relê esse arquivo antes de cada requisição. Por isso as conversas abertas passam a usar a conta nova **na próxima mensagem**, sem reiniciar nem recarregar nada.
- O uso vem do mesmo endpoint do `/usage` do Claude Code (`/api/oauth/usage`). A conta em uso é consultada a cada 3 minutos. As outras são consultadas a cada 15 minutos e também na hora exata em que o limite delas zera. A extensão também aproveita as consultas que o próprio Claude Code já faz.
- As memórias são lidas de `~/.claude/projects/<projeto>/memory/`. O estado da página Memórias (análise, ignoradas, junções que dá para desfazer, subprojeto de cada memória) fica em `~/.claude-switcher/memories.json`.
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
    curator.js       página Memórias: analisa, junta, ignora, remove, desfaz e separa por subprojeto
    memories.js      lê as memórias dos projetos, edita o MEMORY.md e monta a análise
    claudeMd.js      o CLAUDE.md global em seções e itens; adiciona e remove regras
    conversations.js lê as conversas salvas (só o que é novo) em pedidos, comandos e skills usadas; tira os segredos
    skills.js        as skills que existem, o formato da SKILL.md e o que o Claude recebe para sugerir e escrever uma
    skillCurator.js  página Skills: analisa, escreve o rascunho, instala, desfaz e apaga
    claudeCli.js     pergunta ao Claude pelo `claude -p`, com resposta em JSON
    vault.js         cofre de credenciais criptografado (AES-256-GCM + scrypt)
    secretBus.js     canal local entre o segredo e as janelas do VS Code
    serverMd.js      importa um arquivo de credenciais em texto (como o server.md)
    usage.js         leitura do /api/oauth/usage e formatação de horários
    api.js           chamadas à API (perfil, uso, renovação de token)
    claudeFiles.js   leitura e escrita dos arquivos do Claude Code
    claudeHook.js    instala e remove os hooks do autoswitcher, do aviso de assunto novo, das conversas no mesmo projeto e das aprovações no settings.json do Claude Code; uma escrita de cada vez nesse arquivo
    locks.js         página Travas: as exceções do modo automático em autoMode.allow, liberadas e travadas de novo
    limitQueue.js    fila de pedidos entre um hook e a extensão (~/.claude-switcher/limits/ e topics/)
    access.js        acesso: a URL do grupo, a sessão, o que cada comando e página precisa, e a conversa com a API do grupo
    approvals.js     aprovações: os pedidos de permissão em ~/.claude-switcher/approvals/, as janelas abertas e como cada pedido aparece
    topic.js         aviso de assunto novo: lê o fim da conversa e monta a pergunta ao Haiku
    store.js         accounts.json e memories.json compartilhados entre janelas
    fsutil.js        escrita atômica e lock
    paths.js         onde ficam os arquivos
  hook/
    limit-hook.js    roda dentro do Claude Code no fim de cada resposta e quando o limite estoura (copiado para ~/.claude-switcher/)
    topic-hook.js    roda dentro do Claude Code antes de cada pedido ir para o modelo (copiado para ~/.claude-switcher/)
    peer-hook.js     roda dentro de cada conversa e conta às outras do mesmo projeto o que ela faz; segura o git que levaria o trabalho delas (copiado para ~/.claude-switcher/)
    approval-hook.js roda dentro do Claude Code a cada pedido de permissão e espera a resposta da página Aprovações (copiado para ~/.claude-switcher/)
    uninstall.js     tira os hooks do settings.json quando a extensão é desinstalada
    segredo.js       o comando que o Claude usa para rodar algo com uma credencial (copiado para ~/.claude-switcher/)
  ui/                tudo que aparece no VS Code
    sidebar.js       o painel da barra lateral, uma página de cada vez, só as que o acesso permite
    accessView.js    página Acesso (webview): sem login ou grupo, o login, a sessão guardada e a conferência das permissões
    accountsView.js  página Contas
    memoriesView.js  página Memórias
    skillsView.js    página Skills e os botões do rascunho no editor
    credentialsView.js  página Credenciais
    locksView.js     página Travas: uma caixa por trava, com a pergunta antes de liberar
    statusBar.js     indicador na barra de status
    menu.js          menu rápido
    actions.js       trocar, adicionar, renomear, remover e as notificações
    autoSwitch.js    liga/desliga o autoswitcher e atende os pedidos do hook
    topicGuard.js    liga/desliga o aviso de assunto novo, atende o hook e manda o pedido para uma conversa nova
    sameProject.js   liga/desliga as conversas no mesmo projeto e conta quantas há no projeto aberto
    approvalsView.js página Aprovações (uma webview que entra no lugar da lista): marca a janela, mostra os pedidos e manda as respostas
    present.js       textos de cada conta, compartilhados pelas telas
test/                testes do core (pasta temporária, API e Claude falsos, sem rede); grupoFalso.js é um grupo de teste
media/               ícone da barra lateral, os cartões da página Aprovações e as telas da página Acesso
```

```sh
npm test          # roda os testes
npm run package   # gera dist/claude-switcher-<versão>.vsix
code --install-extension dist/claude-switcher-0.10.1.vsix
```

Testado no Windows com o Claude Code 2.1.281. No macOS o Claude Code guarda o login no Keychain, e esta extensão não cobre esse caso.
