'use strict';

// Cirurgia nos blocos GCC — testes determinísticos, sem rede.
// Rode com: node test/rdp-mcs.test.js

const assert = require('assert');
const crypto = require('crypto');
const m = require('../lib/rdp-mcs');

let ok = 0;
const teste = (nome, fn) => {
  try { fn(); ok++; console.log(`  ✓ ${nome}`); }
  catch (e) { console.log(`  ✗ ${nome}\n      ${e.message}`); process.exitCode = 1; }
};

// ---------- montagem de blocos de mentira ----------
function blocoCs(metodos) {
  const b = Buffer.alloc(12);
  b.writeUInt16LE(m.CS_SECURITY, 0); b.writeUInt16LE(12, 2);
  b.writeUInt32LE(metodos, 4);
  return b;
}
function blocoSc(metodo, nivel, tamRandom, tamCert) {
  const len = tamRandom || tamCert ? 20 + tamRandom + tamCert : 12;
  const b = Buffer.alloc(len);
  b.writeUInt16LE(m.SC_SECURITY, 0); b.writeUInt16LE(len, 2);
  b.writeUInt32LE(metodo, 4); b.writeUInt32LE(nivel, 8);
  if (len > 12) {
    b.writeUInt32LE(tamRandom, 12); b.writeUInt32LE(tamCert, 16);
    b.fill(0xaa, 20, 20 + tamRandom);
    b.fill(0xbb, 20 + tamRandom, len);
  }
  return b;
}
function outroBloco(tipo, len) {
  const b = Buffer.alloc(len);
  b.writeUInt16LE(tipo, 0); b.writeUInt16LE(len, 2);
  return b;
}

console.log('\nLocalização de blocos');
teste('acha o CS_SECURITY entre outros blocos', () => {
  const buf = Buffer.concat([outroBloco(0xc001, 216), blocoCs(0), outroBloco(0xc003, 8)]);
  const b = m.acharBloco(buf, m.CS_SECURITY);
  assert.strictEqual(b.inicio, 216);
  assert.strictEqual(b.len, 12);
});
teste('devolve null quando o bloco não existe', () => {
  assert.strictEqual(m.acharBloco(outroBloco(0xc001, 216), m.CS_SECURITY), null);
});
teste('ignora um comprimento que estoura o buffer', () => {
  const b = Buffer.alloc(8);
  b.writeUInt16LE(m.CS_SECURITY, 0); b.writeUInt16LE(999, 2);
  assert.strictEqual(m.acharBloco(b, m.CS_SECURITY), null);
});

console.log('\nCS_SECURITY — anunciar métodos ao servidor');
teste('troca 0 por 40|128|56 sem mudar tamanho', () => {
  const buf = Buffer.concat([outroBloco(0xc001, 216), blocoCs(0), outroBloco(0xc003, 8)]);
  const antes = buf.length;
  const r = m.anunciarMetodos(buf);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.antes, 0);
  assert.strictEqual(buf.readUInt32LE(r.posicao + 4), 0x0b);
  assert.strictEqual(buf.length, antes, 'o tamanho mudou — quebraria o BER/PER');
});
teste('não anuncia FIPS (não implementamos 3DES)', () => {
  assert.strictEqual(m.METODOS_SUPORTADOS & 0x10, 0);
});
teste('falha com motivo quando não há bloco', () => {
  const r = m.anunciarMetodos(outroBloco(0xc001, 216));
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /não encontrado/);
});
teste('falha com motivo quando o bloco é curto demais', () => {
  const b = Buffer.alloc(8);
  b.writeUInt16LE(m.CS_SECURITY, 0); b.writeUInt16LE(8, 2);
  const r = m.anunciarMetodos(b);
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /esperado 12/);
});

console.log('\nSC_SECURITY — ler o que o servidor escolheu');
teste('lê método, nível, random e certificado', () => {
  const buf = Buffer.concat([outroBloco(0x0c01, 36), blocoSc(2, 3, 32, 376)]);
  const g = m.lerSegurancaDoServidor(buf);
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.metodo, 2);
  assert.strictEqual(g.nivel, 3);
  assert.strictEqual(g.serverRandom.length, 32);
  assert.strictEqual(g.certificado.length, 376);
  assert.strictEqual(g.serverRandom[0], 0xaa);
  assert.strictEqual(g.certificado[0], 0xbb);
});
teste('bloco de 12 bytes = sem criptografia, sem random nem cert', () => {
  const g = m.lerSegurancaDoServidor(blocoSc(0, 0, 0, 0));
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.metodo, 0);
  assert.strictEqual(g.serverRandom, null);
  assert.strictEqual(g.certificado, null);
});
teste('recusa bloco que declara mais dados do que cabe', () => {
  const b = blocoSc(2, 3, 32, 376);
  b.writeUInt32LE(9999, 16); // certLen mentiroso
  const g = m.lerSegurancaDoServidor(b);
  assert.strictEqual(g.ok, false);
  assert.match(g.motivo, /mais dados/);
});

console.log('\nSC_SECURITY — neutralizar para o cliente');
teste('zera método e nível mantendo o tamanho do PDU', () => {
  const buf = Buffer.concat([outroBloco(0x0c01, 36), blocoSc(2, 3, 32, 376)]);
  const antes = buf.length;
  const r = m.neutralizarSegurancaDoServidor(buf);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(buf.length, antes, 'mudou de tamanho — quebraria o BER/PER');
  const g = m.lerSegurancaDoServidor(buf);
  assert.strictEqual(g.metodo, 0);
  assert.strictEqual(g.nivel, 0);
});
teste('apaga o certificado e o random do que vai para o cliente', () => {
  const buf = blocoSc(2, 3, 32, 376);
  m.neutralizarSegurancaDoServidor(buf);
  assert.strictEqual(buf.slice(12).every((x) => x === 0), true, 'sobrou material sensível');
});

console.log('\nCertificado proprietário e RSA');
function certProprietario(bits) {
  const bytes = bits / 8;
  const blob = Buffer.alloc(20 + bytes + 8);
  blob.write('RSA1', 0, 'ascii');
  blob.writeUInt32LE(bytes + 8, 4);   // keylen
  blob.writeUInt32LE(bits, 8);        // bitlen
  blob.writeUInt32LE(bytes - 1, 12);  // datalen
  blob.writeUInt32LE(65537, 16);      // pubExp little-endian
  // módulo ímpar e com o bit alto ligado, como um módulo RSA de verdade
  const mod = crypto.randomBytes(bytes);
  mod[0] |= 1;              // little-endian: byte 0 é o menos significativo
  mod[bytes - 1] |= 0x80;   // e o último é o mais significativo
  mod.copy(blob, 20);

  const cert = Buffer.alloc(16 + blob.length);
  cert.writeUInt32LE(1, 0);           // dwVersion = proprietary
  cert.writeUInt32LE(1, 4);
  cert.writeUInt32LE(1, 8);
  cert.writeUInt16LE(0x0006, 12);     // BB_RSA_KEY_BLOB
  cert.writeUInt16LE(blob.length, 14);
  blob.copy(cert, 16);
  return cert;
}

teste('lê uma chave de 2048 bits', () => {
  const k = m.lerChavePublica(certProprietario(2048));
  assert.strictEqual(k.bits, 2048);
  assert.strictEqual(k.bytes, 256);
  assert.strictEqual(k.e, 65537n);
  assert.strictEqual(k.n % 2n, 1n, 'módulo par — leitura little-endian errada');
  assert.strictEqual(k.n.toString(2).length, 2048);
});
teste('lê uma chave de 512 bits (xrdp antigo)', () => {
  const k = m.lerChavePublica(certProprietario(512));
  assert.strictEqual(k.bits, 512);
  assert.strictEqual(k.bytes, 64);
});
teste('recusa certificado X.509 (versão 2)', () => {
  const cert = certProprietario(2048);
  cert.writeUInt32LE(2, 0);
  assert.strictEqual(m.lerChavePublica(cert), null);
});
teste('recusa blob sem o magic RSA1', () => {
  const cert = certProprietario(2048);
  cert.write('XXXX', 16, 'ascii');
  assert.strictEqual(m.lerChavePublica(cert), null);
});
teste('recusa entrada vazia sem explodir', () => {
  assert.strictEqual(m.lerChavePublica(null), null);
  assert.strictEqual(m.lerChavePublica(Buffer.alloc(4)), null);
});

console.log('\nSecurity Exchange — cifragem do client random');
teste('produz exatamente o tamanho do módulo', () => {
  const k = m.lerChavePublica(certProprietario(2048));
  const enc = m.cifrarClientRandom(crypto.randomBytes(32), k);
  assert.strictEqual(enc.length, 256);
});
teste('não devolve zeros', () => {
  const k = m.lerChavePublica(certProprietario(2048));
  const enc = m.cifrarClientRandom(crypto.randomBytes(32), k);
  assert.strictEqual(enc.some((x) => x !== 0), true);
});
teste('client randoms diferentes dão saídas diferentes', () => {
  const k = m.lerChavePublica(certProprietario(2048));
  const a = m.cifrarClientRandom(Buffer.alloc(32, 1), k);
  const b = m.cifrarClientRandom(Buffer.alloc(32, 2), k);
  assert.notStrictEqual(a.toString('hex'), b.toString('hex'));
});
teste('confere contra a exponenciação feita à parte', () => {
  const k = m.lerChavePublica(certProprietario(1024));
  const cr = crypto.randomBytes(32);
  const enc = m.cifrarClientRandom(cr, k);
  // desfaz a inversão e recalcula c = m^e mod n de forma independente
  const mm = BigInt('0x' + Buffer.from(cr).reverse().toString('hex'));
  let r = 1n, base = mm % k.n, exp = k.e;
  while (exp > 0n) { if (exp & 1n) r = (r * base) % k.n; base = (base * base) % k.n; exp >>= 1n; }
  const esperado = Buffer.from(r.toString(16).padStart(k.bytes * 2, '0'), 'hex').reverse();
  assert.strictEqual(enc.toString('hex'), esperado.toString('hex'));
});

console.log(`\n${ok} verificações passaram${process.exitCode ? ' (com falhas acima)' : ''}\n`);
