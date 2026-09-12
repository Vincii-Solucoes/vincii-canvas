'use strict';

// Ferramenta "Ping" — N pacotes até um alvo com mín/média/máx, jitter e perda
// (o modelo é o ping do isp.tools). Diferente do lib/monitor.js, que bate ICMP
// contínuo de dentro do processo, aqui o ping é o COMANDO do sistema: roda na
// máquina local (spawn sem shell, args separados) ou num host remoto via SSH,
// onde o servidor manda a linha pronta e recebe texto de volta.
//
// Por isso este módulo é 100% puro, sem I/O: monta o comando por plataforma,
// parseia a saída das implementações que aparecem em campo (iputils, macOS,
// BusyBox, Windows pt-BR/en-US, RouterOS) e calcula as estatísticas. Quem
// spawna ou abre o canal SSH é o server.js — assim cada implementação é
// testada com a saída real colada como fixture, sem depender de rede.

const { ehIPv4, _v6ParaBig: v6ParaBig } = require('../public/subnet');

const PLATAFORMAS = ['darwin', 'linux', 'win32', 'busybox', 'routeros'];
const PADRAO = { pacotes: 10, intervaloMs: 500, tamanho: 56, timeoutMs: 2000 };
const LIMITES = { pacotes: [1, 1000], intervaloMs: [20, 60000], tamanho: [0, 65500], timeoutMs: [100, 60000] };

// ---------- validação do alvo ----------

// A linha vai para um shell remoto sem aspas, então o alvo só pode ter o
// alfabeto de IP/hostname. Traço inicial também é recusado: "-f" passaria na
// lista de caracteres e viraria uma opção do ping (flood, como root).
const RE_CHARS_ALVO = /^[A-Za-z0-9.:_-]+$/;
const RE_LABEL = /^[A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$/;

function validarAlvo(str) {
  if (typeof str !== 'string' || !str || str.length > 253) return false;
  if (!RE_CHARS_ALVO.test(str) || str[0] === '-') return false;
  if (str.includes(':')) return v6ParaBig(str) !== null;
  // "999.1.1.1" passaria como hostname de labels numéricos; é IPv4 mal escrito.
  // Zero à esquerda também é recusado: inet_aton lê "010.0.0.1" como OCTAL
  // (8.0.0.1) e o ping iria para outro host sem ninguém perceber.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(str)) return ehIPv4(str) && !/(?:^|\.)0\d/.test(str);
  const labels = str.split('.');
  if (!labels.every((l) => RE_LABEL.test(l))) return false;
  // TLD só de dígitos não existe (RFC 3696 §2) — pega "10.0.0" e afins.
  return !/^\d+$/.test(labels[labels.length - 1]);
}

// ---------- comando por plataforma ----------

// Só número ou string numérica: `true` e `[5]` passariam pelo Number() como 1
// e 5, e o formulário nunca manda isso de propósito.
function inteiro(v, padrao, [min, max]) {
  const ehNum = typeof v === 'number' || (typeof v === 'string' && v.trim() !== '');
  const n = ehNum && Number.isFinite(Number(v)) ? Math.round(Number(v)) : padrao;
  return Math.min(max, Math.max(min, n));
}
function normalizarOpcoes(o) {
  const op = o && typeof o === 'object' ? o : {};
  return {
    pacotes: inteiro(op.pacotes, PADRAO.pacotes, LIMITES.pacotes),
    intervaloMs: inteiro(op.intervaloMs, PADRAO.intervaloMs, LIMITES.intervaloMs),
    tamanho: inteiro(op.tamanho, PADRAO.tamanho, LIMITES.tamanho),
    timeoutMs: inteiro(op.timeoutMs, PADRAO.timeoutMs, LIMITES.timeoutMs),
  };
}
// 500 → "0.5", 1000 → "1", 250 → "0.25" — sem zeros à direita, que o ping do
// BusyBox antigo não entende.
const segundos = (ms) => String(Math.round(ms) / 1000);
const segundosInteiros = (ms) => String(Math.max(1, Math.round(ms / 1000)));

function comandoPing(alvo, opcoes, plataforma) {
  const a = typeof alvo === 'string' ? alvo.trim() : '';
  if (!validarAlvo(a)) return { erro: 'Alvo inválido: use IP ou hostname (letras, dígitos, ponto, hífen).' };
  if (!PLATAFORMAS.includes(plataforma)) return { erro: `Plataforma desconhecida: ${plataforma}` };
  const o = normalizarOpcoes(opcoes);
  const avisos = [];
  let cmd = 'ping';
  let args;

  if (plataforma === 'darwin') {
    // O man do Darwin 25 (conferido) só exige root abaixo de 0,002 s, e
    // `ping -i 0.5` roda sem root nesta máquina. Piso de 0,1 s por cautela com
    // versões mais antigas do macOS, que eram mais restritivas. -W é em ms.
    let int = o.intervaloMs;
    if (int < 100) { int = 100; avisos.push('macOS: intervalo mínimo sem root é 0,1 s.'); }
    args = ['-c', String(o.pacotes), '-i', segundos(int), '-s', String(o.tamanho), '-W', String(o.timeoutMs), a];
  } else if (plataforma === 'linux') {
    // iputils: sem root o intervalo mínimo é 0,2 s (versões de 2021+ baixaram
    // para 2 ms, mas Ubuntu 20/Debian 11 ainda têm a antiga). -W é em segundos
    // inteiros para valer nas versões que não aceitam fração.
    let int = o.intervaloMs;
    if (int < 200) { int = 200; avisos.push('Linux: intervalo mínimo sem root é 0,2 s.'); }
    args = ['-c', String(o.pacotes), '-i', segundos(int), '-s', String(o.tamanho), '-W', String(Math.max(1, Math.ceil(o.timeoutMs / 1000))), a];
  } else if (plataforma === 'busybox') {
    // BusyBox (OpenWrt, roteadores, Alpine) só aceita segundos inteiros em -i
    // e -W; 500 ms vira 1 s.
    const int = segundosInteiros(o.intervaloMs);
    if (Number(int) * 1000 !== o.intervaloMs) avisos.push(`BusyBox: intervalo arredondado para ${int} s (só aceita inteiros).`);
    args = ['-c', String(o.pacotes), '-i', int, '-s', String(o.tamanho), '-W', segundosInteiros(o.timeoutMs), a];
  } else if (plataforma === 'win32') {
    // O ping do Windows não tem opção de intervalo: é sempre 1 s.
    if (o.intervaloMs !== 1000) avisos.push('Windows: o ping não aceita intervalo; usa 1 s entre pacotes.');
    args = ['-n', String(o.pacotes), '-l', String(o.tamanho), '-w', String(o.timeoutMs), a];
  } else {
    // RouterOS: o comando é interno do shell do MikroTik, só faz sentido via
    // SSH. interval aceita de 20 ms a 5 s. `size` segue a convenção do
    // RouterOS (padrão 56, o mesmo número do Unix) e é passado como veio, para
    // o usuário ver o mesmo "56" em todas as plataformas.
    cmd = '/ping';
    let int = o.intervaloMs;
    if (int > 5000) { int = 5000; avisos.push('RouterOS: intervalo máximo é 5 s.'); }
    args = [a, `count=${o.pacotes}`, `interval=${segundos(int)}`, `size=${o.tamanho}`];
  }
  return { cmd, args, linha: [cmd, ...args].join(' '), avisos };
}

// ---------- parse da saída ----------

// Reply Unix (iputils, macOS, BusyBox). O host é lazy até ": seq" porque
// IPv6 tem ":" dentro ("64 bytes from 2001:4860:4860::8888: icmp_seq=1"), e
// o iputils com hostname põe "(ip)" antes dos dois-pontos.
const RE_REPLY_UNIX = /^\d+ bytes from (.+?): (?:icmp_)?seq=(\d+)(?: ttl=(\d+))?(?: time=([\d.,]+) ?ms)?(.*)$/;
const RE_TIMEOUT_MAC = /^Request timeout for icmp_seq (\d+)/;
// "From 192.168.0.1 icmp_seq=3 Destination Host Unreachable" (iputils; BusyBox
// põe ":" depois do IP).
const RE_FROM_UNIX = /^From (.+?):? (?:icmp_)?seq=(\d+) (.+)$/;
const RE_HEADER_UNIX = /^PING6? (\S+)/m;
// Ancorada em ^ (com m): sem a âncora o motor tentava o ".*?" a partir de
// cada posição da linha e uma saída de 1 MB numa linha só levava 12 s.
const RE_FOOTER_UNIX = /^(\d+) packets transmitted, (\d+) (?:packets )?received,.*?([\d.]+)% packet loss/m;
const RE_RTT_UNIX = /(?:rtt|round-trip) min\/avg\/max(?:\/(?:mdev|stddev))? = ([\d.]+)\/([\d.]+)\/([\d.]+)(?:\/([\d.]+))? ms/;

// Windows: "Reply from 8.8.8.8: bytes=32 time=12ms TTL=117" e a versão pt-BR
// "Resposta de 8.8.8.8: bytes=32 tempo=12ms TTL=117". IPv6 vem sem bytes= e
// sem TTL. "time<1ms" é o Windows arredondando para baixo — vira 0.
const RE_REPLY_WIN = /^(?:Reply from|Resposta de) (.+?): (?:bytes=\d+ )?(?:time|tempo)([=<])([\d.,]+) ?ms(?: TTL=(\d+))?/i;
// Armadilha clássica: "Reply from 192.168.0.1: Destination host unreachable."
// é uma RESPOSTA do gateway, não do alvo — o Windows conta como recebido no
// rodapé, mas para nós é perda.
const RE_LOST_WIN = /^(?:Request timed out|Esgotado o tempo limite|(?:Reply from|Resposta de) .+?: (?:Destination|Host de destino|TTL expired|Tempo de vida|General failure|Falha geral)|Destination host unreachable|Host de destino inacess|PING: transmit failed|General failure|Falha geral)/i;
const RE_HEADER_WIN = /^(?:Pinging|Disparando) (\S+)/m;
// "Estatísticas" pode chegar com acento estragado (cp850 via SSH), por isso \S*.
const RE_STATS_WIN = /^(?:Ping statistics for|Estat\S* do Ping para) (.+?):\s*$/m;
const RE_FOOTER_WIN = /(?:Sent|Enviados) = (\d+), (?:Received|Recebidos) = (\d+), (?:Lost|Perdidos) = (\d+)/;
const RE_RTT_WIN = /(?:Minimum|M\S*nimo) = (\d+)ms, (?:Maximum|M\S*ximo) = (\d+)ms, (?:Average|M\S*dia) = (\d+)ms/;

// RouterOS: "    0 8.8.8.8    56 117 12ms" ou "    2 8.8.8.8    timeout".
// Grupo SIZE/TTL/TIME opcional para a linha de timeout cair no STATUS. Só é
// aplicado quando a implementação já foi detectada como RouterOS: "64 bytes
// from ..." também casaria (seq=64, host="bytes").
const RE_ROW_ROS = /^\s*(\d+)\s+(\S+)(?:\s+(\d+)\s+(\d+)\s+(\d+(?:s|ms|us)\S*))?(?:\s+(.*?))?\s*$/;
const RE_FOOTER_ROS = /sent=(\d+) received=(\d+) packet-loss=(\d+)%(?: min-rtt=(\S+) avg-rtt=(\S+) max-rtt=(\S+))?/;
// v6 imprime "12ms"; v7 imprime "12ms345us" ou "345us".
const RE_TEMPO_ROS = /^(?:(\d+)s)?(?:(\d+)ms)?(?:(\d+)us)?$/;

function num(s) { return s == null || s === '' ? null : Number(String(s).replace(',', '.')); }
function tempoRos(s) {
  const m = RE_TEMPO_ROS.exec(s || '');
  if (!m || (m[1] == null && m[2] == null && m[3] == null)) return null;
  return Number(m[1] || 0) * 1000 + Number(m[2] || 0) + Number(m[3] || 0) / 1000;
}

function detectar(texto) {
  if (/^(?:Pinging|Disparando|Reply from|Resposta de|Request timed out|Esgotado o tempo|Ping statistics for|Estat\S* do Ping)/m.test(texto)) return 'windows';
  // [ \t] e não \s: com a flag m, "^\s*" começa em cada linha e atravessa
  // todas as linhas em branco seguintes — em texto só de "\n" é quadrático
  // (256 KB travavam o processo por minutos).
  if (/^[ \t]*SEQ[ \t]+HOST/m.test(texto) || /\bsent=\d+ received=\d+/.test(texto)) return 'routeros';
  if (/^\d+ bytes from .+: seq=\d+/m.test(texto) || /round-trip min\/avg\/max = /.test(texto)) return 'busybox';
  if (/^Request timeout for icmp_seq/m.test(texto) || /round-trip min\/avg\/max\/stddev/.test(texto) || /^PING .*: \d+ data bytes/m.test(texto)) return 'macos';
  if (/bytes of data\./.test(texto) || /rtt min\/avg\/max\/mdev/.test(texto) || /^From .* icmp_seq=/m.test(texto)) return 'iputils';
  if (/icmp_seq=\d+/.test(texto)) {
    // Só linhas de resposta, sem cabeçalho nem rodapé (processo morto no meio):
    // o formato é idêntico; a diferença é que o macOS numera a partir de 0.
    const m = /icmp_seq=(\d+)/.exec(texto);
    return m[1] === '0' ? 'macos' : 'iputils';
  }
  return 'desconhecida';
}

function vazio(implementacao) {
  return {
    implementacao, alvo: null, enviados: 0, recebidos: 0, perdidos: 0, perdaPct: null,
    rtts: [], seqs: [], resumo: { min: null, avg: null, max: null, mdev: null },
  };
}

function parseUnix(linhas, r, texto) {
  const vistos = new Set();
  for (const l of linhas) {
    let m = RE_REPLY_UNIX.exec(l);
    if (m) {
      const seq = Number(m[2]);
      // "(DUP!)" do iputils: mesma seq duas vezes; a primeira já contou.
      if (vistos.has(seq)) continue;
      vistos.add(seq);
      const ms = num(m[4]);
      r.seqs.push({ seq, ttl: num(m[3]), ms, estado: ms == null ? 'desconhecido' : 'ok' });
      continue;
    }
    m = RE_TIMEOUT_MAC.exec(l);
    if (m) {
      const seq = Number(m[1]);
      if (vistos.has(seq)) continue;
      vistos.add(seq);
      r.seqs.push({ seq, ttl: null, ms: null, estado: 'timeout' });
      continue;
    }
    m = RE_FROM_UNIX.exec(l);
    if (m) {
      const seq = Number(m[2]);
      if (vistos.has(seq)) continue;
      vistos.add(seq);
      r.seqs.push({ seq, ttl: null, ms: null, estado: /unreachable/i.test(m[3]) ? 'inacessivel' : m[3].trim().toLowerCase() });
    }
  }
  const h = RE_HEADER_UNIX.exec(texto);
  if (h) r.alvo = h[1];
  const f = RE_FOOTER_UNIX.exec(texto);
  if (f) { r.enviados = Number(f[1]); r.recebidos = Number(f[2]); }
  const t = RE_RTT_UNIX.exec(texto);
  if (t) r.resumo = { min: num(t[1]), avg: num(t[2]), max: num(t[3]), mdev: num(t[4]) };
  // iputils e Windows numeram de 1; macOS, BusyBox e RouterOS de 0.
  return r.implementacao === 'iputils' ? 1 : 0;
}

function parseWindows(linhas, r, texto) {
  let seq = 0;
  for (const l of linhas) {
    const m = RE_REPLY_WIN.exec(l);
    if (m) {
      seq += 1;
      r.seqs.push({ seq, ttl: num(m[4]), ms: m[2] === '<' ? 0 : num(m[3]), estado: 'ok' });
    } else if (RE_LOST_WIN.test(l)) {
      seq += 1;
      r.seqs.push({ seq, ttl: null, ms: null, estado: /timed out|Esgotado/i.test(l) ? 'timeout' : 'inacessivel' });
    }
  }
  const h = RE_HEADER_WIN.exec(texto) || RE_STATS_WIN.exec(texto);
  if (h) r.alvo = h[1];
  const f = RE_FOOTER_WIN.exec(texto);
  // Só o "Sent" do rodapé é confiável (ver RE_LOST_WIN): recebidos vem das linhas.
  if (f) r.enviados = Number(f[1]);
  const t = RE_RTT_WIN.exec(texto);
  if (t) r.resumo = { min: num(t[1]), avg: num(t[3]), max: num(t[2]), mdev: null };
  return 1;
}

function parseRouterOS(linhas, r, texto) {
  const vistos = new Set();
  for (const l of linhas) {
    if (/^[ \t]*SEQ[ \t]+HOST/.test(l) || /sent=\d+/.test(l)) continue;
    const m = RE_ROW_ROS.exec(l);
    if (!m) continue;
    const seq = Number(m[1]);
    if (vistos.has(seq)) continue;
    vistos.add(seq);
    if (!r.alvo) r.alvo = m[2];
    const ms = m[5] != null ? tempoRos(m[5]) : null;
    if (ms != null) r.seqs.push({ seq, ttl: num(m[4]), ms, estado: 'ok' });
    else {
      const st = (m[6] || m[5] || '').trim().toLowerCase();
      r.seqs.push({ seq, ttl: null, ms: null, estado: /unreachable/.test(st) ? 'inacessivel' : (st || 'timeout') });
    }
  }
  const f = RE_FOOTER_ROS.exec(texto);
  if (f) {
    r.enviados = Number(f[1]); r.recebidos = Number(f[2]);
    if (f[4]) r.resumo = { min: tempoRos(f[4]), avg: tempoRos(f[5]), max: tempoRos(f[6]), mdev: null };
  }
  return 0;
}

function parsePing(texto) {
  // \r do Windows/RouterOS via SSH e escapes ANSI que o RouterOS às vezes manda.
  const t = String(texto || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
  const impl = detectar(t);
  const r = vazio(impl);
  r.enviados = null; r.recebidos = null;
  const linhas = t.split('\n');
  let base;
  if (impl === 'windows') base = parseWindows(linhas, r, t);
  else if (impl === 'routeros') base = parseRouterOS(linhas, r, t);
  else base = parseUnix(linhas, r, t); // 'desconhecida' tenta o formato Unix, o mais comum

  r.seqs.sort((a, b) => a.seq - b.seq);
  r.rtts = r.seqs.filter((s) => s.ms != null).map((s) => s.ms);
  // Sem rodapé (processo morto, saída truncada), o melhor que dá é contar da
  // base até a maior seq vista: buracos no meio são timeouts silenciosos do
  // iputils; perdas no FIM não têm como ser vistas.
  // Laço e não Math.max(...spread): com centenas de milhares de seqs o spread
  // estoura a pilha ("Maximum call stack size exceeded").
  if (r.enviados == null) r.enviados = r.seqs.length ? r.seqs[r.seqs.length - 1].seq - base + 1 : 0;
  if (r.recebidos == null) r.recebidos = r.rtts.length;
  r.enviados = Math.max(r.enviados, r.recebidos);
  r.perdidos = r.enviados - r.recebidos;
  r.perdaPct = r.enviados ? Math.round((r.perdidos / r.enviados) * 1000) / 10 : null;
  return r;
}

// ---------- estatísticas ----------

const arred = (v) => Math.round(v * 1000) / 1000;

function estatisticas(rtts) {
  // Filtra ANTES do Number(): null (timeout), '' e booleanos virariam 0 ms e
  // puxariam o mínimo e a média para baixo.
  const v = (Array.isArray(rtts) ? rtts : [])
    .filter((x) => typeof x === 'number' || (typeof x === 'string' && x.trim() !== ''))
    .map(Number).filter((x) => Number.isFinite(x));
  if (!v.length) return { min: null, avg: null, max: null, mdev: null, jitter: null, mediana: null, p95: null };
  const n = v.length;
  const avg = v.reduce((s, x) => s + x, 0) / n;
  const ord = [...v].sort((a, b) => a - b);
  // Jitter como a RFC 3550 simplificada: média do |Δ| entre amostras
  // consecutivas, na ORDEM de chegada (não ordenado — a ordem é o que mede
  // variação). Com uma amostra só não há Δ: 0, não null.
  let somaDelta = 0;
  for (let i = 1; i < n; i++) somaDelta += Math.abs(v[i] - v[i - 1]);
  const mediana = n % 2 ? ord[(n - 1) / 2] : (ord[n / 2 - 1] + ord[n / 2]) / 2;
  return {
    min: arred(ord[0]),
    avg: arred(avg),
    max: arred(ord[n - 1]),
    mdev: arred(Math.sqrt(v.reduce((s, x) => s + (x - avg) ** 2, 0) / n)),
    jitter: arred(n > 1 ? somaDelta / (n - 1) : 0),
    mediana: arred(mediana),
    p95: arred(ord[Math.max(0, Math.ceil(0.95 * n) - 1)]), // nearest-rank
  };
}

// Uma linha para colar no chamado. Ponto decimal e "ms" de propósito: é o
// que o NOC do outro lado espera ler, independente do idioma do Windows.
function resumoTexto(resultado, rotuloProbe) {
  const r = resultado || {};
  const alvo = r.alvo || '?';
  const via = rotuloProbe ? ` via ${rotuloProbe}` : '';
  const inteiroOuZero = (x) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Math.max(0, Math.round(Number(x))) : 0);
  const recebidos = inteiroOuZero(r.recebidos);
  const enviados = Math.max(inteiroOuZero(r.enviados), recebidos);
  // Recalcula quando perdaPct não é número (NaN/'x' de um resultado montado à
  // mão) para a linha nunca sair com "perda NaN%".
  const perda = Number.isFinite(r.perdaPct) ? r.perdaPct : (enviados ? Math.round(((enviados - recebidos) / enviados) * 1000) / 10 : 0);
  const cabeca = `${alvo}${via}: ${recebidos}/${enviados}, perda ${perda}%`;
  const e = estatisticas(r.rtts);
  if (e.min == null) return `${cabeca}, sem resposta`;
  // toFixed(1) sozinho dá "0.9" para 0,95 (o float é 0,9499…); arredondar
  // antes devolve o "1.0" que a pessoa calcula à mão.
  const f = (x) => (Math.round(x * 10) / 10).toFixed(1);
  return `${cabeca}, min/avg/max ${f(e.min)}/${f(e.avg)}/${f(e.max)} ms, jitter ${f(e.jitter)} ms`;
}

module.exports = {
  comandoPing, validarAlvo, parsePing, estatisticas, resumoTexto,
  PLATAFORMAS, PADRAO, LIMITES,
  _detectar: detectar, _tempoRos: tempoRos, _normalizarOpcoes: normalizarOpcoes,
};
