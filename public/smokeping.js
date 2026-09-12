'use strict';

// Gráfico "Smokeping" para o Monitor de IP — a mesma leitura do isp.tools: a
// série contínua de pings vira BALDES de tempo e cada balde mostra a "fumaça"
// (faixa mín→máx, mais densa entre p25 e p75), a linha da mediana e a perda como
// marca vermelha na base. Uma janela de 12 h com 1 ping/s são 43 200 pontos;
// desenhar cada um seria ilegível e lento, e a fumaça mostra o jitter que a
// média esconde.
//
// Uso duplo (navegador via <script> e Node via require), como subnet.js. Tudo
// que calcula é puro e recebe `agora` por parâmetro; só desenhar() toca no
// canvas, e mesmo ele separa o LAYOUT (coordenadas, testável em Node) do ato de
// pintar. Cores vêm de fora porque o app usa variáveis CSS para o tema
// claro/escuro e o canvas não lê CSS sozinho.
//
// Dentro de uma IIFE pelo mesmo motivo de subnet.js: scripts clássicos dividem
// o escopo global e um `const` repetido no topo mata o arquivo inteiro.
(function () {

const BALDES_PADRAO = 120;

// As janelas do seletor da tela. O monitor guarda um log limitado (MAX_LOG em
// lib/monitor.js), então a janela longa só enche depois de o app acumular
// amostras no navegador — o módulo não presume que a série cubra a janela toda.
const JANELAS = [
  { rotulo: '5 min', ms: 5 * 60 * 1000 },
  { rotulo: '30 min', ms: 30 * 60 * 1000 },
  { rotulo: '2 h', ms: 2 * 60 * 60 * 1000 },
  { rotulo: '12 h', ms: 12 * 60 * 60 * 1000 },
];

// Cores de reserva: se a tela passar `cores` incompleto, o gráfico ainda sai
// legível em vez de pintar com `undefined` (que o canvas ignora em silêncio e
// deixa a cor anterior valendo — o bug parece "a fumaça ficou vermelha").
const CORES_PADRAO = {
  fundo: '#ffffff',
  fumaca: 'rgba(90, 120, 200, 0.28)',
  fumacaDensa: 'rgba(90, 120, 200, 0.55)',
  mediana: '#2b5cd9',
  perda: '#d93025',
  texto: '#555555',
  grade: 'rgba(0, 0, 0, 0.08)',
};

// Margens da área de plotagem. A esquerda cabe "1000 ms"; a base cabe a faixa
// de perda e os rótulos de hora; o topo cabe a legenda.
const MARGEM = { esquerda: 48, direita: 10, topo: 22, base: 30 };
const FAIXA_PERDA_ALTURA = 5;
const FAIXA_PERDA_FOLGA = 3;

// Teto de baldes: mais colunas que pixels de largura não acrescenta nada, e
// `baldes: 1e7` (ou Infinity) alocaria milhões de objetos por redesenho.
const BALDES_MAX = 4096;

// ---------- utilitários ----------

// `agora` pode chegar como Date (a tela guarda o instante do último ping
// assim); qualquer outra coisa não numérica cai no relógio.
function instante(v) {
  if (v instanceof Date) v = v.getTime();
  return Number.isFinite(v) ? v : Date.now();
}

// Janela em ms: Infinity, negativo ou NaN dariam baldes de largura NaN
// (cestos[NaN] → TypeError) ou com fim antes do início.
function janelaValida(v) {
  const j = Number(v);
  return Number.isFinite(j) && j > 0 ? j : JANELAS[0].ms;
}

// Math.max(...arr) estoura a pilha a partir de ~100 mil argumentos — 12 h de
// pings a cada 500 ms já passa disso. Laço simples não tem esse limite.
function minimo(arr) { let m = Infinity; for (const v of arr) if (v < m) m = v; return m; }
function maximo(arr) { let m = -Infinity; for (const v of arr) if (v > m) m = v; return m; }

// ---------- amostras ----------

// O log do monitor (lib/monitor.js) grava { vivo, latencia }; a tela descreve
// a mesma amostra como { estado: 'ok' | 'timeout' | ... }. Aceitar as duas
// formas evita converter a série a cada redesenho. Uma amostra só vale como
// recebida se tem latência numérica: "ok" sem número não dá para plotar e
// contaria como perda de qualquer jeito.
function amostraRecebida(a) {
  if (!a || !Number.isFinite(a.latencia)) return false;
  if (a.estado != null) return a.estado === 'ok';
  return a.vivo !== false;
}

function tempoDa(a) {
  return a && Number.isFinite(a.t) ? a.t : NaN;
}

// ---------- estatística ----------

// Percentil com interpolação linear entre vizinhos (o mesmo do numpy/R tipo 7):
// [1,2,3,4] p50 = 2.5, não 2 nem 3. Ordena uma cópia; não altera a entrada.
function percentil(valores, p) {
  if (!Array.isArray(valores) || !valores.length) return null;
  const v = valores.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const pp = Math.min(100, Math.max(0, Number(p) || 0));
  const pos = ((v.length - 1) * pp) / 100;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return v[lo];
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

// Ticks "bonitos" para o eixo Y: passo 1/2/5 × 10^k escolhido para dar entre
// 4 e 9 marcas, e o último tick fecha por cima do máximo (o topo da escala é o
// último elemento).
//
// Ruído de ponto flutuante é limpo com toPrecision(12), na entrada e em cada
// tick: 3 × 0,1 = 0,30000000000000004 sairia assim no rótulo, e um máximo de
// 7 × 0,1 = 0,7000000000000001 pediria um tick a mais (0,8) e a escala pularia
// de tamanho entre um redesenho e outro. toPrecision (e não toFixed) porque
// toFixed limita a 100 casas e lançava RangeError para máximos ínfimos.
function ticksBonitos(max) {
  let m = Number(max);
  if (!Number.isFinite(m) || m <= 0) return [0, 1];
  m = Number(m.toPrecision(12));
  const bruto = m / 5;
  const mag = 10 ** Math.floor(Math.log10(bruto));
  const norm = bruto / mag;
  let passo;
  if (norm < 1.5) passo = 1;
  else if (norm < 3) passo = 2;
  else if (norm < 7) passo = 5;
  else passo = 10;
  passo *= mag;
  const ticks = [];
  const qtd = Math.ceil(m / passo - 1e-9);
  for (let i = 0; i <= qtd; i += 1) ticks.push(Number((i * passo).toPrecision(12)));
  return ticks;
}

// ---------- baldes ----------

// Divide a janela [agora − janelaMs, agora] em `baldes` fatias iguais e resume
// cada uma. Amostras mais antigas que a janela ficam de fora. Amostra com t
// DEPOIS de `agora` (relógio do servidor adiantado em relação ao do navegador)
// cai no último balde em vez de sumir: sumir faria o ping mais recente não
// aparecer justamente quando mais interessa.
function agrupar(amostras, opts) {
  const o = opts || {};
  const janelaMs = janelaValida(o.janelaMs);
  const baldes = Math.min(BALDES_MAX, Math.max(1, Math.floor(Number(o.baldes) || BALDES_PADRAO)));
  const agora = instante(o.agora);
  const inicioJanela = agora - janelaMs;
  const larg = janelaMs / baldes;

  const cestos = [];
  for (let i = 0; i < baldes; i += 1) cestos.push({ lat: [], perdidos: 0 });

  for (const a of Array.isArray(amostras) ? amostras : []) {
    const t = tempoDa(a);
    if (!Number.isFinite(t) || t < inicioJanela) continue;
    const i = Math.min(baldes - 1, Math.max(0, Math.floor((t - inicioJanela) / larg)));
    if (amostraRecebida(a)) cestos[i].lat.push(a.latencia);
    else cestos[i].perdidos += 1;
  }

  return cestos.map((c, i) => {
    const n = c.lat.length + c.perdidos;
    const tem = c.lat.length > 0;
    return {
      inicio: inicioJanela + i * larg,
      fim: inicioJanela + (i + 1) * larg,
      n,
      perdidos: c.perdidos,
      min: tem ? minimo(c.lat) : null,
      p25: tem ? percentil(c.lat, 25) : null,
      mediana: tem ? percentil(c.lat, 50) : null,
      p75: tem ? percentil(c.lat, 75) : null,
      max: tem ? maximo(c.lat) : null,
    };
  });
}

// Números da legenda para o período. `ultima` é a latência da amostra mais
// recente da janela (null se ela foi perdida) — é o que o olho procura primeiro.
function resumo(amostras, janelaMs, agora) {
  const ag = instante(agora);
  const inicioJanela = ag - janelaValida(janelaMs);
  const lat = [];
  let n = 0;
  let perdidos = 0;
  let maisRecente = null;
  for (const a of Array.isArray(amostras) ? amostras : []) {
    const t = tempoDa(a);
    if (!Number.isFinite(t) || t < inicioJanela) continue;
    n += 1;
    if (amostraRecebida(a)) lat.push(a.latencia); else perdidos += 1;
    if (!maisRecente || t >= tempoDa(maisRecente)) maisRecente = a;
  }
  return {
    n,
    perdaPct: n ? Math.round((perdidos / n) * 1000) / 10 : 0,
    p50: percentil(lat, 50),
    p95: percentil(lat, 95),
    max: lat.length ? maximo(lat) : null,
    ultima: maisRecente && amostraRecebida(maisRecente) ? maisRecente.latencia : null,
  };
}

function janelas() {
  return JANELAS.map((j) => ({ rotulo: j.rotulo, ms: j.ms }));
}

// ---------- formatação ----------

// Latência em pt-BR: abaixo de 10 ms vale a casa decimal (0,8 ms de LAN é
// diferente de 3 ms); acima, inteiro basta. A decisão é tomada DEPOIS de
// arredondar: 9,96 vira "10 ms", não "10,0 ms".
function formatarMs(v) {
  if (!Number.isFinite(v)) return '—';
  const r = Math.round(v * 10) / 10;
  const s = r < 10 ? r.toFixed(1) : String(Math.round(v));
  return `${s.replace('.', ',')} ms`;
}

function formatarPct(v) {
  if (!Number.isFinite(v)) return '—';
  return `${String(Math.round(v * 10) / 10).replace('.', ',')}%`;
}

function dois(n) { return String(n).padStart(2, '0'); }

// Fora da faixa do Date (NaN, undefined, 1e20) sairia "NaN:NaN" no eixo.
function formatarHora(t) {
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '—';
  return `${dois(d.getHours())}:${dois(d.getMinutes())}`;
}

// ---------- eixo X ----------

const PASSOS_TEMPO = [
  1, 2, 5, 10, 15, 30,
  60, 120, 180, 360, 720,
].map((min) => min * 60 * 1000);

// Marcas de hora alinhadas em múltiplos redondos (…:00, :15, :30…). O
// alinhamento é feito no relógio LOCAL: em fuso de meia hora (Índia, Terra
// Nova) alinhar pelo epoch UTC deixaria o tick de 1 h cair em xx:30.
function ticksDeTempo(inicio, fim) {
  const dur = fim - inicio;
  if (!(dur > 0) || !Number.isFinite(dur)) return [];
  let passo = PASSOS_TEMPO[PASSOS_TEMPO.length - 1];
  for (const p of PASSOS_TEMPO) { if (dur / p <= 8) { passo = p; break; } }
  // Janela maior que a tabela (dias, ou um janelaMs absurdo): estica o passo em
  // múltiplos de 12 h em vez de emitir milhões de marcas — mantém ≤ 8 ticks.
  if (dur / passo > 8) passo *= Math.ceil(dur / passo / 8);
  const desloc = new Date(inicio).getTimezoneOffset() * 60 * 1000;
  if (!Number.isFinite(desloc)) return [];
  const local0 = inicio - desloc;
  let t = Math.ceil(local0 / passo) * passo + desloc;
  const out = [];
  while (t <= fim) { out.push(t); t += passo; }
  return out;
}

// ---------- layout ----------

// Tudo em pixels CSS (o devicePixelRatio entra só no desenho, via transform).
// Devolve as coordenadas de cada elemento; a pintura só percorre isto. Por
// isso é testável sem DOM: dá para provar que as colunas são monotônicas e
// que nada sai da área de plotagem.
function layout(baldes, opts) {
  const o = opts || {};
  const largura = Number.isFinite(Number(o.largura)) ? Math.max(0, Number(o.largura)) : 0;
  const altura = Number.isFinite(Number(o.altura)) ? Math.max(0, Number(o.altura)) : 0;
  // Só objetos: um null no meio da lista lançaria em `b.max`.
  const lista = (Array.isArray(baldes) ? baldes : []).filter((b) => b && typeof b === 'object');

  const area = {
    x: MARGEM.esquerda,
    y: MARGEM.topo,
    w: Math.max(1, largura - MARGEM.esquerda - MARGEM.direita),
    h: Math.max(1, altura - MARGEM.topo - MARGEM.base),
  };
  const faixaPerda = { x: area.x, y: area.y + area.h + FAIXA_PERDA_FOLGA, w: area.w, h: FAIXA_PERDA_ALTURA };

  let maior = 0;
  for (const b of lista) if (Number.isFinite(b.max) && b.max > maior) maior = b.max;
  const ticks = ticksBonitos(maior);
  const topo = ticks[ticks.length - 1];
  // Preso à área: um máximo com ruído de ponto flutuante (0,7000000000000001
  // contra escala 0,7) ou um balde com max: Infinity não pode sair do quadro.
  const yDe = (v) => Math.min(area.y + area.h, Math.max(area.y, area.y + area.h - (v / topo) * area.h));

  const ticksY = ticks.map((valor) => ({ valor, y: yDe(valor), rotulo: valor < 10 && valor !== 0 ? String(valor).replace('.', ',') : String(valor) }));

  const inicio = lista.length ? lista[0].inicio : 0;
  const fim = lista.length ? lista[lista.length - 1].fim : 0;
  const xDe = (t) => area.x + ((t - inicio) / (fim - inicio || 1)) * area.w;
  const ticksX = ticksDeTempo(inicio, fim).map((t) => ({ t, x: xDe(t), rotulo: formatarHora(t) }));

  const largCol = lista.length ? area.w / lista.length : area.w;
  const colunas = [];
  const perdas = [];
  const linhas = [];
  let segmento = [];
  lista.forEach((b, i) => {
    const x = area.x + i * largCol;
    if (b.n > 0 && b.perdidos > 0) {
      perdas.push({ i, x, w: largCol, y: faixaPerda.y, h: faixaPerda.h, pct: (b.perdidos / b.n) * 100 });
    }
    if ([b.min, b.p25, b.mediana, b.p75, b.max].every(Number.isFinite)) {
      colunas.push({
        i, x, w: largCol,
        yMin: yDe(b.min), yP25: yDe(b.p25), yMediana: yDe(b.mediana), yP75: yDe(b.p75), yMax: yDe(b.max),
      });
      segmento.push({ x: x + largCol / 2, y: yDe(b.mediana) });
    } else if (segmento.length) {
      // Balde vazio ou todo perdido quebra a linha: ligar por cima de um buraco
      // desenharia latência onde não houve resposta nenhuma.
      linhas.push(segmento);
      segmento = [];
    }
  });
  if (segmento.length) linhas.push(segmento);

  return { largura, altura, area, faixaPerda, topo, ticksY, ticksX, colunas, perdas, linhas };
}

// ---------- pintura ----------

function pintar(ctx, lay, cores, legenda) {
  if (!ctx || !lay || !lay.area) return;
  // Chave presente mas vazia também cai na reserva: getPropertyValue('--x') de
  // uma variável CSS inexistente devolve '' e o canvas ignoraria a atribuição.
  const c = Object.assign({}, CORES_PADRAO);
  if (cores && typeof cores === 'object') {
    for (const k of Object.keys(CORES_PADRAO)) {
      if (typeof cores[k] === 'string' && cores[k].trim()) c[k] = cores[k].trim();
    }
  }
  const { area, faixaPerda } = lay;

  ctx.fillStyle = c.fundo;
  ctx.fillRect(0, 0, lay.largura, lay.altura);

  // grade + rótulos do eixo Y
  ctx.font = '11px system-ui, -apple-system, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.lineWidth = 1;
  for (const t of lay.ticksY) {
    ctx.strokeStyle = c.grade;
    ctx.beginPath();
    ctx.moveTo(area.x, t.y);
    ctx.lineTo(area.x + area.w, t.y);
    ctx.stroke();
    ctx.fillStyle = c.texto;
    ctx.fillText(t.rotulo, area.x - 6, t.y);
  }

  // rótulos do eixo X (com um risco vertical discreto)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of lay.ticksX) {
    ctx.strokeStyle = c.grade;
    ctx.beginPath();
    ctx.moveTo(t.x, area.y);
    ctx.lineTo(t.x, area.y + area.h);
    ctx.stroke();
    ctx.fillStyle = c.texto;
    ctx.fillText(t.rotulo, t.x, faixaPerda.y + faixaPerda.h + 4);
  }

  // fumaça: mín→máx leve, p25→p75 densa. Colunas encostadas de propósito: o
  // gap entre baldes viraria listras e esconderia a continuidade do jitter.
  for (const col of lay.colunas) {
    ctx.fillStyle = c.fumaca;
    ctx.fillRect(col.x, col.yMax, col.w, Math.max(1, col.yMin - col.yMax));
    ctx.fillStyle = c.fumacaDensa;
    ctx.fillRect(col.x, col.yP75, col.w, Math.max(1, col.yP25 - col.yP75));
  }

  // mediana: um caminho por trecho contínuo
  ctx.strokeStyle = c.mediana;
  ctx.lineWidth = 1.5;
  for (const seg of lay.linhas) {
    ctx.beginPath();
    seg.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
    if (seg.length === 1) ctx.lineTo(seg[0].x + 0.5, seg[0].y); // um ponto só ainda aparece
    ctx.stroke();
  }

  // perda: intensidade pela % do balde. Piso de 0,25 para 1 ping perdido em
  // 100 ainda ser visível — perda pequena é justamente o que se quer flagrar.
  for (const p of lay.perdas) {
    ctx.globalAlpha = 0.25 + 0.75 * Math.min(1, p.pct / 100);
    ctx.fillStyle = c.perda;
    ctx.fillRect(p.x, p.y, Math.max(1, p.w), p.h);
  }
  ctx.globalAlpha = 1;

  // legenda no topo
  if (legenda) {
    ctx.fillStyle = c.texto;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const partes = [
      `p50 ${formatarMs(legenda.p50)}`,
      `p95 ${formatarMs(legenda.p95)}`,
      `máx ${formatarMs(legenda.max)}`,
      `perda ${formatarPct(legenda.perdaPct)}`,
    ];
    ctx.fillText(partes.join('   '), area.x + area.w, MARGEM.topo / 2);
    ctx.textAlign = 'left';
    ctx.fillText(`agora ${formatarMs(legenda.ultima)}`, area.x, MARGEM.topo / 2);
  }
}

// Desenha no canvas e devolve o layout (para a tela posicionar tooltip, por
// exemplo). Canvas sem tamanho (aba escondida, ainda sem CSS) → sai sem
// lançar: o redesenho seguinte, com tamanho, resolve. O tamanho lógico vem do
// CSS (clientWidth); o bitmap é multiplicado pelo devicePixelRatio para não
// sair borrado em tela Retina, e o transform faz o resto do código pensar em
// pixels CSS.
function desenhar(canvas, amostras, opts) {
  const o = opts || {};
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  const largura = Number(o.largura) || canvas.clientWidth || canvas.width || 0;
  const altura = Number(o.altura) || canvas.clientHeight || canvas.height || 0;
  if (!(largura > 0) || !(altura > 0) || !Number.isFinite(largura) || !Number.isFinite(altura)) return null;

  const agora = instante(o.agora);
  const janelaMs = janelaValida(o.janelaMs);
  // dpr negativo ou Infinity deixaria canvas.width negativo/NaN e o bitmap
  // some; qualquer valor fora de (0, ∞) volta para 1.
  const bruto = Number(o.dpr) || (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const dpr = Number.isFinite(bruto) && bruto > 0 ? bruto : 1;

  // getContext pode lançar (canvas já entregue ao WebGL/OffscreenCanvas);
  // para o redesenho é o mesmo que não ter contexto.
  let ctx = null;
  try { ctx = canvas.getContext('2d'); } catch { ctx = null; }
  if (!ctx) return null;

  const baldes = agrupar(amostras, { janelaMs, baldes: o.baldes, agora });
  const lay = layout(baldes, { largura, altura });
  const legenda = resumo(amostras, janelaMs, agora);

  const bw = Math.round(largura * dpr);
  const bh = Math.round(altura * dpr);
  if (canvas.width !== bw) canvas.width = bw;
  if (canvas.height !== bh) canvas.height = bh;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, largura, altura);
  pintar(ctx, lay, o.cores, legenda);
  return lay;
}

const API = {
  agrupar, percentil, ticksBonitos, resumo, desenhar, janelas, layout,
  formatarMs, formatarPct, formatarHora,
  BALDES_PADRAO, BALDES_MAX, CORES_PADRAO, MARGEM,
  _amostraRecebida: amostraRecebida, _ticksDeTempo: ticksDeTempo, _pintar: pintar,
};
if (typeof window !== 'undefined') window.smokepingLib = API;
if (typeof module !== 'undefined' && module.exports) module.exports = API;

}());
