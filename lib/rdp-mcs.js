'use strict';

// Cirurgia nos blocos de segurança do GCC, para o modo RDP legado.
//
// A sequência de conexão do RDP carrega, dentro do MCS Connect Initial/Response,
// uma estrutura GCC com blocos "TS_UD_*". Dois nos interessam:
//
//   CS_SECURITY (0xC002) — o cliente diz quais métodos de criptografia aceita
//   SC_SECURITY (0x0C02) — o servidor diz o que escolheu, e manda o certificado
//
// O cliente WASM só fala Enhanced Security, então anuncia "nenhuma
// criptografia" e recusa qualquer resposta diferente disso. O servidor legado
// exige RC4. O proxy fica no meio e conserta os dois lados.
//
// A parte delicada é o TAMANHO: o GCC vive dentro de BER (no MCS) e PER (no
// próprio GCC), com comprimentos codificados em vários níveis. Mudar o tamanho
// de um bloco obrigaria a reescrever todos eles.
//
// Fugimos disso: as duas cirurgias são IN-PLACE, byte por byte, sem mexer em
// nenhum comprimento. No CS_SECURITY é natural (o bloco é fixo de 12 bytes).
// No SC_SECURITY seria preciso encolher de ~428 para 12 bytes — em vez disso
// mantemos o tamanho e zeramos o conteúdo, deixando o resto como enchimento.

const CS_SECURITY = 0xc002;
const SC_SECURITY = 0x0c02;

// Só RC4 de 128 bits. O cliente WASM anuncia "nenhuma criptografia" e nós
// reescrevemos em nome dele — então oferecer 40 e 56 bits seria o PROXY
// escolhendo o elo mais fraco por conta própria, e um servidor hostil (ou
// alguém no caminho) pegaria a opção pior. FIPS (0x10) fica de fora porque
// seria 3DES, que não implementamos: melhor o servidor recusar do que
// negociarmos algo que não sabemos cumprir.
const METODOS_SUPORTADOS = 0x02;

// Procura um bloco TS_UD pelo tipo. Os blocos são { tipo:u16, len:u16, ... }
// em little-endian, concatenados; varremos porque a posição exata depende de
// quantos blocos o outro lado resolveu mandar.
function acharBloco(buf, tipo) {
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.readUInt16LE(i) === tipo) {
      const len = buf.readUInt16LE(i + 2);
      if (len >= 4 && i + len <= buf.length) return { inicio: i, len };
    }
  }
  return null;
}

// ---------- cliente → servidor ----------

// O cliente WASM manda encryptionMethods = 0 (nenhuma). Trocamos por 40|128|56
// para o servidor legado ter o que escolher. São 4 bytes no lugar, o bloco
// continua com 12 — nenhum comprimento muda.
function anunciarMetodos(buf) {
  const b = acharBloco(buf, CS_SECURITY);
  if (!b) return { ok: false, motivo: 'bloco CS_SECURITY não encontrado' };
  if (b.len < 12) return { ok: false, motivo: `CS_SECURITY com ${b.len} bytes, esperado 12` };
  const antes = buf.readUInt32LE(b.inicio + 4);
  buf.writeUInt32LE(METODOS_SUPORTADOS, b.inicio + 4);
  return { ok: true, antes, depois: METODOS_SUPORTADOS, posicao: b.inicio };
}

// ---------- servidor → cliente ----------

function lerSegurancaDoServidor(buf) {
  const b = acharBloco(buf, SC_SECURITY);
  if (!b) return { ok: false, motivo: 'bloco SC_SECURITY não encontrado' };
  const bloco = buf.slice(b.inicio, b.inicio + b.len);
  const metodo = bloco.readUInt32LE(4);
  const nivel = bloco.readUInt32LE(8);
  if (b.len <= 12) {
    // Sem criptografia: o servidor não manda random nem certificado.
    return { ok: true, posicao: b.inicio, len: b.len, metodo, nivel, serverRandom: null, certificado: null };
  }
  if (b.len < 20) return { ok: false, motivo: `SC_SECURITY truncado (${b.len} bytes)` };
  const tamRandom = bloco.readUInt32LE(12);
  const tamCert = bloco.readUInt32LE(16);
  if (20 + tamRandom + tamCert > b.len) {
    return { ok: false, motivo: 'SC_SECURITY declara mais dados do que cabe no bloco' };
  }
  return {
    ok: true,
    posicao: b.inicio,
    len: b.len,
    metodo,
    nivel,
    serverRandom: Buffer.from(bloco.slice(20, 20 + tamRandom)),
    certificado: Buffer.from(bloco.slice(20 + tamRandom, 20 + tamRandom + tamCert)),
  };
}

// Faz o bloco parecer "sem criptografia" para o cliente, SEM mudar o tamanho:
// zera método, nível e os dois comprimentos, e apaga o resto do bloco. O
// enchimento que sobra é lixo do ponto de vista do cliente — que, com método e
// nível em 0, não tem motivo para ler adiante.
function neutralizarSegurancaDoServidor(buf) {
  const b = acharBloco(buf, SC_SECURITY);
  if (!b) return { ok: false, motivo: 'bloco SC_SECURITY não encontrado' };
  buf.writeUInt32LE(0, b.inicio + 4);  // encryptionMethod = NONE
  buf.writeUInt32LE(0, b.inicio + 8);  // encryptionLevel  = NONE
  if (b.len > 12) {
    buf.fill(0, b.inicio + 12, b.inicio + b.len); // some com random, cert e sobras
  }
  return { ok: true, posicao: b.inicio, len: b.len };
}

// ---------- certificado proprietário (§2.2.1.4.3.1.1) ----------

// Devolve a chave pública RSA do servidor. Todos os números do certificado
// proprietário vêm em LITTLE-ENDIAN, ao contrário do RSA de todo dia — inverter
// é obrigatório, e errar aqui dá uma chave numericamente diferente sem que
// nada avise: o servidor só derruba a conexão depois.
function lerChavePublica(cert) {
  if (!cert || cert.length < 20) return null;
  const dwVersion = cert.readUInt32LE(0) & 0x7fffffff;
  if (dwVersion !== 1) return null; // 2 = X.509, que o xrdp não usa

  const tipoBlob = cert.readUInt16LE(12);
  const tamBlob = cert.readUInt16LE(14);
  if (tipoBlob !== 0x0006) return null; // BB_RSA_KEY_BLOB
  const blob = cert.slice(16, 16 + tamBlob);
  if (blob.length < 20 || blob.slice(0, 4).toString('ascii') !== 'RSA1') return null;

  const bitlen = blob.readUInt32LE(8);
  const bytesModulo = bitlen / 8;
  const expoenteLE = blob.slice(16, 20);
  const moduloLE = blob.slice(20, 20 + bytesModulo);
  if (moduloLE.length !== bytesModulo) return null;

  const inverter = (b) => Buffer.from(b).reverse();
  return {
    bits: bitlen,
    bytes: bytesModulo,
    n: BigInt('0x' + inverter(moduloLE).toString('hex')),
    e: BigInt(inverter(expoenteLE).readUInt32BE(0)),
  };
}

// Cifra o client random com a chave pública do servidor. É RSA cru, sem
// padding, sobre o valor lido em little-endian — e o resultado volta em
// little-endian também.
function cifrarClientRandom(clientRandom, chave) {
  const inverter = (b) => Buffer.from(b).reverse();
  const m = BigInt('0x' + inverter(clientRandom).toString('hex'));
  if (m >= chave.n) throw new Error('client random maior que o módulo RSA');

  let base = m % chave.n;
  let exp = chave.e;
  let r = 1n;
  while (exp > 0n) {
    if (exp & 1n) r = (r * base) % chave.n;
    base = (base * base) % chave.n;
    exp >>= 1n;
  }

  let hex = r.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const grande = Buffer.from(hex.padStart(chave.bytes * 2, '0'), 'hex');
  return inverter(grande); // de volta para little-endian
}

module.exports = {
  CS_SECURITY, SC_SECURITY, METODOS_SUPORTADOS,
  acharBloco,
  anunciarMetodos,
  lerSegurancaDoServidor,
  neutralizarSegurancaDoServidor,
  lerChavePublica,
  cifrarClientRandom,
};

// ---------- profundidade de cor (TS_UD_CS_CORE, §2.2.1.3.2) ----------

const CS_CORE = 0xc001;
// supportedColorDepths
const COR_24 = 0x0001, COR_16 = 0x0002, COR_15 = 0x0004, COR_32 = 0x0008;
// earlyCapabilityFlags
const QUER_32BPP = 0x0002;

function lerCore(buf) {
  const b = acharBloco(buf, CS_CORE);
  if (!b || b.len < 146) return null;
  const i = b.inicio;
  return {
    posicao: i,
    len: b.len,
    largura: buf.readUInt16LE(i + 8),
    altura: buf.readUInt16LE(i + 10),
    highColorDepth: buf.readUInt16LE(i + 140),
    supportedColorDepths: buf.readUInt16LE(i + 142),
    earlyCapabilityFlags: buf.readUInt16LE(i + 144),
  };
}

// Pede sessão de 32 bpp. O IronRDP decodifica mal os bitmaps RLE de 24 bpp que
// o xrdp manda por padrão ("Non-32 bpp compressed RLE_BITMAP_STREAM"), e o
// resultado é a tela cisalhada. Anunciar só 32 bpp empurra o servidor para o
// formato que o cliente sabe desenhar. In-place: nenhum comprimento muda.
function pedir32bpp(buf) {
  if (process.env.VC_RDP_SEM32 === '1') return { ok: false, motivo: 'desligado por VC_RDP_SEM32' };
  // VC_RDP_BPP permite experimentar profundidades durante a investigação.
  const forcado = Number(process.env.VC_RDP_BPP || 0);
  if (forcado) {
    const c0 = lerCore(buf);
    if (!c0) return { ok: false, motivo: 'sem CS_CORE' };
    const mapa = { 15: COR_15, 16: COR_16, 24: COR_24, 32: COR_32 | COR_24 };
    const antes = { high: c0.highColorDepth, suportadas: c0.supportedColorDepths, early: c0.earlyCapabilityFlags };
    buf.writeUInt16LE(forcado === 32 ? 24 : forcado, c0.posicao + 140);
    buf.writeUInt16LE(mapa[forcado] || COR_24, c0.posicao + 142);
    const early = forcado === 32 ? (c0.earlyCapabilityFlags | QUER_32BPP) : (c0.earlyCapabilityFlags & ~QUER_32BPP);
    buf.writeUInt16LE(early, c0.posicao + 144);
    return { ok: true, antes, depois: { high: forcado, suportadas: mapa[forcado] || COR_24, early } };
  }
  const c = lerCore(buf);
  if (!c) return { ok: false, motivo: 'bloco CS_CORE não encontrado ou curto' };
  const antes = {
    high: c.highColorDepth,
    suportadas: c.supportedColorDepths,
    early: c.earlyCapabilityFlags,
  };
  buf.writeUInt16LE(24, c.posicao + 140);                        // highColorDepth = 24
  buf.writeUInt16LE(COR_32 | COR_24, c.posicao + 142);           // 32 na frente, 24 como rede
  buf.writeUInt16LE(c.earlyCapabilityFlags | QUER_32BPP, c.posicao + 144);
  return { ok: true, antes, depois: { high: 24, suportadas: COR_32 | COR_24, early: c.earlyCapabilityFlags | QUER_32BPP } };
}

module.exports.CS_CORE = CS_CORE;
module.exports.lerCore = lerCore;
module.exports.pedir32bpp = pedir32bpp;
