'use strict';

// "Meu IP" — o IP público (v4 e v6), ASN/provedor/país, o PTR, as interfaces
// locais e o gateway padrão. Sem API web nenhuma: tudo sai do DNS, que é o que
// o app já usa (redetools). Cada dado vem de um truque conhecido:
//
//   - IP público: A/AAAA de myip.opendns.com perguntado DIRETO ao OpenDNS, que
//     responde com o endereço de quem perguntou. Confirmação/alternativa: TXT
//     de o-o.myaddr.l.google.com no ns1.google.com, que faz o mesmo.
//   - ASN, prefixo, país: TXT em origin.asn.cymru.com (octetos invertidos) e
//     origin6.asn.cymru.com (nibbles invertidos); nome do AS em ASnnn.asn.cymru.com.
//   - PTR: reverse normal.
//
// Funções puras (parsers e inversões) separadas do I/O; o resolver e o spawn
// são injetáveis para o teste não tocar a rede.

const dns = require('dns');
const os = require('os');
const { spawn: spawnPadrao } = require('child_process');

const TIMEOUT_MS = 4000;
const OPENDNS_V4 = '208.67.222.222';
const OPENDNS_V6 = '2620:119:35::35';
const GOOGLE_NS1 = '216.239.32.10';
const HOST_OPENDNS = 'myip.opendns.com';
const HOST_GOOGLE = 'o-o.myaddr.l.google.com';

// ---------- endereços ----------

function ehIPv4(s) {
  return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(String(s || ''))
    && String(s).split('.').every((o) => Number(o) <= 255);
}

// Expande um IPv6 (comprimido ou não) para os 32 nibbles hex, sem separador.
// Reimplementado aqui de propósito: lib/ não pode depender de public/subnet.js
// (aquele é script de navegador com uso duplo; este roda só no servidor).
// Aceita IPv4 embutido no fim (::ffff:1.2.3.4) porque o OpenDNS pode responder
// AAAA nessa forma quando a consulta v6 sai por um túnel/NAT64.
function expandirV6(ip) {
  const s = String(ip || '').trim().toLowerCase();
  if (!s.includes(':')) return null;
  if (s.split('::').length > 2) return null;
  const temComp = s.includes('::');
  const [cab, cauda] = temComp ? s.split('::') : [s, ''];
  const tok = (lado) => {
    if (lado === '') return [];
    const gs = lado.split(':');
    return gs.some((g) => g === '') ? null : gs;
  };
  const gc = tok(cab);
  const gt = tok(cauda);
  if (gc === null || gt === null) return null;
  // IPv4 embutido só vale como ÚLTIMO grupo de tudo (RFC 4291 §2.2). Com "::"
  // no fim ("1.2.3.4::") ele parece o último token mas os zeros vêm depois —
  // é lixo, não endereço.
  const todos = [...gc, ...gt];
  const idxV4 = todos.findIndex((g) => g.includes('.'));
  if (idxV4 !== -1 && (idxV4 !== todos.length - 1 || (temComp && !gt.length))) return null;
  const ultimo = gt.length ? gt : gc;
  if (ultimo.length && ultimo[ultimo.length - 1].includes('.')) {
    const v4 = ultimo.pop();
    if (!ehIPv4(v4)) return null;
    const o = v4.split('.').map(Number);
    ultimo.push(((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16));
  }
  const faltam = 8 - (gc.length + gt.length);
  if (temComp ? faltam < 1 : faltam !== 0) return null;
  const grupos = [...gc, ...Array(temComp ? faltam : 0).fill('0'), ...gt];
  if (!grupos.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return grupos.map((g) => g.padStart(4, '0')).join('');
}

function ehIPv6(s) { return expandirV6(s) !== null; }

// "Público" aqui é o que interessa mostrar como "meu IP na internet". Um
// resolver interceptado (captive portal, roteador que responde por todo
// mundo) pode devolver 192.168.x.x/100.64.x.x para myip.opendns.com; e o
// AAAA atrás de NAT64 vem como ::ffff:a.b.c.d. Nada disso é IP público.
function ehV4Publico(ip) {
  if (!ehIPv4(ip)) return false;
  const [a, b] = String(ip).split('.').map(Number);
  if (a === 10 || a === 127 || a === 0) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  return true;
}

function ehV6Publico(ip) {
  const h = expandirV6(ip);
  if (h === null) return false;
  if (h.startsWith('00000000000000000000ffff')) return false; // v4 mapeado
  if (/^0{31}[01]$/.test(h)) return false; // :: e ::1
  if (/^fe[89ab]/.test(h)) return false; // link-local
  if (/^f[cd]/.test(h)) return false; // ULA
  return true;
}

// 177.125.186.76 → 76.186.125.177 (a forma que o Cymru e o in-addr.arpa usam).
function reverterV4(ip) {
  if (!ehIPv4(ip)) return null;
  return String(ip).split('.').reverse().join('.');
}

// 2001:db8::1 → "1.0.0.0.…8.b.d.0.1.0.0.2": os 32 nibbles, um por rótulo, do
// menos para o mais significativo (ip6.arpa e origin6.asn.cymru.com).
function nibblesV6(ip) {
  const cheio = expandirV6(ip);
  if (cheio === null) return null;
  return cheio.split('').reverse().join('.');
}

// ---------- parsers de TXT ----------

// TXT chega do Node como [[pedaço, pedaço], …]; o app às vezes já passa a
// string pronta. Normaliza para UMA string sem as aspas que o dig imprime.
function textoTxt(txt) {
  let s = txt;
  if (Array.isArray(s)) s = s.length && Array.isArray(s[0]) ? s[0].join('') : s.join('');
  return String(s == null ? '' : s).trim().replace(/^"+|"+$/g, '').trim();
}

// "268323 | 177.125.184.0/22 | BR | lacnic | 2019-01-14"
// O Cymru pode listar MAIS de um ASN no primeiro campo ("6453 3491 | …") quando
// o prefixo é anunciado por vários; fica o primeiro em `asn` e todos em `asns`.
// O prefixo é validado de verdade (rede/tamanho) porque melhorOrigem ordena
// por ele — um "lixo | lixo | …" com 5 barras não pode virar registro.
function parseCymruOrigem(txt) {
  const s = textoTxt(txt);
  const p = s.split('|').map((x) => x.trim());
  if (p.length < 5 || !/^\d+(\s+\d+)*$/.test(p[0])) return null;
  const [rede, tam, sobra] = p[1].split('/');
  if (sobra !== undefined || !/^\d{1,3}$/.test(tam || '')) return null;
  const max = ehIPv4(rede) ? 32 : ehIPv6(rede) ? 128 : -1;
  if (Number(tam) > max) return null;
  const asns = p[0].split(/\s+/);
  return { asn: asns[0], asns, prefixo: p[1], pais: p[2], registro: p[3], data: p[4] };
}

// Vários TXT no origin (o IP cai em mais de um prefixo anunciado, ex.: /22 e
// /23 do mesmo AS): fica o MAIS específico, que é o que o BGP usa. Pura.
// Aceita a forma do resolveTxt ([[pedaços], …]), uma lista de strings ou
// uma string só.
function melhorOrigem(resposta) {
  const regs = Array.isArray(resposta) ? resposta : [resposta];
  const tam = (o) => Number(o.prefixo.split('/')[1]);
  return regs.map(parseCymruOrigem).filter(Boolean).sort((a, b) => tam(b) - tam(a))[0] || null;
}

// "268323 | BR | lacnic | 2019-01-14 | AZZA TELECOM SERVICOS EM TELECOMUNICACOES LTDA, BR"
// O nome vem com ", BR" colado no fim; tiro esse sufixo de país porque ele já
// está no campo próprio e só suja a exibição. AS sem cadastro no Cymru volta
// com os campos vazios ("268323 |  | lacnic |  |"): vazio vira null, não "".
function parseCymruAs(txt) {
  const s = textoTxt(txt);
  const p = s.split('|').map((x) => x.trim());
  if (p.length < 5 || !/^\d+$/.test(p[0])) return null;
  const nome = p.slice(4).join('|').replace(/,\s*[A-Z]{2}$/, '').trim();
  return { asn: p[0], pais: p[1] || null, registro: p[2] || null, data: p[3] || null, nome: nome || null };
}

// TXT de o-o.myaddr.l.google.com → "\"177.125.186.76\"" (v4 ou v6). Qualquer
// outra coisa (vazio, "edns0-client-subnet …" de resolver intermediário) → null.
function parseTxtGoogle(txt) {
  const s = textoTxt(txt);
  if (ehIPv4(s) || ehIPv6(s)) return s;
  return null;
}

// ---------- gateway padrão ----------

// Comando por SO. Pura.
function comandoGateway(plataforma) {
  const p = plataforma || process.platform;
  if (p === 'win32') return { cmd: 'route', args: ['print', '0.0.0.0'] };
  if (p === 'darwin') return { cmd: 'route', args: ['-n', 'get', 'default'] };
  return { cmd: 'ip', args: ['route', 'show', 'default'] };
}

// Extrai o IP do gateway do texto de cada comando. Pura.
// Windows: NÃO caso pelo cabeçalho ("Network Destination"/"Destino de rede"
// muda com o idioma), só pela linha numérica "0.0.0.0  0.0.0.0  <gw>". Um
// gateway "On-link"/"No vínculo" não é IP e cai no null.
// Os espaços são [ \t], nunca \s: com a flag m, "^\s*" engole as quebras de
// linha seguintes e recua uma a uma em CADA linha — O(n²), 26 s num texto de
// 200 mil linhas vazias.
function parseGateway(texto, plataforma) {
  const t = String(texto || '');
  const p = plataforma || process.platform;
  let m = null;
  if (p === 'win32') m = /^[ \t]*0\.0\.0\.0[ \t]+0\.0\.0\.0[ \t]+(\S+)/m.exec(t);
  else if (p === 'darwin') m = /^[ \t]*gateway:[ \t]*(\S+)/m.exec(t);
  else m = /^[ \t]*default[ \t]+via[ \t]+(\S+)/m.exec(t);
  if (!m) return null;
  // macOS com gateway em link-local v6 imprime "fe80::1%en0"; o sufixo de zona
  // não é parte do endereço.
  const ip = m[1].replace(/%.*$/, '');
  return ehIPv4(ip) || ehIPv6(ip) ? ip : null;
}

// Roda o comando de rota e devolve o texto. Nunca lança: erro vira ''.
// No prazo, mata E resolve com o que já veio — não dá para contar com o
// 'close' de um processo que travou (route no Windows com adaptador zumbi).
function lerRota(plataforma, spawn) {
  return new Promise((resolve) => {
    const { cmd, args } = comandoGateway(plataforma);
    let saida = '';
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); }
    catch { resolve(''); return; }
    if (!child || typeof child.on !== 'function') { resolve(''); return; }
    const matar = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(saida); }, TIMEOUT_MS);
    if (matar.unref) matar.unref();
    if (child.stdout) child.stdout.on('data', (d) => { saida += d; });
    if (child.stderr) child.stderr.on('data', (d) => { saida += d; });
    child.on('error', () => { clearTimeout(matar); resolve(saida); });
    child.on('close', () => { clearTimeout(matar); resolve(saida); });
  });
}

// ---------- interfaces locais ----------

// Sem loopback. `family` foi número (4/6) numa janela do Node 18 e string nas
// outras — normalizo para não depender da versão embutida no Electron.
function listarInterfaces(tabela) {
  const t = tabela || os.networkInterfaces();
  const lista = [];
  for (const [nome, ends] of Object.entries(t || {})) {
    for (const e of Array.isArray(ends) ? ends : []) {
      if (!e || typeof e !== 'object' || e.internal) continue;
      const familia = String(e.family).includes('6') ? 'IPv6' : 'IPv4';
      lista.push({ nome, ip: e.address, familia, cidr: e.cidr || null, mac: e.mac || null });
    }
  }
  return lista;
}

// ---------- descoberta ----------

// Resolver padrão: um por consulta, com prazo curto e UMA tentativa — o
// c-ares reenvia sozinho e a espera somaria. Sem `servidores`, usa os do SO
// (é o que serve para Cymru e para o PTR).
function resolverPadrao(servidores) {
  const r = new dns.promises.Resolver({ timeout: TIMEOUT_MS, tries: 1 });
  if (servidores && servidores.length) r.setServers(servidores);
  return r;
}

// Prazo por cima do resolver: o timeout do c-ares cobre a espera da resposta,
// mas não um socket v6 que trava antes de mandar nada.
function comPrazo(promessa, ms) {
  let timer;
  const prazo = new Promise((_, rej) => {
    timer = setTimeout(() => rej(Object.assign(new Error('prazo esgotado'), { code: 'ETIMEOUT' })), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promessa, prazo]).finally(() => clearTimeout(timer));
}

function motivo(e) { return (e && (e.code || e.message)) || 'erro'; }

// Chama o resolver dentro de uma Promise para que um throw SÍNCRONO (resolver
// injetado quebrado, setServers recusando o endereço) vire rejeição e caia no
// mesmo catch/aviso que um erro de rede — e não derrube o Promise.all.
function consultar(fn) {
  return comPrazo(new Promise((res) => res(fn())), TIMEOUT_MS);
}

// NXDOMAIN no Cymru é resposta, não falha: o IP não está em nenhum prefixo
// anunciado no BGP (bogon, CGNAT vazando, alocação nova).
const SEM_REGISTRO = ['ENOTFOUND', 'ENODATA'];

// O nome do AS pelo whois do registro (TCP 43), quando o Cymru não o tem — e
// para muita operadora brasileira ele não tem: o TXT de AS268323 vem
// "268323 |  | lacnic |  |". O whois do LACNIC responde "owner: AZZA TELECOM…".
// É o protocolo clássico, sem API web. Cada registro escreve o nome num campo
// diferente; a lista abaixo é o que cada um usa.
const WHOIS_POR_REGISTRO = {
  lacnic: { host: 'whois.lacnic.net', campos: ['owner', 'aut-num-name', 'as-name', 'descr'] },
  arin: { host: 'whois.arin.net', campos: ['ASName', 'OrgName'] },
  ripencc: { host: 'whois.ripe.net', campos: ['as-name', 'descr', 'org-name'] },
  apnic: { host: 'whois.apnic.net', campos: ['as-name', 'descr'] },
  afrinic: { host: 'whois.afrinic.net', campos: ['as-name', 'descr'] },
};

function parseWhoisNomeAs(texto, campos) {
  const linhas = String(texto || '').split(/\r?\n/);
  for (const campo of campos) {
    const re = new RegExp('^' + campo.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + ':[ \t]*(.+?)[ \t]*$', 'im');
    for (const l of linhas) {
      const m = re.exec(l);
      if (m && m[1] && !/^(AS)?\d+$/.test(m[1])) return m[1].trim().slice(0, 120);
    }
  }
  return null;
}

function whoisTcp(host, consulta, { timeoutMs = 5000, net = require('net') } = {}) {
  return new Promise((resolve, reject) => {
    let dados = '';
    const sock = net.connect({ host, port: 43 });
    const morrer = (e) => { try { sock.destroy(); } catch {} reject(e); };
    sock.setTimeout(timeoutMs, () => morrer(new Error('tempo esgotado')));
    sock.on('connect', () => sock.write(consulta + '\r\n'));
    sock.on('data', (d) => { if (dados.length < 64 * 1024) dados += d.toString('utf8'); });
    sock.on('error', morrer);
    sock.on('end', () => resolve(dados));
    sock.on('close', () => resolve(dados));
  });
}

async function nomeDoAsPorWhois(asn, registro, whois = whoisTcp) {
  const cfg = WHOIS_POR_REGISTRO[String(registro || '').toLowerCase()];
  if (!cfg) return null;
  const texto = await whois(cfg.host, `AS${asn}`);
  return parseWhoisNomeAs(texto, cfg.campos);
}

// O titular do BLOCO, pelo whois do IP — responde onde a consulta por ASN não
// responde (o registro.br, para onde o LACNIC encaminha o Brasil, não casa
// "AS268323"). É outra informação: quem detém o bloco pode não ser quem o
// anuncia — por isso vai num campo próprio, não no lugar do provedor.
const CAMPOS_TITULAR = ['owner', 'OrgName', 'org-name', 'netname', 'descr'];
async function titularDoBlocoPorWhois(ip, registro, whois = whoisTcp) {
  const cfg = WHOIS_POR_REGISTRO[String(registro || '').toLowerCase()];
  if (!cfg) return null;
  const texto = await whois(cfg.host, ip);
  return parseWhoisNomeAs(texto, CAMPOS_TITULAR);
}

// ASN + provedor + PTR de UM endereço, cada consulta isolada: o Cymru fora do
// ar não tira o PTR, e vice-versa. Falhas viram avisos.
async function enriquecer(ip, versao, resolver, avisos, whois) {
  const rot = `IPv${versao}`;
  const info = { ip, ptr: null, asn: null, prefixo: null, provedor: null, titular: null, pais: null };
  let r;
  try { r = resolver(null); } catch (e) { avisos.push(`Detalhes do ${rot} não consultados (${motivo(e)}).`); return info; }
  const nomeOrigem = versao === 4
    ? `${reverterV4(ip)}.origin.asn.cymru.com`
    : `${nibblesV6(ip)}.origin6.asn.cymru.com`;
  await Promise.all([
    consultar(() => r.reverse(ip))
      .then((nomes) => { info.ptr = (Array.isArray(nomes) && nomes[0]) || null; })
      .catch((e) => { if (!SEM_REGISTRO.includes(motivo(e))) avisos.push(`PTR do ${rot} não consultado (${motivo(e)}).`); }),
    consultar(() => r.resolveTxt(nomeOrigem))
      .then(async (txt) => {
        const o = melhorOrigem(txt);
        if (!o) { avisos.push(`Resposta do Cymru para o ${rot} veio em formato inesperado.`); return; }
        info.asn = o.asn; info.prefixo = o.prefixo; info.pais = o.pais;
        try {
          const nome = parseCymruAs(await consultar(() => r.resolveTxt(`AS${o.asn}.asn.cymru.com`)));
          if (nome) info.provedor = nome.nome;
          else avisos.push(`Nome do AS${o.asn} veio em formato inesperado.`);
          if (nome && !nome.nome) {
            // Cymru sem nome: pergunta ao registro pelo whois clássico — pelo
            // ASN e, se não casar, pelo IP (titular do bloco).
            const reg = o.registro || nome.registro;
            try {
              const doWhois = await nomeDoAsPorWhois(o.asn, reg, whois);
              if (doWhois) info.provedor = doWhois;
            } catch (e) { avisos.push(`Whois do registro não respondeu pelo AS${o.asn} (${motivo(e)}).`); }
            if (!info.provedor) {
              try { info.titular = await titularDoBlocoPorWhois(ip, reg, whois); }
              catch (e) { avisos.push(`Whois do registro não respondeu pelo IP (${motivo(e)}).`); }
              if (!info.titular) avisos.push(`AS${o.asn} sem nome no Cymru nem no whois do registro.`);
            }
          }
        } catch (e) { avisos.push(`Nome do AS${o.asn} não consultado (${motivo(e)}).`); }
      })
      .catch((e) => {
        if (SEM_REGISTRO.includes(motivo(e))) avisos.push(`${rot} sem registro de origem no Cymru (não está em nenhum prefixo anunciado no BGP).`);
        else avisos.push(`ASN/provedor do ${rot} não consultado — Cymru sem resposta (${motivo(e)}).`);
      }),
  ]);
  return info;
}

// IPv4 público: OpenDNS primeiro; se falhar, o TXT do Google confirma/supre.
async function ipPublicoV4(resolver, avisos) {
  try {
    const a = await consultar(() => resolver([OPENDNS_V4]).resolve4(HOST_OPENDNS));
    const ip = Array.isArray(a) ? a[0] : null;
    if (ehV4Publico(ip)) return ip;
    avisos.push(ehIPv4(ip)
      ? `OpenDNS respondeu um endereço privado (${ip}) — algum resolver no caminho intercepta o DNS.`
      : 'OpenDNS respondeu sem endereço IPv4.');
  } catch (e) { avisos.push(`OpenDNS não respondeu ao IPv4 (${motivo(e)}).`); }
  try {
    const ip = parseTxtGoogle(await consultar(() => resolver([GOOGLE_NS1]).resolveTxt(HOST_GOOGLE)));
    if (ehV4Publico(ip)) return ip;
    avisos.push('Google respondeu sem endereço IPv4.');
  } catch (e) { avisos.push(`Google não respondeu ao IPv4 (${motivo(e)}).`); }
  return null;
}

// IPv6 público: pergunta ao OpenDNS pelo endereço v6 dele. Sem rota v6 na
// máquina, o socket nem sai (ENETUNREACH; no macOS o c-ares reporta
// ECONNREFUSED) ou morre no prazo — isso não é erro, é "não tem IPv6 público".
async function ipPublicoV6(resolver, avisos) {
  try {
    const a = await consultar(() => resolver([OPENDNS_V6]).resolve6(HOST_OPENDNS));
    const ip = Array.isArray(a) ? a[0] : null;
    if (ehV6Publico(ip)) return ip;
    if (ehIPv6(ip)) avisos.push(`OpenDNS respondeu um IPv6 não roteável (${ip}) — NAT64 ou resolver interceptado.`);
  } catch (e) {
    const c = motivo(e);
    if (!['ENETUNREACH', 'ECONNREFUSED', 'ETIMEOUT', 'EHOSTUNREACH', 'EADDRNOTAVAIL'].includes(c)) {
      avisos.push(`Consulta IPv6 ao OpenDNS falhou (${c}).`);
    }
  }
  avisos.push('Sem IPv6 público (a máquina não tem rota IPv6 ou o OpenDNS não respondeu).');
  return null;
}

// Contrato: NUNCA lança. Cada etapa já engole a própria falha; o try de fora é
// a rede de segurança para o que ninguém previu (opção injetada malformada).
async function descobrir(opts) {
  const o = opts || {};
  const avisos = [];
  const res = { ipv4: null, ipv6: null, interfaces: [], gateway: null, avisos };
  try {
    const resolver = typeof o.resolver === 'function' ? o.resolver : resolverPadrao;
    const spawn = typeof o.spawn === 'function' ? o.spawn : spawnPadrao;
    const plataforma = o.plataforma || process.platform;

    const [v4, v6, rota] = await Promise.all([
      ipPublicoV4(resolver, avisos),
      ipPublicoV6(resolver, avisos),
      lerRota(plataforma, spawn),
    ]);
    [res.ipv4, res.ipv6] = await Promise.all([
      v4 ? enriquecer(v4, 4, resolver, avisos, o.whois) : null,
      v6 ? enriquecer(v6, 6, resolver, avisos, o.whois) : null,
    ]);
    res.gateway = parseGateway(rota, plataforma);
    if (!res.gateway) avisos.push('Gateway padrão não encontrado (sem rota padrão ou comando de rota indisponível).');

    try { res.interfaces = listarInterfaces(o.interfaces); }
    catch (e) { avisos.push(`Interfaces locais não listadas (${motivo(e)}).`); }
  } catch (e) {
    avisos.push(`Descoberta interrompida por erro inesperado (${motivo(e)}).`);
  }
  return res;
}

// ---------- resumo para copiar ----------

function resumoTexto(res) {
  const r = res || {};
  const linhas = [];
  const bloco = (rot, info) => {
    if (!info || !info.ip) { linhas.push(`${rot}: nenhum`); return; }
    linhas.push(`${rot}: ${info.ip}`);
    if (info.ptr) linhas.push(`  PTR: ${info.ptr}`);
    if (info.asn) linhas.push(`  ASN: AS${info.asn}${info.provedor ? ` — ${info.provedor}` : ''}${info.pais ? ` (${info.pais})` : ''}`);
    if (info.prefixo) linhas.push(`  Prefixo: ${info.prefixo}`);
  };
  bloco('IPv4 público', r.ipv4);
  bloco('IPv6 público', r.ipv6);
  linhas.push(`Gateway padrão: ${r.gateway || 'não encontrado'}`);
  const ifs = (Array.isArray(r.interfaces) ? r.interfaces : []).filter((i) => i && typeof i === 'object');
  linhas.push(`Interfaces locais: ${ifs.length ? '' : 'nenhuma'}`.trimEnd());
  for (const i of ifs) linhas.push(`  ${i.nome}  ${i.cidr || i.ip}  ${i.familia}${i.mac ? `  ${i.mac}` : ''}`);
  const avisos = (Array.isArray(r.avisos) ? r.avisos : []).filter((a) => a != null && a !== '');
  if (avisos.length) {
    linhas.push('Avisos:');
    for (const a of avisos) linhas.push(`  - ${a}`);
  }
  return linhas.join('\n');
}

module.exports = {
  descobrir, resumoTexto,
  reverterV4, nibblesV6, expandirV6, parseCymruOrigem, melhorOrigem, parseCymruAs, parseGateway, parseTxtGoogle,
  comandoGateway, listarInterfaces, parseWhoisNomeAs, nomeDoAsPorWhois, titularDoBlocoPorWhois, WHOIS_POR_REGISTRO,
  TIMEOUT_MS, OPENDNS_V4, OPENDNS_V6, GOOGLE_NS1, HOST_OPENDNS, HOST_GOOGLE,
};
