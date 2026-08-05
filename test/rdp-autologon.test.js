'use strict';

// Testes do conserto de logon automático.
//
// A parte medida contra servidor real foi só a do RDP legado — é o único tipo
// de servidor RDP a que temos acesso aqui. O caminho TLS (que é o do Windows)
// passa pela mesma função de marcação, mas com um enquadramento próprio, e
// esse enquadramento precisa aguentar coisas que só aparecem lá: blobs de
// CredSSP, que não são TPKT, e PDUs partidos pelo TCP. É o que estes testes
// cobrem, já que não há Windows para apontar.

const assert = require('assert');
const q = require('../lib/rdp-quadros');
const autologon = require('../lib/rdp-autologon');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n += 1; };
const igual = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); n += 1; };

const INFO_AUTOLOGON = 0x08;

// Monta um Info Packet (§2.2.1.11.1.1) e o embrulha num SendData, como o
// cliente manda. `flags` são as do Info Packet, não as de segurança.
function clientInfo({ usuario = 'vincii', senha = 'segredo', flags = 0x004b0173 } = {}) {
  const u = Buffer.from(usuario, 'ucs2');
  const p = Buffer.from(senha, 'ucs2');
  const cab = Buffer.alloc(18);
  cab.writeUInt32LE(0, 0);            // codePage
  cab.writeUInt32LE(flags >>> 0, 4);
  cab.writeUInt16LE(0, 8);            // cbDomain
  cab.writeUInt16LE(u.length, 10);    // cbUserName (sem o terminador)
  cab.writeUInt16LE(p.length, 12);    // cbPassword
  cab.writeUInt16LE(0, 14);           // cbAlternateShell
  cab.writeUInt16LE(0, 16);           // cbWorkingDir
  const corpo = Buffer.concat([
    cab, Buffer.alloc(2), u, Buffer.alloc(2), p, Buffer.alloc(2), Buffer.alloc(4),
  ]);
  const carga = Buffer.concat([q.cabecalhoBasico(q.SEC_INFO_PKT), corpo]);
  return q.montarSendData(1002, 1003, 0x70, carga);
}

const flagsDoPdu = (pdu) => q.cargaSendData(pdu).carga.readUInt32LE(4 + 4);

// ---------- marcação ----------

{
  const pdu = clientInfo();
  igual(flagsDoPdu(pdu) & INFO_AUTOLOGON, 0, 'fixture começa sem autologon');
  const r = autologon.marcarNoPdu(pdu);
  ok(r && r.marcado, 'Client Info com senha é marcado');
  igual(r.antes, 0x004b0173, 'flags de antes conferem');
  igual(r.depois, 0x004b017b, 'flags de depois só ganharam o bit 0x08');
  igual(flagsDoPdu(pdu) & INFO_AUTOLOGON, INFO_AUTOLOGON,
    'o bit foi escrito no PDU ORIGINAL, não numa cópia');
}

{
  // Sem senha o usuário quer a tela de login: é o modo sem credencial.
  const pdu = clientInfo({ senha: '' });
  const r = autologon.marcarNoPdu(pdu);
  ok(r && !r.marcado, 'Client Info sem senha não é marcado');
  igual(r.motivo, 'sem senha', 'motivo correto');
  igual(flagsDoPdu(pdu) & INFO_AUTOLOGON, 0, 'PDU sem senha fica intacto');
}

{
  const pdu = clientInfo({ flags: 0x004b017b });
  const r = autologon.marcarNoPdu(pdu);
  ok(r && !r.marcado, 'não remarca o que já vinha marcado');
  igual(r.motivo, 'já vinha marcado', 'motivo correto');
}

{
  // Um SendData que não é Client Info não pode ser tocado.
  const outro = q.montarSendData(1002, 1003, 0x70,
    Buffer.concat([q.cabecalhoBasico(q.SEC_LICENSE_PKT), Buffer.alloc(40, 0xaa)]));
  const antes = Buffer.from(outro);
  igual(autologon.marcarNoPdu(outro), null, 'PDU de licença é ignorado');
  ok(antes.equals(outro), 'PDU de licença não foi alterado');
  igual(autologon.marcarNoPdu(Buffer.alloc(3)), null, 'PDU curto demais não quebra');
  igual(autologon.marcar(Buffer.alloc(0)), null, 'carga vazia não quebra');
}

// ---------- espia do caminho TLS ----------

function espiaDeTeste(orcamento) {
  const saida = [];
  const achados = [];
  const espiar = autologon.criarEspia({
    escrever: (b) => saida.push(Buffer.from(b)),
    log: (r) => achados.push(r),
    orcamento,
  });
  return { espiar, achados, saida: () => Buffer.concat(saida) };
}

{
  // O caso normal: CredSSP (DER, começa em 0x30) e só então o Client Info.
  const credssp = Buffer.concat([Buffer.from([0x30, 0x82, 0x01, 0x00]), Buffer.alloc(256, 0x5a)]);
  const pdu = clientInfo();
  const e = espiaDeTeste();
  e.espiar(credssp);
  e.espiar(pdu);
  igual(e.achados.length, 1, 'achou o Client Info uma vez');
  ok(e.achados[0].marcado, 'e marcou');
  const s = e.saida();
  igual(s.length, credssp.length + pdu.length, 'saiu a mesma quantidade de bytes');
  ok(s.slice(0, credssp.length).equals(credssp), 'CredSSP passou intacto');
  igual(flagsDoPdu(s.slice(credssp.length)) & INFO_AUTOLOGON, INFO_AUTOLOGON,
    'o Client Info que saiu está marcado');
}

{
  // O TCP parte onde quiser. Testa TODO corte possível do PDU em dois.
  const original = clientInfo();
  for (let corte = 1; corte < original.length; corte++) {
    const pdu = clientInfo();
    const e = espiaDeTeste();
    e.espiar(pdu.slice(0, corte));
    e.espiar(pdu.slice(corte));
    const s = e.saida();
    assert.strictEqual(s.length, original.length, `corte ${corte}: tamanho mudou`);
    assert.strictEqual(e.achados.length, 1, `corte ${corte}: não achou o Client Info`);
    assert.strictEqual(flagsDoPdu(s) & INFO_AUTOLOGON, INFO_AUTOLOGON,
      `corte ${corte}: saiu sem autologon`);
  }
  n += 1;
  console.log(`   (${original.length - 1} cortes possíveis do Client Info, todos ok)`);
}

{
  // Vários PDUs colados numa escrita só, com o Client Info no meio.
  const antes = q.montarSendData(1002, 1003, 0x70, Buffer.alloc(20, 0x11));
  const depois = q.montarSendData(1002, 1003, 0x70, Buffer.alloc(30, 0x22));
  const pdu = clientInfo();
  const e = espiaDeTeste();
  e.espiar(Buffer.concat([antes, pdu, depois]));
  igual(e.achados.length, 1, 'achou o Client Info entre outros PDUs');
  igual(e.saida().length, antes.length + pdu.length + depois.length,
    'todos os PDUs saíram, nenhum ficou preso no buffer');
}

{
  // Depois de achar, a espia sai de cena: byte nenhum é retido ou remexido.
  const e = espiaDeTeste();
  e.espiar(clientInfo());
  const lixo = Buffer.alloc(5000, 0x03);   // parece TPKT e não é
  e.espiar(lixo);
  const s = e.saida();
  ok(s.slice(-lixo.length).equals(lixo), 'tráfego posterior passa cru e inteiro');
}

{
  // Servidor que nunca manda Client Info: a espia não pode segurar bytes para
  // sempre nem crescer sem limite.
  const e = espiaDeTeste(1024);
  const enxurrada = Buffer.alloc(4096, 0x30);   // não é TPKT
  e.espiar(enxurrada);
  igual(e.saida().length, 4096, 'liberou tudo mesmo sem achar o Client Info');
  e.espiar(Buffer.from([1, 2, 3]));
  igual(e.saida().length, 4099, 'e continua repassando depois de desistir');
}

{
  // TPKT com comprimento inválido: repassa e desiste, em vez de travar.
  const e = espiaDeTeste();
  const ruim = Buffer.from([0x03, 0x00, 0x00, 0x02, 0xff, 0xff]);
  e.espiar(ruim);
  igual(e.saida().length, ruim.length, 'TPKT inválido é repassado, não engolido');
}

console.log(`\n${n} verificações passaram`);
