'use strict';

// Terminal SSH interativo via WebSocket: abre um shell (PTY) no host e faz a
// ponte bidirecional entre o xterm.js do navegador e o canal SSH.

const { WebSocketServer } = require('ws');
const store = require('./store');
const runner = require('./runner');

function clamp(n, lo, hi, dflt) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return dflt;
  return Math.min(hi, Math.max(lo, v));
}

// noServer: o roteamento de upgrade por caminho é centralizado no server.js
// (dois WebSocketServer com `path` no mesmo servidor abortam o handshake um do outro).
const wss = new WebSocketServer({ noServer: true });
wss.on('connection', handleConnection);

function handleConnection(ws, req) {
  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  let url;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
  } catch {
    send({ t: 'e', d: 'Requisição inválida.' });
    ws.close();
    return;
  }
  const hostId = url.searchParams.get('hostId');
  const cols = clamp(url.searchParams.get('cols'), 2, 500, 80);
  const rows = clamp(url.searchParams.get('rows'), 2, 300, 24);

  const host = store.get().hosts.find((h) => h.id === hostId);
  if (!host) {
    send({ t: 'e', d: 'Host não encontrado.' });
    ws.close();
    return;
  }

  send({ t: 'e', d: `Conectando a ${host.username}@${host.host}:${host.port || 22}…\r\n` });

  let conn = null;
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { if (conn) conn.end(); } catch {}
    try { ws.close(); } catch {}
  };

  runner
    .connect(host, {
      onSaveFingerprint: (fp) => {
        host.fingerprint = fp;
        store.save();
        send({ t: 'e', d: `Fingerprint do servidor registrado (primeira conexão): ${fp.slice(0, 20)}…\r\n` });
      },
    })
    .then((c) => {
      conn = c;
      if (closed) { try { conn.end(); } catch {} return; }
      conn.on('close', cleanup);
      conn.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) {
          send({ t: 'e', d: 'Não foi possível abrir o shell: ' + err.message + '\r\n' });
          cleanup();
          return;
        }
        send({ t: 'ready' });

        stream.on('data', (d) => send({ t: 'o', d: d.toString('utf8') }));
        stream.stderr.on('data', (d) => send({ t: 'o', d: d.toString('utf8') }));
        stream.on('close', () => {
          send({ t: 'x' });
          cleanup();
        });

        ws.on('message', (raw) => {
          let msg;
          try { msg = JSON.parse(raw.toString()); } catch { return; }
          if (msg.t === 'i' && typeof msg.d === 'string') {
            stream.write(msg.d);
          } else if (msg.t === 'r') {
            const c2 = clamp(msg.cols, 2, 500, cols);
            const r2 = clamp(msg.rows, 2, 300, rows);
            try { stream.setWindow(r2, c2, 0, 0); } catch {}
          }
        });
        ws.on('close', () => {
          try { stream.end(); } catch {}
          cleanup();
        });
      });
    })
    .catch((err) => {
      send({ t: 'e', d: (err && err.message ? err.message : String(err)) + '\r\n' });
      send({ t: 'x' });
      cleanup();
    });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

module.exports = { wss };
