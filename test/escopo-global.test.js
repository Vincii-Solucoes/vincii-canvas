'use strict';

// Nenhum par de scripts do navegador pode declarar o mesmo nome no topo.
//
// Os arquivos de public/ entram na página como <script> COMUM, não como módulo.
// Num script comum, `const`/`let`/`class` no topo vão para o escopo léxico
// GLOBAL, compartilhado com todos os outros. Declarar o mesmo nome duas vezes
// derruba o segundo script INTEIRO com SyntaxError, antes de qualquer linha
// dele rodar.
//
// Isso já aconteceu, e o estrago não parecia com a causa: `agenda.js` e
// `janela.js` declaravam `const RE_HORA`. O `janela.js` morria calado, então
// `window.estaEmAtendimento` ficava indefinida, `horario.js` lançava ao ser
// chamado, e `hostCard()` morria no meio do desenho — a aba Hosts mostrava o
// cabeçalho do grupo e NENHUM host dentro dele. Nada disso apontava para um
// nome de constante repetido, e nenhum teste pegou: em Node cada arquivo é um
// módulo com escopo próprio, e a suíte inteira passava verde.
//
// Por isso este teste lê o FONTE em vez de exercitar comportamento: o defeito
// não existe em Node, só no navegador.
//
// A saída são duas: renomear, ou embrulhar o arquivo numa função (como
// public/janela.js faz) para que só o que vai a `window` escape.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

const raiz = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(raiz, 'public', 'index.html'), 'utf8');

// A lista vem do HTML, e não escrita à mão: um <script> novo entra na guarda
// sozinho. Vendor de terceiro fica de fora — não é nosso para renomear.
const arquivos = [...html.matchAll(/<script src="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((f) => !f.startsWith('/vendor/'))
  .map((f) => f.replace(/^\//, ''));

ok(arquivos.length >= 5, `achei os scripts do app no index.html (${arquivos.length})`);

// Declarações no TOPO do arquivo (coluna zero). Só essas vão para o escopo
// global; o que está indentado já está dentro de alguma função ou bloco.
function declaracoesDeTopo(fonte) {
  const achadas = new Map();
  const re = /^(const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(fonte))) achadas.set(m[2], m[1]);
  return achadas;
}

const porArquivo = new Map();
for (const f of arquivos) {
  const caminho = path.join(raiz, 'public', f);
  if (!fs.existsSync(caminho)) continue;
  porArquivo.set(f, declaracoesDeTopo(fs.readFileSync(caminho, 'utf8')));
}

// `const`, `let` e `class` são FATAIS: redeclarar derruba o script.
// `var` e `function` só se sobrescrevem — feio, mas não quebra o carregamento.
const FATAIS = new Set(['const', 'let', 'class']);

const colisoes = [];
const nomes = [...porArquivo.keys()];
for (let i = 0; i < nomes.length; i += 1) {
  for (let j = i + 1; j < nomes.length; j += 1) {
    const [a, b] = [nomes[i], nomes[j]];
    for (const [nome, tipoA] of porArquivo.get(a)) {
      const tipoB = porArquivo.get(b).get(nome);
      if (!tipoB) continue;
      if (FATAIS.has(tipoA) || FATAIS.has(tipoB)) {
        colisoes.push(`${nome} (${tipoA} em ${a}, ${tipoB} em ${b})`);
      }
    }
  }
}

igual(colisoes, [],
  'dois scripts do navegador declaram o mesmo nome no topo. O SEGUNDO a carregar '
  + 'morre inteiro com SyntaxError, sem aparecer em teste nenhum de Node — foi '
  + 'assim que a aba Hosts passou a desenhar o grupo e nenhum host. Renomeie, ou '
  + 'embrulhe o arquivo numa função como public/janela.js faz:\n  '
  + colisoes.join('\n  '));

// E o caso conhecido continua isolado: janela.js não pode voltar a declarar
// nada no topo, porque `agenda.js` já tem `RE_HORA` lá.
{
  const j = porArquivo.get('janela.js');
  ok(j && j.size === 0,
    'public/janela.js não declara NADA no escopo global — ele vive dentro de uma '
    + `função, de propósito (achei ${j ? j.size : '?'} declaração(ões) de topo)`);
  ok(fs.readFileSync(path.join(raiz, 'public', 'janela.js'), 'utf8').includes('(function () {'),
    'e o embrulho continua lá');
}

// A ponta que o usuário sente: os três módulos de horário precisam registrar o
// que `horario.js` procura em `window`. Se um deles morrer no carregamento, o
// sintoma é a aba Hosts vazia — e a causa fica a três arquivos de distância.
{
  const precisa = {
    'agenda.js': ['estaNaJanela', 'descreverAgenda', 'fimDaJanelaAtual'],
    'janela.js': ['estaEmAtendimento', 'descreverJanela', 'fimDoAtendimento'],
    'horario.js': ['noHorario', 'temHorario', 'descreverHorario', 'motivoDoHorario'],
  };
  for (const [arq, fns] of Object.entries(precisa)) {
    const src = fs.readFileSync(path.join(raiz, 'public', arq), 'utf8');
    for (const fn of fns) {
      ok(new RegExp(`window\\.${fn}\\s*=`).test(src),
        `${arq} precisa publicar window.${fn} — é por aí que horario.js o encontra`);
    }
  }
}

console.log(`\n${n} verificações passaram`);
