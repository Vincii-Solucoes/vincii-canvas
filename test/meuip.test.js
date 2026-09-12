'use strict';

// "Meu IP" — descoberta do IP público, ASN e gateway só por DNS e comandos de
// rota. Nada aqui toca a rede: os parsers recebem saídas REAIS coladas como
// fixture, e descobrir() roda com resolver e spawn falsos que simulam cada
// cenário (só v4, v4+v6, sem rota v6, Cymru fora do ar, gateway por SO).

const assert = require('assert');
const { EventEmitter } = require('events');
const m = require('../lib/meuip');

let n = 0;
const ok = (c, m_) => { assert.ok(c, m_); n += 1; };
const igual = (a, b, m_) => { assert.deepStrictEqual(a, b, m_); n += 1; };

// ---------- 1. inversão de endereços ----------

{
  igual(m.reverterV4('177.125.186.76'), '76.186.125.177', 'octetos invertidos para o Cymru/in-addr.arpa');
  igual(m.reverterV4('8.8.8.8'), '8.8.8.8', 'palíndromo continua igual');
  igual(m.reverterV4('999.1.1.1'), null, 'octeto > 255 não é IPv4');
  igual(m.reverterV4('2001:db8::1'), null, 'IPv6 não é aceito no reverterV4');

  igual(m.expandirV6('2001:db8::1'), '20010db8000000000000000000000001', 'expansão do "::" no meio');
  igual(m.expandirV6('::1'), '00000000000000000000000000000001', '"::" no início');
  igual(m.expandirV6('fe80::'), 'fe800000000000000000000000000000', '"::" no fim');
  igual(m.expandirV6('2804:14c:65d3:4b0e:1c2f:5d1a:8e3b:9f4c'), '2804014c65d34b0e1c2f5d1a8e3b9f4c', 'endereço cheio sem compressão');
  igual(m.expandirV6('::ffff:192.168.1.1'), '00000000000000000000ffffc0a80101', 'IPv4 embutido vira os 32 bits finais');
  igual(m.expandirV6('2001::db8::1'), null, 'dois "::" é recusado');
  igual(m.expandirV6('2001:db8:::1'), null, '":::" é recusado');
  igual(m.expandirV6('1:2:3:4:5:6:7'), null, '7 grupos sem "::" é recusado');
  igual(m.expandirV6('gggg::1'), null, 'hex inválido é recusado');
  igual(m.expandirV6('::'), '00000000000000000000000000000000', '"::" sozinho é o endereço zero');
  igual(m.expandirV6(':'), null, '":" sozinho é recusado');
  igual(m.expandirV6('1::2:'), null, 'grupo vazio no fim é recusado');
  igual(m.expandirV6('1:2:3:4:5:6:1.2.3.4'), '00010002000300040005000601020304', 'IPv4 embutido sem "::" fecha os 8 grupos');
  igual(m.expandirV6('1.2.3.4::'), null, 'IPv4 embutido antes do "::" não é o último de verdade → recusado');
  igual(m.expandirV6('::1.2.3.4:5'), null, 'IPv4 embutido no meio é recusado');
  igual(m.expandirV6('::1.2.3.4.5'), null, 'IPv4 embutido com 5 octetos é recusado');
  igual(m.expandirV6('::ffff:999.1.1.1'), null, 'IPv4 embutido com octeto > 255 é recusado');
  igual(m.expandirV6('12345::1'), null, 'grupo com 5 hex é recusado');
  for (const v of [null, undefined, '', 0, {}, []]) {
    igual([m.reverterV4(v), m.expandirV6(v), m.nibblesV6(v)], [null, null, null], `entrada ${JSON.stringify(v)} → null nas três inversões, sem lançar`);
  }
  {
    // 1 MB repetitivo: nenhum parser pode passar de milissegundos
    const t0 = Date.now();
    m.expandirV6(':'.repeat(1000000)); m.expandirV6('1:'.repeat(500000)); m.reverterV4('1.'.repeat(500000));
    ok(Date.now() - t0 < 500, 'inversões com 1 MB repetitivo terminam rápido (sem backtracking)');
  }

  igual(m.nibblesV6('2001:db8::1'),
    '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2',
    'nibbles invertidos com ponto (formato do origin6.asn.cymru.com / ip6.arpa)');
  igual(m.nibblesV6('2804:14c:65d3:4b0e::1').split('.').length, 32, 'sempre 32 rótulos');
  igual(m.nibblesV6('2804:14C::1'), m.nibblesV6('2804:14c::1'), 'maiúsculas normalizadas para minúsculas');
  igual(m.nibblesV6('192.168.1.1'), null, 'IPv4 não é aceito no nibblesV6');
}

// ---------- 2. parsers do Cymru (saídas reais do dig) ----------

{
  const origem = m.parseCymruOrigem('268323 | 177.125.184.0/22 | BR | lacnic | 2019-01-14');
  igual(origem, { asn: '268323', asns: ['268323'], prefixo: '177.125.184.0/22', pais: 'BR', registro: 'lacnic', data: '2019-01-14' },
    'origin.asn.cymru.com → asn/prefixo/país/registro/data');
  igual(m.parseCymruOrigem('"15169 | 8.8.8.0/24 | US | arin | 2023-12-28"').asn, '15169', 'aspas do dig são tiradas');
  igual(m.parseCymruOrigem([['268323 | 177.125.184.0/22 | BR | lacnic | 2019-01-14']]).prefixo, '177.125.184.0/22',
    'aceita a forma que o dns.resolveTxt devolve ([[pedaços]])');
  const multi = m.parseCymruOrigem('6453 3491 | 1.2.3.0/24 | US | arin | 2001-01-01');
  igual([multi.asn, multi.asns], ['6453', ['6453', '3491']], 'prefixo com vários ASNs: o primeiro em asn, todos em asns');
  const origem6 = m.parseCymruOrigem('28573 | 2804:14c::/32 | BR | lacnic | 2010-05-05');
  igual(origem6.prefixo, '2804:14c::/32', 'origin6 traz prefixo IPv6');
  igual(m.parseCymruOrigem('NXDOMAIN'), null, 'lixo → null');
  igual(m.parseCymruOrigem(''), null, 'vazio → null');
  igual(m.parseCymruOrigem('1 | lixo | x | y | z'), null, 'cinco campos mas prefixo que não é rede/tamanho → null');
  igual(m.parseCymruOrigem('1 | 1.2.3.0/33 | US | arin | 2001-01-01'), null, 'prefixo v4 com /33 → null');
  igual(m.parseCymruOrigem('1 | 2804::/129 | BR | lacnic | 2001-01-01'), null, 'prefixo v6 com /129 → null');
  igual(m.parseCymruOrigem('1 | 1.2.3.0/24/8 | US | arin | 2001-01-01'), null, 'duas barras → null');
  igual(m.parseCymruOrigem('1 | 1.2.3.0 | US | arin | 2001-01-01'), null, 'prefixo sem tamanho → null');
  for (const v of [null, undefined, 0, {}, [], [[]], [null]]) {
    igual(m.parseCymruOrigem(v), null, `parseCymruOrigem(${JSON.stringify(v)}) → null sem lançar`);
    igual(m.parseCymruAs(v), null, `parseCymruAs(${JSON.stringify(v)}) → null sem lançar`);
    igual(m.melhorOrigem(v), null, `melhorOrigem(${JSON.stringify(v)}) → null sem lançar`);
    igual(m.parseTxtGoogle(v), null, `parseTxtGoogle(${JSON.stringify(v)}) → null sem lançar`);
  }
  {
    const t0 = Date.now();
    m.parseCymruOrigem('1 '.repeat(500000) + 'x | a | b | c | d');
    m.parseCymruAs('"'.repeat(1000000));
    m.parseCymruAs('1 | a | b | c | ' + ', BR'.repeat(250000));
    ok(Date.now() - t0 < 500, 'parsers do Cymru com 1 MB repetitivo terminam rápido');
  }

  const as = m.parseCymruAs('268323 | BR | lacnic | 2019-01-14 | AZZA TELECOM SERVICOS EM TELECOMUNICACOES LTDA, BR');
  igual(as, { asn: '268323', pais: 'BR', registro: 'lacnic', data: '2019-01-14', nome: 'AZZA TELECOM SERVICOS EM TELECOMUNICACOES LTDA' },
    'ASnnn.asn.cymru.com → nome sem o ", BR" repetido no fim');
  igual(m.parseCymruAs('15169 | US | arin | 2000-03-30 | GOOGLE, US').nome, 'GOOGLE', 'sufixo de país é tirado só quando é ", XX" no fim');
  igual(m.parseCymruAs('28573 | BR | lacnic | 2010-05-05 | CLARO S.A., BR').nome, 'CLARO S.A.', 'ponto no nome não confunde');
  igual(m.parseCymruAs('15169 | US | arin | 2000-03-30 | GOOGLE - Google LLC, US').nome, 'GOOGLE - Google LLC', 'formato atual do Cymru ("SIGLA - Razão Social, CC")');
  igual(m.parseCymruAs('268323 |  | lacnic |  |'), { asn: '268323', pais: null, registro: 'lacnic', data: null, nome: null },
    'AS sem cadastro (resposta real, campos vazios) → null nos campos, não ""');
  igual(m.parseCymruAs('x | y'), null, 'formato quebrado → null');

  // resposta real: o IP cai em dois prefixos do mesmo AS (/23 dentro do /22)
  const dois = [['268323 | 177.125.186.0/23 | BR | lacnic | 2012-01-09'], ['268323 | 177.125.184.0/22 | BR | lacnic | 2012-01-09']];
  igual(m.melhorOrigem(dois).prefixo, '177.125.186.0/23', 'com vários TXT fica o prefixo MAIS específico');
  igual(m.melhorOrigem([['268323 | 177.125.184.0/22 | BR | lacnic | 2012-01-09'], ['268323 | 177.125.186.0/23 | BR | lacnic | 2012-01-09']]).prefixo,
    '177.125.186.0/23', 'independente da ordem em que chegam');
  igual(m.melhorOrigem('268323 | 177.125.184.0/22 | BR | lacnic | 2019-01-14').asn, '268323', 'um TXT em string também vale');
  igual(m.melhorOrigem(['268323 | 177.125.184.0/22 | BR | lacnic | 2019-01-14', '268323 | 177.125.186.0/23 | BR | lacnic | 2019-01-14']).prefixo,
    '177.125.186.0/23', 'lista de strings (sem o aninhamento do resolveTxt) é tratada como vários registros, não colada');
  igual(m.melhorOrigem([['lixo']]), null, 'nenhum parseável → null');
  igual(m.melhorOrigem([['lixo'], ['268323 | 177.125.184.0/22 | BR | lacnic | 2019-01-14']]).prefixo, '177.125.184.0/22', 'lixo no meio é ignorado, o válido fica');
}

// ---------- 3. TXT do Google ----------

{
  igual(m.parseTxtGoogle('"177.125.186.76"'), '177.125.186.76', 'TXT vem entre aspas → IPv4 limpo');
  igual(m.parseTxtGoogle([['2804:14c:65d3:4b0e::1']]), '2804:14c:65d3:4b0e::1', 'forma [[…]] com IPv6');
  igual(m.parseTxtGoogle('"edns0-client-subnet 177.125.0.0/16"'), null, 'resposta via resolver intermediário não é IP → null');
  igual(m.parseTxtGoogle(''), null, 'vazio → null');
}

// ---------- 4. gateway por plataforma (saídas reais) ----------

const ROTA_MAC = `   route to: default
destination: default
       mask: default
    gateway: 192.168.1.1
  interface: en0
      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>
 recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire
       0         0         0         0         0         0      1500         0
`;
const ROTA_MAC_SEM = 'route: writing to routing socket: not in table\n';
const ROTA_LINUX = 'default via 10.0.0.1 dev eth0 proto dhcp src 10.0.0.42 metric 100 \n';
const ROTA_LINUX_DUAS = 'default via 10.0.0.1 dev eth0 proto dhcp metric 100 \ndefault via 192.168.7.1 dev wlan0 proto dhcp metric 600 \n';
const ROTA_WIN = `===========================================================================
Interface List
 12...00 15 5d 01 02 03 ......Microsoft Hyper-V Network Adapter
  1...........................Software Loopback Interface 1
===========================================================================

IPv4 Route Table
===========================================================================
Active Routes:
Network Destination        Netmask          Gateway       Interface  Metric
          0.0.0.0          0.0.0.0     192.168.15.1    192.168.15.20     25
===========================================================================
Persistent Routes:
  None

IPv6 Route Table
===========================================================================
Active Routes:
  None
`;
const ROTA_WIN_PTBR = `Tabela de rotas IPv4
===========================================================================
Rotas ativas:
Endereço de rede          Máscara de rede   Gateway         Interface      Métrica
          0.0.0.0          0.0.0.0      10.1.1.254       10.1.1.33     35
===========================================================================
`;

{
  igual(m.parseGateway(ROTA_MAC, 'darwin'), '192.168.1.1', 'macOS: linha "gateway:"');
  igual(m.parseGateway(ROTA_MAC_SEM, 'darwin'), null, 'macOS sem rota padrão → null');
  igual(m.parseGateway('    gateway: fe80::1%en0\n', 'darwin'), 'fe80::1', 'macOS: zona "%en0" é tirada do gateway v6');
  igual(m.parseGateway(ROTA_LINUX, 'linux'), '10.0.0.1', 'Linux: "default via X"');
  igual(m.parseGateway(ROTA_LINUX_DUAS, 'linux'), '10.0.0.1', 'Linux com duas rotas padrão: a primeira (menor métrica)');
  igual(m.parseGateway('', 'linux'), null, 'Linux sem rota padrão (saída vazia) → null');
  igual(m.parseGateway(ROTA_WIN, 'win32'), '192.168.15.1', 'Windows: linha numérica 0.0.0.0/0.0.0.0');
  igual(m.parseGateway(ROTA_WIN_PTBR, 'win32'), '10.1.1.254', 'Windows em pt-BR: o cabeçalho traduzido não importa');
  igual(m.parseGateway('          0.0.0.0          0.0.0.0         On-link     192.168.15.20     25\n', 'win32'), null,
    'Windows "On-link" não é IP → null');
  igual(m.parseGateway('    gateway: link#5\n', 'darwin'), null, 'macOS com rota por interface ("link#5") não tem IP de gateway → null');
  igual(m.parseGateway('default dev ppp0 scope link \n', 'linux'), null, 'Linux com rota padrão sem "via" (PPP) → null');
  igual(m.parseGateway('          0.0.0.0          0.0.0.0     192.168.15.1    192.168.15.20     25\n          0.0.0.0          0.0.0.0     10.0.0.1    10.0.0.5     50\n', 'win32'),
    '192.168.15.1', 'Windows com duas rotas padrão: a primeira listada');
  igual(m.parseGateway('0.0.0.0\n0.0.0.0\n1.2.3.4\n', 'win32'), null, 'Windows: os campos têm de estar na MESMA linha');
  for (const v of [null, undefined, '', 0, {}, []]) {
    igual([m.parseGateway(v, 'darwin'), m.parseGateway(v, 'linux'), m.parseGateway(v, 'win32')], [null, null, null], `parseGateway(${JSON.stringify(v)}) → null sem lançar`);
  }
  ok(['route', 'ip'].includes(m.comandoGateway(null).cmd) && ['route', 'ip'].includes(m.comandoGateway(undefined).cmd), 'comandoGateway sem plataforma cai na do processo');
  {
    // Regressão: "^\s*" com flag m era O(n²) — 26 s com 200 mil linhas vazias.
    const vazio = '\n'.repeat(200000);
    const t0 = Date.now();
    for (const p of ['darwin', 'linux', 'win32']) igual(m.parseGateway(vazio, p), null, `200 mil linhas vazias em ${p} → null`);
    ok(Date.now() - t0 < 500, 'parseGateway com 200 mil linhas vazias termina em milissegundos');
    const espacos = ' '.repeat(1000000) + '\n' + ROTA_MAC;
    igual(m.parseGateway(espacos, 'darwin'), '192.168.1.1', 'linha de 1 MB de espaços antes da saída real não atrapalha');
  }
  igual(m.comandoGateway('darwin'), { cmd: 'route', args: ['-n', 'get', 'default'] }, 'comando do macOS');
  igual(m.comandoGateway('linux'), { cmd: 'ip', args: ['route', 'show', 'default'] }, 'comando do Linux');
  igual(m.comandoGateway('win32'), { cmd: 'route', args: ['print', '0.0.0.0'] }, 'comando do Windows');
}

// ---------- 5. interfaces locais ----------

{
  const tabela = {
    lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
    en0: [
      { address: 'fe80::1cb8:f495:82a6:68c3', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: '32:02:71:7a:c3:9d', internal: false, cidr: 'fe80::1cb8:f495:82a6:68c3/64', scopeid: 12 },
      { address: '192.168.1.17', netmask: '255.255.255.0', family: 'IPv4', mac: '32:02:71:7a:c3:9d', internal: false, cidr: '192.168.1.17/24' },
    ],
    eth0: [{ address: '10.0.0.42', netmask: '255.255.255.0', family: 4, mac: 'aa:bb:cc:dd:ee:ff', internal: false, cidr: '10.0.0.42/24' }],
  };
  const ifs = m.listarInterfaces(tabela);
  igual(ifs.map((i) => i.nome), ['en0', 'en0', 'eth0'], 'loopback fica de fora');
  igual(ifs[1], { nome: 'en0', ip: '192.168.1.17', familia: 'IPv4', cidr: '192.168.1.17/24', mac: '32:02:71:7a:c3:9d' }, 'campos nome/ip/familia/cidr/mac');
  igual(ifs[2].familia, 'IPv4', 'family numérico (Node 18.0–18.3) é normalizado para string');
  igual(m.listarInterfaces({ en0: [null, undefined, 'lixo', 7], en1: 'abc', en2: null }), [], 'entradas que não são objeto são ignoradas, sem lançar');
  igual(m.listarInterfaces({ en0: [{ address: '10.0.0.1', family: 6, internal: false }] }),
    [{ nome: 'en0', ip: '10.0.0.1', familia: 'IPv6', cidr: null, mac: null }], 'cidr/mac ausentes viram null');
  ok(Array.isArray(m.listarInterfaces(null)) && Array.isArray(m.listarInterfaces(undefined)), 'sem tabela usa a do SO e devolve lista');
}

// ---------- 6. descobrir() com resolver e spawn falsos ----------

const erro = (code) => Object.assign(new Error(code), { code });

// Resolver falso: decide pela lista de servidores (OpenDNS v4/v6, Google) ou,
// sem servidores, pelo nome perguntado (Cymru/PTR). `cen` liga/desliga cada
// pedaço para montar os cenários.
function resolverFalso(cen) {
  return (servidores) => {
    const srv = servidores && servidores[0];
    return {
      async resolve4(host) {
        if (srv !== m.OPENDNS_V4 || host !== m.HOST_OPENDNS) throw erro('ENOTFOUND');
        if (cen.opendnsV4 === 'fora') throw erro('ETIMEOUT');
        return ['177.125.186.76'];
      },
      async resolve6(host) {
        if (srv !== m.OPENDNS_V6 || host !== m.HOST_OPENDNS) throw erro('ENOTFOUND');
        if (!cen.v6) throw erro(cen.erroV6 || 'ENETUNREACH');
        return ['2804:14c:65d3:4b0e:1c2f:5d1a:8e3b:9f4c'];
      },
      async resolveTxt(host) {
        if (srv === m.GOOGLE_NS1 && host === m.HOST_GOOGLE) return [['"177.125.186.76"']];
        if (cen.cymru === 'fora') throw erro('ETIMEOUT');
        if (host === '76.186.125.177.origin.asn.cymru.com') return [['268323 | 177.125.184.0/22 | BR | lacnic | 2019-01-14']];
        if (host === 'AS268323.asn.cymru.com') return [['268323 | BR | lacnic | 2019-01-14 | AZZA TELECOM SERVICOS EM TELECOMUNICACOES LTDA, BR']];
        if (host === `${m.nibblesV6('2804:14c:65d3:4b0e:1c2f:5d1a:8e3b:9f4c')}.origin6.asn.cymru.com`) return [['28573 | 2804:14c::/32 | BR | lacnic | 2010-05-05']];
        if (host === 'AS28573.asn.cymru.com') return [['28573 | BR | lacnic | 2010-05-05 | CLARO S.A., BR']];
        throw erro('ENOTFOUND');
      },
      async reverse(ip) {
        if (cen.ptr === 'fora') throw erro('ETIMEOUT');
        if (ip === '177.125.186.76') return ['177-125-186-76.azzatelecom.net.br'];
        throw erro('ENOTFOUND');
      },
    };
  };
}

// Spawn falso: cospe o texto no stdout e fecha. Guarda o comando chamado.
function spawnFalso(texto, chamadas) {
  return (cmd, args) => {
    if (chamadas) chamadas.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => { child.stdout.emit('data', texto); child.emit('close', 0); });
    return child;
  };
}

const semInterfaces = {};

(async () => {
  // só v4 (o caso comum no Brasil: sem rota v6)
  {
    const r = await m.descobrir({ resolver: resolverFalso({ v6: false }), spawn: spawnFalso(ROTA_MAC), plataforma: 'darwin', interfaces: semInterfaces });
    igual(r.ipv4, { ip: '177.125.186.76', ptr: '177-125-186-76.azzatelecom.net.br', asn: '268323', prefixo: '177.125.184.0/22', provedor: 'AZZA TELECOM SERVICOS EM TELECOMUNICACOES LTDA', titular: null, pais: 'BR' },
      'só v4: ip + PTR + ASN + prefixo + provedor + país');
    igual(r.ipv6, null, 'sem rota v6 → ipv6 null');
    ok(r.avisos.some((a) => /Sem IPv6 público/.test(a)), 'sem rota v6 vira aviso em pt-BR, não erro');
    igual(r.avisos.length, 1, 'nada mais foi avisado quando tudo o resto funcionou');
    igual(r.gateway, '192.168.1.1', 'gateway do macOS');
  }

  // v4 + v6
  {
    const r = await m.descobrir({ resolver: resolverFalso({ v6: true }), spawn: spawnFalso(ROTA_LINUX), plataforma: 'linux', interfaces: semInterfaces });
    igual(r.ipv4.ip, '177.125.186.76', 'v4+v6: v4 presente');
    igual(r.ipv6, { ip: '2804:14c:65d3:4b0e:1c2f:5d1a:8e3b:9f4c', ptr: null, asn: '28573', prefixo: '2804:14c::/32', provedor: 'CLARO S.A.', titular: null, pais: 'BR' },
      'v4+v6: v6 enriquecido pelo origin6 (nibbles invertidos) e sem PTR');
    igual(r.avisos, [], 'PTR ausente (ENOTFOUND) não é aviso — é o normal para IPv6 residencial');
    igual(r.gateway, '10.0.0.1', 'gateway do Linux');
  }

  // macOS sem rota v6: o c-ares devolve ECONNREFUSED, e isso também é "sem IPv6", não erro
  {
    const r = await m.descobrir({ resolver: resolverFalso({ v6: false, erroV6: 'ECONNREFUSED' }), spawn: spawnFalso(ROTA_MAC), plataforma: 'darwin', interfaces: semInterfaces });
    igual(r.ipv6, null, 'ECONNREFUSED na consulta v6 → ipv6 null');
    igual(r.avisos.filter((a) => /IPv6/.test(a)), ['Sem IPv6 público (a máquina não tem rota IPv6 ou o OpenDNS não respondeu).'], 'só o aviso de "sem IPv6", sem alarde de falha');
  }

  // OpenDNS v4 fora do ar → o TXT do Google supre
  {
    const r = await m.descobrir({ resolver: resolverFalso({ v6: false, opendnsV4: 'fora' }), spawn: spawnFalso(ROTA_MAC), plataforma: 'darwin', interfaces: semInterfaces });
    igual(r.ipv4 && r.ipv4.ip, '177.125.186.76', 'OpenDNS mudo: o Google entrega o IPv4');
    ok(r.avisos.some((a) => /OpenDNS não respondeu ao IPv4 \(ETIMEOUT\)/.test(a)), 'e a falha do OpenDNS fica registrada');
  }

  // Cymru fora do ar: IP e PTR continuam, ASN some, aviso entra
  {
    const r = await m.descobrir({ resolver: resolverFalso({ v6: true, cymru: 'fora' }), spawn: spawnFalso(ROTA_MAC), plataforma: 'darwin', interfaces: semInterfaces });
    igual([r.ipv4.ip, r.ipv4.ptr], ['177.125.186.76', '177-125-186-76.azzatelecom.net.br'], 'Cymru fora: IP e PTR seguem');
    igual([r.ipv4.asn, r.ipv4.provedor, r.ipv6.asn], [null, null, null], 'Cymru fora: ASN/provedor ficam null (não derruba o resto)');
    igual(r.avisos.filter((a) => /Cymru sem resposta \(ETIMEOUT\)/.test(a)).length, 2, 'um aviso por versão de IP');
  }

  // PTR fora do ar: ASN continua
  {
    const r = await m.descobrir({ resolver: resolverFalso({ v6: false, ptr: 'fora' }), spawn: spawnFalso(ROTA_MAC), plataforma: 'darwin', interfaces: semInterfaces });
    igual([r.ipv4.ptr, r.ipv4.asn], [null, '268323'], 'PTR com timeout não tira o ASN');
    ok(r.avisos.some((a) => /PTR do IPv4 não consultado \(ETIMEOUT\)/.test(a)), 'timeout do PTR vira aviso');
  }

  // gateway em cada plataforma, com o comando certo
  {
    const casos = [
      ['darwin', ROTA_MAC, '192.168.1.1', 'route'],
      ['linux', ROTA_LINUX, '10.0.0.1', 'ip'],
      ['win32', ROTA_WIN, '192.168.15.1', 'route'],
    ];
    for (const [plat, texto, esperado, cmd] of casos) {
      const chamadas = [];
      const r = await m.descobrir({ resolver: resolverFalso({ v6: false }), spawn: spawnFalso(texto, chamadas), plataforma: plat, interfaces: semInterfaces });
      igual(r.gateway, esperado, `gateway em ${plat}`);
      igual(chamadas[0].cmd, cmd, `comando de rota em ${plat}`);
    }
    const r = await m.descobrir({ resolver: resolverFalso({ v6: false }), spawn: spawnFalso(ROTA_MAC_SEM), plataforma: 'darwin', interfaces: semInterfaces });
    igual(r.gateway, null, 'sem rota padrão → gateway null');
    ok(r.avisos.some((a) => /Gateway padrão não encontrado/.test(a)), 'e aviso');
  }

  // comando de rota inexistente (spawn lança ou emite error) não derruba nada
  {
    const spawnQuebrado = () => { throw erro('ENOENT'); };
    const r = await m.descobrir({ resolver: resolverFalso({ v6: false }), spawn: spawnQuebrado, plataforma: 'linux', interfaces: semInterfaces });
    igual([r.gateway, r.ipv4.ip], [null, '177.125.186.76'], 'spawn que lança: gateway null, o resto segue');
  }

  // spawn injetado que devolve nada (nem child) não derruba
  {
    const r = await m.descobrir({ resolver: resolverFalso({ v6: false }), spawn: () => undefined, plataforma: 'linux', interfaces: semInterfaces });
    igual([r.gateway, r.ipv4.ip], [null, '177.125.186.76'], 'spawn que devolve undefined: gateway null, o resto segue');
  }

  // resolver que funciona para os públicos mas LANÇA síncrono no resolver(null) do enriquecimento
  {
    const base = resolverFalso({ v6: false });
    const meioQuebrado = (srv) => { if (!srv) throw new Error('setServers recusou'); return base(srv); };
    const r = await m.descobrir({ resolver: meioQuebrado, spawn: spawnFalso(ROTA_MAC), plataforma: 'darwin', interfaces: semInterfaces });
    igual([r.ipv4.ip, r.ipv4.asn, r.ipv4.ptr], ['177.125.186.76', null, null], 'throw síncrono no enriquecimento: IP fica, detalhes ficam null');
    ok(r.avisos.some((a) => /Detalhes do IPv4 não consultados \(setServers recusou\)/.test(a)), 'e vira aviso');
  }

  // métodos do resolver que lançam SÍNCRONO (não rejeitam): mesmo tratamento de erro de rede
  {
    const sincrono = () => ({
      resolve4: () => { throw erro('EBADRESP'); }, resolve6: () => { throw erro('EBADRESP'); },
      resolveTxt: () => { throw erro('EBADRESP'); }, reverse: () => { throw erro('EBADRESP'); },
    });
    const r = await m.descobrir({ resolver: sincrono, spawn: spawnFalso(ROTA_MAC), plataforma: 'darwin', interfaces: semInterfaces });
    igual([r.ipv4, r.ipv6], [null, null], 'throw síncrono nos métodos: null, sem exceção');
    ok(r.avisos.some((a) => /OpenDNS não respondeu ao IPv4 \(EBADRESP\)/.test(a)), 'com o código no aviso');
  }

  // OpenDNS respondendo IP PRIVADO (resolver interceptado por captive portal/roteador): não é público, o Google supre
  {
    const base = resolverFalso({ v6: false });
    const interceptado = (srv) => {
      const r = base(srv);
      if (srv && srv[0] === m.OPENDNS_V4) r.resolve4 = async () => ['192.168.0.1'];
      return r;
    };
    const r = await m.descobrir({ resolver: interceptado, spawn: spawnFalso(ROTA_MAC), plataforma: 'darwin', interfaces: semInterfaces });
    igual(r.ipv4 && r.ipv4.ip, '177.125.186.76', 'OpenDNS com 192.168.0.1 é descartado e o TXT do Google entrega o público');
    ok(r.avisos.some((a) => /OpenDNS respondeu um endereço privado \(192\.168\.0\.1\)/.test(a)), 'e o aviso explica a interceptação');
  }

  // AAAA vindo como v4 mapeado (::ffff:a.b.c.d, NAT64) ou link-local: não é IPv6 público
  {
    for (const [v6, rot] of [['::ffff:177.125.186.76', 'v4 mapeado'], ['fe80::1', 'link-local'], ['fd00::1', 'ULA']]) {
      const base = resolverFalso({ v6: true });
      const mapeado = (srv) => { const r = base(srv); if (srv && srv[0] === m.OPENDNS_V6) r.resolve6 = async () => [v6]; return r; };
      const r = await m.descobrir({ resolver: mapeado, spawn: spawnFalso(ROTA_MAC), plataforma: 'darwin', interfaces: semInterfaces });
      igual(r.ipv6, null, `AAAA ${rot} (${v6}) não conta como IPv6 público`);
      ok(r.avisos.some((a) => /IPv6 não roteável/.test(a)) && r.avisos.some((a) => /Sem IPv6 público/.test(a)), `${rot}: aviso do porquê + "sem IPv6"`);
    }
  }

  // Cymru sem registro (NXDOMAIN) para o IP: é resposta ("não anunciado"), não "Cymru fora do ar"
  {
    const base = resolverFalso({ v6: false });
    const semRegistro = (srv) => {
      const r = base(srv);
      if (!srv) r.resolveTxt = async () => { throw erro('ENOTFOUND'); };
      return r;
    };
    const r = await m.descobrir({ resolver: semRegistro, spawn: spawnFalso(ROTA_MAC), plataforma: 'darwin', interfaces: semInterfaces });
    igual([r.ipv4.asn, r.ipv4.ptr], [null, '177-125-186-76.azzatelecom.net.br'], 'NXDOMAIN no Cymru: ASN null, PTR segue');
    ok(r.avisos.some((a) => /IPv4 sem registro de origem no Cymru/.test(a)) && !r.avisos.some((a) => /Cymru sem resposta/.test(a)),
      'aviso é "sem registro", não "sem resposta"');
  }

  // interfaces com entrada nula não derrubam nem viram aviso (é filtrado, não erro)
  {
    const r = await m.descobrir({ resolver: resolverFalso({ v6: false }), spawn: spawnFalso(ROTA_MAC), plataforma: 'darwin', interfaces: { en0: [null] } });
    igual(r.interfaces, [], 'tabela com null: lista vazia');
    ok(!r.avisos.some((a) => /Interfaces locais/.test(a)), 'sem aviso de interfaces');
  }

  // tudo fora do ar: nunca lança
  {
    const tudoFora = () => ({
      resolve4: async () => { throw erro('ECONNREFUSED'); }, resolve6: async () => { throw erro('ENETUNREACH'); },
      resolveTxt: async () => { throw erro('ECONNREFUSED'); }, reverse: async () => { throw erro('ECONNREFUSED'); },
    });
    const r = await m.descobrir({ resolver: tudoFora, spawn: spawnFalso(''), plataforma: 'linux', interfaces: semInterfaces });
    igual([r.ipv4, r.ipv6, r.gateway], [null, null, null], 'sem rede: tudo null, sem exceção');
    ok(r.avisos.length >= 3, 'e cada falha virou um aviso');
  }

  // ---------- 7. resumo para copiar ----------
  {
    const r = await m.descobrir({
      resolver: resolverFalso({ v6: false }), spawn: spawnFalso(ROTA_MAC), plataforma: 'darwin',
      interfaces: { en0: [{ address: '192.168.1.17', family: 'IPv4', mac: '32:02:71:7a:c3:9d', internal: false, cidr: '192.168.1.17/24' }] },
    });
    const txt = m.resumoTexto(r);
    ok(/^IPv4 público: 177\.125\.186\.76$/m.test(txt), 'resumo: IPv4');
    ok(/ASN: AS268323 — AZZA TELECOM SERVICOS EM TELECOMUNICACOES LTDA \(BR\)/.test(txt), 'resumo: ASN + provedor + país');
    ok(/^IPv6 público: nenhum$/m.test(txt), 'resumo: sem v6');
    ok(/^Gateway padrão: 192\.168\.1\.1$/m.test(txt), 'resumo: gateway');
    ok(/en0  192\.168\.1\.17\/24  IPv4  32:02:71:7a:c3:9d/.test(txt), 'resumo: interface com cidr e mac');
    ok(/Avisos:\n  - Sem IPv6 público/.test(txt), 'resumo: avisos no fim');
    igual(m.resumoTexto(null), 'IPv4 público: nenhum\nIPv6 público: nenhum\nGateway padrão: não encontrado\nInterfaces locais: nenhuma', 'resumo de resultado vazio não lança');
    for (const v of [undefined, '', 0, {}, []]) igual(m.resumoTexto(v), m.resumoTexto(null), `resumoTexto(${JSON.stringify(v)}) = resumo vazio`);
    igual(m.resumoTexto({ ipv4: {}, interfaces: [null, 'x', { nome: 'en0', ip: '10.0.0.1', familia: 'IPv4' }], avisos: [null, '', 'algo'] }),
      'IPv4 público: nenhum\nIPv6 público: nenhum\nGateway padrão: não encontrado\nInterfaces locais:\n  en0  10.0.0.1  IPv4\nAvisos:\n  - algo',
      'ipv4 sem ip conta como nenhum; interfaces/avisos nulos são filtrados; interface sem cidr usa o ip, sem mac não sobra espaço');
    const v6 = m.resumoTexto({ ipv6: { ip: '2804:14c::1', asn: '28573', pais: 'BR' } });
    ok(/^IPv6 público: 2804:14c::1\n  ASN: AS28573 \(BR\)$/m.test(v6), 'ASN sem provedor não deixa o travessão sobrando');
  }

  // ---------- whois de recuo: quando o Cymru não tem o nome do AS ----------

// Para muita operadora brasileira o TXT do Cymru vem "268323 |  | lacnic |  |".
// Primeiro tenta o registro pelo ASN; o registro.br (para onde o LACNIC manda o
// Brasil) não casa "AS268323", então cai para o whois do IP — e o que volta é o
// TITULAR do bloco, que vai num campo próprio: quem detém o bloco pode não ser
// quem o anuncia.
{
  const { parseWhoisNomeAs, WHOIS_POR_REGISTRO, titularDoBlocoPorWhois, nomeDoAsPorWhois } = require('../lib/meuip');
  igual(parseWhoisNomeAs('% Joint Whois\naut-num:     AS268323\nowner:       AZZA TELECOM SERVICOS EM TELECOMUNICACOES LTDA\nownerid:     12.345\n', WHOIS_POR_REGISTRO.lacnic.campos),
    'AZZA TELECOM SERVICOS EM TELECOMUNICACOES LTDA', 'LACNIC/registro.br: owner');
  igual(parseWhoisNomeAs('ASNumber:       15169\nASName:         GOOGLE\nOrgName:        Google LLC\n', WHOIS_POR_REGISTRO.arin.campos), 'GOOGLE', 'ARIN: ASName');
  igual(parseWhoisNomeAs('aut-num:        AS3320\nas-name:        DTAG\ndescr:          Deutsche Telekom AG\n', WHOIS_POR_REGISTRO.ripencc.campos), 'DTAG', 'RIPE: as-name');
  igual(parseWhoisNomeAs('% No match for AS268323\n', WHOIS_POR_REGISTRO.lacnic.campos), null, 'sem casamento → null');
  igual(parseWhoisNomeAs('owner:  AS268323\n', WHOIS_POR_REGISTRO.lacnic.campos), null, 'valor que é só o número do AS não é nome');
  igual(parseWhoisNomeAs('', WHOIS_POR_REGISTRO.lacnic.campos), null, 'vazio');
  igual(parseWhoisNomeAs('owner: ' + 'x'.repeat(500), WHOIS_POR_REGISTRO.lacnic.campos).length, 120, 'nome longo é cortado');

  (async () => {
    const chamadas = [];
    const whoisFalso = async (host, consulta) => {
      chamadas.push(`${host} ${consulta}`);
      if (/^AS/.test(consulta)) return '% No match for ' + consulta + '\n';
      return 'inetnum:     177.125.184.0/22\naut-num:     AS28220\nowner:       Alares Cabo Servicos de Telecomunicacoes S.A.\n';
    };
    igual(await nomeDoAsPorWhois('268323', 'lacnic', whoisFalso), null, 'pelo ASN o registro.br não casa');
    igual(await titularDoBlocoPorWhois('177.125.186.76', 'lacnic', whoisFalso), 'Alares Cabo Servicos de Telecomunicacoes S.A.', 'pelo IP vem o titular do bloco');
    igual(await nomeDoAsPorWhois('1', 'registro-desconhecido', whoisFalso), null, 'registro desconhecido não consulta nada');
    igual(chamadas, ['whois.lacnic.net AS268323', 'whois.lacnic.net 177.125.186.76'], 'um servidor por registro, na ordem ASN → IP');
    console.log(`\n${n} verificações passaram`);
  })();
}
})().catch((e) => { console.error(e); process.exit(1); });
