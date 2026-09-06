'use strict';

// Diff de linhas — puro, uso duplo (window.diffLib / module.exports).
// Compara duas capturas e devolve a lista de operações, uma por linha:
//   { tipo: '=' | '-' | '+', texto }
// Algoritmo: apara prefixo e sufixo comuns (o grosso de "antes/depois" é
// igual), e roda LCS por programação dinâmica só no miolo. Se o miolo for
// grande demais para o O(n*m) (teto de células), degrada com honestidade:
// marca o miolo inteiro como trocado, em vez de travar a janela.
(function () {
const TETO_CELULAS = 4_000_000; // ~2000 x 2000 linhas

function linhas(t) {
  const s = String(t == null ? '' : t).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const arr = s.split('\n');
  // uma quebra final não é "uma linha vazia a mais"
  if (arr.length && arr[arr.length - 1] === '') arr.pop();
  return arr;
}

// Miolo: "patience" — linhas que aparecem UMA vez em cada lado, na mesma
// ordem relativa (maior subsequência crescente), viram âncoras; cada trecho
// entre âncoras é resolvido recursivamente, e só as folhas pequenas caem no
// LCS quadrático. Assim um 'show run' de 2500 linhas com duas mudanças
// distantes fica exato (as ~2490 linhas iguais e únicas ancoram tudo), em vez
// de degradar para "tudo trocado".
function diffMiolo(A, B, ops, estado) {
  // apara prefixo/sufixo comuns deste trecho
  let i0 = 0;
  while (i0 < A.length && i0 < B.length && A[i0] === B[i0]) { ops.push({ tipo: '=', texto: A[i0] }); i0++; }
  let fa = A.length, fb = B.length;
  while (fa > i0 && fb > i0 && A[fa - 1] === B[fb - 1]) { fa--; fb--; }
  const cauda = A.slice(fa).map((t) => ({ tipo: '=', texto: t }));
  const midA = A.slice(i0, fa), midB = B.slice(i0, fb);
  if (!midA.length) { for (const t of midB) ops.push({ tipo: '+', texto: t }); ops.push(...cauda); return; }
  if (!midB.length) { for (const t of midA) ops.push({ tipo: '-', texto: t }); ops.push(...cauda); return; }

  // âncoras: únicas em A e em B
  const contaA = new Map(), contaB = new Map();
  for (const t of midA) contaA.set(t, (contaA.get(t) || 0) + 1);
  for (const t of midB) contaB.set(t, (contaB.get(t) || 0) + 1);
  const posB = new Map();
  midB.forEach((t, j) => { if (contaB.get(t) === 1 && contaA.get(t) === 1) posB.set(t, j); });
  const pares = []; // [iA, jB] das linhas únicas comuns, na ordem de A
  midA.forEach((t, i) => { if (posB.has(t)) pares.push([i, posB.get(t)]); });
  // LIS sobre jB (patience sorting) -> âncoras que preservam a ordem nos dois lados
  const ancoras = lis(pares);

  if (!ancoras.length) {
    if (midA.length * midB.length > TETO_CELULAS) {
      estado.degradado = true;
      for (const t of midA) ops.push({ tipo: '-', texto: t });
      for (const t of midB) ops.push({ tipo: '+', texto: t });
    } else {
      lcsOps(midA, midB, ops);
    }
    ops.push(...cauda);
    return;
  }
  let ia = 0, jb = 0;
  for (const [i, j] of ancoras) {
    diffMiolo(midA.slice(ia, i), midB.slice(jb, j), ops, estado);
    ops.push({ tipo: '=', texto: midA[i] });
    ia = i + 1; jb = j + 1;
  }
  diffMiolo(midA.slice(ia), midB.slice(jb), ops, estado);
  ops.push(...cauda);
}

// Maior subsequência crescente em jB (O(k log k)); devolve os pares escolhidos.
function lis(pares) {
  const tails = [], tailIdx = [], prev = new Array(pares.length).fill(-1);
  for (let k = 0; k < pares.length; k++) {
    const v = pares[k][1];
    let lo = 0, hi = tails.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (tails[m] < v) lo = m + 1; else hi = m; }
    tails[lo] = v; tailIdx[lo] = k;
    prev[k] = lo > 0 ? tailIdx[lo - 1] : -1;
  }
  const out = [];
  for (let k = tailIdx[tails.length - 1]; k !== undefined && k >= 0; k = prev[k]) out.push(pares[k]);
  return out.reverse();
}

// LCS clássico numa folha pequena.
function lcsOps(midA, midB, ops) {
  const n = midA.length, m = midB.length;
  const L = new Array(n + 1);
  for (let i = 0; i <= n; i++) L[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = midA[i] === midB[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) { ops.push({ tipo: '=', texto: midA[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { ops.push({ tipo: '-', texto: midA[i] }); i++; }
    else { ops.push({ tipo: '+', texto: midB[j] }); j++; }
  }
  while (i < n) ops.push({ tipo: '-', texto: midA[i++] });
  while (j < m) ops.push({ tipo: '+', texto: midB[j++] });
}

function diffLinhas(a, b) {
  const ops = [];
  const estado = { degradado: false };
  diffMiolo(linhas(a), linhas(b), ops, estado);
  return { ops, degradado: estado.degradado, resumo: resumo(ops) };
}

function resumo(ops) {
  let iguais = 0, removidas = 0, adicionadas = 0;
  for (const o of ops) { if (o.tipo === '=') iguais++; else if (o.tipo === '-') removidas++; else adicionadas++; }
  return { iguais, removidas, adicionadas, mudou: removidas + adicionadas > 0 };
}

// Só as diferenças, com N linhas de contexto ao redor (para a tela não afogar
// a mudança num mar de linhas iguais). Linhas puladas viram { tipo: '…', n }.
function compactar(ops, contexto) {
  const c = Math.max(0, contexto | 0);
  const manter = new Array(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].tipo !== '=') {
      for (let d = -c; d <= c; d++) if (k + d >= 0 && k + d < ops.length) manter[k + d] = true;
    }
  }
  const out = [];
  let pulando = 0;
  for (let k = 0; k < ops.length; k++) {
    if (manter[k]) { if (pulando) { out.push({ tipo: '…', n: pulando }); pulando = 0; } out.push(ops[k]); }
    else pulando++;
  }
  if (pulando) out.push({ tipo: '…', n: pulando });
  return out;
}

const API = { diffLinhas, compactar, _linhas: linhas, TETO_CELULAS };
if (typeof window !== 'undefined') window.diffLib = API;
if (typeof module !== 'undefined' && module.exports) module.exports = API;
}());
