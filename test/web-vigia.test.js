'use strict';

// O vigia da primeira carga de uma aba web.
//
// De vez em quando o <webview> do Electron nasce e não navega: o guest existe
// (webContentsId presente, isLoading() dizendo true), `getURL()` volta VAZIO e
// nenhum evento chega — nem did-attach, nem did-fail-load. Nada quebra e nada
// avisa; a página só não vem. O usuário aprendeu a clicar em ⟳, e foi assim que
// o problema chegou aqui: "quando não abre eu tenho que clicar em refresh".
//
// Isto é asserção de FONTE de propósito. O defeito só existe dentro do Electron,
// com um <webview> de verdade; medi-lo aqui exigiria subir o app empacotado a
// cada `npm test`. O que este arquivo protege são as decisões que as medições
// produziram — e cada uma delas custou uma tentativa errada antes.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const naoOk = (c, m) => { assert.ok(!c, m); n += 1; };

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const i = src.indexOf('function createWebSession(');
ok(i > 0, 'achei createWebSession');
const bloco = src.slice(i, src.indexOf('\n}\n', src.indexOf('VIGIA DA PRIMEIRA CARGA', i)) + 3);

// ---------- 1. o `src` vai ANTES do appendChild ----------

{
  const posSrc = bloco.indexOf("view.setAttribute('src'");
  const posAppend = bloco.indexOf('container.appendChild(view)');
  ok(posSrc > 0 && posAppend > 0, 'achei os dois pontos');
  ok(posSrc < posAppend,
    'o src é posto ANTES de o elemento entrar no DOM. Parece contraintuitivo e é '
    + 'o que foi MEDIDO: com o src depois, 9 travamentos em 12 aberturas, contra '
    + '1 em 5 com ele antes');
}

// ---------- 2. o único sinal aceito é a URL ter comprometido ----------

{
  ok(/const chegou = \(\) => \{[\s\S]{0,140}\/\^https\?:\/i\.test\(view\.getURL\(\)/.test(bloco),
    '"chegou" é a URL http(s) comprometida de verdade');
  naoOk(/deuSinal/.test(bloco),
    'e NENHUM outro evento cancela o vigia. Tentei dois atalhos e os dois '
    + 'pioraram, porque no caso travado esses eventos TAMBÉM chegam: o webview '
    + 'faz uma carga inicial de about:blank, e a navegação para o site "começa" '
    + 'sem nunca comprometer.\n'
    + '        did-attach/dom-ready como sinal -> 3 travadas em 20, 0 resgatadas\n'
    + '        did-start-navigation http       -> 1 travada em 20, 0 resgatadas\n'
    + '        só a URL comprometida, 6 s      -> 0 travadas em 20, 2 resgatadas');
}

// ---------- 3. o remédio escala ----------

{
  ok(/tentativasDeCarga === 1\) view\.reload\(\)/.test(bloco),
    'primeira tentativa: reload — é o que o usuário fazia à mão');
  ok(/tentativasDeCarga === 2\) view\.loadURL\(endereco\)/.test(bloco),
    'segunda: loadURL, porque num guest que nunca navegou não há o que recarregar '
    + 'e o reload vira comando vazio');
  ok(/createWebSession\(\{ hostId, hostName, url: endereco, remontagem: remontagem \+ 1 \}\)/.test(bloco),
    'terceira: remonta a aba do zero');
}

// ---------- 4. a remontagem é LIMITADA ----------

{
  ok(/remontagem < 1/.test(bloco),
    'a remontagem tem teto. Sem ele, uma remontagem que também travasse chamaria '
    + 'outra — cada uma nasce com o contador de tentativas zerado, então o laço '
    + 'não teria fim: abas se fechando e abrindo para sempre, muito pior do que a '
    + 'aba parada que isto conserta');
  ok(/remontagem = 0/.test(src.slice(i, i + 200)),
    'e o parâmetro nasce em zero, então quem chama de fora não precisa saber dele');
}

// ---------- 5. o vigia sai de cena quando a página chega ----------

{
  ok(/if \(chegou\(\) \|\| falhou\) pararVigia\(\);/.test(bloco),
    'chegando a página (ou vindo um erro de verdade), o vigia para');
  const posFalhou = bloco.indexOf('let falhou = null');
  const posVigia = bloco.indexOf('const armarVigia');
  ok(posFalhou > 0 && posFalhou < posVigia,
    '`falhou` é declarado ANTES do vigia que o lê. Funcionaria depois (o corpo do '
    + 'timeout só roda segundos adiante), mas "funciona por acidente de '
    + 'cronometragem" é como este projeto já derrubou o servidor inteiro uma vez');
}

console.log(`\n${n} verificações passaram`);
