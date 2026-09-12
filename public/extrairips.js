'use strict';

// Extrator de IPs — cola-se log, config, saída de traceroute/netstat, e sai a
// lista de endereços (IPv4, IPv6, CIDR e faixas "a-b") sem repetição, ordenada
// e com contagem. Puro e offline: nada sai do navegador. Uso duplo (navegador
// via <script> e Node via require), como subnet.js.
//
// Como acha os endereços: duas varreduras com regex GLOBAL, cada uma linear no
// tamanho do texto (o site de referência aceita 50 MB, então nada aqui pode
// ter backtracking que cresça com a entrada):
//   1. candidatos a IPv6 — qualquer trecho de [hex : .] delimitado por
//      não-alfanumérico. A regex é frouxa de propósito e o parser de verdade
//      (v6ParaBig) é quem decide. O que valida é apagado do texto (troca por
//      espaços) para a 2ª varredura não achar o IPv4 embutido de ::ffff:1.2.3.4.
//   2. IPv4 — só casa quando DELIMITADO por não-dígito/não-ponto dos dois
//      lados. Isso descarta "1.2.3.4.5" (versão) e "10.0.0.1.5" inteiros, sem
//      tentar adivinhar qual pedaço seria o IP. Consequência documentada: o
//      netstat do macOS escreve "127.0.0.1.63148" (porta com ponto) e esses
//      NÃO são extraídos — em vez disso entra um aviso. Já "v1.2.3.4" (versão
//      com 4 números) é indistinguível de um IP e sai como IP.
//
// Regras que não são óbvias:
//   - MAC (aa:bb:cc:dd:ee:ff) e hora (12:30:45) são candidatos a IPv6 que o
//     parser recusa: 6 e 3 grupos sem "::". Já "00:11:22:33:44:55:66:77" (8
//     grupos) É um IPv6 bem formado e sai como tal — não há como distinguir.
//   - Tudo vira forma canônica antes de contar: IPv4 sem zeros à esquerda,
//     IPv6 minúsculo e comprimido (RFC 5952), zona (%en0) fora. Assim
//     "FE80::1%en0" e "fe80:0:0:0:0:0:0:1" são o MESMO endereço, contado 2x.
//   - "::" sozinho é ignorado (aparece em código, não é endereço colado), mas
//     "::/0" (rota padrão) e "[::]:80" (ss, nginx: colchete é sinal claro de
//     endereço) ficam.
//   - netstat do Linux escreve IPv6+porta SEM colchete (":::22", "::1:631").
//     ":::22" não é endereço e cai fora; "::1:631" É um endereço válido
//     (::1:631) e sai assim — não há como distinguir. Use `ss`, que põe
//     colchete.
//   - CIDR com prefixo fora da faixa (/33, /129) vira aviso e só o endereço
//     entra. Faixa "a-b" invertida vira aviso e as duas pontas entram soltas.
//   - As pontas de uma faixa e o endereço de um CIDR NÃO se repetem em ipv4/
//     ipv6: entram só em `faixas`.
//
// Tudo dentro de uma IIFE: scripts clássicos dividem o escopo global da
// página, e um `const` repetido mata o arquivo inteiro com SyntaxError.
(function () {

const MAX_AVISOS = 50;
// O aviso do netstat repete o primeiro trecho ignorado; num texto grande esse
// trecho pode ter 100 KB ("1.1.1.1.1…" colado), então corta.
const MAX_EXEMPLO_AVISO = 48;

// ---------- IPv4 ----------

// "a.b.c.d" → inteiro sem sinal de 32 bits, ou null. Aceita zeros à esquerda
// ("001") como decimal, que é o que syslog do Windows e alguns roteadores
// escrevem; ninguém cola IP em octal.
function v4ParaNum(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i += 1) {
    const o = Number(m[i]);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n >>> 0;
}
function numParaV4(n) {
  n = n >>> 0;
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

// ---------- IPv6 ----------

// Expande para BigInt de 128 bits ou devolve null. Mesmo rigor do subnet.js:
// grupo vazio só vale na fronteira do "::", um "::" no máximo, IPv4 embutido só
// nos 32 bits FINAIS (RFC 4291 §2.2). Sem esse rigor, "12:30:45" e MACs
// passariam como se fossem endereços.
function v6ParaBig(s) {
  if (typeof s !== 'string' || !s.includes(':')) return null;
  const temComp = s.includes('::');
  if (temComp && s.split('::').length > 2) return null;
  const [cabecaStr, caudaStr] = temComp ? s.split('::') : [s, ''];
  const tok = (lado) => {
    if (lado === '') return [];
    const gs = lado.split(':');
    return gs.some((g) => g === '') ? null : gs;
  };
  let gc = tok(cabecaStr);
  let gt = tok(caudaStr);
  if (gc === null || gt === null) return null;
  const temPonto = (g) => g.includes('.');
  if (temComp) {
    if (gc.some(temPonto)) return null;
    if (gt.some((g, i) => temPonto(g) && i !== gt.length - 1)) return null;
  } else if (gc.some((g, i) => temPonto(g) && i !== gc.length - 1)) {
    return null;
  }
  const expandir = (arr) => {
    if (!arr.length || !arr[arr.length - 1].includes('.')) return arr;
    const v4 = v4ParaNum(arr[arr.length - 1]);
    if (v4 === null) return null;
    return [...arr.slice(0, -1), (v4 >>> 16).toString(16), (v4 & 0xffff).toString(16)];
  };
  if (gt.length) { gt = expandir(gt); if (gt === null) return null; }
  else { gc = expandir(gc); if (gc === null) return null; }
  const faltam = 8 - (gc.length + gt.length);
  if (temComp) { if (faltam < 1) return null; } else if (faltam !== 0) return null;
  const grupos = [...gc, ...Array(temComp ? faltam : 0).fill('0'), ...gt];
  let n = 0n;
  for (const g of grupos) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) + BigInt(parseInt(g, 16));
  }
  return n;
}

// IPv4-mapeado (::ffff:0:0/96) é o mesmo IPv4 visto pela pilha dupla — ninguém
// reconhece "::ffff:c0a8:101"; a forma pontuada é a recomendada (RFC 5952 §5).
function ehMapeado(n) { return (n >> 32n) === 0xffffn; }

// Forma canônica RFC 5952: minúsculo, sem zeros à esquerda, "::" na MAIOR
// sequência de zeros (a primeira, em empate), nunca em um grupo só.
function bigParaV6(n) {
  if (typeof n !== 'bigint' || n < 0n || n >> 128n) return null;
  if (ehMapeado(n)) return `::ffff:${numParaV4(Number(n & 0xffffffffn))}`;
  const grupos = [];
  for (let i = 0; i < 8; i += 1) { grupos.unshift((n & 0xffffn).toString(16)); n >>= 16n; }
  let melhorIni = -1; let melhorLen = 0; let ini = -1; let len = 0;
  for (let i = 0; i < 8; i += 1) {
    if (grupos[i] === '0') {
      if (ini < 0) ini = i;
      len += 1;
      if (len > melhorLen) { melhorLen = len; melhorIni = ini; }
    } else { ini = -1; len = 0; }
  }
  if (melhorLen < 2) return grupos.join(':');
  return `${grupos.slice(0, melhorIni).join(':')}::${grupos.slice(melhorIni + melhorLen).join(':')}`;
}

// ---------- classificação ----------

function classeV4(n) {
  const a = n >>> 24; const b = (n >>> 16) & 255; const c = (n >>> 8) & 255;
  if (a === 0) return 'reservado';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'privado';
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link-local';
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return 'documentacao';
  if (a >= 224 && a <= 239) return 'multicast';
  // 240/4 (inclui 255.255.255.255), 198.18/15 (benchmark), 192.0.0/24 (IETF)
  if (a >= 240 || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0 && c === 0)) return 'reservado';
  return 'publico';
}
function classeV6(n) {
  if (n === 0n) return 'reservado';
  if (n === 1n) return 'loopback';
  // O mapeado herda a classe do IPv4 de dentro: ::ffff:10.0.0.1 é privado.
  if (ehMapeado(n)) return classeV4(Number(n & 0xffffffffn));
  const alto = Number(n >> 112n);
  if ((alto & 0xfe00) === 0xfc00) return 'privado';      // ULA fc00::/7
  if ((alto & 0xffc0) === 0xfe80) return 'link-local';   // fe80::/10
  if ((alto & 0xff00) === 0xff00) return 'multicast';    // ff00::/8
  if ((n >> 96n) === 0x20010db8n) return 'documentacao'; // 2001:db8::/32
  if ((alto & 0xfff0) === 0x3ff0) return 'documentacao'; // 3fff::/20 (RFC 9637)
  return 'publico';
}

// Aceita IP puro, CIDR, faixa "a-b" (classifica a ponta inicial), zona e
// colchetes — o que o usuário vê na lista e clica.
function classificar(ip) {
  let s = String(ip == null ? '' : ip).trim();
  // "[x]:porta" primeiro, senão a porta sobra grudada ("2001:db8::1]:443").
  const colch = /^\[([^\]]*)\](?::\d{1,5})?$/.exec(s);
  if (colch) s = colch[1];
  s = s.replace(/%[^/]*/, '').replace(/\/\d+$/, '').replace(/-.*$/, '');
  if (!s) return 'invalido';
  // Um ":" só, depois de 4 números com ponto, é porta de IPv4 ("10.0.0.1:22").
  // Com dois ou mais é IPv6 e o ":" faz parte do endereço.
  s = s.replace(/^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/, '$1');
  if (s.includes(':')) {
    const n = v6ParaBig(s);
    return n === null ? 'invalido' : classeV6(n);
  }
  const n = v4ParaNum(s);
  return n === null ? 'invalido' : classeV4(n);
}

// ---------- extração ----------

// Candidato a IPv6: trecho de [hex : .] não colado a letra/dígito à esquerda
// — sem isso, "IPv6:2001:db8::1" começaria no "6" e sairia "6:2001:db8::1",
// que é um endereço válido e errado. Duas formas: entre colchetes (com porta
// opcional, "[2001:db8::1]:443") ou solto, com zona (%en0) e prefixo (/64)
// opcionais. A zona vem ANTES do prefixo porque é assim que o netstat do macOS
// escreve ("fe80::%lo0/64"). Cada parte opcional é tentada uma vez só.
const RE_V6 = /(?<![A-Za-z0-9])(?:\[([0-9a-fA-F:.]+)(?:%[A-Za-z0-9_.\-]+)?\](?::\d{1,5})?|([0-9a-fA-F:.]+)(?:%[A-Za-z0-9_.\-]+)?(?:\/(\d{1,3})(?!\d))?)/g;

// IPv4 delimitado: nem dígito nem "dígito." antes, nem dígito nem ".dígito"
// depois — o ponto final de frase ("... em 10.0.0.1.") continua valendo.
// Depois do endereço, no máximo UMA destas: porta ":443", prefixo "/24" ou
// fim de faixa "-10.0.0.50" (também delimitado).
const RE_V4 = /(?<!\d\.?)(\d{1,3}(?:\.\d{1,3}){3})(?!\.?\d)(?::(\d{1,5})(?!\d)|\/(\d{1,3})(?!\d)|-(\d{1,3}(?:\.\d{1,3}){3})(?!\.?\d))?/g;

// O que a regra de delimitação deixa passar de propósito, para o aviso.
const RE_V4_COLADO = /(?<![\d.])\d+(?:\.\d+){4,}(?![\d.])/g;

// A regex frouxa deixa entrar ponto/dois-pontos de pontuação no fim
// ("2001:db8::1.", "fe80::1:"). Tenta como veio, sem os pontos do fim, e sem
// pontuação nenhuma no fim — nessa ordem, porque "2001:db8::" é válido como
// veio e perderia o "::" na última tentativa.
function analisarV6Solto(cand) {
  const tentativas = [cand, cand.replace(/\.+$/, ''), cand.replace(/[.:]+$/, '')];
  for (const t of tentativas) {
    if (t === '') continue;
    const n = v6ParaBig(t);
    if (n !== null) return n;
  }
  return null;
}

function extrair(texto, opcoes) {
  const { incluirPrivados = true, incluirFaixas = true } = opcoes || {};
  const fonte = String(texto == null ? '' : texto);

  // forma canônica → { endereco, tipo, versao, inicio, fim, ref, n }. inicio/
  // fim ordenam (no CIDR é a rede); ref é o endereço ESCRITO, que dá a classe —
  // "172.16.0.1/8" é privado como classificar() diz, não "publico" pela rede
  // 172.0.0.0.
  const itens = new Map();
  const avisos = new Map(); // texto do aviso → vezes
  const avisar = (msg) => avisos.set(msg, (avisos.get(msg) || 0) + 1);
  const registrar = (endereco, tipo, versao, inicio, fim, ref) => {
    const it = itens.get(endereco);
    if (it) { it.n += 1; return; }
    itens.set(endereco, { endereco, tipo, versao, inicio, fim, ref: ref === undefined ? inicio : ref, n: 1 });
  };
  const registrarCidr = (endereco, versao, inicio, prefixo, bits) => {
    if (!incluirFaixas) { registrar(endereco, versao === 4 ? 'ipv4' : 'ipv6', versao, inicio, inicio); return; }
    const tam = 1n << BigInt(bits - prefixo);
    const rede = inicio - (inicio % tam);
    registrar(`${endereco}/${prefixo}`, 'cidr', versao, rede, rede + tam - 1n, inicio);
  };

  // 1ª varredura: IPv6. O que validar some do texto para a 2ª não ver o IPv4
  // embutido; o que não validar fica como está (pode ser "src:10.0.0.1").
  const semV6 = fonte.replace(RE_V6, (m, colch, solto, prefixoStr) => {
    const cand = colch !== undefined ? colch : solto;
    if (!cand.includes(':')) return m;
    let n = colch !== undefined ? v6ParaBig(cand) : analisarV6Solto(cand);
    if (n === null) return m;
    // "::" solto é código (std::x); entre colchetes ou com prefixo é endereço.
    if (n === 0n && prefixoStr === undefined && colch === undefined) return m;
    const canon = bigParaV6(n);
    if (prefixoStr !== undefined) {
      const prefixo = Number(prefixoStr);
      if (prefixo > 128) {
        avisar(`Prefixo IPv6 fora de 0–128, ficou só o endereço: ${canon}/${prefixoStr}`);
        registrar(canon, 'ipv6', 6, n, n);
      } else registrarCidr(canon, 6, n, prefixo, 128);
    } else registrar(canon, 'ipv6', 6, n, n);
    return ' '.repeat(m.length);
  });

  // 2ª varredura: IPv4 (com porta, CIDR ou faixa).
  let m;
  RE_V4.lastIndex = 0;
  while ((m = RE_V4.exec(semV6)) !== null) {
    const ini = v4ParaNum(m[1]);
    if (ini === null) continue; // octeto > 255 (300.1.1.1)
    const canon = numParaV4(ini);
    const big = BigInt(ini);
    if (m[3] !== undefined) {
      const prefixo = Number(m[3]);
      if (prefixo > 32) {
        avisar(`Prefixo IPv4 fora de 0–32, ficou só o endereço: ${canon}/${m[3]}`);
        registrar(canon, 'ipv4', 4, big, big);
      } else registrarCidr(canon, 4, big, prefixo, 32);
    } else if (m[4] !== undefined) {
      const fim = v4ParaNum(m[4]);
      if (fim === null) {
        avisar(`Fim de faixa inválido, ficou só o início: ${canon}-${m[4]}`);
        registrar(canon, 'ipv4', 4, big, big);
      } else if (fim < ini) {
        avisar(`Faixa invertida (fim antes do início), entraram as duas pontas soltas: ${canon}-${numParaV4(fim)}`);
        registrar(canon, 'ipv4', 4, big, big);
        registrar(numParaV4(fim), 'ipv4', 4, BigInt(fim), BigInt(fim));
      } else if (!incluirFaixas) {
        registrar(canon, 'ipv4', 4, big, big);
        registrar(numParaV4(fim), 'ipv4', 4, BigInt(fim), BigInt(fim));
      } else registrar(`${canon}-${numParaV4(fim)}`, 'faixa', 4, big, BigInt(fim));
    } else registrar(canon, 'ipv4', 4, big, big);
  }

  // O que a regra de delimitação recusou de propósito — o usuário precisa
  // saber que "127.0.0.1.63148" do netstat não é um IP quebrado do extrator.
  RE_V4_COLADO.lastIndex = 0;
  let colados = 0; let exemploColado = '';
  while ((m = RE_V4_COLADO.exec(semV6)) !== null) { colados += 1; if (!exemploColado) exemploColado = m[0]; }
  if (colados) {
    if (exemploColado.length > MAX_EXEMPLO_AVISO) exemploColado = `${exemploColado.slice(0, MAX_EXEMPLO_AVISO)}…`;
    avisar(`${colados} trecho(s) com 5+ números separados por ponto ignorado(s), ex.: ${exemploColado} — `
      + 'ambíguo (netstat do macOS escreve IP.porta; versões usam 4+ pontos). Separe a porta com ":" se quiser extrair.');
  }

  // Classe e filtro de privados. A classe de CIDR/faixa é a da ponta inicial.
  const classes = {};
  for (const it of itens.values()) {
    it.classe = it.versao === 4 ? classeV4(Number(it.ref)) : classeV6(it.ref);
  }
  const lista = [...itens.values()].filter((it) => incluirPrivados || it.classe === 'publico');

  // Ordem natural: v4 antes de v6, numérica (10.0.0.9 antes de 10.0.0.10),
  // faixas pela ponta inicial e a maior primeiro em empate (10/8 antes de
  // 10.0.0.0/24).
  const cmp = (a, b) => {
    if (a.versao !== b.versao) return a.versao - b.versao;
    if (a.inicio !== b.inicio) return a.inicio < b.inicio ? -1 : 1;
    if (a.fim !== b.fim) return a.fim > b.fim ? -1 : 1;
    return 0;
  };
  lista.sort(cmp);

  const ipv4 = []; const ipv6 = []; const faixas = []; const ocorrencias = {};
  let totalOcorrencias = 0;
  for (const it of lista) {
    (it.tipo === 'ipv4' ? ipv4 : it.tipo === 'ipv6' ? ipv6 : faixas).push(it.endereco);
    ocorrencias[it.endereco] = it.n;
    classes[it.endereco] = it.classe;
    totalOcorrencias += it.n;
  }

  const listaAvisos = [...avisos.keys()];
  const avisosFinais = listaAvisos.slice(0, MAX_AVISOS);
  if (listaAvisos.length > MAX_AVISOS) avisosFinais.push(`…e mais ${listaAvisos.length - MAX_AVISOS} aviso(s).`);

  return {
    ipv4, ipv6, faixas, classes, ocorrencias,
    total: lista.length, totalOcorrencias,
    avisos: avisosFinais,
  };
}

// ---------- exportação ----------

// Linhas na ordem da tela: ipv4, ipv6, faixas. Tipo de faixa vem do próprio
// texto ("/" é CIDR, "-" é a-b) para não depender de campo extra no resultado.
function linhas(resultado) {
  // Resultado pode vir de fora (JSON colado, estado velho): só arrays valem e
  // cada item vira string, senão um número em faixas derrubava o CSV inteiro.
  const r = resultado && typeof resultado === 'object' ? resultado : {};
  const lista = (v) => (Array.isArray(v) ? v.map(String) : []);
  const out = [];
  for (const e of lista(r.ipv4)) out.push({ endereco: e, tipo: 'ipv4' });
  for (const e of lista(r.ipv6)) out.push({ endereco: e, tipo: 'ipv6' });
  for (const e of lista(r.faixas)) out.push({ endereco: e, tipo: e.includes('/') ? 'cidr' : 'faixa' });
  return out.map((l) => ({
    ...l,
    classe: (r.classes && r.classes[l.endereco]) || classificar(l.endereco),
    ocorrencias: (r.ocorrencias && r.ocorrencias[l.endereco]) || 0,
  }));
}

// Sem escape: endereço, tipo e classe nunca têm vírgula nem aspas.
function csv(resultado) {
  return ['endereco,tipo,classe,ocorrencias',
    ...linhas(resultado).map((l) => `${l.endereco},${l.tipo},${l.classe},${l.ocorrencias}`)].join('\n');
}

function listaTexto(resultado) {
  return linhas(resultado).map((l) => l.endereco).join('\n');
}

// Log misto para o botão "Exemplo": v4, v6, CIDR, porta, faixa, e as
// armadilhas (MAC, hora, versão, octeto > 255) que NÃO devem sair.
function exemplo() {
  return [
    '# Cole aqui log, config ou saída de comando. Exemplo:',
    'Sep 12 10:15:32 gw sshd[2231]: Accepted publickey for ygor from 192.168.1.10 port 51234 ssh2',
    'Sep 12 10:15:40 gw kernel: eth0: link up, MAC 00:1a:2b:3c:4d:5e',
    '2026-09-12 10:16:01 firewall: DROP src=203.0.113.7:443 dst=10.0.0.5:22 proto=TCP',
    'traceroute to 8.8.8.8 (8.8.8.8), 30 hops max',
    ' 1  192.168.1.1  0.412 ms',
    ' 2  100.64.3.1  8.123 ms',
    ' 3  * * *',
    ' 4  dns.google (8.8.8.8)  12.870 ms',
    'inet6 fe80::1a2b:3cff:fe4d:5e6f/64 scope link',
    'inet6 2001:db8:abcd::10/64 scope global',
    'route: 0.0.0.0/0 via 192.168.1.1 dev eth0',
    'nginx: listen [2001:db8::1]:443 ssl; listen [::ffff:192.168.1.10]:8080',
    'dhcp pool 10.0.0.100-10.0.0.150',
    'OpenSSH_9.2p1, build 1.2.3.4.5 (não é IP), erro 300.1.1.1 (octeto > 255)',
    '::1 localhost, 127.0.0.1 localhost, 192.168.1.10 outra vez',
  ].join('\n');
}

const API = {
  extrair, classificar, csv, listaTexto, exemplo,
  MAX_AVISOS,
  _v4ParaNum: v4ParaNum, _v6ParaBig: v6ParaBig, _bigParaV6: bigParaV6,
};
if (typeof window !== 'undefined') window.extrairIpsLib = API;
if (typeof module !== 'undefined' && module.exports) module.exports = API;

}());
