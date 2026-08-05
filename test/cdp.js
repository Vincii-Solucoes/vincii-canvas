'use strict';

// Avalia uma expressão dentro do renderer do Electron, via Chrome DevTools
// Protocol. Serve para testar o app empacotado de verdade — o preview no
// navegador não vale para nada que dependa do Electron (o BoringSSL dele
// recusa certificados que o Node aceita, por exemplo).
//
// Uso:
//   npx electron . --remote-debugging-port=9222 \
//     --disable-background-timer-throttling \
//     --disable-renderer-backgrounding \
//     --disable-backgrounding-occluded-windows &
//   node test/cdp.js caminho/para/expressao.js
//
// As três flags NÃO são opcionais. Sem elas, o Chromium congela os timers da
// janela quando ela fica em segundo plano — e como o teste roda pelo terminal,
// ela sempre fica. Um setTimeout de 1 s deixa de retornar por MINUTOS, e o
// sintoma é o teste pendurar como se o app tivesse travado. Já custou uma
// caçada a uma regressão que não existia.
//
// O arquivo passado deve conter UMA expressão JavaScript (normalmente uma
// função assíncrona autoinvocada) cujo valor é impresso na saída.
//
// Sem dependências de propósito: implementa o mínimo de WebSocket necessário,
// porque instalar um cliente só para depurar não se justifica.

const http = require('http');
const crypto = require('crypto');
const net = require('net');
const fs = require('fs');

const PORTA = Number(process.env.CDP_PORT || 9222);
const arquivo = process.argv[2];
if (!arquivo) {
  console.error('uso: node test/cdp.js <arquivo-com-expressao.js>');
  process.exit(2);
}
const expressao = fs.readFileSync(arquivo, 'utf8');

http.get(`http://127.0.0.1:${PORTA}/json`, (res) => {
  let corpo = '';
  res.on('data', (d) => { corpo += d; });
  res.on('end', () => {
    let alvo;
    try {
      alvo = JSON.parse(corpo).find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'));
    } catch (e) { console.error('resposta do CDP ilegível:', e.message); process.exit(1); }
    if (!alvo) { console.error('nenhuma página do app encontrada'); process.exit(1); }

    const u = new URL(alvo.webSocketDebuggerUrl);
    const chave = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(u.port, u.hostname, () => {
      sock.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\n`
        + `Upgrade: websocket\r\nConnection: Upgrade\r\n`
        + `Sec-WebSocket-Key: ${chave}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });

    const enviar = (obj) => {
      const carga = Buffer.from(JSON.stringify(obj));
      const cab = [0x81];
      const mascara = crypto.randomBytes(4);
      if (carga.length < 126) cab.push(0x80 | carga.length);
      else if (carga.length < 65536) cab.push(0x80 | 126, (carga.length >> 8) & 255, carga.length & 255);
      else cab.push(0x80 | 127, 0, 0, 0, 0, (carga.length >> 24) & 255, (carga.length >> 16) & 255,
        (carga.length >> 8) & 255, carga.length & 255);
      const m = Buffer.from(carga);
      for (let i = 0; i < m.length; i++) m[i] ^= mascara[i % 4];
      sock.write(Buffer.concat([Buffer.from(cab), mascara, m]));
    };

    let apertoFeito = false;
    let buf = Buffer.alloc(0);

    sock.on('data', (d) => {
      if (!apertoFeito) {
        const fim = d.indexOf('\r\n\r\n');
        if (fim < 0) return;
        apertoFeito = true;
        d = d.slice(fim + 4);
        enviar({ id: 1, method: 'Runtime.evaluate',
          params: { expression: expressao, awaitPromise: true, returnByValue: true } });
        if (!d.length) return;
      }
      buf = Buffer.concat([buf, d]);
      // Só quadros do servidor (sem máscara), que é o que o CDP manda.
      while (buf.length >= 2) {
        let tam = buf[1] & 127;
        let inicio = 2;
        if (tam === 126) { if (buf.length < 4) return; tam = buf.readUInt16BE(2); inicio = 4; }
        else if (tam === 127) { if (buf.length < 10) return; tam = Number(buf.readBigUInt64BE(2)); inicio = 10; }
        if (buf.length < inicio + tam) return;
        const msg = JSON.parse(buf.slice(inicio, inicio + tam).toString());
        buf = buf.slice(inicio + tam);
        if (msg.id !== 1) continue;
        const r = msg.result;
        if (r.exceptionDetails) {
          console.log('EXCEÇÃO:', JSON.stringify(r.exceptionDetails.exception, null, 2));
          process.exit(1);
        }
        const v = r.result.value;
        console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
        process.exit(0);
      }
    });

    sock.on('error', (e) => { console.error('socket:', e.message); process.exit(1); });
  });
}).on('error', (e) => {
  console.error(`CDP fora do ar em 127.0.0.1:${PORTA} — o Electron está com --remote-debugging-port?`, e.message);
  process.exit(1);
});
