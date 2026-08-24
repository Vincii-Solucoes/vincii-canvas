'use strict';

// Monitorador de IP — a aba Ferramentas.
//
// UMA JANELA POR HOST: cada janela solta vigia um único endereço, mostrando um
// terminal de ping ao vivo, um cronômetro e a contagem de perda de pacotes.
// Para vigiar vários hosts, abrem-se várias janelas.
//
// Faz PING de verdade sem módulo nativo: shella para o `ping` do sistema (como o
// terminal local já shella para o shell). O laço roda AQUI, no processo main —
// não no renderer — porque o Chromium estrangula timers de janela oculta, e o
// objetivo é justamente avisar quando o IP cai. A tela toca a sirene; enquanto
// houver algo monitorado, o Electron impede a tela de dormir (powerSaveBlocker).

const { spawn } = require('child_process');

const INTERVALO_MS = 1000;      // um ping por segundo, como o `ping` de verdade
const TIMEOUT_PADRAO_MS = 1500; // espera por resposta de cada ping
const LIMITE_ALARME = 3;        // perdas SEGUIDAS até virar "timeout" (dispara a sirene)
const MAX_LOG = 500;            // linhas de terminal guardadas por host
const MAX_IPS = 50;
const TTL_ORFAO_MS = 15000;    // sem batida da janela (poll de /detalhe) por este tempo → solta o alvo

// Aceita só IPv4/IPv6/hostname plausível — nada de espaço ou metacaractere de
// shell. Como o ping é chamado com args (sem shell), já não há injeção; isto
// barra lixo antes de gastar um processo.
function ipValido(ip) {
  return typeof ip === 'string' && ip.length > 0 && ip.length <= 255 && /^[a-zA-Z0-9.:_-]+$/.test(ip);
}

// O comando de ping muda por SO. Função pura, testável.
function comandoPing(ip, timeoutMs, plataforma) {
  const p = plataforma || process.platform;
  if (p === 'win32') return { cmd: 'ping', args: ['-n', '1', '-w', String(timeoutMs), ip] };
  if (p === 'darwin') { const s = Math.max(1, Math.round(timeoutMs / 1000)); return { cmd: 'ping', args: ['-c', '1', '-t', String(s), ip] }; }
  const s = Math.max(1, Math.round(timeoutMs / 1000));
  return { cmd: 'ping', args: ['-c', '1', '-W', String(s), ip] };
}

// Decide vivo/morto e extrai latência. Pura. A presença de "TTL" é o sinal mais
// confiável entre SOs e idiomas (o Windows às vezes sai com código 0 em
// "inacessível"), por isso não confio só no código de saída.
function parsePing(codigo, saida) {
  const txt = String(saida || '');
  const temTTL = /ttl[=\s:]*\d/i.test(txt);
  const ruim = /unreachable|inacess|timed out|esgotad|100% packet loss|100% de perda/i.test(txt);
  const vivo = temTTL || (codigo === 0 && !ruim);
  let latencia = null;
  const m = txt.match(/(?:time|tempo)[=<]\s*([\d.,]+)\s*ms/i);
  if (m) { const n = parseFloat(m[1].replace(',', '.')); if (!Number.isNaN(n)) latencia = n; }
  return { vivo, latencia };
}

// Um ping. Nunca lança. Mata o processo se passar do timeout (mais uma folga).
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
    child.on('close', (codigo) => { clearTimeout(matar); const r = parsePing(codigo, saida); resolve({ vivo: r.vivo, latencia: r.latencia, erro: null }); });
  });
}

// ---------- o monitor por host ----------

const alvos = new Map(); // ip -> { ip, refs, status, latencia, total, perdidos, falhas, desde, seq, log:[] }
let timer = null;
let bloquear = null;     // injetado pelo main: bloquear(on) liga/desliga o powerSaveBlocker
let bloqueado = false;

let _agora = () => Date.now();
function agora() { return _agora(); }

function definirBloqueio(fn) { bloquear = typeof fn === 'function' ? fn : null; }
function ajustarBloqueio() {
  const quer = alvos.size > 0;
  if (quer === bloqueado) return;
  bloqueado = quer;
  if (bloquear) { try { bloquear(bloqueado); } catch { /* segue */ } }
}

async function rodada() {
  // Varredura de órfãos: a janela do monitor "bate ponto" a cada poll de
  // /detalhe (grava a.visto). Se ela morre por CRASH — quando o pagehide não
  // dispara e o /remove nunca chega —, ninguém mais bate, e sem isto o ping
  // seguiria para sempre e o powerSaveBlocker ficaria preso. Passado o TTL sem
  // batida, o alvo é solto (mesmo espírito do TTL de presença das janelas).
  const agoraMs = agora();
  for (const [ip, a] of alvos) {
    if (agoraMs - a.visto > TTL_ORFAO_MS) alvos.delete(ip);
  }
  if (!alvos.size) { pararLoop(); ajustarBloqueio(); return; }

  const ips = [...alvos.keys()];
  await Promise.all(ips.map(async (ip) => {
    const a = alvos.get(ip);
    if (!a) return;
    const r = await pingar(ip, TIMEOUT_PADRAO_MS);
    if (!alvos.has(ip)) return; // removido durante o ping
    a.total += 1;
    a.seq += 1;
    if (r.vivo) {
      a.status = 'ok';
      a.latencia = r.latencia;
      a.falhas = 0;
      if (r.latencia != null) {
        a.somaLat += r.latencia;
        a.vivos += 1;
        if (a.minLat === null || r.latencia < a.minLat) a.minLat = r.latencia;
        if (a.maxLat === null || r.latencia > a.maxLat) a.maxLat = r.latencia;
      }
      // o host voltou: fecha a queda em aberto (se havia)
      const q = a.quedas[a.quedas.length - 1];
      if (q && !q.fim) q.fim = agora();
    } else {
      a.perdidos += 1;
      a.falhas += 1;
      a.latencia = null;
      if (a.falhas >= LIMITE_ALARME && a.status !== 'timeout') {
        a.status = 'timeout';
        a.quedas.push({ inicio: agora(), fim: null });
        if (a.quedas.length > 200) a.quedas.splice(0, a.quedas.length - 200);
      }
    }
    a.log.push({ seq: a.seq, t: agora(), vivo: r.vivo, latencia: r.latencia });
    if (a.log.length > MAX_LOG) a.log.splice(0, a.log.length - MAX_LOG);
  }));
}

function iniciarLoop() {
  if (timer) return;
  timer = setInterval(() => { rodada(); }, INTERVALO_MS);
  if (timer.unref) timer.unref();
  // O primeiro ping vem no próximo tique (1 s). Sem disparo imediato aqui, o
  // avanço do contador fica 1-por-tique — o que o teste controla com _rodada.
}
function pararLoop() { if (timer) { clearInterval(timer); timer = null; } }

// Refcount: duas janelas do mesmo IP não se atrapalham. Só zera/cria de fato
// quando é o primeiro/último interessado.
function adicionar(ip) {
  const limpo = String(ip || '').trim();
  if (!ipValido(limpo)) return { ok: false, erro: 'Endereço inválido. Use um IP ou nome de host.' };
  const existe = alvos.get(limpo);
  if (existe) { existe.refs += 1; existe.visto = agora(); iniciarLoop(); return { ok: true }; }
  if (alvos.size >= MAX_IPS) return { ok: false, erro: `Limite de ${MAX_IPS} monitores.` };
  alvos.set(limpo, {
    ip: limpo, refs: 1, status: 'checando', latencia: null, visto: agora(),
    total: 0, perdidos: 0, falhas: 0, desde: agora(), seq: 0, log: [],
    // estatísticas para a média e o relatório
    somaLat: 0, vivos: 0, minLat: null, maxLat: null,
    // episódios de queda: { inicio, fim|null } — abre ao virar timeout,
    // fecha quando o host volta. É o histórico que o relatório lista.
    quedas: [],
  });
  ajustarBloqueio();
  iniciarLoop();
  return { ok: true };
}

function remover(ip) {
  const a = alvos.get(String(ip || ''));
  if (!a) return { ok: false };
  a.refs -= 1;
  if (a.refs <= 0) alvos.delete(a.ip);
  if (!alvos.size) pararLoop();
  ajustarBloqueio();
  return { ok: true };
}

function limpar() { alvos.clear(); pararLoop(); ajustarBloqueio(); }

// O que UMA janela precisa: os contadores do host e as linhas de ping NOVAS
// (com seq > `desde`), para o terminal só receber o que ainda não mostrou.
function detalhe(ip, desde) {
  const a = alvos.get(String(ip || ''));
  if (!a) return null;
  a.visto = agora(); // batida de coração: a janela está viva
  const d = Number(desde) || 0;
  return {
    ip: a.ip, status: a.status, latencia: a.latencia,
    total: a.total, perdidos: a.perdidos, falhas: a.falhas,
    desde: a.desde, seq: a.seq, bloqueio: !!(bloquear && bloqueado),
    // crua — quem arredonda é a tela (arredondar aqui podia deixar média > máx)
    media: a.vivos ? a.somaLat / a.vivos : null,
    min: a.minLat, max: a.maxLat,
    quedas: a.quedas,
    novos: a.log.filter((e) => e.seq > d),
  };
}

// Panorama de todos (usado por teste; a UI usa detalhe por janela).
function estado() {
  return {
    bloqueio: !!(bloquear && bloqueado),
    ips: [...alvos.values()].map((a) => ({
      ip: a.ip, status: a.status, latencia: a.latencia,
      total: a.total, perdidos: a.perdidos, desde: a.desde,
    })),
  };
}

module.exports = {
  adicionar, remover, limpar, detalhe, estado, definirBloqueio, pingar,
  INTERVALO_MS, TIMEOUT_PADRAO_MS, LIMITE_ALARME, MAX_IPS, TTL_ORFAO_MS,
  _comandoPing: comandoPing, _parsePing: parsePing, _ipValido: ipValido,
  _setAgora(fn) { _agora = fn; }, _rodada: rodada, _pararLoop: pararLoop,
};
