'use strict';

// Fechar um WebSocket com motivo tem um limite rígido de 123 BYTES (RFC 6455),
// e o `ws` lança RangeError se passar. Cortar por caractere não basta: as
// nossas mensagens são em português e cada acento gasta 2 bytes, então
// justamente os erros mais longos e mais informativos estouravam o limite,
// caíam no catch e o usuário não via motivo nenhum.

const LIMITE_BYTES = 123;

// Corta em até 123 bytes sem partir um caractere multibyte no meio (o que
// geraria UTF-8 inválido e o outro lado descartaria o frame).
function motivoSeguro(msg) {
  const texto = String(msg == null ? '' : msg);
  let buf = Buffer.from(texto, 'utf8');
  if (buf.length <= LIMITE_BYTES) return texto;
  buf = buf.slice(0, LIMITE_BYTES);
  // Volta até o começo do último caractere completo: em UTF-8 os bytes de
  // continuação são 10xxxxxx.
  let fim = buf.length;
  while (fim > 0 && (buf[fim - 1] & 0xc0) === 0x80) fim--;
  if (fim > 0 && buf[fim - 1] >= 0xc0) fim--; // o byte inicial ficou órfão
  return buf.slice(0, fim).toString('utf8');
}

function fecharComMotivo(ws, msg) {
  try { ws.close(4000, motivoSeguro(msg)); } catch { try { ws.close(); } catch {} }
}

module.exports = { motivoSeguro, fecharComMotivo, LIMITE_BYTES };
