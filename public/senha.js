'use strict';

// Gerador de senhas — puro e OFFLINE, no mesmo modelo de uso duplo do
// subnet.js: roda no navegador (window.senhaLib) e no Node (module.exports)
// para os testes. A senha é gerada com o CSPRNG (crypto.getRandomValues),
// nunca sai da máquina e nunca é gravada em lugar nenhum.
//
// TUDO dentro de um IIFE: como script clássico, um `const` no topo divide o
// escopo global com os outros libs (subnet.js, serial.js) — e `const API`
// colidia, com SyntaxError que abortava o arquivo inteiro. Encapsular resolve
// de vez, sem depender de os nomes serem únicos entre os arquivos.
(function () {
//
// Duas decisões que importam:
//   - REJEIÇÃO no sorteio de cada caractere: `valor % pool` puro enviesa os
//     primeiros caracteres do pool quando 2^32 não é múltiplo do tamanho;
//     valores acima do maior múltiplo são descartados e sorteados de novo.
//   - COMPOSIÇÃO garantida: um caractere de cada conjunto marcado entra
//     obrigatoriamente (senão "minúsculas+números" podia sair só com letras),
//     e o embaralhamento Fisher-Yates — também com CSPRNG — esconde a posição.

const CONJUNTOS = {
  minusculas: 'abcdefghijklmnopqrstuvwxyz',
  maiusculas: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  numeros: '0123456789',
  simbolos: '!@#$%&*()-_=+[]{};:,.?',
};

// Caracteres fáceis de confundir ao DIGITAR uma senha lida na tela.
const AMBIGUOS = new Set(['0', 'O', 'o', '1', 'l', 'I', '|', '`', "'", '"']);

const TAM_MIN = 4;
const TAM_MAX = 128;

function cripto() {
  // navegador: window.crypto; Node 20+: globalThis.crypto (webcrypto)
  const c = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
  if (!c || typeof c.getRandomValues !== 'function') throw new Error('CSPRNG indisponível.');
  return c;
}

// Inteiro uniforme em [0, teto) com rejeição — sem viés de módulo.
function sorteio(teto) {
  const c = cripto();
  const buf = new Uint32Array(1);
  const limite = Math.floor(0x100000000 / teto) * teto;
  for (;;) {
    c.getRandomValues(buf);
    if (buf[0] < limite) return buf[0] % teto;
  }
}

function embaralhar(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = sorteio(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function filtrar(conjunto, semAmbiguos) {
  return semAmbiguos ? [...conjunto].filter((ch) => !AMBIGUOS.has(ch)).join('') : conjunto;
}

// gerar({tamanho, minusculas, maiusculas, numeros, simbolos, semAmbiguos})
// -> { senha, bits, pool } ou { erro }
function gerar(opts) {
  const o = opts || {};
  const tamanho = Math.round(Number(o.tamanho));
  if (!Number.isFinite(tamanho) || tamanho < TAM_MIN || tamanho > TAM_MAX) {
    return { erro: `O tamanho vai de ${TAM_MIN} a ${TAM_MAX} caracteres.` };
  }
  const escolhidos = [];
  for (const nome of ['minusculas', 'maiusculas', 'numeros', 'simbolos']) {
    if (o[nome]) {
      const c = filtrar(CONJUNTOS[nome], !!o.semAmbiguos);
      if (c.length) escolhidos.push(c);
    }
  }
  if (!escolhidos.length) return { erro: 'Marque ao menos um conjunto de caracteres.' };
  if (tamanho < escolhidos.length) return { erro: 'Tamanho menor que o número de conjuntos marcados.' };

  const pool = escolhidos.join('');
  const chars = [];
  // um de cada conjunto marcado, garantido
  for (const c of escolhidos) chars.push(c[sorteio(c.length)]);
  // o resto vem do pool inteiro
  while (chars.length < tamanho) chars.push(pool[sorteio(pool.length)]);
  embaralhar(chars);

  return {
    senha: chars.join(''),
    // entropia nominal do processo: tamanho * log2(|pool|)
    bits: Math.round(tamanho * Math.log2(pool.length)),
    pool: pool.length,
  };
}

// Rótulo de força a partir dos bits — os cortes seguem o senso comum de
// auditoria (>=90 aguenta ataque offline sério; <45 só serve com rate limit).
function forca(bits) {
  if (bits < 45) return { classe: 'fraca', rotulo: 'fraca' };
  if (bits < 65) return { classe: 'media', rotulo: 'razoável' };
  if (bits < 90) return { classe: 'forte', rotulo: 'forte' };
  return { classe: 'otima', rotulo: 'excelente' };
}

const API = { gerar, forca, CONJUNTOS, AMBIGUOS, TAM_MIN, TAM_MAX, _sorteio: sorteio, _filtrar: filtrar };
if (typeof window !== 'undefined') window.senhaLib = API;
if (typeof module !== 'undefined' && module.exports) module.exports = API;
}());
