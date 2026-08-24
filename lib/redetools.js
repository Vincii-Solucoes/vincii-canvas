'use strict';

// Ferramentas de rede de UMA consulta (não contínuas): DNS, checagem HTTP/TLS
// e varredura de portas. Tudo com módulos embutidos do Node (dns, net, tls,
// https) — zero dependência, zero módulo nativo.

const dns = require('dns');
const net = require('net');
const tls = require('tls');
const https = require('https');
const http = require('http');

// Alvo plausível, sem metacaractere. Vale para host/domínio.
function alvoValido(a) {
  return typeof a === 'string' && a.length > 0 && a.length <= 255 && /^[a-zA-Z0-9._:-]+$/.test(a) && !/^-/.test(a);
}

// ---------- DNS ----------

const TIPOS_DNS = ['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'SOA', 'PTR'];
// Resolvers públicos, para ver se a resposta é consistente (propagação).
const RESOLVERS = [
  { nome: 'Google', ip: '8.8.8.8' },
  { nome: 'Cloudflare', ip: '1.1.1.1' },
  { nome: 'Quad9', ip: '9.9.9.9' },
];

function achatarDns(tipo, resp) {
  if (!Array.isArray(resp)) return [];
  if (tipo === 'MX') return resp.map((r) => `${r.priority} ${r.exchange}`);
  if (tipo === 'TXT') return resp.map((r) => (Array.isArray(r) ? r.join('') : String(r)));
  if (tipo === 'SOA') return [`${resp.nsname} ${resp.hostmaster} serial ${resp.serial}`];
  return resp.map((r) => String(r));
}

async function umResolver(ip, host, tipo) {
  const r = new dns.promises.Resolver({ timeout: 4000, tries: 1 });
  r.setServers([ip]);
  try {
    const resp = tipo === 'PTR' ? await r.reverse(host) : await r.resolve(host, tipo);
    return { ok: true, respostas: achatarDns(tipo, resp) };
  } catch (e) {
    return { ok: false, erro: e.code || e.message };
  }
}

async function dnsLookup(host, tipoBruto) {
  const alvo = String(host || '').trim();
  if (!alvoValido(alvo)) return { erro: 'Host inválido.' };
  const tipo = TIPOS_DNS.includes(String(tipoBruto || '').toUpperCase()) ? String(tipoBruto).toUpperCase() : 'A';
  const t0 = Date.now();
  const porResolver = await Promise.all(RESOLVERS.map(async (r) => ({
    resolver: r.nome, ip: r.ip, ...(await umResolver(r.ip, alvo, tipo)),
  })));
  // resposta "consolidada": a do primeiro resolver que respondeu
  const primeira = porResolver.find((r) => r.ok);
  return {
    host: alvo, tipo, tempoMs: Date.now() - t0,
    respostas: primeira ? primeira.respostas : [],
    porResolver,
  };
}

// ---------- checagem HTTP/TLS ----------

function normalizarUrl(bruta) {
  let u = String(bruta || '').trim();
  if (!u) return null;
  // Só prefixa https quando NÃO há esquema nenhum. Um "ftp://..." mantém o
  // esquema (e é recusado abaixo); prefixar viraria um "https://ftp://…" válido.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
  try { const url = new URL(u); if (url.protocol !== 'http:' && url.protocol !== 'https:') return null; return url; }
  catch { return null; }
}

function httpCheck(urlBruta) {
  return new Promise((resolve) => {
    const url = normalizarUrl(urlBruta);
    if (!url) { resolve({ erro: 'URL inválida.' }); return; }
    const ehHttps = url.protocol === 'https:';
    const mod = ehHttps ? https : http;
    const t0 = Date.now();
    const opts = {
      method: 'GET', host: url.hostname, port: url.port || (ehHttps ? 443 : 80),
      path: url.pathname + url.search, timeout: 8000,
      headers: { 'User-Agent': 'VinciiCanvas (checagem)', Accept: '*/*' },
      rejectUnauthorized: false, // não recusa cert autoassinado: a checagem é informativa
      servername: net.isIP(url.hostname) ? undefined : url.hostname,
    };
    const req = mod.request(opts, (res) => {
      const tempoMs = Date.now() - t0;
      let tlsInfo = null;
      if (ehHttps && res.socket && res.socket.getPeerCertificate) {
        const c = res.socket.getPeerCertificate();
        if (c && c.valid_to) {
          const ate = new Date(c.valid_to);
          const dias = Math.round((ate.getTime() - Date.now()) / 86400000);
          tlsInfo = {
            emitidoPara: (c.subject && c.subject.CN) || url.hostname,
            emissor: (c.issuer && (c.issuer.O || c.issuer.CN)) || '—',
            validoDe: c.valid_from, validoAte: c.valid_to,
            diasParaExpirar: dias,
            protocolo: res.socket.getProtocol ? res.socket.getProtocol() : null,
            confiavel: res.socket.authorized === true,
          };
        }
      }
      res.resume(); // descarta o corpo
      resolve({
        url: url.href, status: res.statusCode, mensagem: res.statusMessage,
        tempoMs, servidor: res.headers.server || null,
        redirecionaPara: (res.statusCode >= 300 && res.statusCode < 400) ? (res.headers.location || null) : null,
        tls: tlsInfo,
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ url: url.href, erro: 'Tempo esgotado (8s).' }); });
    req.on('error', (e) => resolve({ url: url.href, erro: e.code || e.message }));
    req.end();
  });
}

// ---------- varredura de portas ----------

// Portas comuns, com rótulo do serviço.
const PORTAS_COMUNS = [
  [21, 'FTP'], [22, 'SSH'], [23, 'Telnet'], [25, 'SMTP'], [53, 'DNS'], [80, 'HTTP'],
  [110, 'POP3'], [143, 'IMAP'], [443, 'HTTPS'], [445, 'SMB'], [587, 'SMTP'], [993, 'IMAPS'],
  [995, 'POP3S'], [1433, 'MSSQL'], [1723, 'PPTP'], [3306, 'MySQL'], [3389, 'RDP'],
  [5432, 'PostgreSQL'], [5900, 'VNC'], [6379, 'Redis'], [8080, 'HTTP-alt'], [8443, 'HTTPS-alt'],
];
const SERVICO = new Map(PORTAS_COMUNS);
const MAX_PORTAS = 100;

// Traduz o código de erro do socket num estado honesto. EHOSTUNREACH numa
// rede local quase sempre é o macOS negando a permissão de "Rede Local"
// (Privacidade e Segurança) ao app — mascarar isso como timeout/filtrada
// esconderia a causa e faria a ferramenta parecer quebrada.
function estadoDeErro(code) {
  if (code === 'ECONNREFUSED') return 'fechada';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EHOSTDOWN'
    || code === 'ENETDOWN' || code === 'EACCES' || code === 'EPERM') return 'inacessivel';
  return null; // desconhecido: cada ferramenta escolhe o neutro dela
}

function sondarPorta(host, porta, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = new net.Socket();
    let resolvido = false;
    const fim = (estado) => { if (resolvido) return; resolvido = true; try { s.destroy(); } catch {} resolve({ porta, servico: SERVICO.get(porta) || null, estado, tempoMs: Date.now() - t0 }); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => fim('aberta'));
    s.once('timeout', () => fim('filtrada'));       // sem resposta: firewall ou host mudo
    s.once('error', (e) => fim(estadoDeErro(e.code) || 'filtrada'));
    try { s.connect(porta, host); } catch { fim('filtrada'); }
  });
}

async function portScan(host, portasBrutas) {
  const alvo = String(host || '').trim();
  if (!alvoValido(alvo)) return { erro: 'Host inválido.' };
  let portas;
  if (portasBrutas === 'comuns' || !portasBrutas) portas = PORTAS_COMUNS.map((p) => p[0]);
  else if (Array.isArray(portasBrutas)) portas = portasBrutas.map(Number).filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535);
  else return { erro: 'Lista de portas inválida.' };
  portas = [...new Set(portas)].slice(0, MAX_PORTAS);
  if (!portas.length) return { erro: 'Nenhuma porta válida.' };
  // concorrência limitada para não abrir centenas de sockets de uma vez
  const resultados = [];
  const LOTE = 12;
  for (let i = 0; i < portas.length; i += LOTE) {
    resultados.push(...await Promise.all(portas.slice(i, i + LOTE).map((p) => sondarPorta(alvo, p))));
  }
  resultados.sort((a, b) => a.porta - b.porta);
  return { host: alvo, portas: resultados, resumo: {
    abertas: resultados.filter((r) => r.estado === 'aberta').length,
    fechadas: resultados.filter((r) => r.estado === 'fechada').length,
    filtradas: resultados.filter((r) => r.estado === 'filtrada').length,
    inacessiveis: resultados.filter((r) => r.estado === 'inacessivel').length,
  } };
}

module.exports = {
  dnsLookup, httpCheck, portScan, estadoDeErro,
  TIPOS_DNS, PORTAS_COMUNS,
  _alvoValido: alvoValido, _normalizarUrl: normalizarUrl, _achatarDns: achatarDns, _sondarPorta: sondarPorta,
};
