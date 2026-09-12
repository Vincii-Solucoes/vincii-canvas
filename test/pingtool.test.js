'use strict';

// Ferramenta Ping — comando por plataforma, parse da saída de cada
// implementação que aparece em campo e estatísticas. Tudo puro: as fixtures
// são saídas REAIS (macOS colado desta máquina; as outras no formato fiel de
// cada implementação), então o que trava aqui é o parser ler certo o que o
// ping de verdade imprime — inclusive as armadilhas: seq faltando no iputils,
// "Request timeout" do macOS, "Destination host unreachable" que o Windows
// conta como recebido, "time<1ms", RouterOS v7 com microssegundos.

const assert = require('assert');
const p = require('../lib/pingtool');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };
const perto = (a, b, m, eps = 0.001) => { assert.ok(Math.abs(a - b) <= eps, `${m} (${a} ≠ ${b})`); n += 1; };

// ---------- 1. validarAlvo ----------

{
  ok(p.validarAlvo('8.8.8.8'), 'IPv4 vale');
  ok(p.validarAlvo('2001:db8::1'), 'IPv6 comprimido vale');
  ok(p.validarAlvo('::1'), 'loopback IPv6 vale');
  ok(p.validarAlvo('dns.google') && p.validarAlvo('core-01.rede_interna.local'), 'hostname RFC 1123 (com hífen e underscore) vale');
  ok(p.validarAlvo('localhost'), 'label único vale');
  ok(!p.validarAlvo('8.8.8.8; rm -rf /'), 'injeção de shell é recusada');
  ok(!p.validarAlvo('8.8.8.8 -f') && !p.validarAlvo('a"b') && !p.validarAlvo("a'b"), 'espaço e aspas são recusados');
  ok(!p.validarAlvo('-f') && !p.validarAlvo('-8.8.8.8'), 'traço inicial (viraria opção do ping) é recusado');
  ok(!p.validarAlvo('999.1.1.1'), 'octeto > 255 não vira hostname por acidente');
  ok(!p.validarAlvo('10.0.0'), 'TLD numérico é recusado');
  ok(!p.validarAlvo('2001:db8:::1') && !p.validarAlvo('gggg::1'), 'IPv6 malformado é recusado');
  ok(!p.validarAlvo('') && !p.validarAlvo(null) && !p.validarAlvo('a.'.repeat(130)), 'vazio, null e > 253 chars são recusados');
  ok(!p.validarAlvo('-.com') && !p.validarAlvo('a-.com'), 'label começando/terminando com hífen é recusado');
}

// ---------- 2. comandoPing por plataforma ----------

{
  const mac = p.comandoPing('8.8.8.8', { pacotes: 5, intervaloMs: 500, tamanho: 64, timeoutMs: 1500 }, 'darwin');
  igual(mac.args, ['-c', '5', '-i', '0.5', '-s', '64', '-W', '1500', '8.8.8.8'], 'macOS: -c/-i fracionário/-s/-W em ms');
  igual(mac.linha, 'ping -c 5 -i 0.5 -s 64 -W 1500 8.8.8.8', 'macOS: linha única para o SSH');
  igual(mac.avisos, [], 'macOS: 0,5 s não gera aviso');
  const macRapido = p.comandoPing('8.8.8.8', { intervaloMs: 50 }, 'darwin');
  igual(macRapido.args[3], '0.1', 'macOS: intervalo abaixo do piso sobe para 0,1 s');
  igual(macRapido.avisos.length, 1, 'macOS: e avisa o ajuste');

  const lin = p.comandoPing('dns.google', { pacotes: 10, intervaloMs: 500, tamanho: 56, timeoutMs: 2000 }, 'linux');
  igual(lin.args, ['-c', '10', '-i', '0.5', '-s', '56', '-W', '2', 'dns.google'], 'Linux iputils: -W em segundos inteiros');
  igual(p.comandoPing('1.1.1.1', { intervaloMs: 100 }, 'linux').args[3], '0.2', 'Linux: piso de 0,2 s sem root');
  igual(p.comandoPing('1.1.1.1', { timeoutMs: 2500 }, 'linux').args[7], '3', 'Linux: timeout arredonda para cima (2,5 s → 3 s)');

  const bb = p.comandoPing('192.168.1.1', { pacotes: 4, intervaloMs: 500, tamanho: 56, timeoutMs: 2000 }, 'busybox');
  igual(bb.args, ['-c', '4', '-i', '1', '-s', '56', '-W', '2', '192.168.1.1'], 'BusyBox: intervalo inteiro (0,5 s vira 1 s)');
  ok(bb.avisos.some((a) => /arredondado/.test(a)), 'BusyBox: avisa o arredondamento');

  const win = p.comandoPing('8.8.8.8', { pacotes: 10, tamanho: 32, timeoutMs: 2000 }, 'win32');
  igual(win.args, ['-n', '10', '-l', '32', '-w', '2000', '8.8.8.8'], 'Windows: -n/-l/-w');
  igual(win.linha, 'ping -n 10 -l 32 -w 2000 8.8.8.8', 'Windows: linha');
  ok(win.avisos.some((a) => /intervalo/.test(a)), 'Windows: avisa que não há intervalo');
  igual(p.comandoPing('8.8.8.8', { intervaloMs: 1000 }, 'win32').avisos, [], 'Windows: com 1 s (o fixo) não avisa');

  const ros = p.comandoPing('8.8.8.8', { pacotes: 10, intervaloMs: 500, tamanho: 56 }, 'routeros');
  igual(ros.linha, '/ping 8.8.8.8 count=10 interval=0.5 size=56', 'RouterOS: comando interno do MikroTik');
  igual(ros.cmd, '/ping', 'RouterOS: cmd é /ping');

  const pad = p.comandoPing('8.8.8.8', undefined, 'linux');
  igual(pad.args.slice(0, 8), ['-c', '10', '-i', '0.5', '-s', '56', '-W', '2'], 'opções ausentes caem no padrão');
  igual(p.comandoPing('8.8.8.8', { pacotes: 99999 }, 'linux').args[1], '1000', 'pacotes é limitado a 1000');

  ok(p.comandoPing('8.8.8.8; rm -rf /', {}, 'linux').erro, 'alvo inválido → erro, nunca linha');
  ok(p.comandoPing('8.8.8.8', {}, 'solaris').erro, 'plataforma desconhecida → erro');
  igual(p.comandoPing(' 8.8.8.8 ', {}, 'linux').args[8], '8.8.8.8', 'espaço em volta do alvo é aparado');
  const v6 = p.comandoPing('2001:4860:4860::8888', {}, 'darwin');
  igual(v6.args[8], '2001:4860:4860::8888', 'IPv6 passa inteiro como alvo');
}

// ---------- 3. parse: macOS (saída real desta máquina) ----------

{
  const txt = `PING 127.0.0.1 (127.0.0.1): 56 data bytes
64 bytes from 127.0.0.1: icmp_seq=0 ttl=64 time=0.062 ms
64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=0.165 ms
64 bytes from 127.0.0.1: icmp_seq=2 ttl=64 time=0.127 ms

--- 127.0.0.1 ping statistics ---
3 packets transmitted, 3 packets received, 0.0% packet loss
round-trip min/avg/max/stddev = 0.062/0.118/0.165/0.043 ms
`;
  const r = p.parsePing(txt);
  igual(r.implementacao, 'macos', 'macOS detectado pelo cabeçalho "56 data bytes" + stddev');
  igual(r.alvo, '127.0.0.1', 'alvo do cabeçalho');
  igual([r.enviados, r.recebidos, r.perdidos, r.perdaPct], [3, 3, 0, 0], 'contagem do rodapé');
  igual(r.rtts, [0.062, 0.165, 0.127], 'rtts na ordem de chegada');
  igual(r.seqs[0], { seq: 0, ttl: 64, ms: 0.062, estado: 'ok' }, 'seq 0 com ttl e tempo');
  igual(r.resumo, { min: 0.062, avg: 0.118, max: 0.165, mdev: 0.043 }, 'rodapé min/avg/max/stddev');

  // saída real: sem rota, -W 1000 (o macOS não imprime timeout para o último)
  const perdaTotal = p.parsePing(`PING 10.255.255.1 (10.255.255.1): 56 data bytes
Request timeout for icmp_seq 0

--- 10.255.255.1 ping statistics ---
2 packets transmitted, 0 packets received, 100.0% packet loss
`);
  igual([perdaTotal.enviados, perdaTotal.recebidos, perdaTotal.perdaPct], [2, 0, 100], 'macOS 100% de perda: rodapé manda (2 enviados, só 1 timeout impresso)');
  igual(perdaTotal.seqs, [{ seq: 0, ttl: null, ms: null, estado: 'timeout' }], '"Request timeout for icmp_seq 0" vira seq perdida');
  igual(perdaTotal.resumo.min, null, 'sem resposta não há rodapé de rtt');

  const parcial = p.parsePing(`PING 8.8.8.8 (8.8.8.8): 56 data bytes
64 bytes from 8.8.8.8: icmp_seq=0 ttl=117 time=12.345 ms
Request timeout for icmp_seq 1
64 bytes from 8.8.8.8: icmp_seq=2 ttl=117 time=13.001 ms

--- 8.8.8.8 ping statistics ---
3 packets transmitted, 2 packets received, 33.3% packet loss
round-trip min/avg/max/stddev = 12.345/12.673/13.001/0.328 ms
`);
  igual([parcial.perdidos, parcial.perdaPct], [1, 33.3], 'macOS perda parcial: 1/3 = 33,3%');
  igual(parcial.seqs.map((s) => s.estado), ['ok', 'timeout', 'ok'], 'seqs em ordem com o timeout no meio');
}

// ---------- 4. parse: Linux iputils ----------

{
  const txt = `PING dns.google (8.8.8.8) 56(84) bytes of data.
64 bytes from dns.google (8.8.8.8): icmp_seq=1 ttl=117 time=12.3 ms
64 bytes from dns.google (8.8.8.8): icmp_seq=2 ttl=117 time=11.9 ms
64 bytes from dns.google (8.8.8.8): icmp_seq=4 ttl=117 time=12.1 ms

--- dns.google ping statistics ---
4 packets transmitted, 3 received, 25% packet loss, time 3004ms
rtt min/avg/max/mdev = 11.900/12.100/12.300/0.163 ms
`;
  const r = p.parsePing(txt);
  igual(r.implementacao, 'iputils', 'iputils detectado por "bytes of data."');
  igual(r.alvo, 'dns.google', 'alvo com hostname');
  igual([r.enviados, r.recebidos, r.perdidos, r.perdaPct], [4, 3, 1, 25], 'timeout SILENCIOSO (seq 3 faltando) conta como perda pelo rodapé');
  igual(r.seqs.map((s) => s.seq), [1, 2, 4], 'seqs presentes (numeração começa em 1)');
  igual(r.resumo, { min: 11.9, avg: 12.1, max: 12.3, mdev: 0.163 }, 'rodapé rtt/mdev');

  const inacess = p.parsePing(`PING 192.168.50.9 (192.168.50.9) 56(84) bytes of data.
From 192.168.50.1 icmp_seq=1 Destination Host Unreachable
From 192.168.50.1 icmp_seq=2 Destination Host Unreachable
From 192.168.50.1 icmp_seq=3 Destination Host Unreachable

--- 192.168.50.9 ping statistics ---
3 packets transmitted, 0 received, +3 errors, 100% packet loss, time 2047ms
pipe 3
`);
  igual([inacess.recebidos, inacess.perdaPct], [0, 100], 'Destination Host Unreachable: 100% de perda, "+3 errors" não atrapalha o rodapé');
  igual(inacess.seqs.map((s) => s.estado), ['inacessivel', 'inacessivel', 'inacessivel'], 'linhas "From ..." viram estado inacessivel');

  const v6 = p.parsePing(`PING 2001:4860:4860::8888(2001:4860:4860::8888) 56 data bytes
64 bytes from 2001:4860:4860::8888: icmp_seq=1 ttl=118 time=15.1 ms
64 bytes from 2001:4860:4860::8888: icmp_seq=2 ttl=118 time=15.4 ms (DUP!)
64 bytes from 2001:4860:4860::8888: icmp_seq=2 ttl=118 time=15.9 ms

--- 2001:4860:4860::8888 ping statistics ---
2 packets transmitted, 2 received, +1 duplicates, 0% packet loss, time 1001ms
rtt min/avg/max/mdev = 15.100/15.466/15.900/0.330 ms
`);
  igual(v6.rtts, [15.1, 15.4], 'IPv6 (":" dentro do host) parseia; DUP da mesma seq não entra duas vezes');
  igual([v6.enviados, v6.recebidos], [2, 2], '"+1 duplicates" no rodapé não quebra a contagem');

  // processo morto no meio: só linhas de resposta, sem rodapé
  const truncado = p.parsePing(`PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.
64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=12.3 ms
64 bytes from 8.8.8.8: icmp_seq=3 ttl=117 time=12.1 ms
`);
  igual([truncado.enviados, truncado.recebidos, truncado.perdidos], [3, 2, 1], 'sem rodapé: conta da base (1) até a maior seq; o buraco é perda');
  igual(truncado.resumo, { min: null, avg: null, max: null, mdev: null }, 'sem rodapé: resumo nulo (estatisticas() cobre)');
}

// ---------- 5. parse: BusyBox ----------

{
  const r = p.parsePing(`PING 8.8.8.8 (8.8.8.8): 56 data bytes
64 bytes from 8.8.8.8: seq=0 ttl=117 time=12.345 ms
64 bytes from 8.8.8.8: seq=1 ttl=117 time=11.987 ms
64 bytes from 8.8.8.8: seq=3 ttl=117 time=12.166 ms

--- 8.8.8.8 ping statistics ---
4 packets transmitted, 3 packets received, 25% packet loss
round-trip min/avg/max = 11.987/12.166/12.345 ms
`);
  igual(r.implementacao, 'busybox', 'BusyBox detectado por "seq=" sem icmp_ e rodapé sem stddev');
  igual([r.enviados, r.recebidos, r.perdidos], [4, 3, 1], 'BusyBox: contagem');
  igual(r.resumo, { min: 11.987, avg: 12.166, max: 12.345, mdev: null }, 'BusyBox: rodapé sem mdev');
  igual(r.seqs[1].ttl, 117, 'BusyBox: ttl lido');
}

// ---------- 6. parse: Windows en-US ----------

{
  const r = p.parsePing(`\r
Pinging dns.google [8.8.8.8] with 32 bytes of data:\r
Reply from 8.8.8.8: bytes=32 time=12ms TTL=117\r
Reply from 8.8.8.8: bytes=32 time<1ms TTL=117\r
Request timed out.\r
Reply from 8.8.8.8: bytes=32 time=13ms TTL=117\r
\r
Ping statistics for 8.8.8.8:\r
    Packets: Sent = 4, Received = 3, Lost = 1 (25% loss),\r
Approximate round trip times in milli-seconds:\r
    Minimum = 12ms, Maximum = 13ms, Average = 12ms\r
`);
  igual(r.implementacao, 'windows', 'Windows en-US detectado');
  igual(r.alvo, 'dns.google', 'alvo do "Pinging x [ip]"');
  igual([r.enviados, r.recebidos, r.perdidos, r.perdaPct], [4, 3, 1, 25], 'Windows: contagem (CRLF não atrapalha)');
  igual(r.rtts, [12, 0, 13], '"time<1ms" vira 0');
  igual(r.seqs[2], { seq: 3, ttl: null, ms: null, estado: 'timeout' }, '"Request timed out." é a 3ª seq perdida');
  igual(r.resumo, { min: 12, avg: 12, max: 13, mdev: null }, 'Windows: rodapé Minimum/Maximum/Average (ordem diferente da Unix)');

  // a armadilha: o gateway responde "unreachable" e o Windows conta como Received
  const gw = p.parsePing(`
Pinging 192.168.50.9 with 32 bytes of data:
Reply from 192.168.50.1: Destination host unreachable.
Reply from 192.168.50.1: Destination host unreachable.

Ping statistics for 192.168.50.9:
    Packets: Sent = 2, Received = 2, Lost = 0 (0% loss),
`);
  igual([gw.recebidos, gw.perdidos, gw.perdaPct], [0, 2, 100], '"Reply from gateway: Destination host unreachable" é PERDA, apesar do rodapé dizer Received = 2');
  igual(gw.seqs.map((s) => s.estado), ['inacessivel', 'inacessivel'], 'estado inacessivel');

  const v6 = p.parsePing(`
Pinging 2001:4860:4860::8888 with 32 bytes of data:
Reply from 2001:4860:4860::8888: time=15ms
Reply from 2001:4860:4860::8888: time=16ms

Ping statistics for 2001:4860:4860::8888:
    Packets: Sent = 2, Received = 2, Lost = 0 (0% loss),
Approximate round trip times in milli-seconds:
    Minimum = 15ms, Maximum = 16ms, Average = 15ms
`);
  igual(v6.rtts, [15, 16], 'Windows IPv6: sem bytes= e sem TTL, ainda lê o tempo');
  igual(v6.seqs[0].ttl, null, 'Windows IPv6: ttl null');
}

// ---------- 7. parse: Windows pt-BR ----------

{
  const r = p.parsePing(`
Disparando 8.8.8.8 com 32 bytes de dados:
Resposta de 8.8.8.8: bytes=32 tempo=12ms TTL=117
Resposta de 8.8.8.8: bytes=32 tempo<1ms TTL=117
Esgotado o tempo limite do pedido.
Resposta de 8.8.8.8: bytes=32 tempo=13,5ms TTL=117

Estatísticas do Ping para 8.8.8.8:
    Pacotes: Enviados = 4, Recebidos = 3, Perdidos = 1 (25% de
             perda),
Aproximar um número redondo de vezes em milissegundos:
    Mínimo = 12ms, Máximo = 13ms, Média = 12ms
`);
  igual(r.implementacao, 'windows', 'Windows pt-BR detectado');
  igual(r.alvo, '8.8.8.8', 'alvo do "Disparando"');
  igual([r.enviados, r.recebidos, r.perdidos, r.perdaPct], [4, 3, 1, 25], 'pt-BR: "Perdidos = 1 (25% de\\n perda)" quebrado em duas linhas não atrapalha');
  igual(r.rtts, [12, 0, 13.5], 'pt-BR: "tempo<1ms" → 0 e vírgula decimal "13,5ms" → 13.5');
  igual(r.resumo, { min: 12, avg: 12, max: 13, mdev: null }, 'pt-BR: Mínimo/Máximo/Média');

  // acentos estragados (cp850 chegando pelo SSH) não podem cegar o parser
  const mojibake = p.parsePing(`
Disparando 8.8.8.8 com 32 bytes de dados:
Resposta de 8.8.8.8: bytes=32 tempo=9ms TTL=117

Estat�sticas do Ping para 8.8.8.8:
    Pacotes: Enviados = 1, Recebidos = 1, Perdidos = 0 (0% de perda),
Aproximar um n�mero redondo de vezes em milissegundos:
    M�nimo = 9ms, M�ximo = 9ms, M�dia = 9ms
`);
  igual([mojibake.recebidos, mojibake.resumo.min], [1, 9], 'pt-BR com acento quebrado ainda lê rodapé e rtt');

  const inacess = p.parsePing(`
Disparando 192.168.50.9 com 32 bytes de dados:
Resposta de 192.168.50.1: Host de destino inacessível.
Resposta de 192.168.50.1: Host de destino inacessível.

Estatísticas do Ping para 192.168.50.9:
    Pacotes: Enviados = 2, Recebidos = 2, Perdidos = 0 (0% de perda),
`);
  igual([inacess.recebidos, inacess.perdaPct], [0, 100], 'pt-BR: "Host de destino inacessível" é perda');
}

// ---------- 8. parse: RouterOS ----------

{
  const r = p.parsePing(`  SEQ HOST                                     SIZE TTL TIME  STATUS
    0 8.8.8.8                                    56 117 12ms
    1 8.8.8.8                                    56 117 11ms
    2 8.8.8.8                                                 timeout
    3 8.8.8.8                                    56 117 13ms
    sent=4 received=3 packet-loss=25% min-rtt=11ms avg-rtt=12ms max-rtt=13ms
`);
  igual(r.implementacao, 'routeros', 'RouterOS detectado pelo cabeçalho SEQ HOST');
  igual(r.alvo, '8.8.8.8', 'alvo da coluna HOST');
  igual([r.enviados, r.recebidos, r.perdidos, r.perdaPct], [4, 3, 1, 25], 'RouterOS: rodapé sent/received');
  igual(r.rtts, [12, 11, 13], 'RouterOS v6: TIME em ms inteiros');
  igual(r.seqs[2], { seq: 2, ttl: null, ms: null, estado: 'timeout' }, 'linha "timeout" sem SIZE/TTL/TIME vira seq perdida');
  igual(r.resumo, { min: 11, avg: 12, max: 13, mdev: null }, 'RouterOS: min/avg/max-rtt');

  // v7 imprime microssegundos e às vezes chega com \r e escape ANSI pelo SSH
  const v7 = p.parsePing(`\x1b[?7h  SEQ HOST                                     SIZE TTL TIME       STATUS\r
    0 10.0.0.1                                   56  64 1ms234us\r
    1 10.0.0.1                                   56  64 987us\r
    sent=2 received=2 packet-loss=0% min-rtt=987us avg-rtt=1ms110us max-rtt=1ms234us\r
`);
  igual(v7.rtts, [1.234, 0.987], 'RouterOS v7: "1ms234us" e "987us" viram ms decimais');
  perto(v7.resumo.avg, 1.11, 'RouterOS v7: rodapé com microssegundos');
  igual(p._tempoRos('2s5ms'), 2005, '"2s5ms" → 2005 ms');
  igual(p._tempoRos('abc'), null, 'tempo RouterOS inválido → null');

  const semRota = p.parsePing(`  SEQ HOST                                     SIZE TTL TIME  STATUS
    0 10.9.9.9                                                 host unreachable
    1 10.9.9.9                                                 host unreachable
    sent=2 received=0 packet-loss=100%
`);
  igual([semRota.recebidos, semRota.perdaPct], [0, 100], 'RouterOS: "host unreachable" → 100% de perda');
  igual(semRota.seqs[0].estado, 'inacessivel', 'RouterOS: estado inacessivel');
}

// ---------- 9. parse: saída vazia e lixo ----------

{
  const v = p.parsePing('');
  igual(v.implementacao, 'desconhecida', 'saída vazia → implementação desconhecida');
  igual([v.enviados, v.recebidos, v.perdidos, v.perdaPct], [0, 0, 0, null], 'saída vazia → zeros e perda null (não 100%)');
  igual(v.rtts, [], 'saída vazia → sem rtts');
  const lixo = p.parsePing('ping: cannot resolve nao.existe.invalid: Unknown host\n');
  igual([lixo.implementacao, lixo.enviados], ['desconhecida', 0], 'erro de resolução não vira pacote');
  igual(p.parsePing(null).rtts, [], 'null não quebra');
  igual(p._detectar('64 bytes from 8.8.8.8: icmp_seq=0 ttl=117 time=12.3 ms\n'), 'macos', 'só respostas, seq 0 → macOS');
  igual(p._detectar('64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=12.3 ms\n'), 'iputils', 'só respostas, seq 1 → iputils');
}

// ---------- 10. estatisticas (calculado à mão) ----------

{
  const e = p.estatisticas([10, 12, 11, 15]);
  igual([e.min, e.max], [10, 15], 'min/max');
  igual(e.avg, 12, 'média (10+12+11+15)/4 = 12');
  // desvios -2, 0, -1, 3 → quadrados 4+0+1+9 = 14 → 14/4 = 3,5 → √3,5
  perto(e.mdev, Math.sqrt(3.5), 'mdev populacional = √3,5');
  // |12-10| + |11-12| + |15-11| = 2+1+4 = 7 → 7/3
  perto(e.jitter, 7 / 3, 'jitter = média dos |Δ| consecutivos = 7/3');
  igual(e.mediana, 11.5, 'mediana de par de amostras é a média dos dois do meio');
  igual(e.p95, 15, 'p95 nearest-rank com 4 amostras = a maior');

  igual(p.estatisticas([5, 5, 5]).jitter, 0, 'amostras iguais → jitter 0');
  igual(p.estatisticas([5, 5, 5]).mdev, 0, 'amostras iguais → mdev 0');
  igual(p.estatisticas([7]), { min: 7, avg: 7, max: 7, mdev: 0, jitter: 0, mediana: 7, p95: 7 }, 'uma amostra: jitter 0 (sem Δ), não null');
  igual(p.estatisticas([]), { min: null, avg: null, max: null, mdev: null, jitter: null, mediana: null, p95: null }, 'vazio → tudo null');
  igual(p.estatisticas(null), p.estatisticas([]), 'null → como vazio');
  // jitter é na ordem de CHEGADA: ordenado seria 1+1+1=3/3=1, real é 2+3+1=6/3=2
  igual(p.estatisticas([1, 3, 0, 1]).jitter, 2, 'jitter usa a ordem de chegada, não a ordenada');
  const cem = p.estatisticas(Array.from({ length: 100 }, (_, i) => i + 1));
  igual([cem.mediana, cem.p95], [50.5, 95], '100 amostras 1..100: mediana 50,5 e p95 = 95');
  igual(p.estatisticas([0.1, 0.2, 0.3]).avg, 0.2, 'arredonda a 3 casas (sem 0.20000000000000004)');
}

// ---------- 11. resumoTexto ----------

{
  const r = p.parsePing(`PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.
64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=1.2 ms
64 bytes from 8.8.8.8: icmp_seq=2 ttl=117 time=1.8 ms
64 bytes from 8.8.8.8: icmp_seq=3 ttl=117 time=3.1 ms

--- 8.8.8.8 ping statistics ---
3 packets transmitted, 3 received, 0% packet loss, time 2003ms
rtt min/avg/max/mdev = 1.200/2.033/3.100/0.802 ms
`);
  // jitter: |1.8-1.2| + |3.1-1.8| = 0.6 + 1.3 = 1.9 / 2 = 0.95 → "1.0"
  igual(p.resumoTexto(r, 'core-01'), '8.8.8.8 via core-01: 3/3, perda 0%, min/avg/max 1.2/2.0/3.1 ms, jitter 1.0 ms', 'linha pronta para o chamado');
  igual(p.resumoTexto(r), '8.8.8.8: 3/3, perda 0%, min/avg/max 1.2/2.0/3.1 ms, jitter 1.0 ms', 'sem rótulo (ping local) omite o "via"');

  const morto = p.parsePing(`PING 10.255.255.1 (10.255.255.1): 56 data bytes
Request timeout for icmp_seq 0

--- 10.255.255.1 ping statistics ---
2 packets transmitted, 0 packets received, 100.0% packet loss
`);
  igual(p.resumoTexto(morto, 'core-01'), '10.255.255.1 via core-01: 0/2, perda 100%, sem resposta', 'perda total: sem min/avg/max inventado');
  igual(p.resumoTexto({ alvo: null, rtts: [] }, 'x'), '? via x: 0/0, perda 0%, sem resposta', 'resultado sem nada não quebra');
}

// ---------- 12. robustez: lixo, entradas hostis e volume ----------

{
  // Zero à esquerda: inet_aton lê como octal e o ping iria para 8.0.0.1.
  ok(!p.validarAlvo('010.0.0.1') && !p.validarAlvo('01.2.3.4'), 'IPv4 com zero à esquerda (octal) é recusado');
  ok(p.validarAlvo('10.0.0.0') && p.validarAlvo('0.0.0.0') && p.validarAlvo('100.200.30.40'), '"0" sozinho e "100" continuam válidos');
  ok(p.comandoPing(['8.8.8.8'], {}, 'linux').erro, 'alvo que não é string (array) → erro, não String() disfarçado');
  igual(p._normalizarOpcoes({ pacotes: true, intervaloMs: [], tamanho: {}, timeoutMs: [5] }), p.PADRAO, 'booleano/array/objeto nas opções caem no padrão (não viram 1 e 5)');
  igual(p._normalizarOpcoes({ pacotes: '5', intervaloMs: ' 300 ' }).pacotes, 5, 'string numérica (vinda do formulário) é aceita');

  // null no meio dos rtts (timeout) NÃO pode virar 0 ms e puxar o mínimo.
  igual(p.estatisticas([null, 'a', 5, '6']).min, 5, 'null e texto nos rtts são ignorados, não contados como 0');
  igual(p.estatisticas([true, [1]]).min, null, 'booleano e array não são amostras');

  igual(p.resumoTexto({ alvo: 'a', rtts: [1], perdaPct: NaN }), 'a: 0/0, perda 0%, min/avg/max 1.0/1.0/1.0 ms, jitter 0.0 ms', 'perdaPct NaN é recalculado, nunca "perda NaN%"');
  igual(p.resumoTexto({ rtts: 'x', enviados: 'a', recebidos: -3 }), '?: 0/0, perda 0%, sem resposta', 'campos com lixo não quebram a linha');
  ok(/2\/2, perda 0%/.test(p.resumoTexto({ alvo: 'a', rtts: [1, 2], enviados: 1, recebidos: 2 })), 'recebidos > enviados não gera perda negativa');

  // Regex sem backtracking catastrófico: 1 MB de entrada repetitiva tem de
  // parsear em milissegundos. Os três padrões abaixo travavam o processo
  // (rodapé sem âncora: 12 s; "^\s*" com flag m em linhas em branco: minutos).
  const mb = (t) => t.repeat(Math.ceil(1048576 / t.length));
  const cronometro = (fn) => { const t0 = Date.now(); fn(); return Date.now() - t0; };
  ok(cronometro(() => p.parsePing(mb('1 packets transmitted, 1 received, '))) < 1000, '1 MB de rodapé numa linha só parseia em < 1 s');
  ok(cronometro(() => p.parsePing(mb('\n'))) < 1000, '1 MB de linhas em branco parseia em < 1 s');
  ok(cronometro(() => p.parsePing(mb(' \n'))) < 1000, '1 MB de linhas só com espaço parseia em < 1 s');
  ok(cronometro(() => p.parsePing('Pinging x\n' + mb('Reply from a: Destination host unreachable\n'))) < 1000, '1 MB de respostas do Windows parseia em < 1 s');
  ok(cronometro(() => p.parsePing('  SEQ HOST\n' + mb('    1 8.8.8.8    56 117 12ms\n'))) < 1000, '1 MB de linhas RouterOS parseia em < 1 s');
  ok(cronometro(() => p._tempoRos(mb('1ms'))) < 1000, 'tempo RouterOS gigante não trava');

  // Saída longa sem rodapé (ping -c 1000 morto no meio, ou monitoramento
  // contínuo): Math.max(...spread) estourava a pilha acima de ~120k seqs.
  let longa = 'PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.\n';
  for (let i = 1; i <= 200000; i++) longa += `64 bytes from 8.8.8.8: icmp_seq=${i} ttl=117 time=12.3 ms\n`;
  const rl = p.parsePing(longa);
  igual([rl.enviados, rl.recebidos], [200000, 200000], '200 mil seqs sem rodapé não estouram a pilha');
}

console.log(`\n${n} verificações passaram`);
