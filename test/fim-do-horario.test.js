'use strict';

// Avisar quando o atendimento de um cliente ACABA.
//
// Quando a faixa termina, o app não derruba nada: a aba continua aberta e volta
// a ser fechável (o "×" reaparece). Isso é de propósito — interromper um comando
// em execução seria pior que deixar uma aba a mais na tela. Só que a mudança
// acontecia em silêncio absoluto: quem estava trabalhando não tinha como saber
// que o expediente daquele cliente virou.
//
// Asserção de fonte porque a transição depende do relógio de parede e do laço da
// agenda. O comportamento foi medido no app empacotado por CDP, e o que este
// arquivo protege são as quatro decisões que a medição confirmou.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const i = app.indexOf('function avisarFimDoHorario(');
ok(i > 0, 'achei avisarFimDoHorario');
const fn = app.slice(i, app.indexOf('\n}\n', app.indexOf('for (const g of porGrupo.values())', i)) + 3);

// ---------- 1. só na TRANSIÇÃO, e nunca no primeiro ciclo ----------

{
  ok(/let dentroNoCicloAnterior = null;/.test(app),
    'o conjunto anterior começa em `null`, e não vazio');
  ok(/if \(dentroNoCicloAnterior\) \{[\s\S]{0,220}avisarFimDoHorario\(sairam\)/.test(app),
    'e o aviso só sai quando JÁ existe um ciclo anterior. Comparando com um '
    + 'conjunto vazio, o primeiro ciclo depois de abrir o app trataria todo mundo '
    + 'que está fora do horário como "acabou agora" — uma enxurrada de avisos de '
    + 'atendimentos que terminaram ontem');
  ok(/dentroNoCicloAnterior\.has\(h\.id\) && !dentro\.has\(h\.id\)/.test(app),
    'sai quem ESTAVA dentro e não está mais — não quem simplesmente está fora');
  ok(/dentroNoCicloAnterior = dentro;/.test(app),
    'e o conjunto é atualizado, senão o mesmo aviso sairia a cada dez segundos');
}

// ---------- 2. agrupado por CLIENTE ----------

{
  ok(/f\.tipo === 'cofre' \? `cliente:\$\{f\.cliente\}` : `host:\$\{h\.id\}`/.test(fn),
    'a chave do agrupamento é o CLIENTE quando o horário vem do cofre. Um cliente '
    + 'com seis sistemas produziria seis avisos idênticos no mesmo segundo');
  ok(/atual\.abas \+= abas\.length/.test(fn),
    'e as abas dos vários hosts do mesmo cliente são somadas para o texto');
}

// ---------- 3. sem aba viva, não avisa ----------

{
  ok(/const abas = sessions\.filter\(\(s\) => s\.hostId === h\.id && !sessaoMorta\(s\)\);[\s\S]{0,200}if \(!abas\.length\) continue;/.test(fn),
    'host sem aba viva não gera aviso: ninguém está olhando, e "você já pode '
    + 'fechar" não descreve nada. O aviso existe para dizer que a TRAVA saiu, e '
    + 'trava só existe onde há aba');
  ok(/!sessaoMorta\(s\)/.test(fn),
    'e aba morta não conta — numa aba web "encerrado" quer dizer que a última '
    + 'navegação falhou, com o webview ainda vivo');
}

// ---------- 4. o texto diz o que MUDOU ----------

{
  ok(/O atendimento de \$\{g\.fonte\.cliente\} terminou/.test(fn),
    'o aviso nomeia o cliente — "um horário terminou" não diz de quem');
  ok(/A agenda de "\$\{g\.hosts\[0\]\.name\}" terminou/.test(fn),
    'e para horário digitado à mão, nomeia o host: são coisas diferentes, e a '
    + 'diferença é onde ir mexer');
  ok(/já pode ser fechada|já podem ser fechadas/.test(fn),
    'e diz o que mudou de fato: a aba destravou. Sem isso o aviso seria só uma '
    + 'notificação de relógio, sem nada acionável');
  ok(/g\.abas === 1[\s\S]{0,160}\$\{g\.abas\} abas/.test(fn),
    'com singular e plural certos');
}

console.log(`\n${n} verificações passaram`);
