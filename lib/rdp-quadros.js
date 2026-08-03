'use strict';

// Enquadramento do RDP: separar PDUs do fluxo TCP e achar a carga útil.
//
// O RDP tem dois enquadramentos que convivem no mesmo socket:
//
//   slow-path — TPKT (03 00 <tam16>) + X.224 Data (02 f0 80) + MCS
//   fast-path — cabeçalho de 1 byte cujo bit 0-1 (action) é 0, seguido de um
//               comprimento de 1 ou 2 bytes
//
// Dá para distinguir pelo primeiro byte: 0x03 é TPKT, qualquer outro com
// action=0 é fast-path. É assim que todo cliente RDP faz.

// ---------- tipos de PDU do MCS (escolha << 2) ----------
const MCS_ERECT_DOMAIN = 0x04;
const MCS_ATTACH_USER_REQUEST = 0x28;
const MCS_ATTACH_USER_CONFIRM = 0x2e;
const MCS_CHANNEL_JOIN_REQUEST = 0x38;
const MCS_CHANNEL_JOIN_CONFIRM = 0x3e;
const MCS_SEND_DATA_REQUEST = 0x64;    // cliente → servidor
const MCS_SEND_DATA_INDICATION = 0x68; // servidor → cliente
const MCS_DISCONNECT = 0x21;

// ---------- flags do Security Header (§2.2.8.1.1.2.1) ----------
const SEC_EXCHANGE_PKT = 0x0001;
const SEC_ENCRYPT = 0x0008;
const SEC_LICENSE_PKT = 0x0080;
const SEC_INFO_PKT = 0x0040;
const SEC_SECURE_CHECKSUM = 0x0800;

// ---------- fast-path ----------
const FASTPATH_ENCRYPTED = 0x80;        // bit 7 do cabeçalho de saída
const FASTPATH_SECURE_CHECKSUM = 0x40;  // bit 6

// Devolve o tamanho do próximo PDU completo em `buf`, ou 0 se ainda faltam
// bytes. Nunca lança: dado estranho vira -1 para o chamador derrubar a conexão.
function tamanhoDoProximo(buf) {
  if (buf.length < 2) return 0;
  if (buf[0] === 0x03) {                 // TPKT
    if (buf.length < 4) return 0;
    const total = buf.readUInt16BE(2);
    if (total < 7) return -1;
    return buf.length >= total ? total : 0;
  }
  // fast-path: action nos 2 bits baixos precisa ser 0
  if ((buf[0] & 0x03) !== 0) return -1;
  let total = buf[1];
  if (total & 0x80) {
    if (buf.length < 3) return 0;
    total = ((total & 0x7f) << 8) | buf[2];
  }
  if (total < 2) return -1;
  return buf.length >= total ? total : 0;
}

const ehTpkt = (pdu) => pdu[0] === 0x03;

// Quantos bytes o cabeçalho de fast-path ocupa (1 do action + 1 ou 2 do tamanho)
const tamCabecalhoFastpath = (pdu) => ((pdu[1] & 0x80) ? 3 : 2);

// ---------- slow-path ----------

// O MCS começa depois de TPKT (4) + X.224 Data (3).
const tipoMcs = (pdu) => (pdu.length > 7 ? pdu[7] : -1);

// Localiza a carga de um SendDataRequest/Indication.
// Layout: tipo(1) initiator(2) canal(2) prioridade(1) tamanho(1 ou 2) carga
function cargaSendData(pdu) {
  const tipo = tipoMcs(pdu);
  if (tipo !== MCS_SEND_DATA_REQUEST && tipo !== MCS_SEND_DATA_INDICATION) return null;
  if (pdu.length < 14) return null;
  let i = 13;                       // 7 + 1 + 2 + 2 + 1
  let len = pdu[i];
  if (len & 0x80) { len = ((len & 0x7f) << 8) | pdu[i + 1]; i += 2; } else { i += 1; }
  if (i + len > pdu.length) return null;
  return {
    tipo,
    initiator: pdu.readUInt16BE(8),
    canal: pdu.readUInt16BE(10),
    prioridade: pdu[12],
    inicio: i,
    len,
    carga: pdu.slice(i, i + len),
  };
}

// Comprimento no formato PER usado pelo MCS: 1 byte até 127, senão 2 com 0x8000.
function perTamanho(n) {
  if (n < 128) return Buffer.from([n]);
  if (n < 0x4000) { const b = Buffer.alloc(2); b.writeUInt16BE(n | 0x8000, 0); return b; }
  throw new Error(`carga MCS grande demais: ${n}`);
}

// Remonta um SendData com outra carga. Os comprimentos do PER e do TPKT são
// recalculados — trocar a carga muda o tamanho, e é justamente o que acontece
// quando adicionamos ou removemos o Security Header.
function remontarSendData(pdu, novaCarga) {
  const d = cargaSendData(pdu);
  if (!d) throw new Error('não é um SendData');
  const cabeca = Buffer.from(pdu.slice(7, 13)); // tipo, initiator, canal, prioridade
  const corpo = Buffer.concat([cabeca, perTamanho(novaCarga.length), novaCarga]);
  const x224 = Buffer.from([0x02, 0xf0, 0x80]);
  const total = 4 + x224.length + corpo.length;
  const saida = Buffer.alloc(total);
  saida[0] = 3; saida[1] = 0; saida.writeUInt16BE(total, 2);
  x224.copy(saida, 4);
  corpo.copy(saida, 7);
  return saida;
}

// Monta um SendDataRequest do zero (usado para injetar o Security Exchange).
function montarSendData(initiator, canal, prioridade, carga) {
  const cabeca = Buffer.alloc(6);
  cabeca[0] = MCS_SEND_DATA_REQUEST;
  cabeca.writeUInt16BE(initiator, 1);
  cabeca.writeUInt16BE(canal, 3);
  cabeca[5] = prioridade;
  const corpo = Buffer.concat([cabeca, perTamanho(carga.length), carga]);
  const total = 7 + corpo.length;
  const saida = Buffer.alloc(total);
  saida[0] = 3; saida[1] = 0; saida.writeUInt16BE(total, 2);
  Buffer.from([0x02, 0xf0, 0x80]).copy(saida, 4);
  corpo.copy(saida, 7);
  return saida;
}

// ---------- Security Header (§2.2.8.1.1.2) ----------

function lerFlagsSeguranca(carga) {
  if (carga.length < 4) return null;
  return { flags: carga.readUInt16LE(0), flagsHi: carga.readUInt16LE(2) };
}

const cabecalhoBasico = (flags) => {
  const b = Buffer.alloc(4);
  b.writeUInt16LE(flags, 0);
  b.writeUInt16LE(0, 2);
  return b;
};

// Non-FIPS: 4 bytes de flags + 8 bytes de assinatura.
const cabecalhoNaoFips = (flags, assinatura) => Buffer.concat([cabecalhoBasico(flags), assinatura]);

module.exports = {
  MCS_ERECT_DOMAIN, MCS_ATTACH_USER_REQUEST, MCS_ATTACH_USER_CONFIRM,
  MCS_CHANNEL_JOIN_REQUEST, MCS_CHANNEL_JOIN_CONFIRM,
  MCS_SEND_DATA_REQUEST, MCS_SEND_DATA_INDICATION, MCS_DISCONNECT,
  SEC_EXCHANGE_PKT, SEC_ENCRYPT, SEC_LICENSE_PKT, SEC_INFO_PKT, SEC_SECURE_CHECKSUM,
  FASTPATH_ENCRYPTED, FASTPATH_SECURE_CHECKSUM,
  tamanhoDoProximo, ehTpkt, tamCabecalhoFastpath,
  tipoMcs, cargaSendData, remontarSendData, montarSendData, perTamanho,
  lerFlagsSeguranca, cabecalhoBasico, cabecalhoNaoFips,
};
