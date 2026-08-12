'use strict';

// O terminal da própria máquina deixa de abrir sozinho.
//
// Ele aparecia toda vez que a aba Terminal ficava sem sessão — e "sem sessão"
// inclui trocar de aba e voltar, porque `onTerminalTabShown` zerava a marca de
// "eu fechei de propósito". Quem usa o Canvas para falar com servidores acabava
// com um shell da própria máquina no caminho o tempo todo, sem ter pedido.
//
// Agora é preferência, e ela nasce DESLIGADA. O terminal local continua a um
// clique, fixo no topo da barra lateral.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };

const raiz = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(raiz, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(raiz, 'public', 'index.html'), 'utf8');
const srv = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');

// ---------- 1. a regra ----------

{
  const i = app.indexOf('function ensureLocalTerminal(');
  ok(i > 0, 'achei ensureLocalTerminal');
  const bloco = app.slice(i, i + 900);
  ok(/if \(!prefBool\('abrirLocalSozinho'\)\) return;/.test(bloco),
    'a abertura automática depende da preferência');
  ok(bloco.indexOf("prefBool('abrirLocalSozinho')") < bloco.indexOf('openLocalSession()'),
    'e a preferência é conferida ANTES de abrir');
  ok(/if \(MODO_SOLO\) return;/.test(bloco),
    'e a janela solta continua fora disso — lá o shell local viraria a aba 1, na '
    + 'frente da sessão que a janela veio mostrar');
}

// ---------- 2. nasce desligada ----------

{
  // `prefBool` devolve false para chave não definida, então "não declarar valor
  // padrão" JÁ é o padrão desligado. O que não pode existir é um `|| true` ou um
  // valor inicial `true` em algum ponto.
  ok(/abrirLocalSozinho: null/.test(app),
    'a chave entra na lista de preferências sem valor — e sem valor é desligada');
  ok(!/abrirLocalSozinho['"]?\s*(\|\||\?\?)\s*true/.test(app),
    'e nada a liga por padrão em algum canto');
  ok(/abrirLocalSozinho: 'vc-abrir-local'/.test(app),
    'com espelho no localStorage, como as outras — o app desktop troca de porta a '
    + 'cada abertura, então só o localStorage não bastaria');
}

// ---------- 3. o servidor persiste ----------

{
  const linhas = srv.split('\n').filter((l) => l.includes("'sidebarCollapsed'"));
  ok(linhas.length >= 2, 'achei as listas de preferências booleanas no servidor');
  for (const l of linhas) {
    ok(l.includes("'abrirLocalSozinho'"),
      'a chave entra em TODAS as listas de preferência booleana do servidor. São '
      + 'duas (gravar e importar): entrar só numa faz a preferência voltar ao '
      + 'padrão depois de restaurar um backup, sem nada avisando');
  }
}

// ---------- 4. a tela ----------

{
  ok(/id="cfgAbrirLocal"/.test(html), 'existe a caixa nas configurações');
  ok(/<label class="inline"><input type="checkbox" id="cfgAbrirLocal">/.test(html),
    'usando `label.inline`, que é a classe que o projeto JÁ tem para caixa com '
    + 'texto ao lado — a primeira versão inventou uma classe sem estilo, e o '
    + 'rótulo teria empilhado embaixo da caixa');
  ok(/cfgAbrirLocal[\s\S]{0,400}prefSet\('abrirLocalSozinho'/.test(app),
    'e mexer nela grava a preferência');
  // Ancorado NO ESTADO VAZIO, e não no arquivo inteiro: a primeira versão
  // procurava "Meu computador</strong>" em qualquer lugar do HTML e casava com
  // outro trecho da interface — passava verde com a dica apagada.
  const vazio = (html.match(/<div id="termEmpty"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';
  ok(vazio.length > 40, 'achei o texto da aba Terminal vazia');
  ok(/Meu computador/.test(vazio),
    'a tela vazia aponta para o "Meu computador" da barra lateral — sem isso, '
    + 'tirar a abertura automática deixaria a aba parecendo quebrada');
}

console.log(`\n${n} verificações passaram`);
