'use strict';

// Marca INFO_AUTOLOGON no Client Info PDU.
//
// O IronRDP monta o Client Info com usuário, domínio e senha corretos, mas
// nunca liga o bit INFO_AUTOLOGON — e o SessionBuilder do wasm não expõe nenhum
// jeito de pedir isso. Medido em 2026-08-04 contra um xrdp real: a senha chega
// ao servidor (cbPassword=26 para 13 caracteres), com flags=0x004b0173, ou
// seja, tudo menos o bit 0x08.
//
// Sem esse bit o servidor trata as credenciais como sugestão e mostra a tela de
// login assim mesmo. É por isso que atribuir senha no app não conectava direto.
// No Windows a consequência é a mesma — o Winlogon só aceita as credenciais do
// Client Info como logon automático quando INFO_AUTOLOGON está ligado; é o que
// o mstsc e o FreeRDP fazem sempre que há senha.
//
// A correção é um bit: nada muda de tamanho, então dá para escrever no próprio
// buffer que já está a caminho, sem remontar PDU nenhum. Vale para os dois
// caminhos, porque o Client Info leva cabeçalho básico de segurança tanto no
// RDP legado quanto sobre TLS (§2.2.1.11), e o proxy termina o TLS — então em
// ambos os casos ele vê este PDU em claro.

const q = require('./rdp-quadros');

// §2.2.1.11.1.1
const INFO_AUTOLOGON = 0x00000008;

// Deslocamentos dentro do Info Packet, depois do cabeçalho básico de 4 bytes:
// codePage(4) flags(4) cbDomain(2) cbUserName(2) cbPassword(2) …
const OFF_FLAGS = 4;
const OFF_CB_SENHA = 12;
const MINIMO = 18;

// Recebe a carga de um SendData (cabeçalho básico + Info Packet). Se for mesmo
// um Client Info com senha, liga o bit NO BUFFER RECEBIDO e devolve o que
// aconteceu. `carga` costuma ser uma fatia do PDU original — e fatia de Buffer
// no Node compartilha memória, então escrever aqui já conserta o PDU inteiro.
// Permite comparar lado a lado com o comportamento antigo.
const DESLIGADO = process.env.VC_RDP_SEM_AUTOLOGON === '1';

function marcar(carga) {
  if (DESLIGADO) return null;
  if (!carga || carga.length < 4 + MINIMO) return null;
  const f = q.lerFlagsSeguranca(carga);
  if (!f || !(f.flags & q.SEC_INFO_PKT)) return null;

  const info = carga.slice(4);
  // cbPassword não conta o terminador. Sem senha o usuário QUER a tela de
  // login (é o modo sem credencial), então não se mexe em nada.
  const cbSenha = info.readUInt16LE(OFF_CB_SENHA);
  if (cbSenha === 0) return { clientInfo: true, marcado: false, motivo: 'sem senha' };

  const flags = info.readUInt32LE(OFF_FLAGS);
  if (flags & INFO_AUTOLOGON) return { clientInfo: true, marcado: false, motivo: 'já vinha marcado' };

  info.writeUInt32LE((flags | INFO_AUTOLOGON) >>> 0, OFF_FLAGS);
  return { clientInfo: true, marcado: true, antes: flags, depois: (flags | INFO_AUTOLOGON) >>> 0 };
}

// Mesma coisa, mas a partir de um PDU X.224/MCS inteiro: acha o SendData e
// aplica. Usado no caminho TLS, onde o proxy só repassa bytes e não tem
// tradutor para desmontar nada.
function marcarNoPdu(pdu) {
  const d = q.cargaSendData(pdu);
  if (!d) return null;
  return marcar(d.carga);
}

// No caminho TLS não existe tradutor: o proxy só repassa bytes. Esta fábrica
// devolve a função que fica entre o WebSocket e o socket TLS, procura o Client
// Info e sai de cena assim que acha — enquadrar a sessão inteira custaria CPU
// sem servir para nada, já que o PDU aparece uma vez só, no começo.
//
// Antes dele passa o CredSSP, que NÃO é TPKT: são blobs DER soltos, começando
// em 0x30. Daí a regra: só enquadra o que começa em 0x03, e qualquer outra
// coisa segue crua — exatamente como seguia antes desta função existir. Se o
// Client Info não aparecer dentro do orçamento, desiste e libera: melhor
// conectar sem logon automático do que travar a sessão.
function criarEspia({ escrever, log = () => {}, orcamento = 128 * 1024 } = {}) {
  if (DESLIGADO) return escrever;
  let ativa = true;
  let vistos = 0;
  let buf = Buffer.alloc(0);

  return function espiar(b) {
    if (!ativa) return escrever(b);
    vistos += b.length;
    buf = buf.length ? Buffer.concat([buf, b]) : b;

    while (ativa && buf.length && buf[0] === 0x03) {
      const n = q.tamanhoDoProximo(buf);
      if (n === 0) return;                     // TPKT partido: espera o resto
      if (n < 0) { ativa = false; break; }     // não é o que eu penso que é
      const pdu = buf.slice(0, n);
      buf = buf.slice(n);
      const r = marcarNoPdu(pdu);              // escreve no próprio `pdu`
      escrever(pdu);
      if (r) { ativa = false; log(r); }
    }
    if (vistos > orcamento) ativa = false;
    if (buf.length) { escrever(buf); buf = Buffer.alloc(0); }
  };
}

module.exports = { marcar, marcarNoPdu, criarEspia, INFO_AUTOLOGON };
