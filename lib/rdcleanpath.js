'use strict';

// Codec DER do RDCleanPathPdu — o protocolo que o cliente IronRDP (WASM) usa
// para pedir a um proxy que abra a conexão RDP por ele.
//
// Definição em Devolutions/IronRDP, crate ironrdp-rdcleanpath, com tag_mode
// EXPLICIT (cada campo vem embrulhado num tag de contexto [n]):
//
//   RDCleanPathPdu ::= SEQUENCE {
//     [0] version            INTEGER
//     [1] error              RDCleanPathErr  OPTIONAL   (proxy → cliente)
//     [2] destination        UTF8String      OPTIONAL   (cliente → proxy)
//     [3] proxyAuth          UTF8String      OPTIONAL   (cliente → proxy)
//     [4] serverAuth         UTF8String      OPTIONAL   (não usado)
//     [5] preconnectionBlob  UTF8String      OPTIONAL   (cliente → proxy)
//     [6] x224ConnectionPdu  OCTET STRING    OPTIONAL   (os dois lados)
//     [7] serverCertChain    SEQUENCE OF OCTET STRING OPTIONAL (proxy → cliente)
//     [9] serverAddr         UTF8String      OPTIONAL   (proxy → cliente)
//   }
//
// O tag 8 (ocsp_response) está reservado e comentado no fonte original — não
// emitimos nada nele.

const VERSAO = 3390; // BASE_VERSION (3389) + 1
const ERRO_GERAL = 0x0100;

// ---------- primitivas DER ----------

function tamanhoDer(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, conteudo) {
  return Buffer.concat([Buffer.from([tag]), tamanhoDer(conteudo.length), conteudo]);
}

function inteiro(n) {
  // DER exige o menor número de bytes, em complemento de dois: se o bit mais
  // alto ficar ligado é preciso um 0x00 na frente para não virar negativo.
  const bytes = [];
  let v = n;
  do { bytes.unshift(v % 256); v = Math.floor(v / 256); } while (v > 0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}

const utf8 = (s) => tlv(0x0c, Buffer.from(String(s), 'utf8'));
const octetos = (b) => tlv(0x04, Buffer.isBuffer(b) ? b : Buffer.from(b));
const sequencia = (...partes) => tlv(0x30, Buffer.concat(partes));
// tag_mode EXPLICIT: [n] é construído (0xA0 | n) e embrulha o valor completo
const contexto = (n, conteudo) => tlv(0xa0 | n, conteudo);

// ---------- leitura ----------

// Lê um TLV a partir de `pos`. Devolve null se o buffer ainda está incompleto,
// o que acontece o tempo todo: TCP e WebSocket podem partir a mensagem.
function lerTlv(buf, pos) {
  if (pos + 2 > buf.length) return null;
  const tag = buf[pos];
  let len = buf[pos + 1];
  let inicio = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error('comprimento DER inválido');
    if (inicio + n > buf.length) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[inicio + i];
    inicio += n;
  }
  if (inicio + len > buf.length) return null;
  return { tag, inicio, fim: inicio + len, conteudo: buf.slice(inicio, inicio + len), proximo: inicio + len };
}

function lerInteiro(buf) {
  let v = 0;
  for (const b of buf) v = v * 256 + b;
  return v;
}

// Devolve { pdu, consumido } ou null se ainda faltam bytes.
function decodificar(buf) {
  const topo = lerTlv(buf, 0);
  if (!topo) return null;
  if (topo.tag !== 0x30) throw new Error('RDCleanPath: esperava SEQUENCE');

  const pdu = {};
  let pos = topo.inicio;
  while (pos < topo.fim) {
    const campo = lerTlv(buf, pos);
    if (!campo) throw new Error('RDCleanPath: campo truncado dentro de um SEQUENCE completo');
    const n = campo.tag & 0x1f;
    // EXPLICIT: dentro do tag de contexto vem o valor com o tipo real
    const dentro = lerTlv(buf, campo.inicio);
    if (dentro) {
      if (n === 0) pdu.version = lerInteiro(dentro.conteudo);
      else if (n === 2) pdu.destination = dentro.conteudo.toString('utf8');
      else if (n === 3) pdu.proxyAuth = dentro.conteudo.toString('utf8');
      else if (n === 5) pdu.preconnectionBlob = dentro.conteudo.toString('utf8');
      else if (n === 6) pdu.x224 = dentro.conteudo;
    }
    pos = campo.proximo;
  }
  return { pdu, consumido: topo.fim };
}

// ---------- escrita ----------

function respostaConectado({ enderecoServidor, x224, cadeiaDer }) {
  const partes = [
    contexto(0, inteiro(VERSAO)),
    contexto(6, octetos(x224)),
    contexto(7, sequencia(...cadeiaDer.map(octetos))),
  ];
  if (enderecoServidor) partes.push(contexto(9, utf8(enderecoServidor)));
  return sequencia(...partes);
}

function respostaErro({ codigo = ERRO_GERAL, wsaLastError, tlsAlertCode } = {}) {
  const erro = [contexto(0, inteiro(codigo))];
  if (wsaLastError != null) erro.push(contexto(2, inteiro(wsaLastError)));
  if (tlsAlertCode != null) erro.push(contexto(3, inteiro(tlsAlertCode)));
  return sequencia(contexto(0, inteiro(VERSAO)), contexto(1, sequencia(...erro)));
}

module.exports = { VERSAO, ERRO_GERAL, decodificar, respostaConectado, respostaErro };
