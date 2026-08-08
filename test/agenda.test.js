'use strict';

// Testes da agenda de host (dias da semana + faixa de horário).
//
// O caso que este arquivo existe para proteger é a faixa que ATRAVESSA A
// MEIA-NOITE. Ela é a janela de manutenção típica (22:00–02:00 de sábado) e é
// exatamente onde a comparação óbvia `min >= inicio && min < fim` dá SEMPRE
// falso — a agenda nunca abriria, sem erro nenhum em lugar algum: o host
// simplesmente não conectaria e o usuário descobriria na segunda-feira.
//
// O segundo ponto perigoso é a QUEM a madrugada pertence. Uma faixa de sábado
// 22:00–02:00 cobre a madrugada de domingo, não a noite de domingo. Errar o
// lado faz a conexão abrir 24 h depois do combinado.

const assert = require('assert');
const {
  normalizarAgenda, estaNaJanela, descreverAgenda, fimDaJanelaAtual,
} = require('../public/agenda');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const naoOk = (c, m) => { assert.ok(!c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };
const lanca = (fn, re, m) => { assert.throws(fn, re, m); n += 1; };

// Datas de referência. 2026-08-07 é uma SEXTA (dia 5).
// dom=0 seg=1 ter=2 qua=3 qui=4 sex=5 sáb=6
const em = (iso) => new Date(iso);
const SEX = '2026-08-07';
const SAB = '2026-08-08';
const DOM = '2026-08-09';
const SEG = '2026-08-10';
ok(em(`${SEX}T12:00:00`).getDay() === 5, 'a data de referência precisa ser sexta');
ok(em(`${SAB}T12:00:00`).getDay() === 6, 'e a seguinte, sábado');
ok(em(`${DOM}T12:00:00`).getDay() === 0, 'e a outra, domingo');

// ---------- faixa normal, dentro do mesmo dia ----------

{
  const a = normalizarAgenda({ dias: [1, 2, 3, 4, 5], inicio: '08:00', fim: '18:00' });
  igual(a, { dias: [1, 2, 3, 4, 5], inicio: '08:00', fim: '18:00' }, 'forma canônica');

  naoOk(estaNaJanela(a, em(`${SEX}T07:59:00`)), 'um minuto antes ainda é fora');
  ok(estaNaJanela(a, em(`${SEX}T08:00:00`)), 'o horário de início já está dentro');
  ok(estaNaJanela(a, em(`${SEX}T13:37:00`)), 'meio da faixa');
  ok(estaNaJanela(a, em(`${SEX}T17:59:00`)), 'um minuto antes do fim ainda é dentro');
  naoOk(estaNaJanela(a, em(`${SEX}T18:00:00`)), 'o horário de fim já é fora — senão a '
    + 'faixa 08–18 e a faixa 18–20 se sobreporiam num minuto');
  naoOk(estaNaJanela(a, em(`${SAB}T13:00:00`)), 'sábado não está na lista de dias');
  naoOk(estaNaJanela(a, em(`${DOM}T13:00:00`)), 'domingo tampouco');
}

// ---------- faixa que atravessa a meia-noite ----------

{
  // Manutenção de sábado à noite: 22:00 de sábado até 02:00 de domingo.
  const a = normalizarAgenda({ dias: [6], inicio: '22:00', fim: '02:00' });

  naoOk(estaNaJanela(a, em(`${SAB}T21:59:00`)), 'antes de começar');
  ok(estaNaJanela(a, em(`${SAB}T22:00:00`)), 'sábado 22:00 abre');
  ok(estaNaJanela(a, em(`${SAB}T23:59:00`)), 'sábado, um minuto antes da virada');
  ok(estaNaJanela(a, em(`${DOM}T00:00:00`)), 'a virada do dia NÃO pode fechar a janela');
  ok(estaNaJanela(a, em(`${DOM}T01:59:00`)), 'domingo de madrugada ainda é a janela de sábado');
  naoOk(estaNaJanela(a, em(`${DOM}T02:00:00`)), 'domingo 02:00 fecha');
  naoOk(estaNaJanela(a, em(`${DOM}T03:00:00`)), 'depois disso, fora');

  // O ponto que troca o dia de lugar: a NOITE de domingo não é da agenda de
  // sábado. Errar aqui abre a conexão 24 h depois do combinado.
  naoOk(estaNaJanela(a, em(`${DOM}T22:30:00`)), 'domingo à noite NÃO é a janela de sábado');
  naoOk(estaNaJanela(a, em(`${SEG}T01:00:00`)), 'segunda de madrugada tampouco');
  naoOk(estaNaJanela(a, em(`${SAB}T01:00:00`)), 'sábado de madrugada é da janela de SEXTA, '
    + 'que não está marcada');
}

{
  // Plantão noturno de seg a sex: 20:00 às 06:00. A sexta à noite entra; a
  // madrugada de sábado também (é a continuação da sexta); a de segunda não,
  // porque a noite de domingo não está marcada.
  const a = normalizarAgenda({ dias: [1, 2, 3, 4, 5], inicio: '20:00', fim: '06:00' });
  ok(estaNaJanela(a, em(`${SEX}T23:00:00`)), 'sexta à noite');
  ok(estaNaJanela(a, em(`${SAB}T05:59:00`)), 'madrugada de sábado é a continuação da sexta');
  naoOk(estaNaJanela(a, em(`${SAB}T06:00:00`)), 'e termina às 06:00');
  naoOk(estaNaJanela(a, em(`${SAB}T21:00:00`)), 'sábado à noite não está marcado');
  naoOk(estaNaJanela(a, em(`${SEG}T05:00:00`)), 'madrugada de segunda seria a continuação '
    + 'de domingo, que não está marcado');
  ok(estaNaJanela(a, em(`${SEG}T21:00:00`)), 'segunda à noite, sim');
}

// ---------- o dia inteiro ----------

{
  // 24 horas CONTÍNUAS, sem buraco. Antes disto a mensagem de erro do módulo
  // recomendava 00:00–23:59 como "o dia inteiro" — e como a comparação é
  // `min < fim`, o minuto das 23:59 ficava de fora: um buraco de 60 s por dia,
  // todo dia, na configuração que o próprio app mandava usar. Marcar os sete
  // dias não resolvia, porque o buraco é dentro do dia.
  const a = normalizarAgenda({ dias: [0, 1, 2, 3, 4, 5, 6], inicio: '00:00', fim: '24:00' });
  ok(estaNaJanela(a, em(`${DOM}T00:00:00`)), 'começo do dia');
  ok(estaNaJanela(a, em(`${DOM}T12:00:00`)), 'meio do dia');
  ok(estaNaJanela(a, em(`${DOM}T23:58:00`)), 'quase o fim');
  ok(estaNaJanela(a, em(`${DOM}T23:59:00`)), 'O ÚLTIMO MINUTO TAMBÉM — é isto que "24:00" existe para garantir');
  ok(estaNaJanela(a, em(`${SEG}T00:00:00`)), 'e emenda no dia seguinte sem intervalo');
  igual(descreverAgenda(a), 'Todo dia, 00:00–24:00', 'e o texto diz 24:00');
  igual(fimDaJanelaAtual(a, em(`${DOM}T23:59:00`)), em(`${SEG}T00:00:00`),
    'o fim de um dia inteiro é a meia-noite seguinte');

  // 00:00–23:59 continua sendo aceito (é uma faixa legítima), só não é o dia
  // inteiro — e a mensagem de erro não o recomenda mais.
  const b = normalizarAgenda({ dias: [0], inicio: '00:00', fim: '23:59' });
  naoOk(estaNaJanela(b, em(`${DOM}T23:59:00`)), '23:59 como fim exclui o próprio minuto');

  // 24:00 é só FIM. Como início não faz sentido e não pode ser aceito em silêncio.
  lanca(() => normalizarAgenda({ dias: [0], inicio: '24:00', fim: '02:00' }),
    /HH:MM/, '24:00 não vale como início');
}

// ---------- validação ----------

{
  igual(normalizarAgenda(null), null, 'sem agenda é null');
  igual(normalizarAgenda(undefined), null, 'undefined também');
  igual(normalizarAgenda(''), null, 'string vazia também');
  igual(normalizarAgenda({ dias: [], inicio: '', fim: '' }), null,
    'formulário com nada preenchido DESLIGA a agenda em vez de dar erro — é assim '
    + 'que o usuário tira a trava de um host');

  lanca(() => normalizarAgenda({ dias: [], inicio: '08:00', fim: '18:00' }),
    /pelo menos um dia/, 'horário sem dia não vale');
  lanca(() => normalizarAgenda({ dias: [9], inicio: '08:00', fim: '18:00' }),
    /Dia da semana inválido/, 'dia fora de 0..6 é RECUSADO, não descartado em silêncio');
  lanca(() => normalizarAgenda({ dias: [1], inicio: '', fim: '18:00' }),
    /HH:MM/, 'dia sem horário não vale');
  lanca(() => normalizarAgenda({ dias: [1], inicio: '25:00', fim: '18:00' }),
    /HH:MM/, 'hora impossível');
  lanca(() => normalizarAgenda({ dias: [1], inicio: '08:60', fim: '18:00' }),
    /HH:MM/, 'minuto impossível');
  lanca(() => normalizarAgenda({ dias: [1], inicio: '8:00', fim: '18:00' }),
    /HH:MM/, 'sem o zero à esquerda não passa: é o formato que o <input type="time"> '
    + 'produz e o que o XML de backup grava, então aceitar variações só criaria '
    + 'duas grafias para a mesma hora');
  lanca(() => normalizarAgenda({ dias: [1], inicio: '08:00', fim: '08:00' }),
    /diferente da de início/, 'início igual ao fim é ambíguo (zero minuto ou o dia todo?)');
  // A mensagem precisa apontar para um caminho que EXISTA na tela. Ela já
  // recomendou 00:00–23:59 (um buraco de um minuto por dia) e depois "digite
  // 24:00" — que um <input type="time"> recusa, deixando o campo vazio. Agora
  // aponta para a caixa de marcação, e o texto não pode voltar a mandar digitar.
  const msg = (() => { try { normalizarAgenda({ dias: [1], inicio: '08:00', fim: '08:00' }); }
    catch (e) { return e.message; } return ''; })();
  ok(/fim do dia/.test(msg), 'a mensagem aponta para "até o fim do dia"');
  ok(!/24:00/.test(msg), 'e NÃO manda digitar 24:00 — o campo de hora não aceita esse valor');
  lanca(() => normalizarAgenda([1, 2]), /inválida/, 'array não é agenda');
  lanca(() => normalizarAgenda(7), /inválida/, 'número não é agenda');
}

{
  // Entrada suja: dias repetidos, fora de ordem, como texto — vem do XML de
  // backup, que é arquivo de terceiro.
  const a = normalizarAgenda({ dias: ['5', '1', '5', ' 3 '], inicio: '09:00', fim: '17:00' });
  igual(a.dias, [1, 3, 5], 'dias viram números, únicos e ordenados');

  const b = normalizarAgenda({ dias: '1,2,3', inicio: '09:00', fim: '17:00' });
  igual(b.dias, [1, 2, 3], 'lista separada por vírgula (formato do XML) também é aceita');

  // O caso que fazia um host abrir sozinho aos DOMINGOS sem ninguém ter pedido:
  // `Number('')` é 0, um dia perfeitamente válido. Um <agenda> sem o atributo
  // dias (arquivo editado à mão, ou de outra versão) chegava aqui como string
  // vazia e virava {dias:[0]} — sem erro, sem aviso na importação, com o
  // cadastro parecendo normal na tela.
  for (const vazio of ['', '  ', ',', ',,']) {
    lanca(() => normalizarAgenda({ dias: vazio, inicio: '22:00', fim: '02:00' }),
      /pelo menos um dia/, `dias=${JSON.stringify(vazio)} não pode virar domingo`);
  }
  igual(normalizarAgenda({ dias: '1,,3', inicio: '09:00', fim: '17:00' }).dias, [1, 3],
    'separador vazio no meio é só separador — não pode acrescentar domingo à lista');
  lanca(() => normalizarAgenda({ dias: 'seg,qua', inicio: '09:00', fim: '17:00' }),
    /Dia da semana inválido/, 'dia por extenso é recusado com o motivo, não jogado fora');
  lanca(() => normalizarAgenda({ dias: '1,x', inicio: '09:00', fim: '17:00' }),
    /Dia da semana inválido/, 'lixo no meio de uma lista boa também é recusado — '
    + 'descartar em silêncio perderia um dia que o usuário pediu');
}

{
  // Uma agenda corrompida no data.json não pode travar a interface: estaNaJanela
  // é chamada a cada render e a cada tique do relógio.
  naoOk(estaNaJanela(null, em(`${SEX}T12:00:00`)), 'sem agenda, nunca está na janela');
  naoOk(estaNaJanela({}, em(`${SEX}T12:00:00`)), 'agenda vazia');
  naoOk(estaNaJanela({ dias: [5], inicio: 'lixo', fim: '18:00' }, em(`${SEX}T12:00:00`)),
    'horário ilegível não pode ser lido como "sempre aberto"');
  naoOk(estaNaJanela({ dias: [5], inicio: '08:00', fim: '08:00' }, em(`${SEX}T12:00:00`)),
    'faixa degenerada tampouco');
}

// ---------- até quando a aba fica travada ----------

{
  const a = normalizarAgenda({ dias: [1, 2, 3, 4, 5], inicio: '08:00', fim: '18:00' });
  igual(fimDaJanelaAtual(a, em(`${SEX}T10:00:00`)), em(`${SEX}T18:00:00`),
    'no meio do expediente, o fim é hoje às 18:00');
  igual(fimDaJanelaAtual(a, em(`${SEX}T20:00:00`)), null, 'fora da janela não há fim');
}

{
  const a = normalizarAgenda({ dias: [6], inicio: '22:00', fim: '02:00' });
  igual(fimDaJanelaAtual(a, em(`${SAB}T23:00:00`)), em(`${DOM}T02:00:00`),
    'antes da meia-noite, o fim é AMANHÃ às 02:00');
  igual(fimDaJanelaAtual(a, em(`${DOM}T01:00:00`)), em(`${DOM}T02:00:00`),
    'depois da meia-noite, o fim é hoje às 02:00');
}

// ---------- texto para a tela ----------

{
  const d = (dias, i, f) => descreverAgenda(normalizarAgenda({ dias, inicio: i, fim: f }));
  igual(d([1, 2, 3, 4, 5], '08:00', '18:00'), 'Seg a Sex, 08:00–18:00', 'expediente');
  igual(d([0, 1, 2, 3, 4, 5, 6], '00:00', '23:59'), 'Todo dia, 00:00–23:59', 'todo dia');
  igual(d([0, 6], '10:00', '14:00'), 'Fim de semana, 10:00–14:00', 'fim de semana');
  igual(d([2], '09:00', '10:00'), 'Ter, 09:00–10:00', 'um dia só');
  igual(d([1, 3], '09:00', '10:00'), 'Seg, Qua, 09:00–10:00', 'dois dias soltos');
  igual(d([1, 2], '09:00', '10:00'), 'Seg, Ter, 09:00–10:00', 'dois seguidos ainda são listados');
  igual(d([1, 2, 3, 4, 6], '09:00', '10:00'), 'Seg a Qui, Sáb, 09:00–10:00',
    'corrida de 3+ vira intervalo, o resto fica solto');
  igual(d([6], '22:00', '02:00'), 'Sáb, 22:00–02:00 (vira o dia)',
    'a faixa que atravessa a meia-noite precisa DIZER isso — senão "22:00–02:00" '
    + 'se lê como um erro de digitação');
  igual(descreverAgenda(null), '', 'sem agenda, sem texto');
}

console.log(`\n${n} verificações passaram`);
