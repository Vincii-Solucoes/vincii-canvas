'use strict';

// Monitorador de IP — a aba Ferramentas.
//
// Faz PING de verdade sem módulo nativo: shella para o `ping` do sistema (como o
// terminal local já shella para o shell). O laço roda AQUI, no processo main —
// não no renderer — porque o Chromium estrangula timers de janela oculta, e o
// objetivo é justamente avisar quando o IP cai enquanto ninguém olha. Quando um
// IP fica fora do ar, a TELA (renderer) toca a sirene; enquanto houver algo
// monitorado, o Electron impede o monitor de dormir (powerSaveBlocker).

const { spawn } = require('child_process');

const INTERVALO_PADRAO_MS = 5000;   // entre rodadas de ping
const TIMEOUT_PADRAO_MS = 2000;     // espera por resposta de cada ping
const LIMITE_ALARME = 2;            // falhas SEGUIDAS até virar "timeout" (evita alarme por 1 pacote perdido)
const MAX_IPS = 50;

// Aceita só IPv4/IPv6/hostname plausível — nada de espaço ou metacaractere de
// shell. Como o ping é chamado com args (sem shell), já não há injeção; isto
// barra lixo antes de gastar um processo.
function ipValido(ip) {
  return typeof ip === 'string' && ip.length > 0 && ip.length <= 255 && /^[a-zA-Z0-9.:_-]+$/.test(ip);
}

// O comando de ping muda por SO: as flags de "quantos pacotes" e "timeout" não
// são as mesmas no Windows, mac e Linux. Função pura, testável.
function comandoPing(ip, timeoutMs, plataforma) {
  const p = plataforma || process.platform;
  if (p === 'win32') {
    // -n 1 (um echo), -w em MILISSEGUNDOS.
    return { cmd: 'ping', args: ['-n', '1', '-w', String(timeoutMs), ip] };
  }
  if (p === 'darwin') {
    // -c 1 (um echo), -t em SEGUNDOS (timeout total antes de sair).
    const seg = Math.max(1, Math.round(timeoutMs / 1000));
    return { cmd: 'ping', args: ['-c', '1', '-t', String(seg), ip] };
  }
  // linux e afins: -c 1, -W em SEGUNDOS (espera pela resposta).
  const seg = Math.max(1, Math.round(timeoutMs / 1000));
  return { cmd: 'ping', args: ['-c', '1', '-W', String(seg), ip] };
}

// Decide vivo/morto e extrai a latência a partir do que o ping imprimiu. Pura.
// O sinal mais confiável entre SOs e idiomas é a presença de "TTL": todo echo
// reply de verdade traz TTL, e o Windows às vezes sai com código 0 mesmo em
// "host inacessível" — por isso não confio só no código de saída.
function parsePing(codigo, saida) {
  const txt = String(saida || '');
  const temTTL = /ttl[=\s:]*\d/i.test(txt);
  const ruim = /unreachable|inacess|timed out|esgotad|100% packet loss|100% de perda/i.test(txt);
  const vivo = temTTL || (codigo === 0 && !ruim);
  let latencia = null;
  // "time=10.2 ms" (unix) | "tempo=10ms"/"time=10ms" (win) | "time<1ms"
  const m = txt.match(/(?:time|tempo)[=<]\s*([\d.,]+)\s*ms/i);
  if (m) { const n = parseFloat(m[1].replace(',', '.')); if (!Number.isNaN(n)) latencia = n; }
  return { vivo, latencia };
}

// Um ping. Nunca lança: erro vira { vivo:false }. Mata o processo se ele passar
// do timeout (mais uma folga), para não acumular pings pendurados.
function pingar(ip, timeoutMs = TIMEOUT_PADRAO_MS) {
  return new Promise((resolve) => {
    if (!ipValido(ip)) { resolve({ vivo: false, latencia: null, erro: 'IP inválido' }); return; }
    const { cmd, args } = comandoPing(ip, timeoutMs, process.platform);
    let saida = '';
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); }
    catch (e) { resolve({ vivo: false, latencia: null, erro: e.message }); return; }
    const matar = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* já saiu */ } }, timeoutMs + 1500);
    child.stdout.on('data', (d) => { saida += d; });
    child.stderr.on('data', (d) => { saida += d; });
    child.on('error', (e) => { clearTimeout(matar); resolve({ vivo: false, latencia: null, erro: e.message }); });
    child.on('close', (codigo) => {
      clearTimeout(matar);
      const r = parsePing(codigo, saida);
      resolve({ vivo: r.vivo, latencia: r.latencia, erro: null });
    });
  });
}

// ---------- o monitor propriamente dito ----------

const alvos = new Map(); // ip -> { ip, status, latencia, falhas, desde, ultimoCheck }
let timer = null;
let intervaloMs = INTERVALO_PADRAO_MS;
let bloquear = null;     // injetado pelo main: bloquear(on) liga/desliga o powerSaveBlocker
let bloqueado = false;

function definirBloqueio(fn) { bloquear = typeof fn === 'function' ? fn : null; }

function ajustarBloqueio() {
  const querBloquear = alvos.size > 0;
  if (querBloquear === bloqueado) return;
  bloqueado = querBloquear;
  if (bloquear) { try { bloquear(bloqueado); } catch { /* segue */ } }
}

async function rodada() {
  const ips = [...alvos.keys()];
  await Promise.all(ips.map(async (ip) => {
    const alvo = alvos.get(ip);
    if (!alvo) return;
    const r = await pingar(ip, TIMEOUT_PADRAO_MS);
    if (!alvos.has(ip)) return; // removido durante o ping
    alvo.ultimoCheck = agora();
    if (r.vivo) {
      if (alvo.status !== 'ok') alvo.desde = alvo.ultimoCheck;
      alvo.status = 'ok';
      alvo.latencia = r.latencia;
      alvo.falhas = 0;
    } else {
      alvo.falhas += 1;
      alvo.latencia = null;
      // Só vira "timeout" (o que dispara a sirene) depois de N falhas seguidas.
      if (alvo.falhas >= LIMITE_ALARME && alvo.status !== 'timeout') {
        alvo.status = 'timeout';
        alvo.desde = alvo.ultimoCheck;
      }
    }
  }));
}

// Date.now() isolado, para o teste poder cravar o tempo.
let _agora = () => Date.now();
function agora() { return _agora(); }

function iniciarLoop() {
  if (timer) return;
  timer = setInterval(() => { rodada(); }, intervaloMs);
  if (timer.unref) timer.unref();
  rodada(); // primeira medição já
}
function pararLoop() { if (timer) { clearInterval(timer); timer = null; } }

function adicionar(ip) {
  const limpo = String(ip || '').trim();
  if (!ipValido(limpo)) return { ok: false, erro: 'Endereço inválido. Use um IP ou nome de host.' };
  if (alvos.has(limpo)) return { ok: false, erro: 'Esse endereço já está sendo monitorado.' };
  if (alvos.size >= MAX_IPS) return { ok: false, erro: `Limite de ${MAX_IPS} endereços.` };
  alvos.set(limpo, { ip: limpo, status: 'checando', latencia: null, falhas: 0, desde: agora(), ultimoCheck: null });
  ajustarBloqueio();
  iniciarLoop();
  return { ok: true };
}

function remover(ip) {
  const existia = alvos.delete(String(ip || ''));
  if (!alvos.size) pararLoop();
  ajustarBloqueio();
  return { ok: existia };
}

function limpar() {
  alvos.clear();
  pararLoop();
  ajustarBloqueio();
}

function estado() {
  return {
    intervaloMs,
    // Só reporta bloqueio quando há um de VERDADE: sob Electron (bloquear
    // injetado) e com algo monitorado. No navegador comum não há powerSaveBlocker.
    bloqueio: !!(bloquear && bloqueado),
    ips: [...alvos.values()].map((a) => ({
      ip: a.ip, status: a.status, latencia: a.latencia, falhas: a.falhas,
      desde: a.desde, ultimoCheck: a.ultimoCheck,
    })),
  };
}

module.exports = {
  adicionar, remover, limpar, estado, definirBloqueio, pingar,
  INTERVALO_PADRAO_MS, TIMEOUT_PADRAO_MS, LIMITE_ALARME, MAX_IPS,
  // teste
  _comandoPing: comandoPing, _parsePing: parsePing, _ipValido: ipValido,
  _setAgora(fn) { _agora = fn; }, _rodada: rodada, _pararLoop: pararLoop,
};
