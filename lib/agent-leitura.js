'use strict';

// Classifica um comando de shell como SOMENTE LEITURA ou não.
//
// Por que isto existe: o portão de aprovação do agente autônomo era uma lista
// de ~19 expressões regulares de comandos "perigosos". Tudo que não casasse
// rodava sem perguntar. Medido contra 23 comandos claramente destrutivos, 15
// passavam — entre eles `mv /usr /usr.bak`, `mysql -e 'DROP DATABASE producao'`,
// `curl -d @/etc/shadow`, e plantar chave em authorized_keys. Não é um buraco
// que se tape acrescentando padrões: a mesma ação tem infinitas grafias, e a
// lista de bloqueio sempre perde para quem escreve o comando.
//
// A saída é inverter o padrão: em vez de "bloqueia o que parece ruim", passa a
// ser "só dispensa aprovação o que RECONHECIDAMENTE não altera nada". Qualquer
// coisa que este módulo não entenda cai em `false` e vai para o analista.
// Errar aqui custa uma pergunta a mais, não um servidor a menos.
//
// Isto NÃO é uma caixa de areia. Um comando de leitura ainda lê segredo
// (`cat ~/.ssh/id_rsa`) e a saída ainda é enviada para a API do modelo. O que
// se garante é bem mais estreito: o comando não MODIFICA o sistema.

// Estrutura de shell que torna a análise inviável: substituição de comando,
// redirecionamento para arquivo, segundo plano, nova linha. Qualquer um deles
// já manda o comando para aprovação, sem tentar entender.
const ESTRUTURA_PROIBIDA = [
  [/\$\(|`/, 'substituição de comando'],
  [/>/, 'redirecionamento para arquivo'],
  [/<\(/, 'substituição de processo'],
  // `&&` é encadeamento, não segundo plano — a lookbehind evita confundir os
  // dois e barrar `ls && cat f` à toa.
  [/(?<!&)&(?!&)/, 'execução em segundo plano'],
  [/[\n\r]/, 'múltiplas linhas'],
];

// Descartar stderr é rotina em diagnóstico (`grep x f 2>/dev/null`) e não
// escreve em lugar nenhum. Qualquer OUTRO destino de redirecionamento grava —
// inclusive `2>/etc/passwd`, que passava quando a regra olhava só o caractere
// anterior ao sinal.
const REDIRECIONA_PARA_NADA = /\d*>>?\s*\/dev\/null/g;

// Separadores que encadeiam comandos. Cada pedaço é analisado por si.
const SEPARADORES = /\|\||&&|\||;/;

// Comandos que só leem. O valor é a política de argumentos:
//   true            — qualquer argumento serve
//   { proibidos }   — recusa se algum argumento casar (com `motivo` opcional)
//   { apenas }      — o primeiro argumento precisa estar nesta lista
const LEITURA = {
  // arquivos e diretórios
  ls: true, dir: true, pwd: true, cat: true, head: true,
  // `-f` fica seguindo o arquivo até o timeout e queima o passo do agente.
  tail: { proibidos: /^(-f|-F|--follow)(=|$)/, motivo: 'fica seguindo o arquivo e trava o passo até o tempo esgotar' },
  file: true, stat: true, wc: true, du: true, df: true, tree: true,
  realpath: true, readlink: true, basename: true, dirname: true,
  md5sum: true, sha256sum: true, cksum: true, cmp: true, diff: true,
  // `find` executa comando e apaga se deixarem
  find: { proibidos: /^-(delete|exec|execdir|ok|okdir|fls|fprint|fprintf|fprint0)$/ },
  // texto
  grep: true, egrep: true, fgrep: true, rg: true, ag: true,
  // `sed -i` grava no arquivo
  sed: { proibidos: /^(-i|--in-place)(=|$)/ },
  sort: true, uniq: true, cut: true, tr: true, rev: true, column: true,
  jq: true, yq: true, xxd: true, od: true, strings: true, base64: true,
  // processos e sistema
  // top/htop ficam interativos e só saem no timeout — `ps` cobre o caso.
  ps: true, uptime: true, free: true, vmstat: true,
  iostat: true, mpstat: true, sar: true, lsof: true, pgrep: true,
  uname: true, hostname: true, hostnamectl: true, whoami: true, id: true,
  who: true, w: true, last: true, date: true, cal: true, env: true,
  printenv: true, locale: true, lscpu: true, lsblk: true, lsusb: true,
  lspci: true, dmidecode: true, sensors: true, nproc: true, arch: true,
  dmesg: { proibidos: /^(-C|--clear|-c|--read-clear)$/ },
  // rede (diagnóstico)
  ip: { proibidos: /^(add|del|set|flush|change|replace)$/ },
  ifconfig: true, netstat: true, ss: true, route: true, arp: true,
  dig: true, nslookup: true, host: true, whois: true, traceroute: true,
  mtr: true, nc: { apenas: ['-z'] },
  ping: true, ping6: true, getent: true,
  // serviços: só os verbos que consultam
  systemctl: { apenas: ['status', 'show', 'cat', 'list-units', 'list-unit-files',
    'list-timers', 'list-sockets', 'is-active', 'is-enabled', 'is-failed', 'get-default'] },
  journalctl: { proibidos: /^(--vacuum-size|--vacuum-time|--vacuum-files|--rotate|--flush)/ },
  service: { apenas: ['status'] },
  initctl: { apenas: ['status', 'list'] },
  supervisorctl: { apenas: ['status'] },
  // pacotes: só consulta
  dpkg: { apenas: ['-l', '-L', '-s', '-S', '--list', '--status', '--listfiles'] },
  rpm: { apenas: ['-q', '-qa', '-qi', '-ql', '-qf'] },
  apt: { apenas: ['list', 'show', 'search', 'policy'] },
  'apt-cache': true,
  yum: { apenas: ['list', 'info', 'search'] },
  dnf: { apenas: ['list', 'info', 'search'] },
  brew: { apenas: ['list', 'info', 'outdated', 'config'] },
  pip: { apenas: ['list', 'show', 'freeze'] },
  npm: { apenas: ['ls', 'list', 'view', 'outdated', 'config'] },
  // contêineres e orquestração: só consulta
  docker: { apenas: ['ps', 'logs', 'inspect', 'images', 'version', 'info', 'port', 'diff'],
    proibidos: /^(-f|--follow)(=|$)/, motivo: 'seguir o log trava o passo até o tempo esgotar' },
  podman: { apenas: ['ps', 'logs', 'inspect', 'images', 'stats', 'version', 'info'] },
  kubectl: { apenas: ['get', 'describe', 'logs', 'top', 'version', 'explain', 'api-resources'] },
  // controle de versão: só consulta
  // `config` saiu da lista: `git config core.pager "sh -c ..."` GRAVA no
  // ~/.gitconfig e vira execução de comando no próximo `git` — escrita
  // persistente com execução diferida, que passava como "consulta".
  git: { apenas: ['status', 'log', 'diff', 'show', 'branch', 'remote',
    'ls-files', 'rev-parse', 'describe', 'blame', 'shortlog', 'tag'] },
  // banco: nenhum. `mysql -e` e `psql -c` rodam SQL arbitrário, inclusive DROP.
  // shell auxiliares inofensivos
  echo: true, printf: true, true: true, false: true, sleep: true,
  which: true, type: true, command: { apenas: ['-v'] }, whereis: true,
  test: true, seq: true, yes: false,
};

// Separa o comando em pedaços, respeitando aspas — sem isto, um `grep "a|b"`
// seria partido no meio da expressão e cairia em aprovação à toa.
function fatiar(cmd) {
  const partes = [];
  let atual = '';
  let aspas = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (aspas) {
      atual += c;
      if (c === aspas && cmd[i - 1] !== '\\') aspas = null;
      continue;
    }
    if (c === '"' || c === "'") { aspas = c; atual += c; continue; }
    const resto = cmd.slice(i);
    const m = resto.match(/^(\|\||&&|\||;)/);
    if (m) { partes.push(atual); atual = ''; i += m[1].length - 1; continue; }
    atual += c;
  }
  partes.push(atual);
  return partes.map((p) => p.trim()).filter(Boolean);
}

// Divide um pedaço em palavras, tirando as aspas. Uma palavra com aspas NO MEIO
// (o truque `r"m -rf /`) some aqui — por isso o nome do comando é conferido
// contra o texto original também, mais abaixo.
function palavras(pedaco) {
  const out = [];
  let atual = '';
  let aspas = null;
  let tinhaAspas = false;
  for (let i = 0; i < pedaco.length; i++) {
    const c = pedaco[i];
    if (aspas) {
      if (c === aspas) { aspas = null; continue; }
      atual += c;
      continue;
    }
    if (c === '"' || c === "'") { aspas = c; tinhaAspas = true; continue; }
    if (/\s/.test(c)) { if (atual) { out.push(atual); atual = ''; } continue; }
    atual += c;
  }
  if (atual) out.push(atual);
  return { lista: out, tinhaAspas };
}

// Só leitura? Devolve { leitura: true } ou { leitura: false, motivo }.
function classificar(cmd) {
  const texto = String(cmd || '').trim();
  if (!texto) return { leitura: false, motivo: 'comando vazio' };
  if (texto.length > 4000) return { leitura: false, motivo: 'comando longo demais para analisar' };

  const paraAnalise = texto.replace(REDIRECIONA_PARA_NADA, ' ');
  for (const [re, motivo] of ESTRUTURA_PROIBIDA) {
    if (re.test(paraAnalise)) return { leitura: false, motivo };
  }

  const pedacos = fatiar(texto);
  if (!pedacos.length) return { leitura: false, motivo: 'comando vazio' };

  for (const pedaco of pedacos) {
    // Atribuição de variável antes do comando (A=rm $A ...) muda o que roda.
    if (/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(pedaco)) {
      return { leitura: false, motivo: 'atribuição de variável antes do comando' };
    }
    const { lista, tinhaAspas } = palavras(pedaco);
    if (!lista.length) return { leitura: false, motivo: 'trecho vazio' };
    let nome = lista[0];
    // `sudo`, `env`, `nohup`, `time` etc. escondem o comando real. Em vez de
    // tentar desembrulhar, manda para aprovação.
    if (/^(sudo|doas|su|env|nohup|time|timeout|nice|ionice|xargs|eval|exec|sh|bash|zsh|dash|ksh|fish|perl|python[0-9.]*|ruby|node|php|awk|gawk|mawk)$/.test(nome)) {
      return { leitura: false, motivo: `"${nome}" pode executar qualquer coisa` };
    }
    // Caminho absoluto para o binário: /bin/ls é ls.
    if (nome.includes('/')) nome = nome.slice(nome.lastIndexOf('/') + 1);
    // O nome do comando não pode ter vindo de aspas ou barra invertida no meio
    // da palavra — é o truque clássico para escapar de lista de bloqueio.
    if (tinhaAspas && !pedaco.trimStart().startsWith(nome)) {
      return { leitura: false, motivo: 'nome do comando escrito com aspas' };
    }
    if (nome.includes('\\')) return { leitura: false, motivo: 'nome do comando com barra invertida' };
    if (/\$/.test(lista[0])) return { leitura: false, motivo: 'nome do comando vindo de variável' };

    const politica = Object.prototype.hasOwnProperty.call(LEITURA, nome) ? LEITURA[nome] : undefined;
    if (politica === undefined || politica === false) {
      return { leitura: false, motivo: `"${nome}" não está na lista de comandos de leitura` };
    }
    if (politica === true) continue;
    const args = lista.slice(1);
    if (politica.proibidos) {
      const ruim = args.find((a) => politica.proibidos.test(a));
      if (ruim) {
        return { leitura: false, motivo: politica.motivo
          ? `"${nome} ${ruim}" ${politica.motivo}`
          : `"${nome} ${ruim}" altera o sistema` };
      }
    }
    if (politica.apenas) {
      const primeiro = args.find((a) => !a.startsWith('-')) || args[0];
      if (!primeiro || !politica.apenas.includes(primeiro)) {
        return { leitura: false, motivo: `"${nome} ${primeiro || ''}" não é um subcomando de consulta` };
      }
    }
  }
  return { leitura: true };
}

// Caminhos cujo conteúdo não deve sair da máquina sem o usuário ver.
//
// A lista de permissão garante que o comando não MODIFICA nada — e só isso.
// `cat ~/.ssh/id_rsa` é leitura pura, e a saída de todo comando é enviada para
// a API do modelo. Sem esta segunda camada, "descubra por que o app não acha
// meus hosts" podia virar um `cat` no data.json do próprio app, mandando as
// senhas de TODOS os servidores e a chave da API para fora num passo só, sem
// diálogo nenhum.
const CAMINHOS_SENSIVEIS = [
  [/(^|[\s"'/])\.ssh(\/|\s|$|["'])/, 'chaves SSH (~/.ssh)'],
  [/\/etc\/(shadow|gshadow|sudoers)/, 'arquivo de senhas do sistema'],
  [/\.(pem|key|p12|pfx|jks)(\s|$|["'])/, 'arquivo de chave privada'],
  [/id_(rsa|dsa|ecdsa|ed25519)(\s|$|["'])/, 'chave SSH privada'],
  [/(^|[\s"'/])\.aws\/|credentials(\s|$|["'])/, 'credenciais de nuvem'],
  [/(^|[\s"'/])\.(env|netrc|npmrc|pgpass|my\.cnf)(\s|$|["'])/, 'arquivo de credenciais'],
  [/(^|[\s"'/])\.gnupg(\/|\s|$|["'])/, 'chaveiro GPG'],
  [/Vincii Canvas|vincii-canvas|ssh-commander/, 'os dados do próprio Vincii Canvas (senhas de todos os hosts e a chave da API)'],
  [/data\.json/, 'o arquivo de dados do app'],
  [/\/proc\/\d+\/environ|\/dev\/mem|\/dev\/kmem/, 'memória ou ambiente de outro processo'],
];

// Devolve o motivo se o comando toca algum caminho sensível, ou null.
function caminhoSensivel(cmd) {
  const texto = String(cmd || '');
  for (const [re, motivo] of CAMINHOS_SENSIVEIS) {
    if (re.test(texto)) return motivo;
  }
  return null;
}

const ehLeitura = (cmd) => classificar(cmd).leitura;

module.exports = { classificar, ehLeitura, caminhoSensivel, LEITURA, CAMINHOS_SENSIVEIS };
