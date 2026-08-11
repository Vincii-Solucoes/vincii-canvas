'use strict';

// Testes da janela de atendimento do Homem Vitruviano.
//
// Os três casos que este arquivo existe para travar são os que quebram EM
// SILÊNCIO — o sistema abre no dia ou na hora errada e ninguém percebe:
//
//   1. `dia` aqui é 0 = SEGUNDA; em Date#getDay() é 0 = domingo. Trocar um pelo
//      outro desloca a semana inteira em um dia e continua "abrindo em algum
//      dia", que é o pior tipo de erro.
//   2. O fuso é FIXO em -03:00, não o da máquina. Com o relógio local, um
//      notebook noutro fuso abre fora da hora — e o cofre RECUSA a credencial
//      fora do horário, então vira laço de tentativas.
//   3. Um turno pode atravessar o dia e a semana (domingo 22:00 → segunda
//      06:00). A comparação `inicio <= agora < fim` é sempre falsa aí.

const assert = require('assert');
const { normalizarJanela, estaEmAtendimento, descreverJanela, relogioNoFuso } = require('../public/janela');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const naoOk = (c, m) => { assert.ok(!c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// Instantes escritos em UTC de propósito: assim o teste vale igual em qualquer
// máquina, e é exatamente a independência de fuso que se quer provar.
// 2026-08-10 é uma SEGUNDA.
const em = (iso) => new Date(iso);

// ---------- o dia 0 é segunda, e não domingo ----------

{
  const r = relogioNoFuso(em('2026-08-10T15:00:00Z'), '-03:00'); // segunda 12:00 em Brasília
  igual(r.dia, 0, 'segunda-feira é o dia 0 — em Date#getDay() ela é 1');
  igual(r.minutosDoDia, 12 * 60, '12:00 em -03:00, e não 15:00 de UTC');
  igual(r.data, '2026-08-10', 'a data é a do fuso da janela');

  const d = relogioNoFuso(em('2026-08-16T15:00:00Z'), '-03:00'); // domingo
  igual(d.dia, 6, 'domingo é o dia 6 — em Date#getDay() ele é 0');
}

{
  // A virada do dia acontece no fuso da JANELA, não no da máquina.
  // 2026-08-11T02:00Z é ainda 2026-08-10 23:00 em Brasília.
  const r = relogioNoFuso(em('2026-08-11T02:00:00Z'), '-03:00');
  igual(r.data, '2026-08-10', 'antes das 03:00 UTC ainda é o dia anterior em -03:00');
  igual(r.dia, 0, 'e ainda é segunda');
}

// ---------- comercial: seg a sex, 08:00–18:00 ----------

{
  const j = { fuso: '-03:00', turnos: [
    { diaInicio: 0, inicio: '08:00', diaFim: 0, fim: '18:00', rotulo: 'Comercial' },
    { diaInicio: 1, inicio: '08:00', diaFim: 1, fim: '18:00' },
    { diaInicio: 2, inicio: '08:00', diaFim: 2, fim: '18:00' },
    { diaInicio: 3, inicio: '08:00', diaFim: 3, fim: '18:00' },
    { diaInicio: 4, inicio: '08:00', diaFim: 4, fim: '18:00' },
  ] };
  naoOk(estaEmAtendimento(j, em('2026-08-10T10:59:00Z')), 'segunda 07:59 (BR) ainda é fora');
  ok(estaEmAtendimento(j, em('2026-08-10T11:00:00Z')), 'segunda 08:00 (BR) abre');
  ok(estaEmAtendimento(j, em('2026-08-10T20:59:00Z')), 'segunda 17:59 (BR) ainda dentro');
  naoOk(estaEmAtendimento(j, em('2026-08-10T21:00:00Z')), 'segunda 18:00 (BR) fecha');
  ok(estaEmAtendimento(j, em('2026-08-14T15:00:00Z')), 'sexta 12:00 (BR) abre');
  naoOk(estaEmAtendimento(j, em('2026-08-15T15:00:00Z')), 'sábado não está na lista');
  naoOk(estaEmAtendimento(j, em('2026-08-16T15:00:00Z')), 'domingo tampouco');
}

// ---------- 24 h, como o exemplo da especificação ----------

{
  const j = { fuso: '-03:00', turnos: [
    { diaInicio: 0, inicio: '00:00', diaFim: 6, fim: '23:59', rotulo: '24h' },
  ] };
  for (const d of ['2026-08-10', '2026-08-13', '2026-08-15', '2026-08-16']) {
    ok(estaEmAtendimento(j, em(`${d}T15:00:00Z`)), `${d} ao meio-dia está aberto`);
    ok(estaEmAtendimento(j, em(`${d}T06:00:00Z`)), `${d} de madrugada também`);
  }
  igual(descreverJanela(j), '24 h, todos os dias', 'e a tela diz isso de forma curta');
}

// ---------- plantão que atravessa o dia E a semana ----------

{
  // O exemplo do documento: domingo 22:00 → segunda 06:00.
  const j = { fuso: '-03:00', turnos: [
    { diaInicio: 6, inicio: '22:00', diaFim: 0, fim: '06:00', rotulo: 'Plantão' },
  ] };
  naoOk(estaEmAtendimento(j, em('2026-08-17T00:59:00Z')), 'domingo 21:59 ainda é fora');
  ok(estaEmAtendimento(j, em('2026-08-17T01:00:00Z')), 'domingo 22:00 abre');
  ok(estaEmAtendimento(j, em('2026-08-17T04:00:00Z')), 'domingo 23:59… já é segunda 01:00, e continua');
  ok(estaEmAtendimento(j, em('2026-08-17T08:59:00Z')), 'segunda 05:59 ainda dentro');
  naoOk(estaEmAtendimento(j, em('2026-08-17T09:00:00Z')), 'segunda 06:00 fecha');
  naoOk(estaEmAtendimento(j, em('2026-08-12T15:00:00Z')), 'quarta ao meio-dia, nada a ver');

  // A VOLTA DA SEMANA é o ponto: o turno começa no último dia e termina no
  // primeiro. Uma faixa simples `ini <= x < fim` seria sempre falsa aqui.
  const j2 = { fuso: '-03:00', turnos: [
    { diaInicio: 5, inicio: '18:00', diaFim: 0, fim: '08:00', rotulo: 'Fim de semana' },
  ] };
  ok(estaEmAtendimento(j2, em('2026-08-15T22:00:00Z')), 'sábado 19:00 abre');
  ok(estaEmAtendimento(j2, em('2026-08-16T15:00:00Z')), 'domingo ao meio-dia continua aberto');
  ok(estaEmAtendimento(j2, em('2026-08-17T10:00:00Z')), 'segunda 07:00 ainda é o mesmo turno');
  naoOk(estaEmAtendimento(j2, em('2026-08-17T11:01:00Z')), 'segunda 08:01 acabou');
  naoOk(estaEmAtendimento(j2, em('2026-08-13T15:00:00Z')), 'quinta ao meio-dia, fora');
}

// ---------- exceções: feriado e expediente reduzido ----------

{
  const j = { fuso: '-03:00',
    turnos: [{ diaInicio: 0, inicio: '08:00', diaFim: 4, fim: '18:00' }],
    excecoes: [
      { data: '2026-09-07', fechado: true, rotulo: 'Independência' },
      { data: '2026-12-24', fechado: false, inicio: '09:00', fim: '13:00' },
    ] };
  // 2026-09-07 é uma segunda.
  naoOk(estaEmAtendimento(j, em('2026-09-07T15:00:00Z')),
    'feriado FECHA, mesmo caindo dentro do turno normal');
  // 2026-12-24 é uma quinta.
  naoOk(estaEmAtendimento(j, em('2026-12-24T11:00:00Z')), 'véspera: 08:00 ainda não abriu');
  ok(estaEmAtendimento(j, em('2026-12-24T13:00:00Z')), 'véspera: 10:00 dentro do reduzido');
  naoOk(estaEmAtendimento(j, em('2026-12-24T16:00:00Z')),
    'véspera: 13:00 fecha, mesmo com o turno normal indo até 18:00');
  ok(estaEmAtendimento(j, em('2026-12-23T15:00:00Z')), 'quarta normal segue o turno');
}

{
  // A exceção manda no DIA dela, e sobrepõe até um turno que veio da véspera.
  //
  // É escolha deliberada e CONSERVADORA: o documento diz que a trava real é do
  // cofre, que recusa fora do horário. Esticar o plantão para dentro do feriado
  // produziria um laço de conexões recusadas; encurtá-lo, no pior caso, faz o
  // analista clicar. (Ponto a confirmar com quem mantém o ERP.)
  const j = { fuso: '-03:00',
    turnos: [{ diaInicio: 6, inicio: '22:00', diaFim: 0, fim: '06:00' }],
    excecoes: [{ data: '2026-09-07', fechado: true }] };
  ok(estaEmAtendimento(j, em('2026-09-07T01:00:00Z')),
    'domingo 22:00 abre — o feriado é na segunda');
  naoOk(estaEmAtendimento(j, em('2026-09-07T05:00:00Z')),
    'passada a meia-noite já é o feriado: fecha, mesmo no meio do plantão');
}

// ---------- ausência de janela ----------

{
  igual(normalizarJanela(null), null, 'sem janela');
  igual(normalizarJanela(undefined), null, 'undefined');
  igual(normalizarJanela({ fuso: '-03:00', turnos: [] }), null,
    'cliente SEM turnos não tem janela — abre só quando o analista clicar, e isso '
    + 'precisa ser distinguível de "janela que nunca abre"');
  naoOk(estaEmAtendimento(null, em('2026-08-10T15:00:00Z')), 'sem janela nunca está em atendimento');
  naoOk(estaEmAtendimento({}, em('2026-08-10T15:00:00Z')), 'objeto vazio tampouco');
}

{
  // Cliente sem turnos MAS com exceção de expediente reduzido: abre só naquela
  // data. É o caso que o documento cita.
  const j = { fuso: '-03:00', turnos: [],
    excecoes: [{ data: '2026-12-24', fechado: false, inicio: '09:00', fim: '13:00' }] };
  naoOk(estaEmAtendimento(j, em('2026-12-23T13:00:00Z')), 'num dia normal, não abre');
  ok(estaEmAtendimento(j, em('2026-12-24T13:00:00Z')), 'na data da exceção, abre');
}

// ---------- entrada de rede não confiável ----------

{
  // Turno ilegível precisa ser DESCARTADO. Virar "sempre aberto" seria o pior
  // resultado possível: o app tentaria conectar o tempo todo e o cofre recusaria.
  const j = normalizarJanela({ fuso: '-03:00', turnos: [
    { diaInicio: 0, inicio: '25:00', diaFim: 0, fim: '18:00' },   // hora impossível
    { diaInicio: 9, inicio: '08:00', diaFim: 0, fim: '18:00' },   // dia fora de 0..6
    { diaInicio: 0, inicio: '08:00', diaFim: 0, fim: '18:00' },   // bom
    null, 'lixo',
  ] });
  igual(j.turnos.length, 1, 'só o turno legível sobrevive');
  naoOk(estaEmAtendimento({ fuso: '-03:00', turnos: [{ diaInicio: 0, inicio: 'x', diaFim: 0, fim: 'y' }] },
    em('2026-08-10T15:00:00Z')), 'janela só com turno ilegível não abre nunca');

  const semFuso = normalizarJanela({ turnos: [{ diaInicio: 0, inicio: '08:00', diaFim: 0, fim: '18:00' }] });
  igual(semFuso.fuso, '-03:00', 'sem fuso, assume Brasília, que é o que a especificação fixa');
  const fusoRuim = normalizarJanela({ fuso: 'meio-dia', turnos: [{ diaInicio: 0, inicio: '08:00', diaFim: 0, fim: '18:00' }] });
  igual(fusoRuim.fuso, '-03:00', 'fuso ilegível também cai no padrão, em vez de derrubar a janela');
}

{
  // Exceção de expediente reduzido SEM horário: fecha. Abrir o dia todo seria
  // inventar um horário que ninguém informou.
  const j = normalizarJanela({ fuso: '-03:00',
    turnos: [{ diaInicio: 0, inicio: '08:00', diaFim: 4, fim: '18:00' }],
    excecoes: [{ data: '2026-09-07', fechado: false }] });
  igual(j.excecoes[0].fechado, true, 'sem início/fim, o reduzido vira fechado');
  naoOk(estaEmAtendimento(j, em('2026-09-07T15:00:00Z')), 'e o dia não abre');
}

// ---------- outro fuso, se um dia vier ----------

{
  // O campo existe na resposta, então pode mudar. Calcular sempre em -03:00
  // fixo no código seria ignorar o que a API mandou.
  const j = { fuso: '+00:00', turnos: [{ diaInicio: 0, inicio: '08:00', diaFim: 0, fim: '18:00' }] };
  ok(estaEmAtendimento(j, em('2026-08-10T09:00:00Z')), 'em UTC, 09:00 está dentro de 08–18');
  naoOk(estaEmAtendimento(j, em('2026-08-10T19:00:00Z')), 'e 19:00 está fora');
  // O mesmo instante, na janela de Brasília, cai em 06:00 — fora.
  naoOk(estaEmAtendimento({ ...j, fuso: '-03:00' }, em('2026-08-10T09:00:00Z')),
    'o MESMO instante muda de resposta conforme o fuso da janela');
}

// ---------- texto para a tela ----------

{
  igual(descreverJanela({ fuso: '-03:00', turnos: [
    { diaInicio: 0, inicio: '08:00', diaFim: 4, fim: '18:00', rotulo: 'Comercial' }] }),
  'Seg a Sex 08:00–18:00 (Comercial)', 'faixa de dias com rótulo');
  igual(descreverJanela({ fuso: '-03:00', turnos: [
    { diaInicio: 6, inicio: '22:00', diaFim: 0, fim: '06:00' }] }),
  'Dom a Seg 22:00–06:00', 'plantão que vira o dia');
  igual(descreverJanela(null), '', 'sem janela, sem texto');
  ok(/exceção/.test(descreverJanela({ fuso: '-03:00',
    turnos: [{ diaInicio: 0, inicio: '08:00', diaFim: 0, fim: '18:00' }],
    excecoes: [{ data: '2026-09-07', fechado: true }] })),
  'as exceções são anunciadas — é o que explica um dia que não abriu');
}


// ---------- fim do atendimento (o rótulo "aberto até…") ----------

const { fimDoAtendimento } = require('../public/janela');

{
  const comercial = { fuso: '-03:00', turnos: [
    { diaInicio: 0, inicio: '08:00', diaFim: 4, fim: '18:00' }] };
  // Segunda 12:00 BR. O turno vai até sexta 18:00 BR = sexta 21:00 UTC.
  const f = fimDoAtendimento(comercial, em('2026-08-10T15:00:00Z'));
  igual(f.toISOString(), '2026-08-14T21:00:00.000Z', 'o fim do turno da semana toda é a sexta 18:00 BR');

  igual(fimDoAtendimento(comercial, em('2026-08-16T15:00:00Z')), null,
    'fora do atendimento não há "aberto até": é null, e não uma data no passado');
}

{
  // Turnos ENCOSTADOS: 08:00–12:00 e 12:00–18:00 são um período só para quem vê.
  const partido = { fuso: '-03:00', turnos: [
    { diaInicio: 2, inicio: '08:00', diaFim: 2, fim: '12:00' },
    { diaInicio: 2, inicio: '12:00', diaFim: 2, fim: '18:00' }] };
  // Quarta 09:00 BR = 12:00 UTC.
  const f = fimDoAtendimento(partido, em('2026-08-12T12:00:00Z'));
  igual(f.toISOString(), '2026-08-12T21:00:00.000Z',
    'dois turnos colados viram um só — senão a tela diz "até 12:00" e destrava no meio do dia');
}

{
  // Turno que dá a volta na semana: domingo 22:00 → segunda 06:00.
  const plantao = { fuso: '-03:00', turnos: [
    { diaInicio: 6, inicio: '22:00', diaFim: 0, fim: '06:00' }] };
  // Domingo 23:00 BR = segunda 02:00 UTC.
  const f = fimDoAtendimento(plantao, em('2026-08-17T02:00:00Z'));
  igual(f.toISOString(), '2026-08-17T09:00:00.000Z',
    'o plantão que atravessa a semana termina na segunda 06:00 BR');
}

{
  // Exceção manda no dia: véspera reduzida termina no horário dela.
  const j = { fuso: '-03:00',
    turnos: [{ diaInicio: 0, inicio: '08:00', diaFim: 4, fim: '18:00' }],
    excecoes: [{ data: '2026-12-24', fechado: false, inicio: '09:00', fim: '13:00' }] };
  const f = fimDoAtendimento(j, em('2026-12-24T13:00:00Z')); // 10:00 BR
  igual(f.toISOString(), '2026-12-24T16:00:00.000Z',
    'na véspera reduzida o fim é 13:00 BR, e não as 18:00 do turno normal');
}

{
  // 24 h: o fim existe, mas está uma semana à frente — o importante é não ser
  // "agora" (o que destravaria a tela no mesmo instante).
  const j = { fuso: '-03:00', turnos: [
    { diaInicio: 0, inicio: '00:00', diaFim: 6, fim: '23:59' }] };
  const agora = em('2026-08-12T12:00:00Z');
  const f = fimDoAtendimento(j, agora);
  ok(f && f.getTime() > agora.getTime() + 60000,
    'janela 24 h tem fim no futuro, e não um fim já vencido que destravaria a tela');
}

{
  // Turno degenerado (início == fim): a especificação diz que dá a volta, ou
  // seja, 24 h contínuas. O laço de emenda não pode girar em falso nele.
  const j = { fuso: '-03:00', turnos: [
    { diaInicio: 1, inicio: '09:00', diaFim: 1, fim: '09:00' }] };
  const f = fimDoAtendimento(j, em('2026-08-11T15:00:00Z')); // terça 12:00 BR
  ok(f instanceof Date, 'turno de volta completa devolve uma data, e não trava o laço');
}


// ---------- o que sai daqui precisa sobreviver ao JSON ----------

{
  // A validação usa String(x), então um objeto com toString() certo PASSA. Se o
  // valor for guardado cru, ele vira `{}` no caminho para o navegador e o turno
  // é descartado lá — servidor entende "24 h", navegador entende "sem janela",
  // e nenhum dos dois reclama.
  const hostil = { fuso: '-03:00', turnos: [
    { diaInicio: 0, inicio: { toString: () => '00:00' }, diaFim: 6, fim: '23:59' }] };
  const j = normalizarJanela(hostil);
  igual(typeof j.turnos[0].inicio, 'string', 'o horário normalizado é STRING, e não o que veio da rede');
  igual(JSON.parse(JSON.stringify(j)), j,
    'a janela normalizada sobrevive à ida e volta do JSON — é assim que ela chega ao navegador');
  igual(descreverJanela(j), '24 h, todos os dias',
    'e a descrição reconhece o 24 h, que depende de comparação estrita com string');

  const comExcecao = { fuso: '-03:00',
    turnos: [{ diaInicio: 0, inicio: '08:00', diaFim: 4, fim: '18:00' }],
    excecoes: [{ data: '2026-12-24', fechado: false,
      inicio: { toString: () => '09:00' }, fim: '13:00' }] };
  const j2 = normalizarJanela(comExcecao);
  igual(typeof j2.excecoes[0].inicio, 'string', 'idem para o horário da exceção');
  igual(JSON.parse(JSON.stringify(j2)), j2, 'e a exceção também atravessa o JSON inteira');
}

console.log(`\n${n} verificações passaram`);
