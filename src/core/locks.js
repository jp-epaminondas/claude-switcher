'use strict';

// Travas: what Claude Code's auto mode holds back until the user asks for it in so many words
// (its soft_deny rules, such as Production Deploy), which the user can release for every
// conversation. Releasing one adds an exception to autoMode.allow in ~/.claude/settings.json,
// after the built-in ones ("$defaults"); locking it again takes the exception out. The settings
// file is the only place the state lives. Other modes (edit, plan, normal) keep asking as before.

// Each lock: the row on the page, what auto mode starts doing once it is released, and the
// exception the classifier reads. The rules are prose, named after the built-in rule they clear.
const LOCKS = [
  {
    id: 'prod-deploy',
    label: 'Deploy em produção',
    what: 'fazer deploy em produção e rodar as migrations do banco de produção, sem você nomear o servidor na mensagem',
    rule:
      'o usuário liberou, no Claude Switcher, deploy em produção ou num serviço de produção e as migrations do banco de produção, sem precisar nomear o alvo na mensagem. ' +
      'É exceção à regra Production Deploy e, para os comandos remotos de uma vez só que fazem o deploy (por ssh ou plink: atualizar o código com git pull ou cópia de arquivos, instalar as dependências, rodar as migrations, limpar o cache e reiniciar o serviço), também à regra Remote Shell Writes. ' +
      'Não cobre apagar dados, bancos ou pastas de produção, abrir sessão interativa ou túnel no servidor, nem mostrar segredos: isso continua nas regras de sempre.',
  },
  {
    id: 'prod-read',
    label: 'Ler o servidor de produção',
    what: 'ler o servidor de produção por ssh ou plink (logs, status, crontab, arquivos de código e consultas só de leitura no banco), sem você nomear o servidor na mensagem',
    rule:
      'o usuário liberou, no Claude Switcher, a leitura de um servidor de produção por shell remoto (ssh, plink, docker exec, kubectl exec): logs, status de serviços, crontab, listagem e conteúdo de arquivos de código, e consultas só de leitura no banco de produção, sem precisar nomear o servidor na mensagem. ' +
      'É exceção à regra Production Reads. ' +
      'Não cobre imprimir variáveis de ambiente, arquivos .env ou de configuração com senhas, nem outros segredos.',
  },
  {
    id: 'prod-shell',
    label: 'Mudar o servidor de produção',
    what: 'rodar no servidor de produção, por ssh ou plink, comandos que mudam arquivos, crontab, configuração e serviços, sem você nomear o servidor na mensagem',
    rule:
      'o usuário liberou, no Claude Switcher, comandos de uma vez só que mudam um servidor de produção ou compartilhado por shell remoto (ssh, plink, docker exec, kubectl exec): editar arquivos, crontab, configuração e serviços, sem precisar nomear o servidor na mensagem. ' +
      'É exceção à regra Remote Shell Writes. ' +
      'Não cobre sessão interativa, shell persistente ou túnel (Sensitive Remote Exec), apagar sem volta, nem mostrar segredos.',
  },
  {
    id: 'git-destructive',
    label: 'Git destrutivo',
    what: 'fazer git push --force, apagar branches e tags remotas e reescrever o histórico já enviado do repositório da conversa, sem você nomear a operação na mensagem',
    rule:
      'o usuário liberou, no Claude Switcher, no repositório da conversa: git push --force (de preferência --force-with-lease), apagar branches e tags remotas e reescrever o histórico já enviado, sem precisar nomear a operação na mensagem. ' +
      'É exceção à regra Git Destructive. ' +
      'Não cobre outros repositórios, apagar arquivos locais (git reset --hard, git clean) nem trocar o remote.',
  },
];

const DEFAULTS = '$defaults';
const TAG = /\[Claude Switcher: ([a-z-]+)[,\]]/;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const tagOf = (r) => (typeof r === 'string' && (TAG.exec(r) || [])[1]) || null;

// The text that goes to autoMode.allow for a released lock. The tag is how it is found again.
const entryOf = (lock) => `${lock.label} [Claude Switcher: ${lock.id}, liberado pelo usuário]: ${lock.rule}`;

// The ids of the locks released in these settings, in page order.
function released(settings) {
  const allow = isObject(settings) && isObject(settings.autoMode) && Array.isArray(settings.autoMode.allow) ? settings.autoMode.allow : [];
  const ids = new Set(allow.map(tagOf));
  return LOCKS.filter((l) => ids.has(l.id)).map((l) => l.id);
}

// Leaves released exactly the locks in `ids`, with the current wording, at the end of
// autoMode.allow. The user's own entries stay; so does a list they wrote without "$defaults".
// Settings with nothing of ours, before or after, are not touched.
function setReleased(settings, ids) {
  const auto = isObject(settings.autoMode) ? settings.autoMode : {};
  const before = Array.isArray(auto.allow) ? auto.allow : null;
  const theirs = (before || [DEFAULTS]).filter((r) => !tagOf(r));
  const ours = LOCKS.filter((l) => ids.has(l.id)).map(entryOf);
  if (!ours.length && (!before || before.length === theirs.length)) return;
  const allow = [...theirs, ...ours];
  if (allow.length === 1 && allow[0] === DEFAULTS) delete auto.allow; // the same as no list
  else auto.allow = allow;
  if (Object.keys(auto).length) settings.autoMode = auto;
  else delete settings.autoMode;
}

module.exports = { LOCKS, released, setReleased, entryOf };
