'use strict';

// Gráfico Smokeping do Monitor de IP. O que trava aqui é a MATEMÁTICA do
// agrupamento (balde certo, percentil certo, perda contada) e o layout puro —
// nada de DOM: o canvas do fim é um objeto falso que grava as chamadas, para
// provar que a pintura usa as coordenadas que o layout calculou.

const assert = require('assert');
const sp = require('../public/smokeping');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };
const perto = (a, b, m, eps = 1e-9) => { assert.ok(Math.abs(a - b) <= eps, `${m} (${a} ≠ ${b})`); n += 1; };

// Série sintética: 1 ping/s até `agora`, no formato que a tela descreve
// ({ estado, latencia, t }). `lat(i)` dá a latência; devolver null = perda.
// As amostras ficam a meio segundo das marcas redondas: os baldes são
// intervalos meio-abertos e uma amostra exatamente na fronteira cairia no
// balde seguinte — o que é correto, mas faria a contagem da fixture depender
// disso em vez do que se quer provar.
const AGORA = 1_757_700_000_000; // 2025-09-12T18:00:00Z, fixo para o teste não depender do relógio
function serie(qtd, lat, agora = AGORA, passoMs = 1000) {
  const out = [];
  for (let i = 0; i < qtd; i += 1) {
    const l = lat(i);
    out.push({ seq: i + 1, estado: l == null ? 'timeout' : 'ok', latencia: l, t: agora - (qtd - 1 - i) * passoMs - passoMs / 2 });
  }
  return out;
}

// ---------- 1. percentil ----------

{
  igual(sp.percentil([1, 2, 3, 4], 50), 2.5, 'p50 de [1,2,3,4] interpola: 2,5');
  igual(sp.percentil([1, 2, 3, 4], 25), 1.75, 'p25 de [1,2,3,4] = 1 + 0,75×1');
  igual(sp.percentil([1, 2, 3, 4], 75), 3.25, 'p75 de [1,2,3,4] = 3 + 0,25×1');
  igual(sp.percentil([1, 2, 3, 4], 0), 1, 'p0 é o mínimo');
  igual(sp.percentil([1, 2, 3, 4], 100), 4, 'p100 é o máximo');
  igual(sp.percentil([10, 20, 30, 40, 50], 95), 48, 'p95 de 5 valores: pos 3,8 → 40 + 0,8×10');
  igual(sp.percentil([7], 50), 7, 'um valor só é o próprio');
  igual(sp.percentil([9, 1, 5], 50), 5, 'ordena antes (entrada desordenada)');
  const original = [3, 1, 2];
  sp.percentil(original, 50);
  igual(original, [3, 1, 2], 'não altera o array de entrada');
  igual(sp.percentil([], 50), null, 'vazio → null');
  igual(sp.percentil([1, NaN, 3], 50), 2, 'ignora NaN no meio');
}

// ---------- 2. ticks bonitos ----------

{
  igual(sp.ticksBonitos(37), [0, 10, 20, 30, 40], '37 → passo 10, fecha em 40');
  igual(sp.ticksBonitos(100), [0, 20, 40, 60, 80, 100], '100 → passo 20');
  igual(sp.ticksBonitos(250), [0, 50, 100, 150, 200, 250], '250 → passo 50');
  igual(sp.ticksBonitos(1), [0, 0.2, 0.4, 0.6, 0.8, 1], '1 ms (LAN) → passo 0,2 sem lixo de ponto flutuante');
  igual(sp.ticksBonitos(0.8), [0, 0.2, 0.4, 0.6, 0.8], 'abaixo de 1 ms ainda dá escala');
  igual(sp.ticksBonitos(0), [0, 1], 'máximo 0 (só perda) → escala mínima');
  igual(sp.ticksBonitos(NaN), [0, 1], 'NaN → escala mínima, não lança');
  let todosOk = true;
  for (let m = 1; m < 5000; m += 7) {
    const t = sp.ticksBonitos(m);
    if (t.length < 4 || t.length > 11 || t[t.length - 1] < m || t[0] !== 0) { todosOk = false; break; }
  }
  ok(todosOk, 'para qualquer máximo, 4–11 ticks, começando em 0 e cobrindo o máximo');
}

// ---------- 3. agrupar ----------

{
  // 120 s de série regular, 12 baldes de 10 s → 10 amostras por balde
  const s = serie(120, (i) => 10 + (i % 10)); // latências 10..19 se repetindo
  const b = sp.agrupar(s, { janelaMs: 120_000, baldes: 12, agora: AGORA });
  igual(b.length, 12, 'devolve exatamente o número de baldes pedido');
  igual(b.map((x) => x.n), Array(12).fill(10), 'série regular: 10 amostras em cada balde');
  igual(b.map((x) => x.perdidos), Array(12).fill(0), 'sem perda');
  igual([b[0].min, b[0].max], [10, 19], 'mín/máx do balde');
  igual(b[0].mediana, 14.5, 'mediana de 10..19 = 14,5');
  igual([b[0].p25, b[0].p75], [12.25, 16.75], 'p25/p75 do balde (interpolados)');
  ok(b.every((x, i) => i === 0 || x.inicio === b[i - 1].fim), 'baldes contíguos (fim de um = início do próximo)');
  igual([b[0].inicio, b[11].fim], [AGORA - 120_000, AGORA], 'a janela vai de agora−janela até agora');

  // buraco: sem amostras entre 60 s e 50 s atrás → balde 6 vazio
  const comBuraco = s.filter((a) => !(a.t > AGORA - 60_000 && a.t <= AGORA - 50_000));
  const bb = sp.agrupar(comBuraco, { janelaMs: 120_000, baldes: 12, agora: AGORA });
  igual(bb[6].n, 0, 'balde sem amostra fica n:0');
  igual([bb[6].min, bb[6].mediana, bb[6].max], [null, null, null], 'e sem estatística (null, não 0)');
  igual(bb[5].n + bb[7].n, 20, 'os vizinhos seguem cheios');

  // perda parcial: metade timeout no balde
  const parcial = serie(10, (i) => (i % 2 ? null : 20));
  const bp = sp.agrupar(parcial, { janelaMs: 10_000, baldes: 1, agora: AGORA });
  igual([bp[0].n, bp[0].perdidos], [10, 5], 'perda parcial: n conta todas, perdidos só as falhas');
  igual([bp[0].min, bp[0].mediana, bp[0].max], [20, 20, 20], 'estatística só das recebidas');

  // perda total
  const total = serie(10, () => null);
  const bt = sp.agrupar(total, { janelaMs: 10_000, baldes: 1, agora: AGORA });
  igual([bt[0].n, bt[0].perdidos, bt[0].mediana], [10, 10, null], 'perda total: n = perdidos, sem mediana');

  // uma amostra só
  const uma = sp.agrupar([{ seq: 1, estado: 'ok', latencia: 3.5, t: AGORA }], { janelaMs: 60_000, baldes: 6, agora: AGORA });
  igual(uma[5], { inicio: AGORA - 10_000, fim: AGORA, n: 1, perdidos: 0, min: 3.5, p25: 3.5, mediana: 3.5, p75: 3.5, max: 3.5 },
    'uma amostra em t = agora cai no ÚLTIMO balde (não some pela borda), mín = mediana = máx');

  // vazio
  const vazio = sp.agrupar([], { janelaMs: 60_000, baldes: 6, agora: AGORA });
  igual(vazio.length, 6, 'série vazia ainda devolve os baldes');
  igual(vazio.every((x) => x.n === 0 && x.mediana === null), true, 'todos vazios');
  igual(sp.agrupar(null, { janelaMs: 60_000, baldes: 3, agora: AGORA }).length, 3, 'null em vez de array não lança');

  // fora da janela: 200 s de série, janela de 60 s → só os últimos 60 entram
  const longa = serie(200, () => 5);
  const bl = sp.agrupar(longa, { janelaMs: 60_000, baldes: 6, agora: AGORA });
  igual(bl.reduce((acc, x) => acc + x.n, 0), 60, 'amostras mais antigas que a janela ficam de fora');

  // relógio adiantado: t > agora entra no último balde
  const futura = sp.agrupar([{ estado: 'ok', latencia: 1, t: AGORA + 5000 }], { janelaMs: 60_000, baldes: 6, agora: AGORA });
  igual(futura[5].n, 1, 'amostra com t depois de agora (relógio do servidor adiantado) fica no último balde');

  // formato do log real do monitor: { vivo, latencia, t }
  const real = [
    { seq: 1, t: AGORA - 2000, vivo: true, latencia: 12 },
    { seq: 2, t: AGORA - 1000, vivo: false, latencia: null },
    { seq: 3, t: AGORA, vivo: true, latencia: 14 },
  ];
  const br = sp.agrupar(real, { janelaMs: 10_000, baldes: 1, agora: AGORA });
  igual([br[0].n, br[0].perdidos, br[0].mediana], [3, 1, 13], 'aceita o formato { vivo, latencia } de lib/monitor.js');
  ok(!sp._amostraRecebida({ estado: 'ok', latencia: null, t: AGORA }), '"ok" sem latência numérica conta como perda (não dá para plotar)');
  ok(!sp._amostraRecebida({ estado: 'inacessivel', latencia: 5, t: AGORA }), 'estado de falha com número espúrio ainda é perda');

  // baldes padrão
  igual(sp.agrupar(s, { janelaMs: 120_000, agora: AGORA }).length, sp.BALDES_PADRAO, 'sem `baldes` usa o padrão (120)');
}

// ---------- 4. resumo ----------

{
  // 100 amostras: latências 1..100, das quais as de índice múltiplo de 10 são perdidas (10 perdas)
  const s = serie(100, (i) => (i % 10 === 9 ? null : i + 1));
  const r = sp.resumo(s, 200_000, AGORA);
  igual(r.n, 100, 'n conta todas as amostras da janela');
  igual(r.perdaPct, 10, '10 perdidas em 100 → 10%');
  // recebidas: 1..100 sem 10,20,...,100 → 90 valores
  const recebidas = [];
  for (let i = 1; i <= 100; i += 1) if (i % 10 !== 0) recebidas.push(i);
  igual(r.p50, sp.percentil(recebidas, 50), 'p50 só das recebidas');
  igual(r.p95, sp.percentil(recebidas, 95), 'p95 só das recebidas');
  igual(r.max, 99, 'máx das recebidas (100 foi perdida)');
  igual(r.ultima, null, 'última amostra perdida → ultima null');

  const s2 = serie(4, (i) => [30, 31, null, 29][i]);
  const r2 = sp.resumo(s2, 60_000, AGORA);
  igual(r2.ultima, 29, 'ultima = latência da amostra mais recente');
  igual(r2.perdaPct, 25, '1 em 4 → 25%');

  igual(sp.resumo(serie(3, () => null), 60_000, AGORA).perdaPct, 100, 'tudo perdido → 100%');
  igual(sp.resumo([], 60_000, AGORA), { n: 0, perdaPct: 0, p50: null, p95: null, max: null, ultima: null }, 'vazio → zeros e nulls');
  igual(sp.resumo(serie(3, () => 7), 1600, AGORA).n, 2, 'a janela do resumo também corta o que é antigo');
  igual(sp.resumo(serie(7, (i) => 1 + i / 3), 60_000, AGORA).perdaPct, 0, 'perdaPct sem perda é 0 exato');
  igual(sp.resumo(serie(3, (i) => (i === 0 ? null : 1)), 60_000, AGORA).perdaPct, 33.3, 'perdaPct arredonda a 1 casa (33,3)');
}

// ---------- 5. janelas e formatação ----------

{
  const j = sp.janelas();
  igual(j.map((x) => x.rotulo), ['5 min', '30 min', '2 h', '12 h'], 'as quatro janelas do seletor');
  igual(j.map((x) => x.ms), [300_000, 1_800_000, 7_200_000, 43_200_000], 'em ms, crescentes');
  j[0].rotulo = 'x';
  igual(sp.janelas()[0].rotulo, '5 min', 'devolve cópia (mexer no retorno não muda a tabela)');
  igual(sp.formatarMs(0.83), '0,8 ms', 'abaixo de 10 ms mostra a casa decimal, com vírgula');
  igual(sp.formatarMs(123.6), '124 ms', 'acima de 10 ms arredonda para inteiro');
  igual(sp.formatarMs(null), '—', 'sem valor → travessão');
  igual(sp.formatarPct(33.333), '33,3%', 'percentual com 1 casa e vírgula');
}

// ---------- 6. layout puro ----------

{
  const s = serie(600, (i) => 10 + (i % 7) + (i % 50 === 0 ? 40 : 0)); // 10 min, com picos
  const baldes = sp.agrupar(s, { janelaMs: 600_000, baldes: 60, agora: AGORA });
  const lay = sp.layout(baldes, { largura: 800, altura: 240 });

  ok(lay.area.x > 0 && lay.area.y > 0 && lay.area.x + lay.area.w <= 800 && lay.area.y + lay.area.h <= 240,
    'área de plotagem cabe no canvas');
  igual(lay.colunas.length, 60, 'uma coluna por balde com mediana');
  ok(lay.colunas.every((c, i) => i === 0 || c.x > lay.colunas[i - 1].x), 'colunas com x monotônico crescente');
  ok(lay.colunas.every((c) => c.x >= lay.area.x && c.x + c.w <= lay.area.x + lay.area.w + 1e-6), 'colunas dentro da área');
  ok(lay.colunas.every((c) => c.yMax <= c.yP75 && c.yP75 <= c.yMediana && c.yMediana <= c.yP25 && c.yP25 <= c.yMin),
    'em cada coluna: máx acima de p75, p75 acima da mediana, mediana acima de p25, p25 acima do mín (y cresce para baixo)');
  ok(lay.colunas.every((c) => c.yMax >= lay.area.y - 1e-6 && c.yMin <= lay.area.y + lay.area.h + 1e-6), 'fumaça nunca sai da área');
  igual(lay.ticksY[0], { valor: 0, y: lay.area.y + lay.area.h, rotulo: '0' }, 'tick 0 na base da área');
  ok(lay.ticksY.every((t, i) => i === 0 || t.y < lay.ticksY[i - 1].y), 'ticks Y sobem conforme o valor cresce');
  perto(lay.ticksY[lay.ticksY.length - 1].y, lay.area.y, 'o maior tick encosta no topo da área');
  ok(lay.topo >= 56, 'a escala cobre o pico (56 ms)');
  ok(lay.ticksX.length >= 2 && lay.ticksX.length <= 10, `eixo X com número razoável de marcas (${lay.ticksX.length})`);
  ok(lay.ticksX.every((t) => t.x >= lay.area.x - 1e-6 && t.x <= lay.area.x + lay.area.w + 1e-6), 'marcas de hora dentro da área');
  ok(lay.ticksX.every((t, i) => i === 0 || t.x > lay.ticksX[i - 1].x), 'marcas de hora em ordem');
  ok(lay.ticksX.every((t) => /^\d{2}:\d{2}$/.test(t.rotulo)), 'rótulo HH:MM');
  igual(lay.linhas.length, 1, 'série contínua → uma linha de mediana só');
  igual(lay.linhas[0].length, 60, 'um ponto por balde');
  igual(lay.perdas, [], 'sem perda → nenhuma marca vermelha');

  // buraco e perda quebram/marcam
  const comFalha = s.map((a) => (a.t > AGORA - 300_000 && a.t <= AGORA - 290_000 ? Object.assign({}, a, { estado: 'timeout', latencia: null }) : a));
  const bf = sp.agrupar(comFalha, { janelaMs: 600_000, baldes: 60, agora: AGORA });
  const lf = sp.layout(bf, { largura: 800, altura: 240 });
  igual(lf.colunas.length, 59, 'balde todo perdido não tem coluna de fumaça');
  igual(lf.linhas.length, 2, 'a mediana quebra no balde perdido (não liga por cima do buraco)');
  igual(lf.perdas.length, 1, 'e a perda vira uma marca');
  igual(lf.perdas[0].pct, 100, 'com 100% de intensidade');
  ok(lf.perdas[0].y >= lf.area.y + lf.area.h && lf.perdas[0].y + lf.perdas[0].h < 240, 'a faixa de perda fica abaixo da área, dentro do canvas');

  // vazio e canvas minúsculo não lançam
  const lv = sp.layout([], { largura: 300, altura: 100 });
  igual([lv.colunas, lv.linhas, lv.ticksX], [[], [], []], 'sem baldes: nada para desenhar, sem lançar');
  const lm = sp.layout(baldes, { largura: 20, altura: 10 });
  ok(lm.area.w >= 1 && lm.area.h >= 1, 'canvas menor que as margens ainda dá área ≥ 1 px (sem divisão por zero)');

  // ticks de tempo alinhados em múltiplos redondos
  const tt = sp._ticksDeTempo(AGORA - 3_600_000, AGORA);
  ok(tt.every((t) => new Date(t).getMinutes() % 10 === 0), '1 h → marcas em múltiplos de 10 min');
  ok(tt.every((t, i) => i === 0 || t - tt[i - 1] === 600_000), 'passo de 10 min constante');
}

// ---------- 7. desenhar() com canvas falso ----------

// Grava toda chamada e toda atribuição de propriedade do contexto 2D.
function canvasFalso(largura, altura) {
  const chamadas = [];
  const props = {};
  const metodos = ['setTransform', 'clearRect', 'fillRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill', 'fillText', 'scale'];
  const ctx = {};
  for (const m of metodos) ctx[m] = (...args) => { chamadas.push({ m, args }); };
  const proxy = new Proxy(ctx, { set(alvo, k, v) { props[k] = v; chamadas.push({ m: `set:${String(k)}`, args: [v] }); alvo[k] = v; return true; } });
  let pedidos = 0;
  const canvas = {
    clientWidth: largura, clientHeight: altura, width: 0, height: 0,
    getContext(tipo) { pedidos += 1; return tipo === '2d' ? proxy : null; },
  };
  return { canvas, chamadas, props, pedidos: () => pedidos };
}

{
  const s = serie(300, (i) => 8 + (i % 5) + (i % 40 === 0 ? 30 : 0));
  const cores = { fundo: '#111', fumaca: 'rgba(1,2,3,0.3)', fumacaDensa: 'rgba(1,2,3,0.6)', mediana: '#0af', perda: '#f00', texto: '#eee', grade: '#333' };
  const f = canvasFalso(600, 200);
  const lay = sp.desenhar(f.canvas, s, { janelaMs: 300_000, baldes: 30, cores, agora: AGORA, dpr: 2 });

  ok(lay && lay.colunas.length === 30, 'desenhar() devolve o layout usado');
  igual([f.canvas.width, f.canvas.height], [1200, 400], 'bitmap = tamanho CSS × devicePixelRatio (2)');
  igual(f.chamadas.find((c) => c.m === 'setTransform').args, [2, 0, 0, 2, 0, 0], 'transform pelo dpr para desenhar em pixels CSS');

  const fillRects = f.chamadas.filter((c) => c.m === 'fillRect');
  igual(fillRects[0].args, [0, 0, 600, 200], 'primeiro fillRect é o fundo inteiro em pixels CSS');
  const col = lay.colunas[3];
  ok(fillRects.some((c) => c.args[0] === col.x && c.args[1] === col.yMax && c.args[2] === col.w && c.args[3] === col.yMin - col.yMax),
    'a fumaça leve de uma coluna é pintada exatamente nas coordenadas do layout (x, yMax, w, yMin−yMax)');
  ok(fillRects.some((c) => c.args[0] === col.x && c.args[1] === col.yP75 && c.args[3] === col.yP25 - col.yP75),
    'a fumaça densa também (yP75 → yP25)');

  const moves = f.chamadas.filter((c) => c.m === 'moveTo');
  const lines = f.chamadas.filter((c) => c.m === 'lineTo');
  const p0 = lay.linhas[0][0];
  const p1 = lay.linhas[0][1];
  ok(moves.some((c) => c.args[0] === p0.x && c.args[1] === p0.y), 'a mediana começa com moveTo no primeiro ponto do layout');
  ok(lines.some((c) => c.args[0] === p1.x && c.args[1] === p1.y), 'e segue com lineTo no segundo');

  // as cores passadas são de fato usadas (tema vem de fora)
  const fills = f.chamadas.filter((c) => c.m === 'set:fillStyle').map((c) => c.args[0]);
  ok(fills.includes('#111') && fills.includes('rgba(1,2,3,0.3)') && fills.includes('rgba(1,2,3,0.6)'), 'fundo e fumaças usam as cores passadas');
  igual(f.chamadas.filter((c) => c.m === 'set:strokeStyle').map((c) => c.args[0]).includes('#0af'), true, 'a mediana usa a cor passada');
  ok(f.chamadas.some((c) => c.m === 'fillText' && /p50 .* ms/.test(c.args[0]) && /perda 0%/.test(c.args[0])), 'legenda com p50/p95/perda do período');
  ok(f.chamadas.some((c) => c.m === 'fillText' && /^\d{2}:\d{2}$/.test(c.args[0])), 'rótulos de hora no eixo X');
  ok(!fillRects.some((c) => c.args[1] >= lay.faixaPerda.y && c.args[3] === lay.faixaPerda.h), 'sem perda, nada pintado na faixa de perda');

  // com perda: marca vermelha com alpha proporcional
  const sp2 = serie(300, (i) => (i >= 150 && i < 160 ? null : 10));
  const g = canvasFalso(600, 200);
  const lay2 = sp.desenhar(g.canvas, sp2, { janelaMs: 300_000, baldes: 30, cores, agora: AGORA, dpr: 1 });
  igual(lay2.perdas.length, 1, 'um balde com perda');
  const marca = g.chamadas.filter((c) => c.m === 'fillRect').find((c) => c.args[1] === lay2.faixaPerda.y);
  ok(marca && marca.args[0] === lay2.perdas[0].x, 'a marca de perda é pintada no x do balde perdido');
  const alphas = g.chamadas.filter((c) => c.m === 'set:globalAlpha').map((c) => c.args[0]);
  igual(alphas[0], 1, '100% de perda → intensidade máxima');
  igual(alphas[alphas.length - 1], 1, 'globalAlpha volta a 1 no fim (não vaza para o próximo desenho)');

  // cores incompletas não quebram (reserva)
  const h = canvasFalso(300, 100);
  ok(sp.desenhar(h.canvas, s, { janelaMs: 300_000, agora: AGORA, dpr: 1 }) !== null, 'sem `cores` desenha com a paleta de reserva');
  ok(!h.chamadas.some((c) => c.m === 'set:fillStyle' && c.args[0] === undefined), 'nenhum fillStyle fica undefined');

  // 0×0: sai sem lançar e sem pedir contexto
  const z = canvasFalso(0, 0);
  igual(sp.desenhar(z.canvas, s, { janelaMs: 300_000, cores, agora: AGORA }), null, 'canvas 0×0 → null, sem lançar');
  igual(z.pedidos(), 0, 'e nem pede o contexto 2D');
  igual(sp.desenhar(null, s, {}), null, 'canvas null → null, sem lançar');
  igual(sp.desenhar({}, s, {}), null, 'objeto sem getContext → null, sem lançar');
  const semCtx = { clientWidth: 10, clientHeight: 10, getContext: () => null };
  igual(sp.desenhar(semCtx, s, {}), null, 'getContext devolvendo null → null');

  // largura/altura explícitas vencem o clientWidth (canvas ainda fora do DOM)
  const e = canvasFalso(0, 0);
  const le = sp.desenhar(e.canvas, s, { janelaMs: 300_000, largura: 400, altura: 150, agora: AGORA, dpr: 1 });
  igual([le.largura, le.altura, e.canvas.width], [400, 150, 400], 'largura/altura passadas por opção valem quando o canvas não tem tamanho');
}

// ---------- 8. bordas defensivas ----------

// Entradas que o app não deveria mandar mas que já derrubaram o gráfico em
// revisão: nada aqui pode lançar, travar ou devolver NaN para o canvas.

{
  // ponto flutuante no eixo Y
  igual(sp.ticksBonitos(7 * 0.1), [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7], '0,7000000000000001 (7×0,1) não ganha um tick a mais por ruído de ponto flutuante');
  igual(sp.ticksBonitos(3 * 0.1), [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3], '0,30000000000000004 sai com rótulos limpos');
  const infimo = sp.ticksBonitos(1e-120);
  ok(infimo.length === 6 && infimo[5] === 1e-120 && new Set(infimo).size === 6, 'máximo ínfimo (1e-120) não lança RangeError nem colapsa os ticks em 0');
  ok(sp.ticksBonitos(1e308).length === 6, 'máximo gigantesco também dá escala');
  let ruim = 0;
  for (let e = -9; e <= 15; e += 1) for (let k = 1; k < 100; k += 1) {
    const m = k * 10 ** e;
    const t = sp.ticksBonitos(m);
    if (t.length < 4 || t.length > 11 || t[t.length - 1] < m * (1 - 1e-11) || t[0] !== 0 || new Set(t).size !== t.length) ruim += 1;
  }
  igual(ruim, 0, 'de 1e-9 a 1e17, sempre 4–11 ticks distintos, do 0 até cobrir o máximo');

  // séries grandes: Math.max(...arr) estourava a pilha
  const grande = [];
  for (let i = 0; i < 300_000; i += 1) grande.push({ estado: 'ok', latencia: i % 100, t: AGORA - i * 100 });
  const rg = sp.resumo(grande, 43_200_000, AGORA);
  igual([rg.n, rg.max, rg.ultima], [300_000, 99, 0], '300 mil amostras no resumo não estouram a pilha (sem spread)');
  igual(sp.agrupar(grande, { janelaMs: 43_200_000, baldes: 1, agora: AGORA })[0].max, 99, 'nem no agrupar com tudo num balde só');

  // janela e baldes fora do razoável
  const um = [{ estado: 'ok', latencia: 1, t: AGORA }];
  igual(sp.agrupar(um, { janelaMs: Infinity, baldes: 3, agora: AGORA }).length, 3, 'janelaMs Infinity cai na janela padrão em vez de TypeError (cestos[NaN])');
  const neg = sp.agrupar(um, { janelaMs: -5, baldes: 3, agora: AGORA });
  ok(neg.every((b) => b.fim > b.inicio), 'janelaMs negativo não produz balde com fim antes do início');
  igual(sp.agrupar([], { janelaMs: 1000, baldes: 1e7, agora: AGORA }).length, sp.BALDES_MAX, `baldes: 1e7 é limitado a BALDES_MAX (${sp.BALDES_MAX}) — não aloca milhões de objetos`);
  igual(sp.agrupar([], { janelaMs: 1000, baldes: Infinity, agora: AGORA }).length, sp.BALDES_MAX, 'baldes: Infinity idem (antes era laço infinito)');
  igual(sp.agrupar([], { janelaMs: 1000, baldes: 1, agora: new Date(AGORA) })[0].fim, AGORA, '`agora` como Date é aceito');
  igual(sp.agrupar('ab'.repeat(500_000), { janelaMs: 1000 }).length, 120, 'string de 1 MB no lugar da série: ignora, não lança');
  const lixo = sp.agrupar([null, undefined, 'x', 5, {}, { t: 'abc' }, { t: AGORA, latencia: '5' }], { janelaMs: 1000, baldes: 1, agora: AGORA });
  igual([lixo[0].n, lixo[0].perdidos], [1, 1], 'itens sem `t` numérico são ignorados; latência em string conta como perda');
  igual(sp.resumo(um, Infinity, AGORA).n, 1, 'resumo com janela Infinity usa a padrão');
  igual(sp.resumo(um, -5, AGORA).n, 1, 'resumo com janela negativa idem');
  igual(sp.percentil(null, 50), null, 'percentil(null) → null');
  igual(sp.percentil(['1', '2'], 50), null, 'percentil só de strings → null (não converte lixo)');

  // eixo X não explode
  const t0 = Date.now();
  const tx = sp._ticksDeTempo(0, 1e15);
  ok(tx.length >= 2 && tx.length <= 9 && Date.now() - t0 < 100, `janela de 1e15 ms dá ${tx.length} marcas, não 23 milhões`);
  igual(sp._ticksDeTempo(1e20, 1e20 + 1000), [], 'fora da faixa do Date → sem marcas, sem lançar');

  // layout com lixo
  igual(sp.layout([null, 'x', 5], { largura: 100, altura: 100 }).colunas, [], 'itens nulos na lista de baldes são ignorados (antes: TypeError em b.max)');
  igual(sp.layout([], { largura: Infinity, altura: 100 }).area.w, 1, 'largura Infinity vira área mínima, não Infinity');
  igual(sp.layout([], { largura: NaN, altura: 'a' }).area, { x: 48, y: 22, w: 1, h: 1 }, 'largura/altura NaN idem');
  const bInf = { inicio: 0, fim: 10, n: 1, perdidos: 0, min: 1, p25: 1, mediana: 1, p75: 1, max: Infinity };
  igual(sp.layout([bInf], { largura: 100, altura: 100 }).colunas, [], 'balde com estatística não finita não vira coluna (fillRect com -Infinity)');
  const bRuido = sp.agrupar([{ estado: 'ok', latencia: 7 * 0.1, t: AGORA }], { janelaMs: 1000, baldes: 1, agora: AGORA });
  const lRuido = sp.layout(bRuido, { largura: 100, altura: 100 });
  ok(lRuido.colunas[0].yMax >= lRuido.area.y, 'máximo com ruído (0,7000000000000001 numa escala de 0,7) fica preso à área, não acima');

  // formatação
  igual(sp.formatarMs(9.96), '10 ms', '9,96 arredonda para "10 ms" (não "10,0 ms")');
  igual(sp.formatarMs(9.94), '9,9 ms', '9,94 fica "9,9 ms"');
  igual([sp.formatarHora(NaN), sp.formatarHora(undefined), sp.formatarHora(''), sp.formatarHora(1e20)], ['—', '—', '—', '—'], 'hora inválida → travessão, nunca "NaN:NaN"');
  igual(sp.formatarHora(AGORA).length, 5, 'hora válida continua HH:MM');

  // desenhar com opções tortas
  const s = serie(30, () => 5);
  const d1 = canvasFalso(100, 50);
  sp.desenhar(d1.canvas, s, { dpr: -1, agora: AGORA });
  igual([d1.canvas.width, d1.canvas.height], [100, 50], 'dpr negativo cai em 1 (canvas.width negativo apagava o bitmap)');
  const d2 = canvasFalso(100, 50);
  sp.desenhar(d2.canvas, s, { dpr: Infinity, agora: AGORA });
  igual([d2.canvas.width, d2.canvas.height], [100, 50], 'dpr Infinity idem');
  igual(sp.desenhar(canvasFalso(100, 50).canvas, s, { largura: Infinity, altura: 10, dpr: 1 }), null, 'largura Infinity por opção → null');
  igual(sp.desenhar({ clientWidth: 10, clientHeight: 10, getContext() { throw new Error('boom'); } }, s, {}), null, 'getContext que lança → null, sem propagar');
  ok(sp.desenhar(canvasFalso(100, 50).canvas, null, { dpr: 1 }) !== null, 'amostras null desenha o quadro vazio');
  ok(sp.desenhar(canvasFalso(100, 50).canvas, s, { cores: 'x', dpr: 1 }) !== null, 'cores como string não quebra');
  const d3 = canvasFalso(100, 50);
  sp.desenhar(d3.canvas, s, { cores: { fundo: '', mediana: undefined, texto: '   ' }, dpr: 1, agora: AGORA });
  const estilos = d3.chamadas.filter((c) => c.m === 'set:fillStyle' || c.m === 'set:strokeStyle').map((c) => c.args[0]);
  ok(estilos.every((v) => typeof v === 'string' && v.trim()), 'cor presente mas vazia ("" de getPropertyValue) cai na reserva, não vira fillStyle vazio');
  igual(sp._pintar(null, null, null, null), undefined, '_pintar sem contexto/layout sai em silêncio');
}

console.log(`\n${n} verificações passaram`);
