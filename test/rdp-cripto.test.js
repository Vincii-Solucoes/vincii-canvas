'use strict';

// Validação da criptografia do RDP legado contra vetores conhecidos.
// Rode com: node test/rdp-cripto.test.js

const assert = require('assert');
const c = require('../lib/rdp-cripto');

let ok = 0;
const teste = (nome, fn) => {
  try { fn(); ok++; console.log(`  ✓ ${nome}`); }
  catch (e) { console.log(`  ✗ ${nome}\n      ${e.message}`); process.exitCode = 1; }
};

console.log('\nRC4 — vetores do RFC 6229');
// Chave "Key", texto "Plaintext" → conhecido do RFC 6229 / teste clássico
teste('chave "Key" sobre "Plaintext"', () => {
  const saida = c.rc4Uma(Buffer.from('Key'), Buffer.from('Plaintext'));
  assert.strictEqual(saida.toString('hex'), 'bbf316e8d940af0ad3');
});
teste('chave "Wiki" sobre "pedia"', () => {
  const saida = c.rc4Uma(Buffer.from('Wiki'), Buffer.from('pedia'));
  assert.strictEqual(saida.toString('hex'), '1021bf0420');
});
teste('chave "Secret" sobre "Attack at dawn"', () => {
  const saida = c.rc4Uma(Buffer.from('Secret'), Buffer.from('Attack at dawn'));
  assert.strictEqual(saida.toString('hex'), '45a01f645fc35b383552544b9bf5');
});
teste('RFC 6229: chave 0102030405, primeiros 16 bytes do fluxo', () => {
  const saida = c.rc4Uma(Buffer.from('0102030405', 'hex'), Buffer.alloc(16));
  assert.strictEqual(saida.toString('hex'), 'b2396305f03dc027ccc3524a0a1118a8');
});

console.log('\nRC4 — o estado precisa sobreviver entre chamadas');
teste('cifrar em dois pedaços dá o mesmo que de uma vez', () => {
  const chave = Buffer.from('0102030405', 'hex');
  const dados = Buffer.alloc(64, 0xab);
  const inteiro = c.rc4Uma(chave, dados);
  const e = c.iniciarRc4(chave);
  const partes = Buffer.concat([c.rc4(e, dados.slice(0, 20)), c.rc4(e, dados.slice(20))]);
  assert.strictEqual(partes.toString('hex'), inteiro.toString('hex'));
});
teste('decifrar desfaz cifrar (RC4 é simétrico)', () => {
  const chave = Buffer.from('cafebabe1234', 'hex');
  const claro = Buffer.from('PDU de teste do RDP legado', 'utf8');
  const cifrado = c.rc4Uma(chave, claro);
  assert.notStrictEqual(cifrado.toString('hex'), claro.toString('hex'));
  assert.strictEqual(c.rc4Uma(chave, cifrado).toString('utf8'), claro.toString('utf8'));
});

console.log('\nDerivação de chaves (§5.3.5)');
const clientRandom = Buffer.alloc(32, 0x11);
const serverRandom = Buffer.alloc(32, 0x22);

teste('128 bits produz três chaves de 16 bytes', () => {
  const k = c.derivarChaves(clientRandom, serverRandom, c.METODO_128);
  assert.strictEqual(k.macKey.length, 16);
  assert.strictEqual(k.chaveCifrar.length, 16);
  assert.strictEqual(k.chaveDecifrar.length, 16);
  assert.strictEqual(k.masterSecret.length, 48);
  assert.strictEqual(k.sessionKeyBlob.length, 48);
});
teste('as três chaves são diferentes entre si', () => {
  const k = c.derivarChaves(clientRandom, serverRandom, c.METODO_128);
  const hex = [k.macKey, k.chaveCifrar, k.chaveDecifrar].map((b) => b.toString('hex'));
  assert.strictEqual(new Set(hex).size, 3, 'duas chaves saíram iguais — erro na derivação');
});
teste('é determinística', () => {
  const a = c.derivarChaves(clientRandom, serverRandom, c.METODO_128);
  const b = c.derivarChaves(clientRandom, serverRandom, c.METODO_128);
  assert.strictEqual(a.chaveCifrar.toString('hex'), b.chaveCifrar.toString('hex'));
});
teste('trocar os randoms de lugar muda tudo (a ordem importa)', () => {
  const a = c.derivarChaves(clientRandom, serverRandom, c.METODO_128);
  const b = c.derivarChaves(serverRandom, clientRandom, c.METODO_128);
  assert.notStrictEqual(a.chaveCifrar.toString('hex'), b.chaveCifrar.toString('hex'));
});
teste('40 bits é enfraquecida com d1269e e tem 8 bytes', () => {
  const k = c.derivarChaves(clientRandom, serverRandom, c.METODO_40);
  assert.strictEqual(k.chaveCifrar.length, 8);
  assert.strictEqual(k.chaveCifrar.slice(0, 3).toString('hex'), 'd1269e');
});
teste('56 bits é enfraquecida com d1 e tem 8 bytes', () => {
  const k = c.derivarChaves(clientRandom, serverRandom, c.METODO_56);
  assert.strictEqual(k.chaveCifrar.length, 8);
  assert.strictEqual(k.chaveCifrar[0], 0xd1);
});
teste('FIPS é recusado com mensagem clara', () => {
  assert.throws(() => c.derivarChaves(clientRandom, serverRandom, c.METODO_FIPS), /FIPS/);
});

console.log('\nAssinatura MAC (§5.3.6)');
teste('tem 8 bytes', () => {
  const k = c.derivarChaves(clientRandom, serverRandom, c.METODO_128);
  assert.strictEqual(c.assinar(k.macKey, Buffer.from('abc')).length, 8);
});
teste('muda quando os dados mudam', () => {
  const k = c.derivarChaves(clientRandom, serverRandom, c.METODO_128);
  const a = c.assinar(k.macKey, Buffer.from('abc'));
  const b = c.assinar(k.macKey, Buffer.from('abd'));
  assert.notStrictEqual(a.toString('hex'), b.toString('hex'));
});
teste('muda quando a chave muda', () => {
  const a = c.assinar(Buffer.alloc(16, 1), Buffer.from('abc'));
  const b = c.assinar(Buffer.alloc(16, 2), Buffer.from('abc'));
  assert.notStrictEqual(a.toString('hex'), b.toString('hex'));
});
teste('o comprimento entra no cálculo (dados diferentes, mesmo prefixo)', () => {
  const k = Buffer.alloc(16, 7);
  const a = c.assinar(k, Buffer.from('abc'));
  const b = c.assinar(k, Buffer.from('abcd'));
  assert.notStrictEqual(a.toString('hex'), b.toString('hex'));
});
teste('MAC salgado muda com a contagem de cifragens', () => {
  const k = Buffer.alloc(16, 7);
  const a = c.assinarSalgado(k, Buffer.from('abc'), 0);
  const b = c.assinarSalgado(k, Buffer.from('abc'), 42);
  assert.notStrictEqual(a.toString('hex'), b.toString('hex'));
});
teste('MAC salgado com contagem 0 difere do MAC normal', () => {
  const k = Buffer.alloc(16, 7);
  assert.notStrictEqual(
    c.assinar(k, Buffer.from('abc')).toString('hex'),
    c.assinarSalgado(k, Buffer.from('abc'), 0).toString('hex'),
  );
});

console.log('\nAtualização de chave (§5.3.7)');
teste('a chave renovada difere da inicial', () => {
  const ini = Buffer.alloc(16, 0x33);
  const nova = c.renovarChave(ini, ini, c.METODO_128);
  assert.strictEqual(nova.length, 16);
  assert.notStrictEqual(nova.toString('hex'), ini.toString('hex'));
});
teste('renovar é determinístico', () => {
  const ini = Buffer.alloc(16, 0x33);
  assert.strictEqual(
    c.renovarChave(ini, ini, c.METODO_128).toString('hex'),
    c.renovarChave(ini, ini, c.METODO_128).toString('hex'),
  );
});
teste('renovações sucessivas dão chaves diferentes', () => {
  const ini = Buffer.alloc(16, 0x33);
  const k1 = c.renovarChave(ini, ini, c.METODO_128);
  const k2 = c.renovarChave(ini, k1, c.METODO_128);
  assert.notStrictEqual(k1.toString('hex'), k2.toString('hex'));
});
teste('40 bits renova mantendo o enfraquecimento', () => {
  const ini = c.derivarChaves(clientRandom, serverRandom, c.METODO_40).chaveCifrar;
  const nova = c.renovarChave(ini, ini, c.METODO_40);
  assert.strictEqual(nova.length, 8);
  assert.strictEqual(nova.slice(0, 3).toString('hex'), 'd1269e');
});

console.log('\nSentido de fluxo (renovação automática)');
teste('renova exatamente no pacote 4096 e o fluxo continua', () => {
  const k = c.derivarChaves(clientRandom, serverRandom, c.METODO_128);
  const s = c.criarSentido(k.chaveCifrar, k.macKey, c.METODO_128);
  const antes = s.chaveAtual.toString('hex');
  for (let i = 0; i < c.PACOTES_ATE_RENOVAR - 1; i++) c.processar(s, Buffer.alloc(4));
  assert.strictEqual(s.chaveAtual.toString('hex'), antes, 'renovou cedo demais');
  c.processar(s, Buffer.alloc(4));
  assert.notStrictEqual(s.chaveAtual.toString('hex'), antes, 'não renovou no 4096');
  assert.strictEqual(s.pacotes, 0);
  assert.strictEqual(s.total, c.PACOTES_ATE_RENOVAR);
});
teste('dois sentidos com as chaves cruzadas se desfazem', () => {
  const k = c.derivarChaves(clientRandom, serverRandom, c.METODO_128);
  // quem cifra com chaveCifrar é desfeito por quem decifra com a MESMA chave
  const escreve = c.criarSentido(k.chaveCifrar, k.macKey, c.METODO_128);
  const le = c.criarSentido(k.chaveCifrar, k.macKey, c.METODO_128);
  const claro = Buffer.from('Client Info PDU fingido', 'utf8');
  assert.strictEqual(c.processar(le, c.processar(escreve, claro)).toString('utf8'), claro.toString('utf8'));
});

console.log(`\n${ok} verificações passaram${process.exitCode ? ' (com falhas acima)' : ''}\n`);
