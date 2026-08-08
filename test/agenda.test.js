'use strict';

// Testes da agenda de host: a faixa de horário que vale TODO DIA.
//
// O caso que este arquivo existe para proteger é a faixa que ATRAVESSA A
// MEIA-NOITE (22:00–02:00, a janela de manutenção típica). É exatamente onde a
// comparação óbvia `min >= inicio && min < fim` dá SEMPRE falso — a agenda
// nunca abriria, sem erro nenhum em lugar algum: o host simplesmente não
// conectaria e o usuário descobriria no dia seguinte.
//
// O segundo ponto é a COMPATIBILIDADE com o que já está gravado. A agenda teve
// seleção de dias da semana por uma versão; data.json e backups .xml daquele
// período trazem `dias`. Recusá-los transformaria um backup legítimo em erro de
// importação, então o campo é ignorado e a faixa passa a valer todo dia.

const assert = require('assert');
const {
  normalizarAgenda, estaNaJanela, descreverAgenda, fimDaJanelaAtual,
} = require('../public/agenda');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const naoOk = (c, m) => { assert.ok(!c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };
const lanca = (fn, re, m) => { assert.throws(fn, re, m); n += 1; };

const em = (iso) => new Date(iso);
// Uma semana inteira de datas, para provar que a faixa não escolhe dia.
const SEMANA = ['2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12',
  '2026-08-13', '2026-08-14', '2026-08-15'];
igual(SEMANA.map((d) => em(`${d}T12:00`).getDay()), [0, 1, 2, 3, 4, 5, 6],
  'as datas de referência precisam cobrir domingo a sábado');

// ---------- faixa dentro do mesmo dia ----------

{
  const a = normalizarAgenda({ inicio: '08:00', fim: '18:00' });
  igual(a, { inicio: '08:00', fim: '18:00' }, 'forma canônica: só as duas horas');

  naoOk(estaNaJanela(a, em('2026-08-12T07:59')), 'um minuto antes ainda é fora');
  ok(estaNaJanela(a, em('2026-08-12T08:00')), 'o horário de início já está dentro');
  ok(estaNaJanela(a, em('2026-08-12T13:37')), 'meio da faixa');
  ok(estaNaJanela(a, em('2026-08-12T17:59')), 'um minuto antes do fim ainda é dentro');
  naoOk(estaNaJanela(a, em('2026-08-12T18:00')), 'o horário de fim já é fora — senão a '
    + 'faixa 08–18 e a faixa 18–20 se sobreporiam num minuto');

  // A propriedade nova: TODO dia, sem exceção.
  for (const d of SEMANA) {
    ok(estaNaJanela(a, em(`${d}T13:00`)), `${d} às 13h precisa estar dentro`);
    naoOk(estaNaJanela(a, em(`${d}T20:00`)), `${d} às 20h precisa estar fora`);
  }
}

// ---------- faixa que atravessa a meia-noite ----------

{
  // Manutenção da madrugada: 22:00 às 02:00, todo dia.
  const a = normalizarAgenda({ inicio: '22:00', fim: '02:00' });

  naoOk(estaNaJanela(a, em('2026-08-12T21:59')), 'antes de começar');
  ok(estaNaJanela(a, em('2026-08-12T22:00')), '22:00 abre');
  ok(estaNaJanela(a, em('2026-08-12T23:59')), 'um minuto antes da virada');
  ok(estaNaJanela(a, em('2026-08-13T00:00')), 'a VIRADA DO DIA não pode fechar a janela');
  ok(estaNaJanela(a, em('2026-08-13T01:59')), 'a madrugada ainda é a faixa');
  naoOk(estaNaJanela(a, em('2026-08-13T02:00')), '02:00 fecha');
  naoOk(estaNaJanela(a, em('2026-08-13T12:00')), 'o meio do dia fica de fora');

  // Sem dias da semana, a madrugada não pertence a ninguém em especial: ela
  // vale sempre. Isso era o ponto mais fácil de errar quando havia dias.
  for (const d of SEMANA) {
    ok(estaNaJanela(a, em(`${d}T01:00`)), `madrugada de ${d} está dentro`);
    ok(estaNaJanela(a, em(`${d}T23:00`)), `noite de ${d} está dentro`);
  }
}

// ---------- o dia inteiro ----------

{
  // 24 horas CONTÍNUAS, sem buraco. "23:59" como fim exclui o próprio minuto —
  // seria um buraco de 60 s por dia, e a mensagem de erro deste módulo chegou a
  // RECOMENDAR essa configuração.
  const a = normalizarAgenda({ inicio: '00:00', fim: '24:00' });
  for (const h of ['00:00', '12:00', '23:58', '23:59']) {
    ok(estaNaJanela(a, em(`2026-08-12T${h}`)), `${h} precisa estar dentro`);
  }
  ok(estaNaJanela(a, em('2026-08-13T00:00')), 'e emenda no dia seguinte sem intervalo');
  igual(descreverAgenda(a), '00:00–24:00 (todo dia)', 'o texto diz 24:00');
  igual(fimDaJanelaAtual(a, em('2026-08-12T23:59')), em('2026-08-13T00:00'),
    'o fim de um dia inteiro é a meia-noite seguinte');

  const b = normalizarAgenda({ inicio: '00:00', fim: '23:59' });
  naoOk(estaNaJanela(b, em('2026-08-12T23:59')), '23:59 como fim exclui o próprio minuto');

  lanca(() => normalizarAgenda({ inicio: '24:00', fim: '02:00' }),
    /HH:MM/, '24:00 não vale como início');
}

// ---------- compatibilidade com o que já está gravado ----------

{
  // A agenda teve dias da semana. data.json e backups .xml daquela versão
  // trazem `dias`; recusá-los faria um backup legítimo virar erro de importação.
  const a = normalizarAgenda({ dias: [6], inicio: '22:00', fim: '02:00' });
  igual(a, { inicio: '22:00', fim: '02:00' },
    '`dias` é IGNORADO e não sobrevive na forma canônica — campo morto gravado é '
    + 'convite para a próxima pessoa tentar interpretá-lo');
  ok(estaNaJanela(a, em('2026-08-10T23:00')),
    'a faixa que era só de sábado passa a valer todo dia — é a consequência direta '
    + 'de tirar os dias, e o diálogo de importação avisa');

  igual(normalizarAgenda({ dias: '1,2,3', inicio: '09:00', fim: '17:00' }),
    { inicio: '09:00', fim: '17:00' }, 'dias como texto (formato do XML antigo) também passa');
  igual(normalizarAgenda({ dias: 'lixo', inicio: '09:00', fim: '17:00' }),
    { inicio: '09:00', fim: '17:00' }, 'e nem precisa ser válido: ninguém mais o lê');
  igual(normalizarAgenda({ dias: [1, 2, 3] }), null,
    'só dias, sem horário, não é agenda nenhuma — sem faixa não há o que manter aberto');
}

// ---------- validação ----------

{
  igual(normalizarAgenda(null), null, 'sem agenda é null');
  igual(normalizarAgenda(undefined), null, 'undefined também');
  igual(normalizarAgenda(''), null, 'string vazia também');
  igual(normalizarAgenda({ inicio: '', fim: '' }), null,
    'formulário vazio DESLIGA a agenda em vez de dar erro — é assim que o usuário '
    + 'tira a trava de um host');

  lanca(() => normalizarAgenda({ inicio: '08:00' }), /HH:MM/, 'início sem fim não vale');
  lanca(() => normalizarAgenda({ fim: '18:00' }), /HH:MM/, 'fim sem início tampouco');
  lanca(() => normalizarAgenda({ inicio: '25:00', fim: '18:00' }), /HH:MM/, 'hora impossível');
  lanca(() => normalizarAgenda({ inicio: '08:60', fim: '18:00' }), /HH:MM/, 'minuto impossível');
  lanca(() => normalizarAgenda({ inicio: '8:00', fim: '18:00' }),
    /HH:MM/, 'sem o zero à esquerda não passa: é o formato que o <input type="time"> '
    + 'produz e o que o XML de backup grava, então aceitar variações só criaria '
    + 'duas grafias para a mesma hora');
  lanca(() => normalizarAgenda({ inicio: '08:00', fim: '08:00' }),
    /diferente da de início/, 'início igual ao fim é ambíguo (zero minuto ou o dia todo?)');
  lanca(() => normalizarAgenda([1, 2]), /inválida/, 'array não é agenda');
  lanca(() => normalizarAgenda(7), /inválida/, 'número não é agenda');

  // A mensagem precisa apontar para um caminho que EXISTA na tela. Ela já
  // recomendou 00:00–23:59 (um buraco de um minuto por dia) e depois "digite
  // 24:00" — que um <input type="time"> recusa, deixando o campo vazio.
  const msg = (() => {
    try { normalizarAgenda({ inicio: '08:00', fim: '08:00' }); } catch (e) { return e.message; }
    return '';
  })();
  ok(/fim do dia/.test(msg), 'a mensagem aponta para "até o fim do dia"');
  ok(!/24:00/.test(msg), 'e NÃO manda digitar 24:00 — o campo de hora não aceita esse valor');
}

{
  // Uma agenda corrompida no data.json não pode travar a interface: estaNaJanela
  // é chamada a cada render e a cada tique do relógio.
  naoOk(estaNaJanela(null, em('2026-08-12T12:00')), 'sem agenda, nunca está na janela');
  naoOk(estaNaJanela({}, em('2026-08-12T12:00')), 'agenda vazia');
  naoOk(estaNaJanela({ inicio: 'lixo', fim: '18:00' }, em('2026-08-12T12:00')),
    'horário ilegível não pode ser lido como "sempre aberto"');
  naoOk(estaNaJanela({ inicio: '08:00', fim: '08:00' }, em('2026-08-12T12:00')),
    'faixa degenerada tampouco');
}

// ---------- até quando a aba fica travada ----------

{
  const a = normalizarAgenda({ inicio: '08:00', fim: '18:00' });
  igual(fimDaJanelaAtual(a, em('2026-08-12T10:00')), em('2026-08-12T18:00'),
    'no meio do expediente, o fim é hoje às 18:00');
  igual(fimDaJanelaAtual(a, em('2026-08-12T20:00')), null, 'fora da janela não há fim');
}

{
  const a = normalizarAgenda({ inicio: '22:00', fim: '02:00' });
  igual(fimDaJanelaAtual(a, em('2026-08-12T23:00')), em('2026-08-13T02:00'),
    'antes da meia-noite, o fim é AMANHÃ às 02:00');
  igual(fimDaJanelaAtual(a, em('2026-08-13T01:00')), em('2026-08-13T02:00'),
    'depois da meia-noite, o fim é hoje às 02:00');
}

// ---------- texto para a tela ----------

{
  igual(descreverAgenda({ inicio: '08:00', fim: '18:00' }), '08:00–18:00 (todo dia)',
    'a faixa comum diz que vale todo dia — sem isso o usuário lê como "uma vez só"');
  igual(descreverAgenda({ inicio: '22:00', fim: '02:00' }),
    '22:00–02:00 (todo dia, virando a madrugada)',
    'a faixa que atravessa a meia-noite precisa DIZER isso — senão "22:00–02:00" '
    + 'se lê como um erro de digitação');
  igual(descreverAgenda(null), '', 'sem agenda, sem texto');
  igual(descreverAgenda({ inicio: '08:00' }), '', 'agenda pela metade não vira texto');
}

console.log(`\n${n} verificações passaram`);
