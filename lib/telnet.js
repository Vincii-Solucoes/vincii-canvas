'use strict';

// Cliente Telnet mínimo (RFC 854/1073/1091) para o terminal interativo —
// usado em equipamentos de rede antigos (switches, roteadores, consoles) que
// não falam SSH. Faz a negociação de opções e entrega ao xterm só o fluxo de
// dados limpo, sem os bytes de controle IAC.
//
// AVISO: Telnet é um protocolo em TEXTO CLARO — sem criptografia e sem
// verificação de identidade do servidor. Qualquer um na rede pode ler a senha
// digitada. Use apenas em rede confiável/gerência; prefira SSH sempre que der.

const net = require('net');

const IAC = 255;
const DONT = 254, DO = 253, WONT = 252, WILL = 251;
const SB = 250, SE = 240;
const OPT_ECHO = 1, OPT_SGA = 3, OPT_TTYPE = 24, OPT_NAWS = 31;

const CONNECT_TIMEOUT_MS = 15000;
const MAX_SUBNEG_BYTES = 64 * 1024; // teto para sub-negociação sem terminador

// Opções que aceitamos que o SERVIDOR faça (respondemos DO)
const SERVER_MAY = new Set([OPT_ECHO, OPT_SGA]);
// Opções que NÓS fazemos quando o servidor pede (respondemos WILL)
const WE_WILL = new Set([OPT_TTYPE, OPT_NAWS, OPT_SGA]);

function connect({ host, port, term = 'xterm-256color', cols = 80, rows = 24, onData, onError, onClose }) {
  const socket = net.createConnection({ host, port: port || 23 });
  socket.setNoDelay(true);
  socket.setTimeout(CONNECT_TIMEOUT_MS);

  let connected = false;
  let closed = false;
  let buf = Buffer.alloc(0);

  const send = (bytes) => {
    if (!closed && socket.writable) { try { socket.write(Buffer.from(bytes)); } catch {} }
  };
  const sendNegotiation = (verb, opt) => send([IAC, verb, opt]);

  // sub-negociação: informa o tipo de terminal
  const sendTermType = () => {
    const name = Buffer.from(term, 'ascii');
    send([IAC, SB, OPT_TTYPE, 0, ...name, IAC, SE]); // 0 = IS
  };
  // sub-negociação: informa o tamanho da janela (NAWS)
  const sendWindowSize = (c, r) => {
    const w = Math.max(1, Math.min(65535, c | 0));
    const h = Math.max(1, Math.min(65535, r | 0));
    // bytes 255 dentro do payload precisam ser duplicados
    const payload = [];
    for (const v of [w >> 8, w & 0xff, h >> 8, h & 0xff]) {
      payload.push(v);
      if (v === IAC) payload.push(IAC);
    }
    send([IAC, SB, OPT_NAWS, ...payload, IAC, SE]);
  };

  // Processa o buffer separando comandos IAC dos dados da tela.
  // Devolve os bytes de dados; guarda sobras de sequências incompletas.
  function parse(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    const out = [];
    let i = 0;
    while (i < buf.length) {
      const b = buf[i];
      if (b !== IAC) { out.push(b); i++; continue; }
      if (i + 1 >= buf.length) break; // sequência incompleta: espera mais dados
      const cmd = buf[i + 1];
      if (cmd === IAC) { out.push(IAC); i += 2; continue; } // 255 escapado = dado
      if (cmd === WILL || cmd === WONT || cmd === DO || cmd === DONT) {
        if (i + 2 >= buf.length) break;
        const opt = buf[i + 2];
        if (cmd === WILL) sendNegotiation(SERVER_MAY.has(opt) ? DO : DONT, opt);
        else if (cmd === DO) {
          const ok = WE_WILL.has(opt);
          sendNegotiation(ok ? WILL : WONT, opt);
          if (ok && opt === OPT_NAWS) sendWindowSize(cols, rows);
        }
        // WONT/DONT: nada a fazer além de aceitar
        i += 3;
        continue;
      }
      if (cmd === SB) {
        // procura o fim da sub-negociação (IAC SE), pulando pares IAC IAC
        // (255 escapado é DADO, não terminador)
        let j = i + 2;
        let end = -1;
        while (j + 1 < buf.length) {
          if (buf[j] === IAC) {
            if (buf[j + 1] === IAC) { j += 2; continue; }
            if (buf[j + 1] === SE) { end = j + 1; break; }
          }
          j++;
        }
        if (end < 0) {
          // Sem terminador: um equipamento hostil (ou um MITM — Telnet é texto
          // claro) poderia despejar dados para sempre e estourar a memória do
          // processo, derrubando junto todas as sessões SSH e agentes.
          if (buf.length - i > MAX_SUBNEG_BYTES) {
            if (onError) onError(new Error('Sub-negociação Telnet sem terminador e acima do limite — conexão encerrada por segurança.'));
            try { socket.destroy(); } catch {}
            buf = Buffer.alloc(0);
            return Buffer.from(out);
          }
          break; // incompleta: espera mais dados
        }
        const opt = buf[i + 2];
        // pedido de tipo de terminal: IAC SB TTYPE SEND(1) IAC SE
        if (opt === OPT_TTYPE && buf[i + 3] === 1) sendTermType();
        i = end + 1;
        continue;
      }
      i += 2; // outros comandos de 2 bytes (NOP, AYT…): ignora
    }
    buf = buf.slice(i);
    return Buffer.from(out);
  }

  socket.on('connect', () => {
    connected = true;
    socket.setTimeout(0); // timeout vale só para conectar
    // anuncia o que sabemos fazer
    sendNegotiation(WILL, OPT_TTYPE);
    sendNegotiation(WILL, OPT_NAWS);
    sendNegotiation(DO, OPT_SGA);
  });
  socket.on('timeout', () => {
    if (!connected) {
      socket.destroy();
      if (onError) onError(new Error(`Tempo esgotado ao conectar em ${host}:${port || 23}.`));
    }
  });
  socket.on('data', (chunk) => {
    const data = parse(chunk);
    if (data.length && onData) onData(data);
  });
  socket.on('error', (err) => {
    if (closed) return;
    if (onError) onError(new Error(humanize(err, host, port)));
  });
  socket.on('close', () => {
    if (closed) return;
    closed = true;
    if (onClose) onClose();
  });

  return {
    write(str) { if (!closed && socket.writable) { try { socket.write(escapeIac(str)); } catch {} } },
    resize(c, r) { sendWindowSize(c, r); },
    end() { closed = true; try { socket.destroy(); } catch {} },
  };
}

// bytes 255 vindos do usuário precisam ser duplicados para não virar comando
function escapeIac(str) {
  const b = Buffer.from(str, 'utf8');
  if (!b.includes(IAC)) return b;
  const out = [];
  for (const v of b) { out.push(v); if (v === IAC) out.push(IAC); }
  return Buffer.from(out);
}

function humanize(err, host, port) {
  const msg = (err && err.message) || String(err);
  if (/ECONNREFUSED/.test(msg)) return `Conexão recusada em ${host}:${port || 23} — o Telnet está ativo nessa porta?`;
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return `Host não encontrado: ${host}`;
  if (/EHOSTUNREACH|ENETUNREACH/.test(msg)) return `Host inalcançável: ${host}`;
  if (/ETIMEDOUT/.test(msg)) return `Tempo esgotado ao conectar em ${host}:${port || 23}.`;
  return msg;
}

module.exports = { connect };
