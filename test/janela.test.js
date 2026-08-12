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
  'Dom 22:00 – Seg 06:00',
  'plantão que vira o dia mostra o dia dos DOIS lados. Era "Dom a Seg 22:00–06:00", '
  + 'que se lê como "das 22:00 às 06:00, de domingo a segunda" — o oposto do que é');
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
    // TURNO QUE FECHA O CÍRCULO (início == fim) É 24 HORAS.
  //
  // Este bloco afirmava o CONTRÁRIO, e a afirmação custou caro. Li no contrato
  // que a volta acontece quando o fim é "MENOR que o início" e concluí que igual
  // não dá a volta — fechando o turno. Só que o Homem Vitruviano codifica 24/7
  // exatamente assim:
  //
  //   { diaInicio: 0, inicio: "00:00", diaFim: 0, fim: "00:00", rotulo: "24h" }
  //
  // O cliente 24 h em produção passou a não abrir em instante NENHUM da semana,
  // sem erro em lugar nenhum. E não foi pego porque o ERP de mentira copiava o
  // EXEMPLO do documento (`diaFim 6, fim 23:59`) em vez do que o produtor manda.
  //
  // Quem define o significado do dado é quem o produz.
  const circulo = { fuso: '-03:00', turnos: [
    { diaInicio: 0, inicio: '00:00', diaFim: 0, fim: '00:00', rotulo: '24h' }] };
  let abertos = 0;
  const instantes = [];
  for (let d = 0; d < 7; d += 1) {
    for (const h of [0, 6, 9, 12, 18, 23]) {
      instantes.push(new Date(Date.UTC(2026, 7, 10 + d, h + 3)));
    }
  }
  for (const t of instantes) if (estaEmAtendimento(circulo, t)) abertos += 1;
  igual(abertos, instantes.length,
    'a janela 24 h do ERP abre em TODOS os instantes da semana — é a forma que a '
    + 'produção usa, e tratá-la como duração zero deixou o cliente sem horário');

  // A outra escrita da mesma coisa, a do exemplo do documento, também vale.
  const doDocumento = { fuso: '-03:00', turnos: [
    { diaInicio: 0, inicio: '00:00', diaFim: 6, fim: '23:59' }] };
  ok(estaEmAtendimento(doDocumento, em('2026-08-12T15:00:00Z')),
    'e a forma do documento (diaFim 6, fim 23:59) continua valendo: o mesmo '
    + 'significado escrito de dois jeitos, e os dois precisam funcionar');

  // Um turno de meio-dia continua sendo meio-dia, não a semana toda.
  const meioDia = { fuso: '-03:00', turnos: [
    { diaInicio: 2, inicio: '08:00', diaFim: 2, fim: '12:00' }] };
  ok(estaEmAtendimento(meioDia, em('2026-08-12T13:00:00Z')), 'quarta 10:00 dentro');
  naoOk(estaEmAtendimento(meioDia, em('2026-08-12T18:00:00Z')), 'quarta 15:00 fora');
  naoOk(estaEmAtendimento(meioDia, em('2026-08-13T13:00:00Z')), 'quinta 10:00 fora');

  const volta = { fuso: '-03:00', turnos: [
    { diaInicio: 6, inicio: '22:00', diaFim: 0, fim: '06:00' }] };
  ok(estaEmAtendimento(volta, em('2026-08-17T02:00:00Z')),
    'o plantão que atravessa a semana segue valendo');
  naoOk(estaEmAtendimento(volta, em('2026-08-12T15:00:00Z')),
    'e não vaza para a quarta ao meio-dia');

  // Exceção que fecha o círculo: o dia inteiro daquela data.
  const excCirculo = { fuso: '-03:00', turnos: [],
    excecoes: [{ data: '2026-12-24', fechado: false, inicio: '09:00', fim: '09:00' }] };
  ok(estaEmAtendimento(excCirculo, new Date(Date.UTC(2026, 11, 24, 15))),
    'exceção com fim igual ao início vale o dia inteiro daquela data');
  naoOk(estaEmAtendimento(excCirculo, new Date(Date.UTC(2026, 11, 25, 15))),
    'e só naquela data');
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


// ---------- a armadilha: EXCEÇÃO não atravessa o dia, TURNO atravessa ----------

// As duas vêm no mesmo payload, e a escrita é parecida. Um turno 22:00→06:00
// significa "de hoje à noite até amanhã de manhã" (ele tem diaInicio/diaFim).
// Uma exceção 22:00→06:00 significa outra coisa: as duas pontas do MESMO dia.
// Aplicar a regra do turno na exceção deixava a madrugada inteira de fora, sem
// erro em lugar nenhum — o sistema só não abria.
{
  const j = { fuso: '-03:00', turnos: [],
    excecoes: [{ data: '2026-12-24', fechado: false, inicio: '22:00', fim: '06:00' }] };
  // hora de Brasília -> instante UTC (BR = UTC-3)
  const brasilia = (h) => new Date(Date.UTC(2026, 11, 24, h + 3, 0, 0));

  ok(estaEmAtendimento(j, brasilia(1)),
    '01:00 do dia 24 ABRE — é a metade que o código perdia inteira');
  ok(estaEmAtendimento(j, brasilia(5)), '05:00 ainda abre');
  naoOk(estaEmAtendimento(j, brasilia(6)), '06:00 fecha (o fim não conta)');
  naoOk(estaEmAtendimento(j, brasilia(12)), 'meio-dia fica fora das duas pontas');
  naoOk(estaEmAtendimento(j, brasilia(21)), '21:00 ainda fora');
  ok(estaEmAtendimento(j, brasilia(22)), '22:00 abre a ponta da noite');
  ok(estaEmAtendimento(j, brasilia(23)), '23:00 também');

  // E, o ponto todo: NÃO invade o dia seguinte.
  const dia25 = (h) => new Date(Date.UTC(2026, 11, 25, h + 3, 0, 0));
  naoOk(estaEmAtendimento(j, dia25(2)),
    '02:00 do dia 25 NÃO abre — a exceção não atravessa para o dia seguinte, '
    + 'ao contrário do turno');

  igual(fimDoAtendimento(j, brasilia(1)).toISOString(), '2026-12-24T09:00:00.000Z',
    'quem está na madrugada termina às 06:00 do próprio dia');
  igual(fimDoAtendimento(j, brasilia(23)).toISOString(), '2026-12-25T03:00:00.000Z',
    'quem está na noite termina à meia-noite, e não às 06:00 do dia seguinte');
}

{
  // O mesmo horário, agora como TURNO: aí sim atravessa.
  const j = { fuso: '-03:00', turnos: [
    { diaInicio: 3, inicio: '22:00', diaFim: 4, fim: '06:00' }] }; // quinta 22:00 -> sexta 06:00
  ok(estaEmAtendimento(j, new Date('2026-08-14T05:00:00Z')),
    'turno 22:00→06:00 ATRAVESSA: sexta 02:00 ainda está dentro');
  naoOk(estaEmAtendimento(j, new Date('2026-08-13T05:00:00Z')),
    'e não vale na madrugada da própria quinta — que é justamente o oposto da exceção');
}

// ---------- o feriado substitui os turnos NOS DOIS SENTIDOS ----------

{
  // Cliente SEM turno nenhum, com feriado de expediente reduzido: ABRE.
  const j = { fuso: '-03:00', turnos: [],
    excecoes: [{ data: '2026-12-25', fechado: false, inicio: '01:00', fim: '03:00' }] };
  ok(estaEmAtendimento(j, new Date(Date.UTC(2026, 11, 25, 5, 0, 0))),
    'cliente sem turnos ABRE às 02:00 numa data com exceção de expediente reduzido — '
    + '"sem turnos" NÃO implica "nunca abre"');
  naoOk(estaEmAtendimento(j, new Date(Date.UTC(2026, 11, 25, 15, 0, 0))),
    'mas só dentro da faixa da exceção');
  naoOk(estaEmAtendimento(j, new Date(Date.UTC(2026, 11, 26, 5, 0, 0))),
    'e só naquela data');
}

{
  // O corte é por DIA-CALENDÁRIO: plantão domingo 22:00 -> segunda 06:00 com
  // feriado na segunda entrega no domingo e recusa na segunda.
  const j = { fuso: '-03:00',
    turnos: [{ diaInicio: 6, inicio: '22:00', diaFim: 0, fim: '06:00' }],
    excecoes: [{ data: '2026-08-17', fechado: true, rotulo: 'feriado na segunda' }] };
  ok(estaEmAtendimento(j, new Date('2026-08-17T02:00:00Z')),
    'domingo 23:00 entrega — o feriado é do dia seguinte e não corta a véspera');
  naoOk(estaEmAtendimento(j, new Date('2026-08-17T05:00:00Z')),
    'segunda 02:00 recusa — a cauda do plantão morre na virada do dia-calendário, '
    + 'que é exatamente o que o cofre faz');
}

// ---------- fuso: deslocamento fixo OU nome de zona ----------

{
  const comZona = normalizarJanela({ fuso: 'America/Sao_Paulo',
    turnos: [{ diaInicio: 0, inicio: '08:00', diaFim: 4, fim: '18:00' }] });
  igual(comZona.fuso, 'America/Sao_Paulo',
    'nome de zona IANA é PRESERVADO — caía no padrão -03:00 calado, e no horário '
    + 'de verão isso é uma hora errada todo dia sem nenhum erro na tela');
  ok(estaEmAtendimento(comZona, new Date('2026-08-10T15:00:00Z')),
    'e a zona decide o horário: segunda 12:00 em São Paulo está dentro');
  naoOk(estaEmAtendimento(comZona, new Date('2026-08-10T10:00:00Z')),
    'segunda 07:00 em São Paulo, fora');

  // Zona de OUTRO país, para provar que não é o -03:00 disfarçado.
  const lisboa = normalizarJanela({ fuso: 'Europe/Lisbon',
    turnos: [{ diaInicio: 0, inicio: '08:00', diaFim: 0, fim: '18:00' }] });
  ok(estaEmAtendimento(lisboa, new Date('2026-08-10T10:00:00Z')),
    'segunda 11:00 em Lisboa está dentro do comercial de lá');
  naoOk(estaEmAtendimento(lisboa, new Date('2026-08-10T18:00:00Z')),
    'e às 19:00 de Lisboa, fora — com -03:00 seriam 15:00 e daria "dentro"');

  // O DESLOCAMENTO É DO INSTANTE, não da zona.
  //
  // É o ponto inteiro de aceitar zona em vez de offset. Brasília não tem
  // horário de verão hoje, então isso não dá para provar com -03:00 — mas Nova
  // York tem, e a mesma zona vale -04:00 em agosto e -05:00 em janeiro. Se o
  // deslocamento fosse calculado uma vez e reusado, uma das duas datas erraria
  // uma hora. É o mesmo erro que nos espera quando o horário de verão voltar.
  {
    const ny = normalizarJanela({ fuso: 'America/New_York',
      turnos: [{ diaInicio: 0, inicio: '09:00', diaFim: 0, fim: '17:00' }] });
    // Segunda 13:00 UTC. Em agosto (EDT, -04:00) são 09:00 em NY: dentro.
    ok(estaEmAtendimento(ny, new Date('2026-08-10T13:00:00Z')),
      'agosto: 13:00 UTC é 09:00 em Nova York (horário de verão), dentro do comercial');
    // Mesma hora UTC em janeiro (EST, -05:00) são 08:00 em NY: fora.
    naoOk(estaEmAtendimento(ny, new Date('2026-01-05T13:00:00Z')),
      'janeiro: a MESMA hora UTC é 08:00 em Nova York, fora — o deslocamento é '
      + 'calculado para cada instante, e não uma vez para a zona');
    ok(estaEmAtendimento(ny, new Date('2026-01-05T14:00:00Z')),
      'e às 14:00 UTC de janeiro são 09:00 em NY, dentro');
  }

  igual(normalizarJanela({ fuso: 'Marte/Olympus',
    turnos: [{ diaInicio: 0, inicio: '08:00', diaFim: 4, fim: '18:00' }] }).fuso, '-03:00',
    'zona inexistente cai no padrão do contrato, em vez de derrubar a janela');
  igual(normalizarJanela({ fuso: '+05:30',
    turnos: [{ diaInicio: 0, inicio: '08:00', diaFim: 4, fim: '18:00' }] }).fuso, '+05:30',
    'e deslocamento fixo continua valendo, inclusive positivo e quebrado');
}


// ---------- a etiqueta: "24 h" é cobertura, não formato de escrita ----------

// A conta era literal e só reconhecia a forma do EXEMPLO do documento. A
// produção manda a outra, e a etiqueta virava "Seg 00:00–00:00" — um texto que
// não significa nada, num host que abre sozinho e não deixa fechar. Quem lê
// aquilo não tem como saber por que o "×" sumiu.
{
  const producao = { fuso: '-03:00', turnos: [
    { diaInicio: 0, inicio: '00:00', diaFim: 0, fim: '00:00', rotulo: '24h' }] };
  igual(descreverJanela(producao), '24 h, todos os dias',
    'o 24 h que a PRODUÇÃO manda (círculo fechado) é reconhecido pela etiqueta');

  const documento = { fuso: '-03:00', turnos: [
    { diaInicio: 0, inicio: '00:00', diaFim: 6, fim: '23:59' }] };
  igual(descreverJanela(documento), '24 h, todos os dias',
    'e o do documento também — mesmo significado, mesma etiqueta');

  igual(descreverJanela({ ...producao, excecoes: [{ data: '2026-09-07', fechado: true }] }),
    '24 h, todos os dias · 1 exceção(ões)',
    'com os feriados contados junto: 24 h COM exceção não é 24 h de verdade');

  const plantao = { fuso: '-03:00', turnos: [
    { diaInicio: 6, inicio: '22:00', diaFim: 0, fim: '06:00' }] };
  igual(descreverJanela(plantao), 'Dom 22:00 – Seg 06:00',
    'turno que ATRAVESSA mostra o dia dos dois lados. "Dom a Seg 22:00–06:00" '
    + 'confunde quem tenta achar onde começa');

  const comercial = { fuso: '-03:00', turnos: [
    { diaInicio: 0, inicio: '08:00', diaFim: 4, fim: '18:00', rotulo: 'Comercial' }] };
  igual(descreverJanela(comercial), 'Seg a Sex 08:00–18:00 (Comercial)',
    'e a faixa normal continua lendo como antes');

  // Quase 24 h NÃO pode virar "24 h": a diferença é justamente o que a pessoa
  // precisa ver.
  const quase = { fuso: '-03:00', turnos: [
    { diaInicio: 0, inicio: '00:00', diaFim: 5, fim: '23:59' }] };
  naoOk(descreverJanela(quase).includes('24 h'),
    'seg a sáb NÃO é "24 h, todos os dias" — arredondar isso esconderia o domingo');
}

console.log(`\n${n} verificações passaram`);
