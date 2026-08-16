'use strict';

// Área de trabalho remota: duas pontes WebSocket, uma para cada protocolo.
//
// VNC  — ponte crua: o noVNC no navegador fala RFB direto, então aqui é só
//        repasse de bytes entre o WebSocket e o TCP do servidor VNC. Não
//        precisa de nada instalado além do app.
//
// RDP  — mora em lib/rdp.js: o IronRDP em WebAssembly fala o protocolo no
//        navegador e o proxy daqui faz a parte que o navegador não pode (TCP,
//        TLS e, em servidores antigos, a tradução da criptografia).
//
// SEGURANÇA: as duas rotas passam pela guarda de origem e pelo token de
// processo do server.js — as mesmas barreiras do terminal.

const net = require('net');
const { WebSocketServer } = require('ws');
const store = require('./store');
const quickhosts = require('./quickhosts');
const { fecharComMotivo } = require('./wsclose');

const CONNECT_TIMEOUT_MS = 15000;

function acharHost(id) {
  // Espelhado por último na cadeia, como em toda resolução de host.
  return store.get().hosts.find((h) => h.id === id) || quickhosts.get(id)
    || require('./dadosdecofre').pegarHost(id);
}

// ---------- VNC: repasse puro entre WebSocket e TCP ----------

const vncWss = new WebSocketServer({ noServer: true });
vncWss.on('connection', (ws, req) => {
  const enviarErro = (msg) => fecharComMotivo(ws, msg);

  let url;
  try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return enviarErro('Requisição inválida.'); }
  const host = acharHost(url.searchParams.get('hostId'));
  if (!host) return enviarErro('Host não encontrado.');
  if (host.protocol !== 'vnc') return enviarErro('Este host não é VNC.');

  const porta = host.port || 5900;
  const sock = net.createConnection({ host: host.host, port: porta });
  sock.setNoDelay(true);
  sock.setTimeout(CONNECT_TIMEOUT_MS);

  let fechado = false;
  const encerrar = () => {
    if (fechado) return;
    fechado = true;
    try { sock.destroy(); } catch {}
    try { ws.close(); } catch {}
  };

  sock.on('connect', () => sock.setTimeout(0));
  sock.on('timeout', () => { if (!fechado) { enviarErro(`Tempo esgotado ao conectar em ${host.host}:${porta}.`); encerrar(); } });
  sock.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
  sock.on('error', (err) => { enviarErro(humanizaRede(err, host.host, porta, 'VNC')); encerrar(); });
  sock.on('close', encerrar);

  ws.on('message', (data) => {
    if (fechado || !sock.writable) return;
    // o noVNC manda binário; texto só apareceria por engano
    try { sock.write(Buffer.isBuffer(data) ? data : Buffer.from(data)); } catch {}
  });
  ws.on('close', encerrar);
  ws.on('error', encerrar);
});

function humanizaRede(err, host, porta, quem) {
  const m = (err && err.message) || String(err);
  if (/ECONNREFUSED/.test(m)) return `Conexão recusada em ${host}:${porta} — o ${quem} está ativo nessa porta?`;
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return `Host não encontrado: ${host}`;
  if (/EHOSTUNREACH|ENETUNREACH/.test(m)) return `Host inalcançável: ${host}`;
  if (/ETIMEDOUT/.test(m)) return `Tempo esgotado ao conectar em ${host}:${porta}.`;
  return m;
}

module.exports = { vncWss };
