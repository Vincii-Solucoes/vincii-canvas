'use strict';

// Copiar e colar no terminal, pelo TECLADO.
//
// A queixa que gerou isto (29/set/2026): "Ctrl+C e Ctrl+V não funcionam dentro
// da tela do terminal". E não funcionavam mesmo: o xterm não joga a seleção na
// textarea escondida, então o copiar nativo do Chromium pega uma seleção de DOM
// vazia e não copia nada — quem tem de tratar o atalho é o app.
//
// O que estes testes protegem é o acordo com o shell: Ctrl+C sem seleção
// PRECISA continuar sendo o SIGINT (é como se interrompe um comando). O 'colar'
// tem uma regra que mora em quem chama: nada de preventDefault, porque o
// Chromium também cola sozinho em alguns sistemas — a colagem própria só entra
// se nenhum evento `paste` aparecer (public/app.js, colarSeNinguemColou).

const assert = require('assert');
const { decidirAtalhoDeTerminal } = require('../public/atalhos.js');

let n = 0;
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };
const ok = (c, m) => { assert.ok(c, m); n += 1; };

const tecla = (o) => Object.assign(
  { key: 'c', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }, o);
const win = (ev, temSelecao) => decidirAtalhoDeTerminal(ev, { ehMac: false, temSelecao });
const mac = (ev, temSelecao) => decidirAtalhoDeTerminal(ev, { ehMac: true, temSelecao });

// ---------- 1. Windows e Linux: o modificador é o Ctrl ----------

{
  igual(win(tecla({ ctrlKey: true }), true), 'copiar', 'Ctrl+C com seleção copia');
  igual(win(tecla({ ctrlKey: true }), false), null,
    'Ctrl+C SEM seleção não é tratado — tem de chegar ao shell como SIGINT');
  igual(win(tecla({ key: 'v', ctrlKey: true }), false), 'colar', 'Ctrl+V cola');
  igual(win(tecla({ key: 'C', ctrlKey: true, shiftKey: true }), true), 'copiar', 'Ctrl+Shift+C copia');
  igual(win(tecla({ key: 'V', ctrlKey: true, shiftKey: true }), false), 'colar', 'Ctrl+Shift+V cola');
  igual(win(tecla({ key: 'C', ctrlKey: true, shiftKey: true }), false), null,
    'Ctrl+Shift+C sem seleção não engole a tecla');
  igual(win(tecla({ key: 'Insert', ctrlKey: true }), true), 'copiar', 'Ctrl+Insert copia (clássico do Windows)');
  igual(win(tecla({ key: 'Insert', shiftKey: true }), false), 'colar', 'Shift+Insert cola');
}

// ---------- 2. macOS: o modificador é o Cmd, e o Ctrl+C é SEMPRE SIGINT ----------

{
  igual(mac(tecla({ metaKey: true }), true), 'copiar', 'Cmd+C com seleção copia');
  igual(mac(tecla({ metaKey: true }), false), null, 'Cmd+C sem seleção não faz nada');
  igual(mac(tecla({ ctrlKey: true }), true), null,
    'Ctrl+C no mac continua SIGINT mesmo com texto selecionado — lá quem copia é o Cmd');
  igual(mac(tecla({ key: 'v', metaKey: true }), false), 'colar', 'Cmd+V cola');
  igual(mac(tecla({ key: 'v', ctrlKey: true }), false), null,
    'Ctrl+V no mac NÃO é colar — é o ^V literal do readline');
  igual(mac(tecla({ key: 'C', ctrlKey: true, shiftKey: true }), true), 'copiar',
    'Ctrl+Shift+C também vale no mac (não conflita com nada)');
}

// ---------- 3. o que NÃO pode ser confundido com copiar/colar ----------

{
  igual(win(tecla({ key: 'a', ctrlKey: true }), true), null, 'Ctrl+A é do shell (início da linha, prefixo do tmux)');
  igual(win(tecla({ key: 'z', ctrlKey: true }), true), null, 'Ctrl+Z é do shell (suspende)');
  igual(win(tecla({ key: 'd', ctrlKey: true }), true), null, 'Ctrl+D é do shell (fim de arquivo)');
  igual(win(tecla({ ctrlKey: true, altKey: true }), true), null, 'Ctrl+Alt+C não é o atalho');
  igual(win(tecla({ ctrlKey: true, metaKey: true }), true), null, 'com a outra tecla junto, não');
  igual(mac(tecla({ metaKey: true, ctrlKey: true }), true), null, 'idem no mac');
  igual(win(tecla({}), true), null, 'a letra c sozinha é texto');
  igual(win(tecla({ key: 'Insert' }), true), null, 'Insert puro não é copiar nem colar');
  igual(decidirAtalhoDeTerminal(null, null), null, 'sem evento e sem opções, não decide nada');
  igual(decidirAtalhoDeTerminal(tecla({ ctrlKey: true }), undefined), null,
    'sem opções, trata como se não houvesse seleção (deixa o SIGINT passar)');
}

// ---------- 4. o atalho do Claude Code e o aviso do sino (v1.79.0) ----------
//
// Estes dois moram na interface (public/app.js) e dependem do xterm, então o
// que dá para travar aqui é o CONTRATO: o item só aparece quando o `claude`
// existe na máquina, o comando vai UMA vez, e o sino respeita a preferência.

{
  const fs = require('fs');
  const path = require('path');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

  ok(/localInfo && localInfo\.claude/.test(app),
    'o item do Claude só entra na barra quando o servidor diz que o binário existe');
  ok(/const args = continuar \? `\$\{exe\} --continue` : exe;/.test(app),
    'o atalho abre o claude, e com Shift continua a última conversa');
  ok(/command -v claude >\/dev\/null 2>&1 && \$\{args\}/.test(app),
    'sem caminho conhecido, o comando TENTA e explica se não houver — nada de "command not found" seco');
  ok(/function devoMostrarClaude/.test(app)
    && /\['nao', 'windows', 'manual-invalido'\]\.includes\(localInfo\.claudeOnde\)/.test(app),
    'o atalho só some quando se SABE que não há claude; na incerteza, aparece');
  ok(/const exe = caminho \? aspasDeShell\(caminho\) : 'claude';/.test(app),
    'e usa o CAMINHO ABSOLUTO achado — digitar só "claude" dependeria do PATH do shell da sessão');
  ok(/function aspasDeShell/.test(app),
    'o caminho vai entre aspas: espaço ou apóstrofo no meio quebraria a linha digitada');
  ok(/if \(session\.comandoInicial && !session\.comandoInicialEnviado\)/.test(app),
    'o comando de abertura vai UMA vez só (reatar não pode digitar de novo)');
  ok(/term\.onBell\(\(\) => aoTocarSino\(session\)\)/.test(app),
    'o sino do terminal está ligado ao aviso');
  ok((app.match(/term\.onBell\(/g) || []).length === 2,
    'nos DOIS terminais: o de texto (SSH/local) e o serial');
  ok(/if \(!prefBool\('avisarSino', true\)\) return;/.test(app),
    'o aviso respeita a preferência, e nasce ligado');
  ok(/const emFoco = document\.hasFocus\(\) && activeSessionId === session\.id;/.test(app),
    'com a aba na frente e a janela em foco, não marca a aba — o som já basta');
  ok(/if \(!document\.hasFocus\(\)\) \{\s*notificarSistema/.test(app),
    'notificação do sistema SÓ com a janela fora de foco');

  // O sinal de "o Claude terminou" não é o sino: no padrão `auto` ele não sai
  // dentro do Canvas. É a barra de progresso (OSC 9;4), que vem ligada de
  // fábrica no Claude Code — 9;4;3 ao começar, 9;4;0 ao parar.
  ok(/registerOscHandler\(9,/.test(app), 'o app escuta a sequência OSC 9 do terminal');
  ok(/if \(p\[0\] !== '4'\) return false;/.test(app),
    'OSC 9 que não é barra de progresso (notificação do iTerm2) não é engolida');
  ok(/avisarNaAba\(session, 'O Claude terminou de responder\.'\)/.test(app),
    'o fim de turno avisa com corpo próprio');
  ok(/session\.trabalhando = true/.test(app) && /session\.trabalhando = false/.test(app),
    'a aba sabe quando ele está trabalhando e quando parou');
  ok(/itemDoClaude\(list\)/.test(app) && /'claude code terminal ia'\.includes\(q\)/.test(app),
    'a busca da barra lateral também acha o atalho do Claude');

  const servidor = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok(/'-lc', 'command -v claude'/.test(servidor),
    'a procura pelo claude passa pelo shell de LOGIN (um app de GUI não herda o PATH do ~/.zshrc)');
  ok(/if \(process\.platform === 'win32'\) \{\s*_claude = \{ tem: false, onde: 'windows' \};/.test(servidor),
    'no Windows nem procura: sem PTY, o TUI do Claude não roda lá');
  // O padrão antigo era cair em /bin/zsh — que num Ubuntu comum NEM EXISTE, e
  // foi por isso que o atalho não apareceu no Linux.
  ok(/\['\/bin\/bash', '\/bin\/zsh', '\/bin\/sh'\]|'\/bin\/bash', '\/bin\/zsh', '\/bin\/sh'/.test(servidor),
    'a procura tenta bash, zsh e sh — e só os que existem na máquina');
  ok(/fs\.accessSync\(s, fs\.constants\.X_OK\)/.test(servidor),
    'o shell só é tentado se o arquivo dele existir (nada de spawn fadado ao erro)');
  ok(/\.nvm', 'versions', 'node'/.test(servidor) && /linuxbrew/.test(servidor) && /snap/.test(servidor),
    'a lista de caminhos cobre nvm, linuxbrew e snap — típicos do Linux');
  ok(/if \(!houveErro\) \{ _claude = \{ tem: false, onde: 'nao', tentativas \}/.test(servidor),
    '"não tem" só vira cache quando um shell REALMENTE respondeu que não tem');
  ok(/claudeTentativas: c\.tentativas \|\| null, versao: pkg\.version/.test(servidor),
    'a rota conta a versão e o que foi tentado — é o que permite resolver à distância');

  const main = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
  ok(/'clipboard-sanitized-write', 'notifications'/.test(main),
    'a permissão de notificação foi liberada — e só para a janela do app');
}

console.log(`\n${n} verificações passaram`);
