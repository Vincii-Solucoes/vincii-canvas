'use strict';

// Extrator de IPs — texto colado (log, config, traceroute, netstat) → lista
// de endereços. O que trava aqui: a delimitação (não pegar "1.2.3.4.5" nem
// "10.0.0.1.5"), os falsos positivos de dois-pontos (MAC, hora) que o parser
// IPv6 tem de recusar, a forma canônica que junta "FE80::1%en0" com
// "fe80:0:0:0:0:0:0:1", a ordenação numérica e o custo linear em 2 MB.

const assert = require('assert');
const x = require('../public/extrairips');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// ---------- 1. IPv4: válidos, repetidos, porta, pontuação ----------

{
  const r = x.extrair('de 10.0.0.1 para 10.0.0.2, e 10.0.0.1 de novo; fim em 10.0.0.9.');
  igual(r.ipv4, ['10.0.0.1', '10.0.0.2', '10.0.0.9'], 'IPv4 sem repetição; ponto final de frase não atrapalha');
  igual(r.ocorrencias['10.0.0.1'], 2, 'conta as ocorrências');
  igual([r.total, r.totalOcorrencias], [3, 4], 'total = únicos; totalOcorrencias = soma');
  igual(r.ipv6, [], 'nada de IPv6 aqui');
  igual(r.avisos, [], 'sem avisos');

  igual(x.extrair('conectou em 1.2.3.4:443 e src:10.0.0.1 dst=10.0.0.2:22').ipv4,
    ['1.2.3.4', '10.0.0.1', '10.0.0.2'], 'porta ":443" é descartada, só o IP fica; "src:" colado também vale');
  igual(x.extrair('host 192.168.001.010 e 192.168.1.10').ipv4, ['192.168.1.10'],
    'zeros à esquerda (syslog do Windows) viram a forma canônica e caem no mesmo endereço');
  igual(x.extrair('bind 0.0.0.0 e 255.255.255.255').ipv4, ['0.0.0.0', '255.255.255.255'], 'extremos 0.0.0.0 e 255.255.255.255 são IPs');
}

// ---------- 2. IPv4: o que NÃO pode sair ----------

{
  igual(x.extrair('erro 300.1.1.1 e 1.256.1.1').ipv4, [], 'octeto > 255 é recusado (e não sobra "00.1.1.1" de dentro)');
  igual(x.extrair('só 1.2.3 e 1.2').ipv4, [], '3 ou 2 números não é IPv4');
  igual(x.extrair('versão 1.2.3.4.5 instalada').ipv4, [], 'versão 1.2.3.4.5 não é IP (nem "1.2.3.4" nem "2.3.4.5" de dentro)');
  igual(x.extrair('bloco 10.0.0.1.5 aqui').ipv4, [], '"10.0.0.1.5" é ambíguo: a regra é só casar delimitado por não-dígito/não-ponto');
  igual(x.extrair('1234.1.1.1 e 1.1.1.1234').ipv4, [], 'octeto de 4 dígitos não vale, e não sobra "234.1.1.1" nem "1.1.1.123"');
  // saída REAL de `netstat -an -f inet` no macOS: porta separada por PONTO
  const netstat = [
    'Active Internet connections (including servers)',
    'Proto Recv-Q Send-Q  Local Address                                 Foreign Address                               (state)    ',
    'tcp4       0      0  10.248.255.136.49425   192.168.3.254.8291     SYN_SENT   ',
    'tcp4       0      0  192.168.1.17.49421     162.125.21.2.443       ESTABLISHED',
    'tcp4       0      0  127.0.0.1.63148        127.0.0.1.49415        FIN_WAIT_2 ',
  ].join('\n');
  const r = x.extrair(netstat);
  igual(r.ipv4, [], 'netstat do macOS (IP.porta) não é extraído — consequência documentada da regra');
  ok(r.avisos.length === 1 && r.avisos[0].includes('6 trecho(s)') && r.avisos[0].includes('10.248.255.136.49425'),
    'mas o usuário recebe um aviso com a contagem e o primeiro exemplo inteiro');
}

// ---------- 3. IPv6: formas, zona, colchetes, mapeado ----------

{
  const r = x.extrair('a 2001:0db8:0000:0000:0000:0000:0000:0001 b 2001:db8::1 c FE80::1%en0 d fe80:0:0:0:0:0:0:1 e ::1 f fe80::1%eth0');
  igual(r.ipv6, ['::1', '2001:db8::1', 'fe80::1'], 'cheio/comprimido/maiúsculo/com zona convergem para a forma canônica RFC 5952');
  igual(r.ocorrencias['fe80::1'], 3, 'fe80::1 com zona en0, eth0 e por extenso é o MESMO endereço, 3 vezes');
  igual(r.ocorrencias['2001:db8::1'], 2, 'cheio e comprimido contam junto');

  const b = x.extrair('listen [2001:db8::1]:443 e [fe80::2%en0]:22 e [::1]:8080');
  igual(b.ipv6, ['::1', '2001:db8::1', 'fe80::2'], 'colchetes com porta: tira colchete, porta e zona');
  igual(b.ipv4, [], 'a porta 443 não vira lixo em ipv4');

  const m = x.extrair('cliente ::ffff:192.168.1.10 e [::ffff:10.0.0.7]:80');
  igual(m.ipv6, ['::ffff:10.0.0.7', '::ffff:192.168.1.10'], 'IPv4-mapeado fica em ipv6, na forma pontuada');
  igual(m.ipv4, [], 'e o IPv4 de dentro NÃO é contado de novo em ipv4');
  igual(m.classes['::ffff:192.168.1.10'], 'privado', 'o mapeado herda a classe do IPv4 de dentro');

  igual(x.extrair('vai para 2001:db8::1. Depois fe80::1: timeout').ipv6, ['2001:db8::1', 'fe80::1'],
    'ponto e dois-pontos de pontuação no fim são descartados');
  igual(x.extrair('rede 2001:db8:: e 2001:db8::.').ipv6, ['2001:db8::'], '"2001:db8::" (termina em ::) continua válido, com ou sem ponto de frase');
  igual(x.extrair('1:2:3:4:5:6:7:8 e 2001:db8::1:2:3:4:5:6:7').ipv6, ['1:2:3:4:5:6:7:8'], '8 grupos vale; 9 grupos não');
  igual(x.extrair('IPv6:2001:db8::1 e ID:2001:db8::2').ipv6, ['2001:db8::1', '2001:db8::2'],
    'colado a "IPv6:" não começa no "6" (que daria o endereço válido e errado 6:2001:db8::1)');
  igual(x.extrair('a 64:ff9b::192.0.2.33 b').ipv6, ['64:ff9b::c000:221'], 'NAT64 com IPv4 embutido: aceito e expandido (só o ::ffff: fica pontuado)');
}

// ---------- 4. Falsos positivos de dois-pontos ----------

{
  const r = x.extrair([
    'MAC 00:1a:2b:3c:4d:5e e AA:BB:CC:DD:EE:FF',
    '2026-09-12 10:15:32 hora 12:30:45 e 12:30 e 23:59:59.999',
    'std::string x; ns::fn(); valor :: Int',
    'proporção 3:1, placar 2:0',
  ].join('\n'));
  igual(r.ipv6, [], 'MAC, hora, "::" de código e proporções não viram IPv6');
  igual(r.ipv4, [], 'nem a data 2026-09-12 vira IPv4');
  igual(r.total, 0, 'nada extraído');
}

// ---------- 5. CIDR e faixas ----------

{
  const r = x.extrair('rotas 10.0.0.0/8 10.0.0.0/24 192.168.1.0/24 e 2001:db8::/32 e ::/0 e fe80::%lo0/64');
  igual(r.faixas, ['10.0.0.0/8', '10.0.0.0/24', '192.168.1.0/24', '::/0', '2001:db8::/32', 'fe80::/64'],
    'CIDR v4 e v6 em faixas; "::/0" (rota padrão) fica; zona antes do prefixo (netstat do macOS) funciona');
  igual([r.ipv4, r.ipv6], [[], []], 'o endereço do CIDR não se repete em ipv4/ipv6');

  const inv = x.extrair('erradas 10.0.0.1/33 e 2001:db8::1/129 e certa 10.0.0.2/32');
  igual(inv.faixas, ['10.0.0.2/32'], 'prefixo fora da faixa não vira CIDR');
  igual([inv.ipv4, inv.ipv6], [['10.0.0.1'], ['2001:db8::1']], 'mas o endereço entra solto');
  igual(inv.avisos.length, 2, 'com um aviso para cada');

  const f = x.extrair('pool 10.0.0.1-10.0.0.50 e 10.0.0.1-10.0.0.50 de novo, e 192.168.0.10-192.168.0.20');
  igual(f.faixas, ['10.0.0.1-10.0.0.50', '192.168.0.10-192.168.0.20'], 'faixa "a-b" em faixas');
  igual(f.ipv4, [], 'as pontas não se repetem em ipv4');
  igual(f.ocorrencias['10.0.0.1-10.0.0.50'], 2, 'faixa repetida conta');

  const rev = x.extrair('invertida 10.0.0.50-10.0.0.1 e quebrada 10.0.0.1-10.0.0.300');
  igual(rev.faixas, [], 'faixa invertida ou com fim inválido não vira faixa');
  igual(rev.ipv4, ['10.0.0.1', '10.0.0.50'], 'as pontas válidas entram soltas');
  igual(rev.avisos.length, 2, 'um aviso para cada');

  igual(x.extrair('10.0.0.1-10.0.0.50.7 e 10.0.0.1-2024').ipv4, ['10.0.0.1'],
    'fim de faixa colado a mais número, ou que não é IP, é ignorado sem levar o início junto');
}

// ---------- 6. Opções ----------

{
  const r = x.extrair('10.0.0.0/24 10.0.0.1-10.0.0.3 2001:db8::/32', { incluirFaixas: false });
  igual(r.faixas, [], 'incluirFaixas=false: nenhuma faixa');
  igual([r.ipv4, r.ipv6], [['10.0.0.0', '10.0.0.1', '10.0.0.3'], ['2001:db8::']], 'o endereço do CIDR e as pontas da faixa entram soltos');

  const p = x.extrair('8.8.8.8 10.0.0.1 127.0.0.1 169.254.1.1 100.64.0.1 192.0.2.1 224.0.0.1 ::1 fe80::1 fd00::1 2001:db8::1 2606:4700::1111 10.0.0.0/8 1.0.0.0/8',
    { incluirPrivados: false });
  igual([p.ipv4, p.ipv6, p.faixas], [['8.8.8.8'], ['2606:4700::1111'], ['1.0.0.0/8']],
    'incluirPrivados=false deixa só o público (inclusive nas faixas, pela ponta inicial)');
  igual(Object.keys(p.ocorrencias).length, 3, 'ocorrencias e classes acompanham o filtro');
}

// ---------- 7. Ordenação ----------

{
  const r = x.extrair('100.1.1.1 10.0.0.10 10.0.0.9 9.9.9.9 10.0.0.100 2.2.2.2 10.0.1.1');
  igual(r.ipv4, ['2.2.2.2', '9.9.9.9', '10.0.0.9', '10.0.0.10', '10.0.0.100', '10.0.1.1', '100.1.1.1'],
    'IPv4 em ordem numérica por octeto, não alfabética');
  const v6 = x.extrair('fe80::1 2001:db8::10 2001:db8::2 ::1 2001:db8::a 2001:db8:0:1::');
  igual(v6.ipv6, ['::1', '2001:db8::2', '2001:db8::a', '2001:db8::10', '2001:db8:0:1::', 'fe80::1'],
    'IPv6 pela forma expandida (::2 < ::a < ::10; 2001:db8::10 antes de 2001:db8:0:1::)');
  const fx = x.extrair('10.0.0.0/24 10.0.0.0/8 10.0.0.1-10.0.0.5 2001:db8::/32 1.0.0.0/8');
  igual(fx.faixas, ['1.0.0.0/8', '10.0.0.0/8', '10.0.0.0/24', '10.0.0.1-10.0.0.5', '2001:db8::/32'],
    'faixas pela ponta inicial; em empate a maior primeiro (/8 antes de /24); v4 antes de v6');
}

// ---------- 8. classificar() ----------

{
  igual(['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1'].map(x.classificar), ['privado', 'privado', 'privado', 'privado'], 'RFC 1918');
  igual(['172.15.0.1', '172.32.0.1', '8.8.8.8'].map(x.classificar), ['publico', 'publico', 'publico'], 'vizinhos do 172.16/12 são públicos');
  igual(x.classificar('127.0.0.1'), 'loopback', 'loopback');
  igual(x.classificar('169.254.10.1'), 'link-local', 'APIPA');
  igual([x.classificar('100.64.0.1'), x.classificar('100.127.255.254'), x.classificar('100.128.0.1')], ['cgnat', 'cgnat', 'publico'], 'CGNAT 100.64/10 e o vizinho');
  igual(['192.0.2.1', '198.51.100.1', '203.0.113.1'].map(x.classificar), ['documentacao', 'documentacao', 'documentacao'], 'RFC 5737');
  igual([x.classificar('224.0.0.1'), x.classificar('239.255.255.255')], ['multicast', 'multicast'], 'multicast 224/4');
  igual([x.classificar('0.0.0.0'), x.classificar('240.0.0.1'), x.classificar('255.255.255.255'), x.classificar('198.18.0.1')], ['reservado', 'reservado', 'reservado', 'reservado'], 'reservados');
  igual([x.classificar('::1'), x.classificar('fe80::1'), x.classificar('fd12::1'), x.classificar('fc00::'), x.classificar('ff02::1'), x.classificar('2001:db8::1'), x.classificar('::'), x.classificar('2606:4700::1111')],
    ['loopback', 'link-local', 'privado', 'privado', 'multicast', 'documentacao', 'reservado', 'publico'], 'classes IPv6');
  igual([x.classificar('10.0.0.0/8'), x.classificar('10.0.0.1-10.0.0.9'), x.classificar('[fe80::1%en0]:22')], ['privado', 'privado', 'link-local'],
    'aceita CIDR, faixa (ponta inicial), colchete, zona e porta');
  igual([x.classificar('300.1.1.1'), x.classificar('12:30:45'), x.classificar(''), x.classificar(null)], ['invalido', 'invalido', 'invalido', 'invalido'], 'lixo é "invalido"');
}

// ---------- 9. CSV e lista ----------

{
  const r = x.extrair('8.8.8.8 10.0.0.1 8.8.8.8 ::1 10.0.0.0/24 10.0.0.1-10.0.0.9');
  igual(x.csv(r).split('\n'), [
    'endereco,tipo,classe,ocorrencias',
    '8.8.8.8,ipv4,publico,2',
    '10.0.0.1,ipv4,privado,1',
    '::1,ipv6,loopback,1',
    '10.0.0.0/24,cidr,privado,1',
    '10.0.0.1-10.0.0.9,faixa,privado,1',
  ], 'CSV com cabeçalho, tipo (ipv4/ipv6/cidr/faixa), classe e contagem, na ordem da tela');
  igual(x.listaTexto(r), '8.8.8.8\n10.0.0.1\n::1\n10.0.0.0/24\n10.0.0.1-10.0.0.9', 'lista: um por linha, mesma ordem');
  igual(x.csv(x.extrair('')), 'endereco,tipo,classe,ocorrencias', 'CSV vazio é só o cabeçalho');
  igual(x.listaTexto(x.extrair('nada aqui')), '', 'lista vazia é string vazia');
}

// ---------- 10. Entradas estranhas e exemplo() ----------

{
  igual(x.extrair('').total, 0, 'string vazia');
  igual(x.extrair(null).total, 0, 'null não lança');
  igual(x.extrair(undefined).ipv4, [], 'undefined não lança');
  igual(x.extrair(12345).total, 0, 'número vira string e não é IP');

  const ex = x.exemplo();
  ok(typeof ex === 'string' && ex.includes('00:1a:2b:3c:4d:5e') && ex.includes('1.2.3.4.5') && ex.includes('300.1.1.1'),
    'o exemplo traz as armadilhas (MAC, versão, octeto > 255)');
  const r = x.extrair(ex);
  ok(r.ipv4.includes('8.8.8.8') && r.ipv4.includes('192.168.1.10') && r.ipv4.includes('100.64.3.1'), 'exemplo: IPv4 de log, traceroute e porta');
  ok(r.ipv6.includes('::1') && r.ipv6.includes('2001:db8::1') && r.ipv6.includes('::ffff:192.168.1.10'), 'exemplo: IPv6 loopback, colchete e mapeado');
  ok(r.faixas.includes('0.0.0.0/0') && r.faixas.includes('10.0.0.100-10.0.0.150') && r.faixas.includes('fe80::1a2b:3cff:fe4d:5e6f/64'), 'exemplo: CIDR v4/v6 e faixa');
  ok(!r.ipv6.some((e) => e.startsWith('0:1a:2b')) && !r.ipv4.includes('300.1.1.1') && !r.ipv4.includes('1.2.3.4'), 'exemplo: MAC, 300.1.1.1 e a versão ficam de fora');
  igual(r.ocorrencias['8.8.8.8'], 3, 'exemplo: 8.8.8.8 aparece 3 vezes no traceroute');
}

// ---------- 11. Saídas reais de comandos ----------

{
  // ifconfig lo0 no macOS, colado como está
  const ifc = [
    'lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384',
    '\toptions=1203<RXCSUM,TXCSUM,TXSTATUS,SW_TIMESTAMP>',
    '\tinet 127.0.0.1 netmask 0xff000000',
    '\tinet6 ::1 prefixlen 128 ',
    '\tinet6 fe80::1%lo0 prefixlen 64 scopeid 0x1 ',
    '\tnd6 options=201<PERFORMNUD,DAD>',
  ].join('\n');
  igual(x.extrair(ifc), {
    ipv4: ['127.0.0.1'], ipv6: ['::1', 'fe80::1'], faixas: [],
    classes: { '127.0.0.1': 'loopback', '::1': 'loopback', 'fe80::1': 'link-local' },
    ocorrencias: { '127.0.0.1': 1, '::1': 1, 'fe80::1': 1 },
    total: 3, totalOcorrencias: 3, avisos: [],
  }, 'ifconfig: netmask em hexa, "0x1" e flags não viram endereço');

  // netstat -rn -f inet6 no macOS
  const rotas = [
    'Internet6:',
    'Destination                             Gateway                                 Flags               Netif Expire',
    'default                                 fe80::%utun0                            UGcIg               utun0       ',
    '::1                                     ::1                                     UHL                   lo0       ',
    'fe80::%lo0/64                           fe80::1%lo0                             UcI                   lo0       ',
  ].join('\n');
  const rr = x.extrair(rotas);
  igual([rr.ipv6, rr.faixas], [['::1', 'fe80::', 'fe80::1'], ['fe80::/64']], 'tabela de rotas v6: "fe80::%utun0" é o endereço fe80:: e "fe80::%lo0/64" é CIDR');

  // traceroute (Linux) com nomes e asteriscos
  const tr = [
    'traceroute to one.one.one.one (1.1.1.1), 30 hops max, 60 byte packets',
    ' 1  _gateway (192.168.1.1)  0.512 ms  0.480 ms  0.466 ms',
    ' 2  100.64.0.1 (100.64.0.1)  9.144 ms  9.120 ms  9.101 ms',
    ' 3  * * *',
    ' 4  172.68.1.5 (172.68.1.5)  12.303 ms  12.280 ms  12.259 ms',
    ' 5  one.one.one.one (1.1.1.1)  12.011 ms  11.989 ms  11.967 ms',
  ].join('\n');
  const tt = x.extrair(tr);
  igual(tt.ipv4, ['1.1.1.1', '100.64.0.1', '172.68.1.5', '192.168.1.1'], 'traceroute: latências "0.512 ms" não viram IP');
  igual(tt.ocorrencias['1.1.1.1'], 2, 'e o destino conta 2 vezes (cabeçalho + último salto)');
}

// ---------- 12. Desempenho: linear em 2 MB ----------

{
  const linha = 'Sep 12 10:15:32 gw sshd[2231]: Accepted publickey for u from 192.168.1.10 port 51234 ssh2 fe80::1a2b:3cff:fe4d:5e6f%en0 [2001:db8::1]:443 00:1a:2b:3c:4d:5e 12:30:45 10.0.0.0/24 1.2.3.4.5\n';
  const partes = [];
  while (partes.join('').length < 1.5 * 1024 * 1024) partes.push(linha);
  // trechos que castigariam regex com backtracking: hexa contínuo, dígitos e
  // pontos sem fim, dois-pontos em sequência
  partes.push('deadbeef'.repeat(40000), '\n', '1.'.repeat(120000), '\n', ':'.repeat(100000), '\n', '1'.repeat(200000), '\n');
  const texto = partes.join('');
  ok(texto.length > 2 * 1024 * 1024, `texto de teste tem mais de 2 MB (${(texto.length / 1048576).toFixed(2)} MB)`);
  const t0 = Date.now();
  const r = x.extrair(texto);
  const dt = Date.now() - t0;
  ok(dt < 1000, `extrair() em 2 MB levou ${dt} ms (< 1000)`);
  igual([r.ipv4, r.ipv6, r.faixas], [['192.168.1.10'], ['2001:db8::1', 'fe80::1a2b:3cff:fe4d:5e6f'], ['10.0.0.0/24']], 'e o resultado continua certo no texto grande');
  ok(r.ocorrencias['192.168.1.10'] > 8000, `contagem acompanha (${r.ocorrencias['192.168.1.10']} ocorrências)`);
}

// ---------- 13. Revisão: o que a API prometia e não fazia ----------

{
  // classificar() é chamado com o texto da lista como está: colchete+porta
  // sem zona e IPv4:porta não podiam dar "invalido".
  igual([x.classificar('[2001:db8::1]:443'), x.classificar('[10.0.0.1]:22'), x.classificar('10.0.0.1:22'), x.classificar('[::]:80')],
    ['documentacao', 'privado', 'privado', 'reservado'], 'colchete com porta sem zona e IPv4 com porta classificam');
  igual([x.classificar('2001:db8::1:443'), x.classificar('10.0.0.1:22:33')], ['documentacao', 'invalido'],
    '"2001:db8::1:443" é IPv6 inteiro (não porta); dois ":" depois de IPv4 é lixo');

  // saída REAL de `ss -tln` no Linux: "[::]" é o "qualquer endereço" v6 e
  // aparece em todo servidor; "127.0.0.53%lo:53" é o resolver do systemd.
  const ss = [
    'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
    'LISTEN 0      128          0.0.0.0:22         0.0.0.0:*',
    'LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*',
    'LISTEN 0      128             [::]:22            [::]:*',
    'LISTEN 0      511            [::1]:631          [::]:*',
  ].join('\n');
  const r = x.extrair(ss);
  igual([r.ipv4, r.ipv6, r.faixas], [['0.0.0.0', '127.0.0.53'], ['::', '::1'], []], 'ss: "[::]" entre colchetes É endereço; zona "%lo" em IPv4 não atrapalha');
  igual([r.ocorrencias['::'], r.ocorrencias['0.0.0.0']], [3, 3], 'e conta cada "[::]:porta"');
  igual(x.extrair('std::string a; ns::b(); x :: y').ipv6, [], 'mas "::" solto continua sendo código, não endereço');

  // CIDR com bits de host: a classe é do endereço ESCRITO, igual a classificar().
  const c = x.extrair('172.16.0.1/8 100.127.0.1/9 10.0.0.0/8');
  igual(c.classes, { '10.0.0.0/8': 'privado', '100.127.0.1/9': 'cgnat', '172.16.0.1/8': 'privado' },
    'classe do CIDR pela ponta escrita (172.16.0.1 é privado, não a rede 172.0.0.0)');
  igual(c.classes['172.16.0.1/8'], x.classificar('172.16.0.1/8'), 'extrair() e classificar() concordam');
  igual(c.faixas, ['10.0.0.0/8', '100.127.0.1/9', '172.16.0.1/8'], 'e a ordem continua pela rede');

  // Helpers internos e exportação não lançam com lixo.
  igual([x._v4ParaNum(null), x._v4ParaNum(undefined), x._v4ParaNum(5), x._v4ParaNum('')], [null, null, null, null], '_v4ParaNum defensivo');
  igual([x._v6ParaBig(null), x._v6ParaBig(undefined), x._v6ParaBig(5), x._v6ParaBig({}), x._v6ParaBig('')], [null, null, null, null, null], '_v6ParaBig defensivo');
  igual([x._bigParaV6(null), x._bigParaV6(undefined), x._bigParaV6(5), x._bigParaV6(-1n), x._bigParaV6(1n << 128n)], [null, null, null, null, null], '_bigParaV6 defensivo');
  igual(x._bigParaV6((1n << 128n) - 1n), 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'e o maior endereço válido ainda passa');
  igual(x.csv(null), 'endereco,tipo,classe,ocorrencias', 'csv(null)');
  igual(x.csv(42), 'endereco,tipo,classe,ocorrencias', 'csv(42)');
  igual(x.csv({ faixas: [1], ipv4: 'ab' }), 'endereco,tipo,classe,ocorrencias\n1,faixa,invalido,0',
    'csv com resultado estranho: número vira string, campo que não é array é ignorado');
  igual(x.listaTexto(undefined), '', 'listaTexto(undefined)');

  // Teto de avisos.
  let t = '';
  for (let i = 1; i <= 60; i += 1) t += `10.0.0.${i}/33 `;
  const a = x.extrair(t);
  igual([a.avisos.length, a.avisos[x.MAX_AVISOS]], [x.MAX_AVISOS + 1, '…e mais 10 aviso(s).'], '60 avisos distintos → 50 + "…e mais 10"');
  igual(a.ipv4.length, 60, 'e os 60 endereços entraram soltos');
  const g = x.extrair(`${'1.'.repeat(50000)}1 x`);
  ok(g.avisos.length === 1 && g.avisos[0].length < 300, `aviso do trecho colado é curto mesmo com 100 KB de "1.1.1…" (${g.avisos[0].length} chars)`);
}

// ---------- 14. ipconfig do Windows (pt-BR) ----------

{
  const ipc = [
    'Adaptador Ethernet Ethernet:',
    '',
    '   Sufixo DNS específico de conexão. . . . . . : lan',
    '   Endereço IPv6 . . . . . . . . . . . . . . . : 2001:db8:1:2:3:4:5:6(Preferencial)',
    '   Endereço IPv6 de Link Local . . . . . . . . : fe80::a1b2:c3d4:e5f6:1234%12(Preferencial)',
    '   Endereço IPv4. . . . . . . . . . . . . . . . : 192.168.15.7(Preferencial)',
    '   Máscara de Sub-rede . . . . . . . . . . . . : 255.255.255.0',
    '   Gateway Padrão. . . . . . . . . . . . . . . : fe80::1%12',
    '                                                 192.168.15.1',
  ].join('\n');
  const r = x.extrair(ipc);
  igual([r.ipv4, r.ipv6], [['192.168.15.1', '192.168.15.7', '255.255.255.0'], ['2001:db8:1:2:3:4:5:6', 'fe80::1', 'fe80::a1b2:c3d4:e5f6:1234']],
    'ipconfig: ". . . :" não vira endereço, "(Preferencial)" colado e zona numérica "%12" saem');
  igual(r.avisos, [], 'sem avisos');
}

// ---------- 15. Desempenho: padrões adversos de 1 MB ----------

{
  // Cada padrão castiga um pedaço diferente das regex: só "::", grupos hexa
  // sem fim, faixa/porta/prefixo colados, colchetes repetidos.
  const padroes = ['a:', '::', '1.2.3.4-', '1.2.3.4:', '1.2.3.4/', '1:1:1:1:1:1:1:1:', '[::1]:', 'fe80::1 ', '12345.', '.1'];
  for (const s of padroes) {
    const txt = s.repeat(Math.ceil((1024 * 1024) / s.length));
    const t0 = Date.now();
    x.extrair(txt);
    const dt = Date.now() - t0;
    ok(dt < 1500, `1 MB de "${s}" em ${dt} ms (< 1500)`);
  }
}

console.log(`\n${n} verificações passaram`);
