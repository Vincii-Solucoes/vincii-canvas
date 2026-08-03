'use strict';

// Criptografia do RDP Standard Security (MS-RDPBCGR §5.3).
//
// Isto é criptografia OBSOLETA — RC4 com chaves derivadas de MD5/SHA-1, sem
// autenticação de servidor. Só existe aqui porque servidores xrdp configurados
// com security_layer=rdp não oferecem outra coisa, e o app precisa falar com
// eles. Nada aqui deve ser reaproveitado em outro contexto.
//
// Duas armadilhas que custam horas se erradas:
//
//   1. O RC4 saiu do provider padrão do OpenSSL 3, então o Node não tem mais
//      `createCipheriv('rc4')`. Implementado aqui em JS puro (RFC compatível,
//      validado contra os vetores do RFC 6229).
//
//   2. Circula por aí uma versão da SaltedHash em que o segundo estágio
//      inverte a ordem dos randoms (ServerRandom + ClientRandom). Está ERRADA:
//      a §5.3.5.1 usa ClientRandom + ServerRandom nos dois estágios. Invertendo,
//      as chaves não batem e o MAC do primeiro PDU falha sem explicar por quê.

const crypto = require('crypto');

const PAD1 = Buffer.alloc(40, 0x36); // 320 bits
const PAD2 = Buffer.alloc(48, 0x5c); // 384 bits

const md5 = (...p) => crypto.createHash('md5').update(Buffer.concat(p)).digest();
const sha1 = (...p) => crypto.createHash('sha1').update(Buffer.concat(p)).digest();

// ---------- RC4 ----------

// Estado próprio em vez de crypto.createCipheriv: o RC4 é um cifrador de fluxo
// e o estado PRECISA sobreviver entre PDUs — cada pacote continua o fluxo de
// onde o anterior parou.
function iniciarRc4(chave) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + chave[i % chave.length]) & 0xff;
    const t = s[i]; s[i] = s[j]; s[j] = t;
  }
  return { s, i: 0, j: 0 };
}

function rc4(estado, dados) {
  const saida = Buffer.allocUnsafe(dados.length);
  let { i, j } = estado;
  const s = estado.s;
  for (let n = 0; n < dados.length; n++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const t = s[i]; s[i] = s[j]; s[j] = t;
    saida[n] = dados[n] ^ s[(s[i] + s[j]) & 0xff];
  }
  estado.i = i; estado.j = j;
  return saida;
}

// Uso avulso (sem estado persistente), para a atualização de chave.
function rc4Uma(chave, dados) {
  return rc4(iniciarRc4(chave), dados);
}

// ---------- derivação de chaves (§5.3.5) ----------

// SaltedHash(S, I) = MD5(S + SHA1(I + S + ClientRandom + ServerRandom))
function saltedHash(s, i, clientRandom, serverRandom) {
  return md5(s, sha1(i, s, clientRandom, serverRandom));
}

// FinalHash(K) = MD5(K + ClientRandom + ServerRandom)
function finalHash(k, clientRandom, serverRandom) {
  return md5(k, clientRandom, serverRandom);
}

const SAL_A = Buffer.from([0x41]);                   // "A"
const SAL_BB = Buffer.from([0x42, 0x42]);            // "BB"
const SAL_CCC = Buffer.from([0x43, 0x43, 0x43]);     // "CCC"
const SAL_X = Buffer.from([0x58]);                   // "X"
const SAL_YY = Buffer.from([0x59, 0x59]);            // "YY"
const SAL_ZZZ = Buffer.from([0x5a, 0x5a, 0x5a]);     // "ZZZ"

// Métodos de criptografia (§2.2.1.4.3)
const METODO_40 = 0x01;
const METODO_128 = 0x02;
const METODO_56 = 0x08;
const METODO_FIPS = 0x10;

// §5.3.5.1: chaves de 40 e 56 bits são enfraquecidas de propósito, trocando os
// primeiros bytes por constantes conhecidas. Mantido por fidelidade à spec.
function enfraquecer(chave, metodo) {
  if (metodo === METODO_40) {
    const c = Buffer.from(chave.slice(0, 8));
    c[0] = 0xd1; c[1] = 0x26; c[2] = 0x9e;
    return c;
  }
  if (metodo === METODO_56) {
    const c = Buffer.from(chave.slice(0, 8));
    c[0] = 0xd1;
    return c;
  }
  return Buffer.from(chave.slice(0, 16)); // 128 bits
}

// Devolve o material de chave do ponto de vista do CLIENTE.
function derivarChaves(clientRandom, serverRandom, metodo) {
  if (metodo === METODO_FIPS) throw new Error('FIPS (3DES) não é suportado.');

  const pre = Buffer.concat([clientRandom.slice(0, 24), serverRandom.slice(0, 24)]);

  const masterSecret = Buffer.concat([
    saltedHash(pre, SAL_A, clientRandom, serverRandom),
    saltedHash(pre, SAL_BB, clientRandom, serverRandom),
    saltedHash(pre, SAL_CCC, clientRandom, serverRandom),
  ]);

  const sessionKeyBlob = Buffer.concat([
    saltedHash(masterSecret, SAL_X, clientRandom, serverRandom),
    saltedHash(masterSecret, SAL_YY, clientRandom, serverRandom),
    saltedHash(masterSecret, SAL_ZZZ, clientRandom, serverRandom),
  ]);

  // O primeiro terço é a chave de MAC e NÃO passa pelo FinalHash.
  const macKey = enfraquecer(sessionKeyBlob.slice(0, 16), metodo);
  // Segundo terço decifra o que vem do servidor; terceiro cifra o que vai.
  const decifrar = enfraquecer(finalHash(sessionKeyBlob.slice(16, 32), clientRandom, serverRandom), metodo);
  const cifrar = enfraquecer(finalHash(sessionKeyBlob.slice(32, 48), clientRandom, serverRandom), metodo);

  return { macKey, chaveDecifrar: decifrar, chaveCifrar: cifrar, masterSecret, sessionKeyBlob };
}

// ---------- assinatura MAC (§5.3.6) ----------

function tamanhoLE(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

// MACSignature = First64Bits(MD5(MACKey + Pad2 + SHA1(MACKey + Pad1 + len + dados)))
function assinar(macKey, dados) {
  const sha = sha1(macKey, PAD1, tamanhoLE(dados.length), dados);
  return md5(macKey, PAD2, sha).slice(0, 8);
}

// §5.3.6.1.1: variante "salgada", que mistura o número de cifragens já feitas.
// Só vale depois da troca de capacidades, e só se ENC_SALTED_CHECKSUM (0x0010)
// tiver sido anunciado pelos dois lados.
function assinarSalgado(macKey, dados, contagem) {
  const sha = sha1(macKey, PAD1, tamanhoLE(dados.length), dados, tamanhoLE(contagem));
  return md5(macKey, PAD2, sha).slice(0, 8);
}

// ---------- atualização de chave (§5.3.7) ----------

// A cada 4096 pacotes a chave é renovada a partir da INICIAL e da ATUAL.
const PACOTES_ATE_RENOVAR = 4096;

function renovarChave(chaveInicial, chaveAtual, metodo) {
  const curta = metodo === METODO_40 || metodo === METODO_56;
  const ini = curta ? chaveInicial.slice(0, 8) : chaveInicial;
  const atu = curta ? chaveAtual.slice(0, 8) : chaveAtual;

  const sha = sha1(ini, PAD1, atu);
  const temp = md5(ini, PAD2, sha);          // TempKey128

  // O RC4 é aplicado sobre a própria chave temporária, com uma tabela nova.
  const nova = rc4Uma(temp, curta ? temp.slice(0, 8) : temp);
  return enfraquecer(nova, metodo);
}

// ---------- sentido do fluxo ----------

// Um sentido de tráfego: chave RC4 com estado, contador de pacotes e a
// renovação automática a cada 4096.
function criarSentido(chaveInicial, macKey, metodo) {
  return {
    metodo,
    macKey,
    chaveInicial: Buffer.from(chaveInicial),
    chaveAtual: Buffer.from(chaveInicial),
    estado: iniciarRc4(chaveInicial),
    pacotes: 0,       // desde a última renovação
    total: 0,         // acumulado, usado pelo MAC salgado
  };
}

function processar(sentido, dados) {
  const saida = rc4(sentido.estado, dados);
  sentido.pacotes += 1;
  sentido.total += 1;
  if (sentido.pacotes >= PACOTES_ATE_RENOVAR) {
    sentido.chaveAtual = renovarChave(sentido.chaveInicial, sentido.chaveAtual, sentido.metodo);
    sentido.estado = iniciarRc4(sentido.chaveAtual);
    sentido.pacotes = 0;
  }
  return saida;
}

module.exports = {
  METODO_40, METODO_56, METODO_128, METODO_FIPS,
  PACOTES_ATE_RENOVAR,
  iniciarRc4, rc4, rc4Uma,
  derivarChaves, saltedHash, finalHash,
  assinar, assinarSalgado,
  renovarChave, criarSentido, processar,
};
