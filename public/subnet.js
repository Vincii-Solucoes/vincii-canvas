'use strict';

// Calculadora de sub-rede — IPv4 e IPv6. Pura, offline, sem servidor: só
// aritmética de endereço. Uso duplo (navegador via <script> e Node via
// require), como serial.js/protocolos.js. IPv6 usa BigInt (128 bits).
//
// Placeholder padrão dos campos de endereço das ferramentas fica aqui também,
// para uma frase só valer em todas.

// A frase padrão dos campos onde se digita um alvo. Uma fonte, todas as telas.
const PLACEHOLDER_HOST = 'IP ou host — ex.: 192.168.0.1, roteador.local';
const PLACEHOLDER_CIDR = 'Endereço/prefixo — ex.: 192.168.1.10/24 ou 2001:db8::/48';

// ---------- IPv4 ----------

function ehIPv4(s) {
  return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(String(s || ''))
    && String(s).split('.').every((o) => Number(o) >= 0 && Number(o) <= 255);
}
function v4ParaNum(ip) {
  return ip.split('.').reduce((n, o) => (n * 256 + Number(o)) >>> 0, 0) >>> 0;
}
function numParaV4(n) {
  n = n >>> 0;
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function calcularV4(entrada) {
  const m = String(entrada || '').trim().match(/^([^/]+)\/(\d{1,2})$/);
  if (!m) return { erro: 'Use endereço/prefixo, ex.: 192.168.1.10/24' };
  const ip = m[1].trim();
  const prefixo = Number(m[2]);
  if (!ehIPv4(ip)) return { erro: 'Endereço IPv4 inválido.' };
  if (prefixo < 0 || prefixo > 32) return { erro: 'O prefixo de IPv4 vai de 0 a 32.' };

  const ipNum = v4ParaNum(ip);
  const mascara = prefixo === 0 ? 0 : (0xffffffff << (32 - prefixo)) >>> 0;
  const rede = (ipNum & mascara) >>> 0;
  const broadcast = (rede | (~mascara >>> 0)) >>> 0;
  const totalEnderecos = prefixo >= 31 ? (prefixo === 32 ? 1 : 2) : (2 ** (32 - prefixo));
  const usaveis = prefixo >= 31 ? totalEnderecos : Math.max(0, totalEnderecos - 2);
  const primeiro = prefixo >= 31 ? rede : (rede + 1) >>> 0;
  const ultimo = prefixo >= 31 ? broadcast : (broadcast - 1) >>> 0;
  // classe privada / especial (informativo)
  const priv = (ipNum >>> 24) === 10
    || ((ipNum >>> 20) === 0xac1 && (ipNum >>> 16 & 0xff) >= 16 && (ipNum >>> 16 & 0xff) <= 31)
    || (ipNum >>> 16) === 0xc0a8;
  return {
    versao: 4,
    endereco: ip,
    prefixo,
    mascara: numParaV4(mascara),
    curinga: numParaV4(~mascara >>> 0),
    rede: numParaV4(rede),
    broadcast: numParaV4(broadcast),
    primeiroHost: numParaV4(primeiro),
    ultimoHost: numParaV4(ultimo),
    totalEnderecos: String(totalEnderecos),
    hostsUsaveis: String(usaveis),
    privado: priv,
  };
}

// ---------- IPv6 ----------

// Expande "2001:db8::1" para os 8 grupos completos e devolve BigInt.
function v6ParaBig(ip) {
  let s = String(ip || '').trim();
  if (!s.includes(':')) return null;
  let cabeca = s;
  let cauda = '';
  if (s.includes('::')) {
    const partes = s.split('::');
    if (partes.length > 2) return null;
    cabeca = partes[0];
    cauda = partes[1] || '';
  }
  const gc = cabeca ? cabeca.split(':').filter((x) => x !== '') : [];
  const gt = cauda ? cauda.split(':').filter((x) => x !== '') : [];
  if (!s.includes('::') && gc.length !== 8) return null;
  const faltam = 8 - (gc.length + gt.length);
  if (s.includes('::')) { if (faltam < 1) return null; } else if (faltam !== 0) return null;
  const grupos = [...gc, ...Array(s.includes('::') ? faltam : 0).fill('0'), ...gt];
  if (grupos.length !== 8) return null;
  let n = 0n;
  for (const g of grupos) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) + BigInt(parseInt(g, 16));
  }
  return n;
}
function bigParaV6(n) {
  const grupos = [];
  for (let i = 0; i < 8; i++) { grupos.unshift((n & 0xffffn).toString(16)); n >>= 16n; }
  return grupos;
}
// Forma comprimida (:: na maior sequência de zeros).
function comprimirV6(grupos) {
  let melhorIni = -1; let melhorLen = 0; let ini = -1; let len = 0;
  for (let i = 0; i < 8; i++) {
    if (grupos[i] === '0') { if (ini < 0) ini = i; len++; if (len > melhorLen) { melhorLen = len; melhorIni = ini; } }
    else { ini = -1; len = 0; }
  }
  if (melhorLen < 2) return grupos.join(':');
  const antes = grupos.slice(0, melhorIni).join(':');
  const depois = grupos.slice(melhorIni + melhorLen).join(':');
  return `${antes}::${depois}`;
}
function expandirV6(grupos) {
  return grupos.map((g) => g.padStart(4, '0')).join(':');
}

function calcularV6(entrada) {
  const m = String(entrada || '').trim().match(/^(.+)\/(\d{1,3})$/);
  if (!m) return { erro: 'Use endereço/prefixo, ex.: 2001:db8::/48' };
  const ip = m[1].trim();
  const prefixo = Number(m[2]);
  const big = v6ParaBig(ip);
  if (big === null) return { erro: 'Endereço IPv6 inválido.' };
  if (prefixo < 0 || prefixo > 128) return { erro: 'O prefixo de IPv6 vai de 0 a 128.' };

  const mascara = prefixo === 0 ? 0n : (((1n << BigInt(prefixo)) - 1n) << BigInt(128 - prefixo));
  const rede = big & mascara;
  const ultimo = rede | (~mascara & ((1n << 128n) - 1n));
  const total = 1n << BigInt(128 - prefixo);
  const gRede = bigParaV6(rede);
  const gUlt = bigParaV6(ultimo);
  const tipo = (() => {
    const primeiro = Number((rede >> 120n) & 0xffn);
    if (prefixo >= 8 && (rede >> 121n) === 0b1111110n) return 'ULA (privado, fc00::/7)';
    if ((rede >> 118n) === 0b1111111010n) return 'link-local (fe80::/10)';
    if (primeiro === 0xff) return 'multicast (ff00::/8)';
    if (rede === 0n && prefixo === 128) return 'não especificado (::)';
    return 'global unicast';
  })();
  return {
    versao: 6,
    endereco: comprimirV6(bigParaV6(big)),
    prefixo,
    rede: comprimirV6(gRede),
    redeExpandida: expandirV6(gRede),
    primeiroHost: comprimirV6(gRede),
    ultimoHost: comprimirV6(gUlt),
    totalEnderecos: total.toString(),
    tipo,
  };
}

function calcular(entrada) {
  const s = String(entrada || '').trim();
  if (!s.includes('/')) return { erro: 'Falta o prefixo. Ex.: 192.168.1.0/24 ou 2001:db8::/48' };
  return s.includes(':') ? calcularV6(s) : calcularV4(s);
}

const API = {
  PLACEHOLDER_HOST, PLACEHOLDER_CIDR,
  calcular, calcularV4, calcularV6, ehIPv4, _v6ParaBig: v6ParaBig, _comprimirV6: comprimirV6,
};
if (typeof window !== 'undefined') window.subnetLib = API;
if (typeof module !== 'undefined' && module.exports) module.exports = API;
