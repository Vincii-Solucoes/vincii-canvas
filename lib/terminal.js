'use strict';

// Terminal SSH interativo via WebSocket: abre um shell (PTY) no host e faz a
// ponte bidirecional entre o xterm.js do navegador e o canal SSH.

const { WebSocketServer } = require('ws');
const store = require('./store');
const quickhosts = require('./quickhosts');
const runner = require('./runner');
const telnet = require('./telnet');

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

  const host = store.get().hosts.find((h) => h.id === hostId) || quickhosts.get(hostId);
  if (!host) {
    send({ t: 'e', d: 'Host não encontrado.' });
    ws.close();
    return;
  }

  let conn = null;
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { if (conn) conn.end(); } catch {}
    try { ws.close(); } catch {}
  };

  // ----- Telnet (equipamentos de rede legados; texto claro) -----
  if (host.protocol === 'telnet') {
    send({ t: 'e', d: `Conectando via Telnet a ${host.host}:${host.port || 23}…\r\n` });
    send({ t: 'e', d: 'Atenção: Telnet não é criptografado — a senha trafega em texto claro.\r\n' });
    // Login automático: Telnet não tem autenticação no protocolo — quem pergunta
    // é o próprio equipamento, em texto na tela. Então observamos a saída à
    // procura dos prompts e respondemos com o que está guardado no host. Só age
    // se houver credencial salva, uma vez por prompt, e desliga após o login
    // (ou após 20s) para nunca reagir a um texto qualquer no meio da sessão.
    const senhaSalva = (host.auth && host.auth.password) || '';
    const autoLogin = { ativo: !!(host.username || senhaSalva), usuarioEnviado: false, senhaEnviada: false, buffer: '' };
    setTimeout(() => { autoLogin.ativo = false; }, 20000);

    const tentaAutoLogin = (texto) => {
      if (!autoLogin.ativo) return;
      autoLogin.buffer = (autoLogin.buffer + texto).slice(-400);
      const b = autoLogin.buffer;
      if (!autoLogin.usuarioEnviado && host.username && /(login|user\s*name|username|user)\s*:\s*$/i.test(b)) {
        autoLogin.usuarioEnviado = true;
        autoLogin.buffer = '';
        tn.write(host.username + '\r');
        return;
      }
      if (!autoLogin.senhaEnviada && senhaSalva && /(password|senha|pass)\s*:\s*$/i.test(b)) {
        autoLogin.senhaEnviada = true;
        autoLogin.buffer = '';
        tn.write(senhaSalva + '\r');
        // objetivo cumprido: não vigia mais a sessão
        if (autoLogin.usuarioEnviado || !host.username) autoLogin.ativo = false;
      }
    };

    const tn = telnet.connect({
      host: host.host,
      port: host.port || 23,
      cols, rows,
      onData: (data) => {
        const texto = data.toString('utf8');
        send({ t: 'o', d: texto });
        tentaAutoLogin(texto);
      },
      onError: (err) => { send({ t: 'e', d: (err && err.message ? err.message : String(err)) + '\r\n' }); send({ t: 'x' }); cleanup(); },
      onClose: () => { send({ t: 'x' }); cleanup(); },
    });
    if (autoLogin.ativo) {
      send({ t: 'e', d: 'Login automático ativo (usuário/senha salvos no host).\r\n' });
    }
    conn = tn;
    send({ t: 'ready' });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.t === 'i' && typeof msg.d === 'string') tn.write(msg.d);
      else if (msg.t === 'r') tn.resize(clamp(msg.cols, 2, 500, cols), clamp(msg.rows, 2, 300, rows));
    });
    ws.on('close', cleanup);
    ws.on('error', cleanup);
    return;
  }

  send({ t: 'e', d: `Conectando a ${host.username}@${host.host}:${host.port || 22}…\r\n` });

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
