'use strict';

// Terminal SSH interativo via WebSocket: abre um shell (PTY) no host e faz a
// ponte bidirecional entre o xterm.js do navegador e o canal SSH.

const { WebSocketServer } = require('ws');
const protocolos = require('../public/protocolos');
const termsessions = require('./termsessions');
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
  const enviarDireto = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  let url;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
  } catch {
    enviarDireto({ t: 'e', d: 'Requisição inválida.' });
    ws.close();
    return;
  }

  // Reatar: outra janela pediu ESTA sessão pelo id. A conexão já existe e
  // continua rodando — aqui só se troca a tela que a exibe.
  const idSessao = url.searchParams.get('sessao');
  if (idSessao) {
    const existente = termsessions.pegar(idSessao);
    if (!existente || existente.encerrada) {
      enviarDireto({ t: 'e', d: '\r\nEsta sessão não existe mais (foi encerrada ou expirou).\r\n' });
      enviarDireto({ t: 'x' });
      try { ws.close(); } catch {}
      return;
    }
    existente.atacar(ws);
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

  // VNC, RDP e página web não têm terminal. A interface nunca abre um daqui,
  // mas o WebSocket é uma porta própria: sem a guarda, um pedido montado à mão
  // com o id de um host de RDP tentaria abrir SSH na 3389.
  if (protocolos.SEM_TERMINAL.includes(host.protocol)) {
    send({ t: 'e', d: `\r\nEste host é ${String(host.protocol).toUpperCase()} — não tem terminal.\r\n` });
    try { ws.close(); } catch {}
    return;
  }

  let conn = null;
  // A conexão passa a pertencer à SESSÃO, não ao socket: fechar a janela deixa
  // a sessão órfã (viva, acumulando saída) em vez de matar o shell.
  const sessao = termsessions.criar({
    rotulo: host.name || host.host,
    hostId: host.id || hostId,
  });
  const send = (obj) => sessao.enviar(obj);
  const cleanup = () => sessao.encerrar('a conexão caiu');
  sessao.definirCanal({
    escrever: () => {},
    redimensionar: () => {},
    encerrar: () => { try { if (conn) conn.end(); } catch {} },
  });
  sessao.atacar(ws);

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
      // \b à esquerda: sem isso "bypass:" e "compass:" casavam como "pass:"
      if (!autoLogin.usuarioEnviado && host.username && /\b(login|user\s*name|username|user)\s*:\s*$/i.test(b)) {
        autoLogin.usuarioEnviado = true;
        autoLogin.buffer = '';
        tn.write(host.username + '\r');
        return;
      }
      if (!autoLogin.senhaEnviada && senhaSalva && /\b(password|senha|pass)\s*:\s*$/i.test(b)) {
        autoLogin.senhaEnviada = true;
        autoLogin.buffer = '';
        tn.write(senhaSalva + '\r');
        autoLogin.ativo = false; // senha entregue: encerra a vigilância aqui
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
    sessao.definirCanal({
      escrever: (d) => {
        // usuário digitou: ele assumiu o login, o vigia sai de cena
        autoLogin.ativo = false;
        tn.write(d);
      },
      redimensionar: (c2, r2) => tn.resize(clamp(c2, 2, 500, cols), clamp(r2, 2, 300, rows)),
      encerrar: () => { try { tn.end(); } catch {} },
    });
    send({ t: 'ready' });
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
      // A sessão pode ter sido encerrada enquanto o TLS/SSH negociava (o usuário
      // fechou a aba de propósito, ou o TTL de órfã venceu).
      if (sessao.encerrada) { try { conn.end(); } catch {} return; }
      conn.on('close', cleanup);
      conn.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
        if (err) {
          send({ t: 'e', d: 'Não foi possível abrir o shell: ' + err.message + '\r\n' });
          cleanup();
          return;
        }
        sessao.definirCanal({
          escrever: (dado) => { try { stream.write(dado); } catch {} },
          redimensionar: (c2, r2) => {
            try { stream.setWindow(clamp(r2, 2, 300, rows), clamp(c2, 2, 500, cols), 0, 0); } catch {}
          },
          encerrar: () => {
            try { stream.end(); } catch {}
            try { conn.end(); } catch {}
          },
        });
        send({ t: 'ready' });

        stream.on('data', (d) => send({ t: 'o', d: d.toString('utf8') }));
        stream.stderr.on('data', (d) => send({ t: 'o', d: d.toString('utf8') }));
        stream.on('close', () => sessao.encerrar('o shell terminou'));
      });
    })
    .catch((err) => {
      send({ t: 'e', d: (err && err.message ? err.message : String(err)) + '\r\n' });
      send({ t: 'x' });
      cleanup();
    });

  // Nada de ws.on('close', cleanup) aqui: quem trata o socket é a sessão, e
  // fechar a janela deve deixar a sessão ÓRFÃ, não matar o shell.
}

module.exports = { wss };
