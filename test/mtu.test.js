'use strict';

// MTU Detect — busca binária do PMTU com pings DF. Tudo puro/injetável, então
// testo a busca contra sondas simuladas (caminhos com MTU 1500, 1492, 1420,
// 1280, tudo timeout), a classificação das saídas REAIS de cada ping (macOS
// colado do terminal; Linux/Windows/RouterOS no formato dos respectivos
// binários, inclusive o Windows em pt-BR), os comandos por plataforma e o
// atalho do "mtu=".

const assert = require('assert');
const mtu = require('../lib/mtu');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// Sonda simulada: caminho com um MTU real. Passa se payload + overhead ≤ mtuReal.
// `avisa` = roteador que devolve "frag needed" (fragmentacao); sem ele, o
// pacote grande some (timeout) — o buraco negro de PMTU.
function caminho(mtuReal, { avisa = true, overhead = 28, sugere = false } = {}) {
  return async (payload) => {
    if (payload + overhead <= mtuReal) return 'ok';
    if (!avisa) return 'timeout';
    return sugere ? { resultado: 'fragmentacao', mtuSugerido: mtuReal } : 'fragmentacao';
  };
}

// ---------- 1. comandos por plataforma ----------

{
  const mac = mtu.comandoSonda('1.1.1.1', 1472, 'darwin');
  igual(mac.args, ['-c', '1', '-D', '-s', '1472', '-t', '2', '1.1.1.1'], 'macOS: -D é o DF e -t é timeout em segundos');
  igual(mac.linha, 'ping -c 1 -D -s 1472 -t 2 1.1.1.1', 'macOS: linha pronta para o SSH');

  const lin = mtu.comandoSonda('8.8.8.8', 1464, 'linux');
  igual(lin.args, ['-c', '1', '-M', 'do', '-s', '1464', '-W', '2', '8.8.8.8'], 'Linux iputils: -M do');
  igual(mtu.comandoSonda('8.8.8.8', 100, undefined) !== null, true, 'plataforma omitida cai no process.platform');

  const win = mtu.comandoSonda('10.0.0.1', 1472, 'win32');
  igual(win.linha, 'ping -n 1 -f -l 1472 -w 2000 10.0.0.1', 'Windows: -f é DF, -l é payload, -w em ms');

  const ros = mtu.comandoSonda('1.1.1.1', 1472, 'routeros');
  igual(ros.cmd, '/ping', 'RouterOS: comando é /ping');
  igual(ros.linha, '/ping address=1.1.1.1 count=1 size=1500 do-not-fragment', 'RouterOS: size é o pacote IP inteiro (payload + 28)');
  igual(mtu.comandoSonda('2001:db8::1', 1452, 'routeros', mtu.OVERHEAD_V6).linha,
    '/ping address=2001:db8::1 count=1 size=1500 do-not-fragment', 'RouterOS IPv6: size = payload + 48');

  igual(mtu.comandoSonda('1.1.1.1', 1472, 'busybox'), null, 'BusyBox não tem DF → null (não dá para medir)');

  ok(mtu.comandoSonda('-c5', 100, 'linux').erro, 'alvo começando com "-" é recusado (viraria flag)');
  ok(mtu.comandoSonda('a;rm -rf /', 100, 'linux').erro, 'metacaractere de shell é recusado');
  ok(mtu.comandoSonda('1.1.1.1', -1, 'linux').erro && mtu.comandoSonda('1.1.1.1', 70000, 'linux').erro, 'payload fora de 0–65507 é recusado');
  ok(mtu.comandoSonda('1.1.1.1', 1472.5, 'linux').erro, 'payload não inteiro é recusado');
  ok(mtu.validarAlvo('roteador.local') && mtu.validarAlvo('fe80::1'), 'hostname e IPv6 passam');
}

// ---------- 2. classificação — macOS (saídas reais) ----------

{
  const macOk = `PING 1.1.1.1 (1.1.1.1): 1472 data bytes
1480 bytes from 1.1.1.1: icmp_seq=0 ttl=55 time=10.573 ms

--- 1.1.1.1 ping statistics ---
1 packets transmitted, 1 packets received, 0.0% packet loss
round-trip min/avg/max/stddev = 10.573/10.573/10.573/nan ms
`;
  const macFrag = `ping: sendto: Message too long
PING 1.1.1.1 (1.1.1.1): 1473 data bytes

--- 1.1.1.1 ping statistics ---
1 packets transmitted, 0 packets received, 100.0% packet loss
`;
  const macTimeout = `PING 192.0.2.1 (192.0.2.1): 1472 data bytes

--- 192.0.2.1 ping statistics ---
1 packets transmitted, 0 packets received, 100.0% packet loss
`;
  const macFragRoteador = `PING 8.8.8.8 (8.8.8.8): 1472 data bytes
92 bytes from 10.0.0.1: frag needed and DF set (MTU 1492)
Vr HL TOS  Len   ID Flg  off TTL Pro  cks      Src      Dst
 4  5  00 5dc0 1a2b   2 0000  40  01 0000 10.0.0.2  8.8.8.8

--- 8.8.8.8 ping statistics ---
1 packets transmitted, 0 packets received, 100.0% packet loss
`;
  igual(mtu.classificarResposta(macOk, 0), 'ok', 'macOS: ttl= e 0.0% loss → ok');
  igual(mtu.classificarResposta(macFrag, 2), 'fragmentacao', 'macOS: "Message too long" local (mesmo com 100% loss junto)');
  igual(mtu.classificarResposta(macTimeout, 2), 'timeout', 'macOS: só 100.0% packet loss → timeout');
  igual(mtu.classificarResposta(macFragRoteador, 2), 'fragmentacao', 'macOS: "frag needed and DF set" vindo do roteador');
  igual(mtu.extrairMtuSugerido(macFragRoteador), 1492, 'macOS: "(MTU 1492)" vira atalho');
  igual(mtu.extrairMtuSugerido(macFrag), null, 'macOS: erro local não diz o MTU');
}

// ---------- 3. classificação — Linux iputils ----------

{
  const linOk = `PING 1.1.1.1 (1.1.1.1) 1472(1500) bytes of data.
1480 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=9.81 ms

--- 1.1.1.1 ping statistics ---
1 packets transmitted, 1 received, 0% packet loss, time 0ms
rtt min/avg/max/mdev = 9.810/9.810/9.810/0.000 ms
`;
  const linFragLocal = `PING 1.1.1.1 (1.1.1.1) 1473(1501) bytes of data.
ping: local error: message too long, mtu=1500

--- 1.1.1.1 ping statistics ---
1 packets transmitted, 0 received, +1 errors, 100% packet loss, time 0ms
`;
  const linFragRoteador = `PING 8.8.8.8 (8.8.8.8) 1472(1500) bytes of data.
From 10.0.0.1 icmp_seq=1 Frag needed and DF set (mtu = 1492)

--- 8.8.8.8 ping statistics ---
1 packets transmitted, 0 received, +1 errors, 100% packet loss, time 0ms
`;
  const linTimeout = `PING 192.0.2.1 (192.0.2.1) 1472(1500) bytes of data.

--- 192.0.2.1 ping statistics ---
1 packets transmitted, 0 received, 100% packet loss, time 0ms
`;
  const linUnreach = `PING 10.255.255.1 (10.255.255.1) 1472(1500) bytes of data.
From 10.0.0.2 icmp_seq=1 Destination Host Unreachable

--- 10.255.255.1 ping statistics ---
1 packets transmitted, 0 received, +1 errors, 100% packet loss, time 0ms
`;
  igual(mtu.classificarResposta(linOk, 0), 'ok', 'Linux: resposta com ttl= → ok');
  igual(mtu.classificarResposta(linFragLocal, 1), 'fragmentacao', 'Linux: "message too long, mtu=1500"');
  igual(mtu.classificarResposta(linFragRoteador, 1), 'fragmentacao', 'Linux: "Frag needed and DF set (mtu = 1492)"');
  igual(mtu.classificarResposta(linTimeout, 1), 'timeout', 'Linux: 100% packet loss sem aviso → timeout');
  igual(mtu.classificarResposta(linUnreach, 1), 'erro', 'Linux: unreachable é erro, não timeout (100% loss junto não engana)');
  igual(mtu.classificarResposta('ping: unknown host naoexiste.invalid\n', 2), 'erro', 'Linux: host desconhecido → erro');
  igual(mtu.classificarResposta('ping: socket: Operation not permitted\n', 2), 'erro', 'Linux: sem raw socket → erro');
  igual(mtu.extrairMtuSugerido(linFragLocal), 1500, 'Linux: "mtu=1500"');
  igual(mtu.extrairMtuSugerido(linFragRoteador), 1492, 'Linux: "mtu = 1492" (com espaços)');
  igual(mtu.extrairMtuSugerido('From mtu-gw.local icmp_seq=1 Frag needed'), null, '"mtu" dentro de hostname sem número não é sugestão');
  igual(mtu.extrairMtuSugerido('mtu=7'), null, 'MTU abaixo de 68 é ruído');
}

// ---------- 4. classificação — Windows (en e pt-BR) ----------

{
  const winFrag = `
Pinging 1.1.1.1 with 1473 bytes of data:
Packet needs to be fragmented but DF set.

Ping statistics for 1.1.1.1:
    Packets: Sent = 1, Received = 0, Lost = 1 (100% loss),
`;
  const winFragPt = `
Disparando 1.1.1.1 com 1473 bytes de dados:
O pacote precisa ser fragmentado mas o DF está definido.

Estatísticas do Ping para 1.1.1.1:
    Pacotes: Enviados = 1, Recebidos = 0, Perdidos = 1 (100% de
             perda),
`;
  const winOkPt = `
Disparando 1.1.1.1 com 1472 bytes de dados:
Resposta de 1.1.1.1: bytes=1472 tempo=10ms TTL=55

Estatísticas do Ping para 1.1.1.1:
    Pacotes: Enviados = 1, Recebidos = 1, Perdidos = 0 (0% de
             perda),
Aproximar um número redondo de vezes em milissegundos:
    Mínimo = 10ms, Máximo = 10ms, Média = 10ms
`;
  const winTimeoutPt = `
Disparando 192.0.2.1 com 1472 bytes de dados:
Esgotado o tempo limite do pedido.

Estatísticas do Ping para 192.0.2.1:
    Pacotes: Enviados = 1, Recebidos = 0, Perdidos = 1 (100% de
             perda),
`;
  const winTimeout = `
Pinging 192.0.2.1 with 1472 bytes of data:
Request timed out.

Ping statistics for 192.0.2.1:
    Packets: Sent = 1, Received = 0, Lost = 1 (100% loss),
`;
  const winUnreach = `
Pinging 10.255.255.1 with 1472 bytes of data:
Reply from 10.0.0.2: Destination host unreachable.

Ping statistics for 10.255.255.1:
    Packets: Sent = 1, Received = 1, Lost = 0 (0% loss),
`;
  igual(mtu.classificarResposta(winFrag, 1), 'fragmentacao', 'Windows en: "Packet needs to be fragmented but DF set."');
  igual(mtu.classificarResposta(winFragPt, 1), 'fragmentacao', 'Windows pt-BR: "O pacote precisa ser fragmentado mas o DF está definido."');
  igual(mtu.classificarResposta(winOkPt, 0), 'ok', 'Windows pt-BR: tempo=/TTL= → ok');
  igual(mtu.classificarResposta(winTimeoutPt, 1), 'timeout', 'Windows pt-BR: "Esgotado o tempo limite" → timeout');
  igual(mtu.classificarResposta(winTimeout, 1), 'timeout', 'Windows en: "Request timed out."');
  igual(mtu.classificarResposta(winUnreach, 0), 'erro', 'Windows: unreachable sai com código 0 e "0% loss" — mesmo assim é erro');
  igual(mtu.extrairMtuSugerido(winFrag), null, 'Windows não diz o MTU → sem atalho');
}

// ---------- 5. classificação — RouterOS e casos soltos ----------

{
  const rosOk = `  SEQ HOST                                     SIZE TTL TIME       STATUS
    0 1.1.1.1                                  1500  55 10ms307us
    sent=1 received=1 packet-loss=0% min-rtt=10ms307us avg-rtt=10ms307us max-rtt=10ms307us
`;
  const rosGrande = `  SEQ HOST                                     SIZE TTL TIME       STATUS
    0 1.1.1.1                                                      packet too large
    sent=1 received=0 packet-loss=100%
`;
  const rosFragRot = `  SEQ HOST                                     SIZE TTL TIME       STATUS
    0 8.8.8.8                                                      fragmentation needed and DF set
    sent=1 received=0 packet-loss=100%
`;
  const rosTimeout = `  SEQ HOST                                     SIZE TTL TIME       STATUS
    0 192.0.2.1                                                    timeout
    sent=1 received=0 packet-loss=100%
`;
  igual(mtu.classificarResposta(rosOk, 0), 'ok', 'RouterOS: received=1 → ok (não imprime ttl=)');
  igual(mtu.classificarResposta(rosGrande, 0), 'fragmentacao', 'RouterOS: "packet too large"');
  igual(mtu.classificarResposta(rosFragRot, 0), 'fragmentacao', 'RouterOS: "fragmentation needed"');
  igual(mtu.classificarResposta(rosTimeout, 0), 'timeout', 'RouterOS: "timeout" na linha');
  igual(mtu.classificarResposta('', 0), 'erro', 'saída vazia com código 0 não é ok (sem evidência)');
  igual(mtu.classificarResposta('bash: ping: command not found\n', 127), 'erro', 'sem binário → erro');
  igual(mtu.classificarResposta('1 packets transmitted, 1 received, 0% packet loss', 0), 'ok', 'só o resumo "0% packet loss" + código 0 vale como ok (idioma desconhecido)');
  igual(mtu.classificarResposta('1 packets transmitted, 1 received, 0% packet loss', 1), 'erro', 'mas o mesmo resumo com código ≠ 0 não convence');
}

(async () => {
  // ---------- 6. busca — MTU 1500 (caso comum, 1 sonda) ----------

  {
    const r = await mtu.buscar(caminho(1500));
    igual([r.pmtu, r.payloadMax], [1500, 1472], 'Ethernet 1500: teto passa → pmtu 1500');
    igual(r.tentativas.length, 1, 'e gasta UMA sonda');
    igual([r.convergiu, r.inconclusivo, r.atalho], [true, false, false], 'convergiu, sem ressalva, sem atalho');
  }

  // ---------- 7. busca — MTU 1492 (PPPoE) ----------

  {
    const r = await mtu.buscar(caminho(1492));
    igual(r.pmtu, 1492, 'PPPoE: bissecção acha 1492');
    igual(r.payloadMax, 1464, 'payload máximo 1464');
    ok(r.tentativas.length <= mtu.MAX_TENTATIVAS, `cabe no teto de ${mtu.MAX_TENTATIVAS} (${r.tentativas.length})`);
    igual(r.tentativas[0], { payload: 1472, resultado: 'fragmentacao' }, 'primeira sonda é o teto e fragmenta');
    igual(r.tentativas[1], { payload: 548, resultado: 'ok' }, 'segunda é o piso e passa');
    ok(r.convergiu && !r.inconclusivo, 'convergiu com aviso explícito de fragmentação');
  }

  // ---------- 8. busca — MTU 1420 (WireGuard) e 1280 (mínimo IPv6) ----------

  {
    const wg = await mtu.buscar(caminho(1420));
    igual(wg.pmtu, 1420, 'WireGuard: 1420');
    const v6 = await mtu.buscar(caminho(1280));
    igual(v6.pmtu, 1280, 'túnel a 1280 sobre IPv4');
    // a bissecção nunca sonda fora da faixa
    ok(v6.tentativas.every((t) => t.payload >= 548 && t.payload <= 1472), 'todas as sondas dentro de 548–1472');
    // e cada sonda depois do piso/teto reduz a faixa (nenhum tamanho repetido)
    const vistos = new Set(v6.tentativas.map((t) => t.payload));
    igual(vistos.size, v6.tentativas.length, 'nenhum payload sondado duas vezes');
  }

  // ---------- 9. busca — IPv6 ajusta padrões ----------

  {
    const r = await mtu.buscar(caminho(1500, { overhead: 48 }), { ipv6: true });
    igual([r.pmtu, r.payloadMax, r.overhead], [1500, 1452, 48], 'IPv6: overhead 48, teto 1452');
    const r2 = await mtu.buscar(caminho(1280, { overhead: 48 }), { ipv6: true });
    igual([r2.pmtu, r2.tentativas[1].payload], [1280, 1232], 'IPv6: piso é 1232 (1280−48) e o mínimo da RFC bate');
  }

  // ---------- 10. busca — tudo timeout (inconclusivo) ----------

  {
    const r = await mtu.buscar(async () => 'timeout');
    igual(r.pmtu, null, 'tudo timeout: sem pmtu');
    igual(r.inconclusivo, true, 'e marcado inconclusivo (ninguém avisou fragmentação)');
    igual(r.tentativas.length, 2, 'parou no piso — não bissecciona contra o vazio');
    ok(/ICMP|não responde/.test(r.motivo), 'motivo explica: alvo não responde / ICMP bloqueado');
  }

  // ---------- 11. busca — buraco negro de PMTU (grandes somem sem aviso) ----------

  {
    const r = await mtu.buscar(caminho(1492, { avisa: false }));
    igual(r.pmtu, 1492, 'timeout conta como falha → ainda acha 1492');
    igual(r.inconclusivo, true, 'mas inconclusivo: nenhuma falha foi fragmentação explícita');
    ok(!r.tentativas.some((t) => t.resultado === 'fragmentacao'), 'confere: só ok/timeout nas tentativas');
  }

  // ---------- 12. busca — piso fragmenta / erro aborta / teto de tentativas ----------

  {
    const r = await mtu.buscar(caminho(500));
    igual([r.pmtu, r.inconclusivo], [null, false], 'até o piso fragmenta → pmtu null, mas conclusivo');
    ok(/mínimo/.test(r.motivo), 'motivo fala do mínimo da rede');

    const e = await mtu.buscar(async () => 'erro');
    igual([e.pmtu, e.tentativas.length], [null, 1], "'erro' na primeira sonda aborta na hora");

    const lanca = await mtu.buscar(async () => { throw new Error('boom'); });
    igual(lanca.tentativas[0].resultado, 'erro', 'exceção da sonda vira erro, não derruba a busca');

    const curto = await mtu.buscar(caminho(1000), { maxTentativas: 4 });
    igual(curto.convergiu, false, 'teto de tentativas baixo → não converge');
    igual(curto.tentativas.length, 4, 'e respeita o teto');
    ok(curto.pmtu <= 1000 && curto.pmtu >= 576, 'devolve o piso confirmado, nunca acima do real');

    const inv = await mtu.buscar(caminho(1500), { min: 2000, max: 1000 });
    igual(inv.pmtu, null, 'faixa invertida é recusada');
  }

  // ---------- 13. busca — atalho mtu= ----------

  {
    const r = await mtu.buscar(caminho(1492, { sugere: true }));
    igual(r.pmtu, 1492, 'com sugestão: acha 1492');
    igual(r.atalho, true, 'e marca que usou o atalho');
    igual(r.tentativas.length, 3, 'teto, piso, pulo direto em 1464 (passa) — 3 sondas em vez de ~12, porque o salto que avisou limita por cima');
    igual(r.tentativas[2].payload, 1464, 'a terceira sonda é exatamente sugerido − overhead');

    // sugestão mentirosa (salto mais à frente é menor): o atalho falha e a
    // bissecção assume sem estragar o resultado
    const mentira = async (p) => (p + 28 <= 1420 ? 'ok' : { resultado: 'fragmentacao', mtuSugerido: p + 28 > 1492 ? 1492 : null });
    const m = await mtu.buscar(mentira);
    igual(m.pmtu, 1420, 'sugestão de 1492 num caminho de 1420: bissecção corrige');
    ok(m.tentativas.length <= mtu.MAX_TENTATIVAS, 'ainda dentro do teto');
  }

  // ---------- 14. explicar ----------

  {
    const r = await mtu.buscar(caminho(1492));
    const txt = mtu.explicar(r);
    ok(txt.startsWith('MTU do caminho: 1492 (payload ICMP 1464 + 28 de cabeçalho).'), 'cabeçalho com pmtu, payload e overhead');
    ok(/1492 {2}PPPoE {2}← bate/.test(txt), 'marca PPPoE como o que bate');
    ok(!/1500 {2}Ethernet {2}←/.test(txt), 'e não marca Ethernet');
    for (const v of [1500, 1492, 1480, 1476, 1460, 1420, 1280]) ok(txt.includes(String(v)), `tabela traz ${v}`);

    const t = mtu.explicar(await mtu.buscar(async () => 'timeout'));
    ok(/não determinado/.test(t) && /ICMP bloqueado/.test(t), 'tudo timeout: diz que não determinou e por quê');

    const bn = mtu.explicar(await mtu.buscar(caminho(1492, { avisa: false })));
    ok(/buraco negro/.test(bn), 'buraco negro de PMTU tem aviso próprio');

    const estranho = mtu.explicar({ pmtu: 1448, payloadMax: 1420, overhead: 28, tentativas: [] });
    ok(/1448 não é um valor padrão/.test(estranho) && /12 bytes abaixo de IPsec/.test(estranho), 'valor fora da tabela: aponta o padrão logo acima e a diferença');

    const v6 = mtu.explicar({ pmtu: 1280, payloadMax: 1232, overhead: 48, tentativas: [{}, {}] });
    ok(/payload ICMP 1232 \+ 48/.test(v6) && /2 sondas enviadas/.test(v6), 'IPv6: overhead 48 e contagem no plural');
  }

  // ---------- 15. revisão — IPv6 "Packet too big", hostname enganoso, TTL expirado ----------

  {
    // Linux `ping -6` contra um túnel 1280: não há DF no IPv6, o roteador manda
    // "Packet too big" — antes da revisão isso caía no "100% packet loss" e
    // virava timeout, deixando toda busca v6 inconclusiva à toa.
    const v6Big = `PING 2606:4700:4700::1111(2606:4700:4700::1111) 1452 data bytes
From 2001:db8::1 icmp_seq=1 Packet too big: mtu=1280

--- 2606:4700:4700::1111 ping statistics ---
1 packets transmitted, 0 received, +1 errors, 100% packet loss, time 0ms
`;
    igual(mtu.classificarResposta(v6Big, 1), 'fragmentacao', 'Linux IPv6: "Packet too big" é fragmentação, não timeout');
    igual(mtu.extrairMtuSugerido(v6Big), 1280, 'e traz o atalho mtu=1280');
    // ping6 do macOS/BSD imprime hlim= em vez de ttl=
    const macV6Ok = `PING6(1280=40+8+1232 bytes) fe80::1 --> fe80::2
1240 bytes from fe80::2, icmp_seq=0 hlim=64 time=0.412 ms

--- fe80::2 ping6 statistics ---
1 packets transmitted, 1 packets received, 0.0% packet loss
`;
    igual(mtu.classificarResposta(macV6Ok, 0), 'ok', 'macOS ping6: hlim= + time= → ok');

    // hostname com palavra-chave dentro: o nome sai no cabeçalho "PING host" e
    // no rodapé; a resposta forte (ttl + tempo na mesma linha) tem de ganhar.
    const hostTimeoutOk = `PING timeout.local (10.0.0.5): 56 data bytes
64 bytes from 10.0.0.5: icmp_seq=0 ttl=64 time=1.2 ms

--- timeout.local ping statistics ---
1 packets transmitted, 1 packets received, 0.0% packet loss
`;
    const hostTimeoutSumiu = `PING timeout.local (10.0.0.5): 56 data bytes

--- timeout.local ping statistics ---
1 packets transmitted, 0 packets received, 100.0% packet loss
`;
    igual(mtu.classificarResposta(hostTimeoutOk, 0), 'ok', 'host "timeout.local" com resposta real → ok');
    igual(mtu.classificarResposta(hostTimeoutSumiu, 2), 'timeout', 'host "timeout.local" sem resposta → timeout (a palavra sozinha não decide)');
    igual(mtu.classificarResposta('PING gw-unreachable.local (10.0.0.9): 56 data bytes\n64 bytes from 10.0.0.9: icmp_seq=0 ttl=64 time=1.0 ms\n', 0), 'ok', 'host "gw-unreachable" com resposta → ok');

    // laço de roteamento: Windows sai com 0 e "0% loss" — não pode virar ok
    const winTtl = `
Pinging 1.1.1.1 with 1472 bytes of data:
Reply from 10.0.0.1: TTL expired in transit.

Ping statistics for 1.1.1.1:
    Packets: Sent = 1, Received = 1, Lost = 0 (0% loss),
`;
    igual(mtu.classificarResposta(winTtl, 0), 'erro', 'Windows "TTL expired in transit" com código 0 e 0% loss → erro');
    igual(mtu.classificarResposta('From 10.0.0.1 icmp_seq=1 Time to live exceeded\n1 packets transmitted, 0 received, +1 errors, 100% packet loss', 1), 'erro', 'Linux "Time to live exceeded" → erro, não timeout');
    igual(mtu.classificarResposta("ping: invalid argument: '70000': out of range: 0 <= value <= 65507\n", 1), 'erro', 'iputils novo: payload fora da faixa → erro');
  }

  // ---------- 16. revisão — defensivo com null/undefined/lixo ----------

  {
    igual(mtu.classificarResposta(null, 0), 'erro', 'classificar(null) não lança');
    igual(mtu.classificarResposta({}, 0), 'erro', 'classificar(objeto) não lança');
    igual(mtu.extrairMtuSugerido(undefined), null, 'extrair(undefined) → null');
    igual(mtu.extrairMtuSugerido(123), null, 'extrair(número) → null');
    igual(mtu.comandoSonda(null, 100, 'linux').erro, 'Alvo inválido. Use um IP ou nome de host.', 'comandoSonda(null) → erro, não exceção');
    ok(mtu.comandoSonda('1.1.1.1', undefined, 'linux').erro, 'payload undefined → erro');
    igual(mtu.comandoSonda('1.1.1.1', 1472, 'routeros', 'x').linha, '/ping address=1.1.1.1 count=1 size=1500 do-not-fragment', 'overhead torto no RouterOS cai no 28 (antes vazava "size=1472x" na linha)');
    igual(mtu.comandoSonda('1.1.1.1', 1472, 'routeros', null).linha, '/ping address=1.1.1.1 count=1 size=1500 do-not-fragment', 'overhead null idem');
    ok(!mtu.validarAlvo(null) && !mtu.validarAlvo('') && !mtu.validarAlvo('a'.repeat(256)), 'validarAlvo: null, vazio e >255 falham');
    ok(mtu.explicar(null).startsWith('MTU do caminho: não determinado.'), 'explicar(null) devolve texto, não lança');

    const nulo = await mtu.buscar(async () => 'ok', null);
    igual(nulo.pmtu, 1500, 'buscar(fn, null) usa os padrões (default param não cobre null)');
    const semSonda = await mtu.buscar(null);
    igual([semSonda.pmtu, semSonda.motivo], [null, 'Sonda não informada.'], 'buscar(null) → motivo, sem exceção');
    const lixo = await mtu.buscar(async () => 'banana');
    igual(lixo.tentativas[0].resultado, 'erro', 'sonda devolvendo string desconhecida vira erro (não entra crua no histórico)');
    igual(lixo.inconclusivo, false, 'e erro não é "inconclusivo" — o motivo já explica');
    const vazio = await mtu.buscar(async () => ({}));
    igual(vazio.tentativas[0].resultado, 'erro', 'sonda devolvendo {} vira erro');
    const negativo = await mtu.buscar(async () => 'ok', { overhead: -5 });
    igual(negativo.overhead, 28, 'overhead negativo é ignorado');
    const fracao = await mtu.buscar(async (p) => (p + 28 <= 1492 ? 'ok' : { resultado: 'fragmentacao', mtuSugerido: 1492.5 }));
    igual([fracao.pmtu, fracao.atalho], [1492, false], 'sugestão fracionária não vira atalho (payload ficaria não inteiro) — bissecção resolve');
    const texto = await mtu.buscar(async (p) => (p + 28 <= 1492 ? 'ok' : { resultado: 'fragmentacao', mtuSugerido: '1492' }));
    igual([texto.pmtu, texto.atalho, texto.tentativas[0].mtuSugerido], [1492, true, 1492], 'sugestão como string numérica é normalizada e usada');
    const um = await mtu.buscar(caminho(1000), { maxTentativas: 1 });
    igual(um.tentativas.length, 2, 'maxTentativas < 2 sobe para 2 (teto e piso sempre são sondados)');
    igual((await mtu.buscar(async () => 'ok', { min: 100, max: 100 })).pmtu, 128, 'min = max e passa → pmtu = 100 + 28 com uma sonda');
  }

  // ---------- 17. revisão — sem backtracking catastrófico (1 MB) ----------

  {
    // Antes: `\bmtu\s*[=:]?\s*(\d{2,5})\b` com "mtu" + 1 MB de espaços travava
    // o processo por minutos (dois \s* adjacentes). Saída via SSH é texto
    // arbitrário, então cada regex do módulo tem de ser linear.
    const MB = 1 << 20;
    const casos = [
      ['mtu' + ' '.repeat(MB) + 'x', 'mtu + 1 MB de espaços'],
      ['mtu = '.repeat(MB / 6), '"mtu = " repetido'],
      ['ttl' + ' '.repeat(MB) + 'x', 'ttl + 1 MB de espaços'],
      ['ttl1 '.repeat(MB / 5), '"ttl1 " repetido numa linha só'],
      ['time=1 '.repeat(MB / 7), '"time=1 " repetido'],
      ['100%' + ' '.repeat(MB) + 'x', '100% + 1 MB de espaços'],
      ['0% de ' + ' '.repeat(MB) + 'x', '"0% de " + 1 MB de espaços'],
      ['\n'.repeat(MB), '1 MB de quebras de linha'],
      ['Frag' + ' '.repeat(MB) + 'needed', '"Frag" + espaços + "needed"'],
    ];
    for (const [entrada, nome] of casos) {
      const t0 = Date.now();
      mtu.classificarResposta(entrada, 0);
      mtu.extrairMtuSugerido(entrada);
      const dt = Date.now() - t0;
      ok(dt < 500, `${nome}: classificar + extrair em ${dt} ms (< 500)`);
    }
  }

  // ---------- 18. revisão — a busca fecha em ≤ 12 para todo MTU de 576 a 1500 ----------

  {
    let pior = 0; let errados = 0; let piorSumico = 0;
    for (let m = 576; m <= 1500; m += 1) {
      const r = await mtu.buscar(caminho(m));
      if (r.pmtu !== m || !r.convergiu) errados += 1;
      pior = Math.max(pior, r.tentativas.length);
      const s = await mtu.buscar(caminho(m, { avisa: false }));
      if (s.pmtu !== m || !s.convergiu) errados += 1;
      piorSumico = Math.max(piorSumico, s.tentativas.length);
    }
    igual(errados, 0, 'todo MTU de 576..1500 é achado exato, com aviso ou com sumiço');
    ok(pior <= mtu.MAX_TENTATIVAS && piorSumico <= mtu.MAX_TENTATIVAS, `pior caso ${Math.max(pior, piorSumico)} sondas ≤ ${mtu.MAX_TENTATIVAS} (a conta do log2 no módulo fecha)`);
    // sonda que oscila (resposta aleatória) nunca passa do teto nem lança
    let piorOscila = 0;
    for (let i = 0; i < 200; i += 1) {
      const r = await mtu.buscar(async () => ['ok', 'fragmentacao', 'timeout'][Math.floor(Math.random() * 3)]);
      piorOscila = Math.max(piorOscila, r.tentativas.length);
    }
    ok(piorOscila <= mtu.MAX_TENTATIVAS, `sonda oscilando: no máximo ${piorOscila} sondas, sem laço infinito`);
  }

  console.log(`\n${n} verificações passaram`);
})().catch((e) => { console.error(e); process.exit(1); });
