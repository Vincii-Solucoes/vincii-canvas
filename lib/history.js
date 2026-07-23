'use strict';

// Histórico de comandos executados no app — terminal interativo (humano),
// assistente e agente de IA (selo IA) e execuções em lote. Cada entrada guarda
// data/hora, o comando, a fonte (humano/ia), a origem, e a máquina onde rodou
// (nome, IP, usuário). Fica em history.json (separado do data.json de
// credenciais), com escrita atômica, permissão 600 e limite de tamanho.
//
// SEGURANÇA: a captura no terminal lê a LINHA JÁ RENDERIZADA do xterm, não as
// teclas — como senhas (sudo/ssh) não são ecoadas na tela, elas não aparecem
// aqui. Ainda assim o arquivo pode conter comandos sensíveis: mode 600 e fora
// do controle de versão.

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = process.env.SSHC_DATA_DIR || path.join(__dirname, '..');
const FILE = path.join(DATA_DIR, 'history.json');
const MAX_ENTRIES = 5000;
const MAX_CMD_LEN = 4000;

let entries = load();
let idSeq = 0;
let saveTimer = null;

function load() {
  try {
    if (!fs.existsSync(FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.entries)) return parsed.entries;
    return [];
  } catch {
    return [];
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 400);
  if (saveTimer.unref) saveTimer.unref();
}

function flush() {
  try {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
    try { fs.chmodSync(FILE, 0o600); } catch {}
  } catch {
    // persistência é best-effort — não derruba a execução se o disco falhar
  }
}

// IP da máquina local (primeiro IPv4 não interno) — para as entradas locais
function localIp() {
  try {
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const i of ifs[name] || []) {
        if (i && i.family === 'IPv4' && !i.internal) return i.address;
      }
    }
  } catch {}
  return '127.0.0.1';
}

function genId() {
  idSeq = (idSeq + 1) % 1000000;
  return Date.now().toString(36) + '-' + idSeq.toString(36);
}

function add({ command, source, origin, machine, ip, username, port, local, hostId }) {
  command = String(command == null ? '' : command).trim();
  if (!command) return null;
  if (command.length > MAX_CMD_LEN) command = command.slice(0, MAX_CMD_LEN) + '…';
  const entry = {
    id: genId(),
    ts: Date.now(),
    command,
    source: source === 'ai' ? 'ai' : 'human',
    origin: origin || 'terminal',
    machine: machine || '',
    ip: ip || '',
    username: username || '',
    port: port || null,
    local: !!local,
    hostId: hostId || null,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  scheduleSave();
  return entry;
}

// Lista as entradas mais recentes primeiro, com filtros opcionais.
function list({ limit, source, hostId, q } = {}) {
  let out = entries;
  if (source === 'ai' || source === 'human') out = out.filter((e) => e.source === source);
  if (hostId === 'local') out = out.filter((e) => e.local);
  else if (hostId) out = out.filter((e) => e.hostId === hostId);
  if (q) {
    const s = String(q).toLowerCase();
    out = out.filter((e) => e.command.toLowerCase().includes(s) || (e.machine || '').toLowerCase().includes(s));
  }
  out = out.slice().reverse();
  const lim = Math.min(3000, Math.max(1, Number(limit) || 1000));
  if (out.length > lim) out = out.slice(0, lim);
  return out;
}

function clear() {
  entries = [];
  flush();
}

function remove(id) {
  const i = entries.findIndex((e) => e.id === id);
  if (i < 0) return false;
  entries.splice(i, 1);
  scheduleSave();
  return true;
}

module.exports = { add, list, clear, remove, localIp };
