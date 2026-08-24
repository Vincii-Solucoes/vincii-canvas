'use strict';

// MTR (My TraceRoute) — a rota até um host MAIS o ping contínuo de cada salto,
// para ver ONDE a rede dói. Sem módulo nativo e sem root: o `traceroute` do
// sistema descobre os saltos, e cada salto é pingado direto (reusa o ping do
// monitor). É a variante "poor man's MTR", e para achar o hop problemático ela
// é até melhor que o MTR clássico — pingar o salto mede o RTT real até ele, sem
// os falsos positivos de perda que o rate-limit de ICMP-TTL-exceeded causa.
//
// Mesmo espírito do lib/monitor.js: laço no processo main (não estrangulado),
// estado por host com refcount, batida de coração via /detalhe e TTL de órfão.

const { spawn } = require('child_process');
const { pingar } = require('./monitor');

const INTERVALO_MS = 1000;      // um ciclo de ping por segundo
const TIMEOUT_PING_MS = 1500;   // espera por resposta de cada salto
const MAX_HOPS = 30;
const TRACE_TIMEOUT_MS = 40000; // teto do traceroute inteiro
const TTL_ORFAO_MS = 15000;     // janela morta sem batida → solta
const MAX_ALVOS = 20;

// Aceita só IP/hostname plausível — sem espaço nem metacaractere (o traceroute
// e o ping são chamados com ARGS, sem shell, mas isto barra lixo antes).
function hostValido(h) {
  return typeof h === 'string' && h.length > 0 && h.length <= 255 && /^[a-zA-Z0-9.:_-]+$/.test(h)
    && !/^-/.test(h); // nada de começar com traço (viraria opção)
}

// Comando de traceroute por SO. Pura.
function comandoTraceroute(host, plataforma) {
  const p = plataforma || process.platform;
  if (p === 'win32') {
    // -d numérico, -w timeout(ms) por salto, -h máximo de saltos
    return { cmd: 'tracert', args: ['-d', '-w', '1500', '-h', String(MAX_HOPS), host] };
  }
  // mac/linux: -n numérico, -q 1 uma sonda por salto, -w espera, -m máximo
  return { cmd: 'traceroute', args: ['-n', '-q', '1', '-w', '2', '-m', String(MAX_HOPS), host] };
}

// Extrai a lista ordenada de saltos do texto do traceroute. Pura, testável.
// Devolve [{ n, ip|null }] — ip null quando o salto não respondeu ('*').
function parseTraceroute(saida, plataforma) {
  const p = plataforma || process.platform;
  const ehIp = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || /^[0-9a-f:]+:[0-9a-f:]+$/i.test(s);
  const hops = [];
  for (const linha of String(saida || '').split(/\r?\n/)) {
    const m = linha.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue; // linha de cabeçalho ou vazia
    const n = Number(m[1]);
    const resto = m[2];
    let ip = null;
    if (p === 'win32') {
      // Windows põe o IP no FIM da linha; "Request timed out" = sem ip.
      const toks = resto.trim().split(/\s+/);
      const ult = toks[toks.length - 1];
      if (ehIp(ult)) ip = ult;
    } else {
      // unix: primeiro token do resto é o IP, ou '*'.
      const tok = resto.trim().split(/\s+/)[0];
      if (tok && tok !== '*' && ehIp(tok)) ip = tok;
    }
    hops.push({ n, ip });
  }
  return hops;
}

// Roda o traceroute e devolve os saltos. Nunca lança: erro vira lista vazia.
function tracar(host) {
  return new Promise((resolve) => {
    if (!hostValido(host)) { resolve([]); return; }
    const { cmd, args } = comandoTraceroute(host, process.platform);
    let saida = '';
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); }
    catch { resolve([]); return; }
    const matar = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, TRACE_TIMEOUT_MS);
    child.stdout.on('data', (d) => { saida += d; });
    child.stderr.on('data', (d) => { saida += d; });
    child.on('error', () => { clearTimeout(matar); resolve([]); });
    child.on('close', () => { clearTimeout(matar); resolve(parseTraceroute(saida, process.platform)); });
  });
}

// ---------- o motor por host ----------

const alvos = new Map(); // host -> { host, refs, tracando, erro, desde, seq, hops:[], visto }
let timer = null;
let _agora = () => Date.now();
function agora() { return _agora(); }

function novoHop(n, ip) {
  return { n, ip, total: 0, perdidos: 0, ultima: null, melhor: null, pior: null, somaLat: 0, vivos: 0, status: ip ? 'checando' : 'sem-resposta' };
}

async function rodada() {
  // varredura de órfãos (janela morta sem batida)
  const ag = agora();
  for (const [h, a] of alvos) if (ag - a.visto > TTL_ORFAO_MS) alvos.delete(h);
  if (!alvos.size) { pararLoop(); return; }

  for (const a of alvos.values()) {
    if (a.tracando) continue; // ainda descobrindo a rota
    a.seq += 1;
    await Promise.all(a.hops.map(async (hop) => {
      if (!hop.ip) return; // salto mudo: nada a pingar
      const r = await pingar(hop.ip, TIMEOUT_PING_MS);
      hop.total += 1;
      if (r.vivo) {
        hop.status = 'ok';
        hop.ultima = r.latencia;
        if (r.latencia != null) {
          hop.somaLat += r.latencia; hop.vivos += 1;
          if (hop.melhor === null || r.latencia < hop.melhor) hop.melhor = r.latencia;
          if (hop.pior === null || r.latencia > hop.pior) hop.pior = r.latencia;
        }
      } else {
        hop.perdidos += 1;
        hop.ultima = null;
      }
    }));
  }
}

function iniciarLoop() {
  if (timer) return;
  timer = setInterval(() => { rodada(); }, INTERVALO_MS);
  if (timer.unref) timer.unref();
}
function pararLoop() { if (timer) { clearInterval(timer); timer = null; } }

function iniciar(host) {
  const limpo = String(host || '').trim();
  if (!hostValido(limpo)) return { ok: false, erro: 'Endereço inválido. Use um IP ou nome de host.' };
  const existe = alvos.get(limpo);
  if (existe) { existe.refs += 1; existe.visto = agora(); iniciarLoop(); return { ok: true }; }
  if (alvos.size >= MAX_ALVOS) return { ok: false, erro: `Limite de ${MAX_ALVOS} traçados.` };
  const a = { host: limpo, refs: 1, tracando: true, erro: null, desde: agora(), seq: 0, hops: [], visto: agora() };
  alvos.set(limpo, a);
  iniciarLoop();
  // descobre a rota em segundo plano; enquanto isso, tracando=true
  tracar(limpo).then((hops) => {
    if (!alvos.has(limpo)) return; // removido durante o traceroute
    if (!hops.length) { a.erro = 'Não foi possível traçar a rota até este host.'; a.tracando = false; return; }
    a.hops = hops.map((h) => novoHop(h.n, h.ip));
    a.tracando = false;
  });
  return { ok: true };
}

function remover(host) {
  const a = alvos.get(String(host || ''));
  if (!a) return { ok: false };
  a.refs -= 1;
  if (a.refs <= 0) alvos.delete(a.host);
  if (!alvos.size) pararLoop();
  return { ok: true };
}

function limpar() { alvos.clear(); pararLoop(); }

// O que a janela precisa: os saltos com stats calculados (média, perda %).
function detalhe(host) {
  const a = alvos.get(String(host || ''));
  if (!a) return null;
  a.visto = agora();
  return {
    host: a.host, tracando: a.tracando, erro: a.erro, desde: a.desde, seq: a.seq,
    hops: a.hops.map((h) => ({
      n: h.n, ip: h.ip, status: h.status, total: h.total, perdidos: h.perdidos,
      perda: h.total ? Math.round((h.perdidos / h.total) * 100) : 0,
      ultima: h.ultima, melhor: h.melhor, pior: h.pior,
      media: h.vivos ? h.somaLat / h.vivos : null,
    })),
  };
}

module.exports = {
  iniciar, remover, limpar, detalhe,
  INTERVALO_MS, MAX_HOPS, MAX_ALVOS, TTL_ORFAO_MS,
  _comandoTraceroute: comandoTraceroute, _parseTraceroute: parseTraceroute, _hostValido: hostValido,
  _setAgora(fn) { _agora = fn; }, _rodada: rodada, _pararLoop: pararLoop, _alvos: alvos,
};
