'use strict';

// TCP ping — como o monitor de IP, mas em vez de ICMP mede o tempo do handshake
// TCP até host:porta. Essencial quando o ICMP é bloqueado mas o serviço
// responde (checar se o 443/22/3306 está de pé). Sem módulo nativo (net puro).
//
// Mesmo motor do lib/monitor.js: estado por alvo (host:porta) com refcount,
// batida de coração via /detalhe e TTL de órfão.

const net = require('net');

const INTERVALO_MS = 1000;
const TIMEOUT_MS = 2000;
const TTL_ORFAO_MS = 15000;
const MAX_ALVOS = 50;
const MAX_LOG = 500;

function alvoValido(host, porta) {
  return typeof host === 'string' && host.length > 0 && host.length <= 255
    && /^[a-zA-Z0-9._:-]+$/.test(host) && !/^-/.test(host)
    && Number.isInteger(porta) && porta >= 1 && porta <= 65535;
}

// Uma sonda TCP. Nunca lança. Estados: 'aberta' (conectou), 'fechada'
// (recusada — host vivo, porta sem serviço), 'timeout' (sem resposta).
function sondar(host, porta, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = new net.Socket();
    let feito = false;
    const fim = (estado, lat) => { if (feito) return; feito = true; try { s.destroy(); } catch {} resolve({ estado, latencia: lat != null ? lat : null }); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => fim('aberta', Date.now() - t0));
    s.once('timeout', () => fim('timeout'));
    s.once('error', (e) => fim(e.code === 'ECONNREFUSED' ? 'fechada' : 'timeout'));
    try { s.connect(porta, host); } catch { fim('timeout'); }
  });
}

const alvos = new Map(); // "host:porta" -> estado
let timer = null;
let _agora = () => Date.now();
function agora() { return _agora(); }
const chave = (h, p) => `${h}:${p}`;

async function rodada() {
  const ag = agora();
  for (const [k, a] of alvos) if (ag - a.visto > TTL_ORFAO_MS) alvos.delete(k);
  if (!alvos.size) { pararLoop(); return; }
  await Promise.all([...alvos.values()].map(async (a) => {
    const r = await sondar(a.host, a.porta, TIMEOUT_MS);
    a.total += 1; a.seq += 1;
    if (r.estado === 'aberta') {
      a.status = 'aberta'; a.ultima = r.latencia;
      if (r.latencia != null) { a.somaLat += r.latencia; a.vivos += 1; if (a.melhor === null || r.latencia < a.melhor) a.melhor = r.latencia; if (a.pior === null || r.latencia > a.pior) a.pior = r.latencia; }
    } else {
      a.perdidos += 1; a.ultima = null; a.status = r.estado; // 'fechada' | 'timeout'
    }
    a.log.push({ seq: a.seq, estado: r.estado, latencia: r.latencia });
    if (a.log.length > MAX_LOG) a.log.splice(0, a.log.length - MAX_LOG);
  }));
}

function iniciarLoop() { if (timer) return; timer = setInterval(() => rodada(), INTERVALO_MS); if (timer.unref) timer.unref(); }
function pararLoop() { if (timer) { clearInterval(timer); timer = null; } }

function iniciar(host, porta) {
  const h = String(host || '').trim();
  const p = Number(porta);
  if (!alvoValido(h, p)) return { ok: false, erro: 'Informe host e porta (1–65535).' };
  const k = chave(h, p);
  const existe = alvos.get(k);
  if (existe) { existe.refs += 1; existe.visto = agora(); iniciarLoop(); return { ok: true }; }
  if (alvos.size >= MAX_ALVOS) return { ok: false, erro: `Limite de ${MAX_ALVOS} alvos.` };
  alvos.set(k, {
    host: h, porta: p, refs: 1, status: 'checando', ultima: null, visto: agora(),
    total: 0, perdidos: 0, somaLat: 0, vivos: 0, melhor: null, pior: null, desde: agora(), seq: 0, log: [],
  });
  iniciarLoop();
  return { ok: true };
}

function remover(host, porta) {
  const a = alvos.get(chave(String(host || '').trim(), Number(porta)));
  if (!a) return { ok: false };
  a.refs -= 1;
  if (a.refs <= 0) alvos.delete(chave(a.host, a.porta));
  if (!alvos.size) pararLoop();
  return { ok: true };
}

function limpar() { alvos.clear(); pararLoop(); }

function detalhe(host, porta, desde) {
  const a = alvos.get(chave(String(host || '').trim(), Number(porta)));
  if (!a) return null;
  a.visto = agora();
  const d = Number(desde) || 0;
  return {
    host: a.host, porta: a.porta, status: a.status, ultima: a.ultima,
    total: a.total, perdidos: a.perdidos, desde: a.desde, seq: a.seq,
    perda: a.total ? Math.round((a.perdidos / a.total) * 100) : 0,
    media: a.vivos ? a.somaLat / a.vivos : null, melhor: a.melhor, pior: a.pior,
    novos: a.log.filter((e) => e.seq > d),
  };
}

module.exports = {
  iniciar, remover, limpar, detalhe,
  INTERVALO_MS, TIMEOUT_MS, TTL_ORFAO_MS, MAX_ALVOS,
  _alvoValido: alvoValido, _sondar: sondar, _setAgora(fn) { _agora = fn; }, _rodada: rodada, _pararLoop: pararLoop,
};
