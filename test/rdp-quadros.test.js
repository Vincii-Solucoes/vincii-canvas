'use strict';

// Enquadramento do RDP — offsets e remontagem.
// Rode com: node test/rdp-quadros.test.js

const assert = require('assert');
const q = require('../lib/rdp-quadros');

let ok = 0;
const teste = (nome, fn) => {
  try { fn(); ok++; console.log(`  ✓ ${nome}`); }
  catch (e) { console.log(`  ✗ ${nome}\n      ${e.message}`); process.exitCode = 1; }
};

console.log('\nSeparar PDUs do fluxo');
teste('TPKT completo devolve o tamanho', () => {
  const b = Buffer.from([3, 0, 0, 11, 2, 0xf0, 0x80, 0x64, 0, 0, 0]);
  assert.strictEqual(q.tamanhoDoProximo(b), 11);
});
teste('TPKT incompleto devolve 0 (esperar mais bytes)', () => {
  assert.strictEqual(q.tamanhoDoProximo(Buffer.from([3, 0, 0, 20, 2, 0xf0])), 0);
});
teste('cabeçalho TPKT parcial devolve 0', () => {
  assert.strictEqual(q.tamanhoDoProximo(Buffer.from([3, 0])), 0);
});
teste('TPKT com tamanho absurdo devolve -1', () => {
  assert.strictEqual(q.tamanhoDoProximo(Buffer.from([3, 0, 0, 3, 0])), -1);
});
teste('fast-path curto (tamanho em 1 byte)', () => {
  assert.strictEqual(q.tamanhoDoProximo(Buffer.from([0x00, 6, 1, 2, 3, 4])), 6);
});
teste('fast-path longo (tamanho em 2 bytes)', () => {
  const b = Buffer.alloc(300); b[0] = 0x00; b.writeUInt16BE(300 | 0x8000, 1);
  assert.strictEqual(q.tamanhoDoProximo(b), 300);
});
teste('fast-path com action inválido devolve -1', () => {
  assert.strictEqual(q.tamanhoDoProximo(Buffer.from([0x01, 6, 1, 2, 3, 4])), -1);
});
teste('distingue TPKT de fast-path', () => {
  assert.strictEqual(q.ehTpkt(Buffer.from([3, 0, 0, 7])), true);
  assert.strictEqual(q.ehTpkt(Buffer.from([0x00, 6])), false);
});
teste('tamanho do cabeçalho fast-path: 2 ou 3 bytes', () => {
  assert.strictEqual(q.tamCabecalhoFastpath(Buffer.from([0, 10])), 2);
  assert.strictEqual(q.tamCabecalhoFastpath(Buffer.from([0, 0x81, 0x2c])), 3);
});

console.log('\nSendData — achar a carga');
function sendData(tipo, initiator, canal, carga) {
  const cab = Buffer.alloc(6);
  cab[0] = tipo; cab.writeUInt16BE(initiator, 1); cab.writeUInt16BE(canal, 3); cab[5] = 0x70;
  const corpo = Buffer.concat([cab, q.perTamanho(carga.length), carga]);
  const total = 7 + corpo.length;
  const b = Buffer.alloc(total);
  b[0] = 3; b.writeUInt16BE(total, 2);
  Buffer.from([2, 0xf0, 0x80]).copy(b, 4);
  corpo.copy(b, 7);
  return b;
}

teste('carga curta (tamanho PER de 1 byte)', () => {
  const carga = Buffer.from('cargade10b');
  const d = q.cargaSendData(sendData(q.MCS_SEND_DATA_REQUEST, 1004, 1003, carga));
  assert.strictEqual(d.initiator, 1004);
  assert.strictEqual(d.canal, 1003);
  assert.strictEqual(d.carga.toString(), carga.toString());
});
teste('carga longa (tamanho PER de 2 bytes)', () => {
  const carga = Buffer.alloc(500, 0x5a);
  const d = q.cargaSendData(sendData(q.MCS_SEND_DATA_INDICATION, 1004, 1003, carga));
  assert.strictEqual(d.len, 500);
  assert.strictEqual(d.carga.length, 500);
  assert.strictEqual(d.carga[499], 0x5a);
});
teste('carga exatamente no limite de 127/128 bytes', () => {
  for (const n of [126, 127, 128, 129]) {
    const d = q.cargaSendData(sendData(q.MCS_SEND_DATA_REQUEST, 1004, 1003, Buffer.alloc(n, 1)));
    assert.strictEqual(d.len, n, `falhou em ${n} bytes`);
    assert.strictEqual(d.carga.length, n);
  }
});
teste('não é SendData → null', () => {
  const b = Buffer.from([3, 0, 0, 8, 2, 0xf0, 0x80, q.MCS_ERECT_DOMAIN]);
  assert.strictEqual(q.cargaSendData(b), null);
});

console.log('\nRemontar com outra carga');
teste('trocar a carga recalcula TPKT e PER', () => {
  const orig = sendData(q.MCS_SEND_DATA_REQUEST, 1004, 1003, Buffer.alloc(50, 1));
  const nova = Buffer.alloc(62, 2); // +12 do Security Header
  const saida = q.remontarSendData(orig, nova);
  assert.strictEqual(saida.readUInt16BE(2), saida.length, 'TPKT não bate com o tamanho real');
  const d = q.cargaSendData(saida);
  assert.strictEqual(d.len, 62);
  assert.strictEqual(d.carga.toString('hex'), nova.toString('hex'));
  assert.strictEqual(d.initiator, 1004);
  assert.strictEqual(d.canal, 1003);
});
teste('crescer de 1 byte para 2 bytes de PER continua consistente', () => {
  const orig = sendData(q.MCS_SEND_DATA_REQUEST, 1004, 1003, Buffer.alloc(120, 1));
  const saida = q.remontarSendData(orig, Buffer.alloc(132, 2)); // cruza o limite
  assert.strictEqual(saida.readUInt16BE(2), saida.length);
  assert.strictEqual(q.cargaSendData(saida).len, 132);
});
teste('encolher de 2 bytes para 1 byte de PER continua consistente', () => {
  const orig = sendData(q.MCS_SEND_DATA_INDICATION, 1004, 1003, Buffer.alloc(200, 1));
  const saida = q.remontarSendData(orig, Buffer.alloc(60, 2)); // -12 do header removido
  assert.strictEqual(saida.readUInt16BE(2), saida.length);
  assert.strictEqual(q.cargaSendData(saida).len, 60);
});
teste('ida e volta preserva a carga', () => {
  const carga = Buffer.from('Client Info PDU fingido, com acentuação');
  const orig = sendData(q.MCS_SEND_DATA_REQUEST, 1007, 1003, carga);
  const saida = q.remontarSendData(orig, carga);
  assert.strictEqual(saida.toString('hex'), orig.toString('hex'));
});

console.log('\nMontar SendData do zero (Security Exchange)');
teste('monta e é lido de volta', () => {
  const dados = Buffer.alloc(272, 0xcc);
  const pdu = q.montarSendData(1004, 1003, 0x70, dados);
  assert.strictEqual(q.ehTpkt(pdu), true);
  assert.strictEqual(pdu.readUInt16BE(2), pdu.length);
  assert.strictEqual(q.tipoMcs(pdu), q.MCS_SEND_DATA_REQUEST);
  const d = q.cargaSendData(pdu);
  assert.strictEqual(d.initiator, 1004);
  assert.strictEqual(d.canal, 1003);
  assert.strictEqual(d.carga.length, 272);
});

console.log('\nSecurity Header');
teste('lê flags', () => {
  const c = Buffer.concat([q.cabecalhoBasico(q.SEC_INFO_PKT), Buffer.alloc(4)]);
  const f = q.lerFlagsSeguranca(c);
  assert.strictEqual(f.flags, q.SEC_INFO_PKT);
  assert.strictEqual(f.flagsHi, 0);
});
teste('cabeçalho não-FIPS tem 12 bytes', () => {
  const h = q.cabecalhoNaoFips(q.SEC_ENCRYPT, Buffer.alloc(8, 0xaa));
  assert.strictEqual(h.length, 12);
  assert.strictEqual(h.readUInt16LE(0), q.SEC_ENCRYPT);
  assert.strictEqual(h.slice(4).toString('hex'), 'aaaaaaaaaaaaaaaa');
});
teste('carga curta demais devolve null em vez de explodir', () => {
  assert.strictEqual(q.lerFlagsSeguranca(Buffer.alloc(2)), null);
});

console.log('\nPER — codificação de tamanho');
teste('limites 127/128 e 16383', () => {
  assert.strictEqual(q.perTamanho(127).toString('hex'), '7f');
  assert.strictEqual(q.perTamanho(128).toString('hex'), '8080');
  assert.strictEqual(q.perTamanho(16383).toString('hex'), 'bfff');
});
teste('recusa carga grande demais em vez de gerar lixo', () => {
  assert.throws(() => q.perTamanho(16384), /grande demais/);
});

console.log(`\n${ok} verificações passaram${process.exitCode ? ' (com falhas acima)' : ''}\n`);
