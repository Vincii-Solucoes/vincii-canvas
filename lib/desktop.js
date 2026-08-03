'use strict';

// Área de trabalho remota: duas pontes WebSocket, uma para cada protocolo.
//
// VNC  — ponte crua: o noVNC no navegador fala RFB direto, então aqui é só
//        repasse de bytes entre o WebSocket e o TCP do servidor VNC. Não
//        precisa de nada instalado além do app.
//
// RDP  — o RDP moderno exige NLA/CredSSP e não existe implementação viável em
//        JavaScript. Usamos o guacd (daemon do Apache Guacamole), que fala o
//        protocolo Guacamole em TCP: fazemos o handshake AQUI (as credenciais
//        nunca chegam ao navegador) e depois repassamos para o cliente
//        guacamole-common-js. Exige o guacd rodando (ver README).
//
// SEGURANÇA: as duas rotas passam pela guarda de origem e pelo token de
// processo do server.js — as mesmas barreiras do terminal.

const net = require('net');
const { WebSocketServer } = require('ws');
const store = require('./store');
const quickhosts = require('./quickhosts');

const GUACD_HOST = process.env.GUACD_HOST || '127.0.0.1';
const GUACD_PORT = Number(process.env.GUACD_PORT || 4822);
const CONNECT_TIMEOUT_MS = 15000;

function clamp(n, lo, hi, dflt) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return dflt;
  return Math.min(hi, Math.max(lo, v));
}

function acharHost(id) {
  return store.get().hosts.find((h) => h.id === id) || quickhosts.get(id);
}

// ---------- VNC: repasse puro entre WebSocket e TCP ----------

const vncWss = new WebSocketServer({ noServer: true });
vncWss.on('connection', (ws, req) => {
  const enviarErro = (msg) => { try { ws.close(4000, String(msg).slice(0, 120)); } catch {} };

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

// ---------- RDP (e VNC, se quiser) via guacd ----------
// O protocolo Guacamole é textual: cada instrução é uma lista de elementos
// "TAMANHO.VALOR" separados por vírgula e terminada em ponto e vírgula.

function instrucao(...partes) {
  return partes.map((p) => {
    const s = String(p == null ? '' : p);
    // o tamanho é em CARACTERES (code points), não em bytes
    return [...s].length + '.' + s;
  }).join(',') + ';';
}

// Lê instruções completas de um buffer de texto; devolve as prontas e o resto.
function lerInstrucoes(buffer) {
  const prontas = [];
  let resto = buffer;
  for (;;) {
    const fim = resto.indexOf(';');
    if (fim < 0) break;
    const bruto = resto.slice(0, fim);
    resto = resto.slice(fim + 1);
    const partes = [];
    let i = 0;
    let ok = true;
    while (i < bruto.length) {
      const ponto = bruto.indexOf('.', i);
      if (ponto < 0) { ok = false; break; }
      const n = parseInt(bruto.slice(i, ponto), 10);
      if (!Number.isFinite(n)) { ok = false; break; }
      const valor = [...bruto.slice(ponto + 1)].slice(0, n).join('');
      partes.push(valor);
      i = ponto + 1 + valor.length;
      if (bruto[i] === ',') i++;
    }
    if (ok && partes.length) prontas.push(partes);
  }
  return { prontas, resto };
}

// Valores dos parâmetros que o guacd pedir, conforme o host cadastrado.
function valorDoParametro(nome, host, tela) {
  const auth = host.auth || {};
  const mapa = {
    hostname: host.host,
    port: String(host.port || (host.protocol === 'rdp' ? 3389 : 5900)),
    username: host.username || '',
    password: auth.password || '',
    domain: host.rdpDomain || '',
    width: String(tela.width),
    height: String(tela.height),
    dpi: String(tela.dpi),
    // certificado autoassinado é a regra em servidor Windows interno
    'ignore-cert': 'true',
    security: host.rdpSecurity || 'any',
    'resize-method': 'display-update',
    'enable-wallpaper': 'true',
    'server-layout': host.rdpLayout || 'pt-br-qwerty',
  };
  return Object.prototype.hasOwnProperty.call(mapa, nome) ? mapa[nome] : '';
}

const guacWss = new WebSocketServer({ noServer: true });
guacWss.on('connection', (ws, req) => {
  const falhar = (msg) => { try { ws.close(4000, String(msg).slice(0, 120)); } catch {} };

  let url;
  try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return falhar('Requisição inválida.'); }
  const host = acharHost(url.searchParams.get('hostId'));
  if (!host) return falhar('Host não encontrado.');
  const protocolo = host.protocol === 'vnc' ? 'vnc' : 'rdp';
  const tela = {
    width: clamp(url.searchParams.get('width'), 320, 4096, 1280),
    height: clamp(url.searchParams.get('height'), 240, 2160, 800),
    dpi: clamp(url.searchParams.get('dpi'), 72, 288, 96),
  };

  const sock = net.createConnection({ host: GUACD_HOST, port: GUACD_PORT });
  sock.setNoDelay(true);
  sock.setTimeout(CONNECT_TIMEOUT_MS);

  let fechado = false;
  let fase = 'select';       // select -> args -> pronto
  let buffer = '';
  const encerrar = () => {
    if (fechado) return;
    fechado = true;
    try { sock.destroy(); } catch {}
    try { ws.close(); } catch {}
  };

  sock.on('connect', () => {
    sock.setTimeout(0);
    sock.write(instrucao('select', protocolo));
  });
  sock.on('timeout', () => { if (!fechado) { falhar('Tempo esgotado ao falar com o guacd.'); encerrar(); } });
  sock.on('error', (err) => {
    const m = (err && err.code) === 'ECONNREFUSED'
      ? `guacd não está respondendo em ${GUACD_HOST}:${GUACD_PORT}. Suba o guacd para usar RDP (veja as instruções na aba Área de trabalho).`
      : humanizaRede(err, GUACD_HOST, GUACD_PORT, 'guacd');
    falhar(m);
    encerrar();
  });
  sock.on('close', encerrar);

  sock.on('data', (chunk) => {
    if (fase === 'pronto') {
      if (ws.readyState === ws.OPEN) ws.send(chunk.toString('utf8'));
      return;
    }
    buffer += chunk.toString('utf8');
    const { prontas, resto } = lerInstrucoes(buffer);
    buffer = resto;
    for (const inst of prontas) {
      if (inst[0] === 'args') {
        // responde na ORDEM exata em que o guacd pediu
        const nomes = inst.slice(1);
        sock.write(instrucao('size', String(tela.width), String(tela.height), String(tela.dpi)));
        sock.write(instrucao('audio'));
        sock.write(instrucao('video'));
        sock.write(instrucao('image'));
        sock.write(instrucao('connect', ...nomes.map((n) => valorDoParametro(n, host, tela))));
        fase = 'pronto';
      } else if (inst[0] === 'error') {
        falhar('guacd: ' + (inst[1] || 'erro desconhecido'));
        encerrar();
        return;
      }
    }
    // o que sobrou depois do handshake segue para o navegador
    if (fase === 'pronto' && buffer) {
      if (ws.readyState === ws.OPEN) ws.send(buffer);
      buffer = '';
    }
  });

  ws.on('message', (data) => {
    if (fechado || !sock.writable) return;
    try { sock.write(typeof data === 'string' ? data : data.toString('utf8')); } catch {}
  });
  ws.on('close', encerrar);
  ws.on('error', encerrar);
});

// Testa se o guacd está no ar (para a interface avisar antes de tentar).
function guacdDisponivel() {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: GUACD_HOST, port: GUACD_PORT });
    const fim = (ok) => { try { s.destroy(); } catch {} resolve(ok); };
    s.setTimeout(1200);
    s.on('connect', () => fim(true));
    s.on('timeout', () => fim(false));
    s.on('error', () => fim(false));
  });
}

function humanizaRede(err, host, porta, quem) {
  const m = (err && err.message) || String(err);
  if (/ECONNREFUSED/.test(m)) return `Conexão recusada em ${host}:${porta} — o ${quem} está ativo nessa porta?`;
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return `Host não encontrado: ${host}`;
  if (/EHOSTUNREACH|ENETUNREACH/.test(m)) return `Host inalcançável: ${host}`;
  if (/ETIMEDOUT/.test(m)) return `Tempo esgotado ao conectar em ${host}:${porta}.`;
  return m;
}

module.exports = { vncWss, guacWss, guacdDisponivel, GUACD_HOST, GUACD_PORT, instrucao, lerInstrucoes };
