'use strict';

// Monitorador de IP (aba Ferramentas). O ping de verdade shella para o sistema
// e não dá para cravar no teste; o que ESTE arquivo trava é o que decide o
// resultado: o comando certo por SO, a leitura vivo/morto+latência (robusta a
// idioma e ao Windows que sai com código 0 em "inacessível"), a validação de
// endereço, e a máquina de estados do alarme (só vira "timeout" após N falhas).

const assert = require('assert');
const mon = require('../lib/monitor');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// ---------- 1. comando de ping por SO ----------

{
  const win = mon._comandoPing('10.0.0.1', 2000, 'win32');
  igual(win.args, ['-n', '1', '-w', '2000', '10.0.0.1'], 'Windows: -n 1, -w em ms');
  const mac = mon._comandoPing('10.0.0.1', 2000, 'darwin');
  igual(mac.args, ['-c', '1', '-t', '2', '10.0.0.1'], 'mac: -c 1, -t em segundos');
  const lin = mon._comandoPing('10.0.0.1', 3000, 'linux');
  igual(lin.args, ['-c', '1', '-W', '3', '10.0.0.1'], 'linux: -c 1, -W em segundos');
  igual(mon._comandoPing('x', 400, 'linux').args[3], '1', 'timeout < 1s vira 1s (mínimo do ping)');
  ok(win.cmd === 'ping' && win.args[win.args.length - 1] === '10.0.0.1', 'o IP é o último argumento');
}

// ---------- 2. parsing vivo/morto + latência ----------

{
  const unix = '64 bytes from 8.8.8.8: icmp_seq=0 ttl=118 time=10.2 ms';
  igual(mon._parsePing(0, unix), { vivo: true, latencia: 10.2 }, 'unix: TTL presente = vivo, latência 10.2');

  const win = 'Resposta de 8.8.8.8: bytes=32 tempo=13ms TTL=118';
  igual(mon._parsePing(0, win), { vivo: true, latencia: 13 }, 'Windows pt-BR: "tempo=13ms" e TTL');

  const winMenor = 'Reply from 127.0.0.1: bytes=32 time<1ms TTL=128';
  igual(mon._parsePing(0, winMenor).vivo, true, 'time<1ms ainda é vivo');
  igual(mon._parsePing(0, winMenor).latencia, 1, 'time<1ms lê 1');

  // Windows: código 0 MAS "host inacessível" — não pode contar como vivo.
  const inacess = 'Resposta de 192.168.0.1: Host de destino inacessível.';
  igual(mon._parsePing(0, inacess).vivo, false, 'código 0 + "inacessível" (sem TTL) = MORTO');

  const timeout = 'Esgotado o tempo limite do pedido.';
  igual(mon._parsePing(1, timeout).vivo, false, 'timeout = morto');
  const loss = '1 packets transmitted, 0 received, 100% packet loss';
  igual(mon._parsePing(1, loss).vivo, false, '100% packet loss = morto');
}

// ---------- 3. validação de endereço (anti-lixo/anti-injeção) ----------

{
  ok(mon._ipValido('192.168.0.1'), 'IPv4 vale');
  ok(mon._ipValido('roteador.local'), 'hostname vale');
  ok(mon._ipValido('fe80::1'), 'IPv6 vale');
  ok(!mon._ipValido('8.8.8.8; rm -rf /'), 'com metacaractere de shell NÃO vale');
  ok(!mon._ipValido('8.8.8.8 && ping'), 'com espaço/&& NÃO vale');
  ok(!mon._ipValido(''), 'vazio não vale');
}

// ---------- 4. máquina de estados: só alarma após N falhas seguidas ----------

(async () => {
  // relógio cravado, e o ping trocado por um controlável
  let t = 1000;
  mon._setAgora(() => t);
  const respostas = new Map(); // ip -> vivo?
  const pingReal = mon.pingar;
  // monkeypatch do pingar do módulo: substituo a função exportada usada pela rodada
  // (a rodada usa a `pingar` interna; para testá-la sem rede, exponho _rodada que
  // chama a interna — então recrio o comportamento controlando via respostas).
  // Como não dá para trocar a interna, testo a lógica de estado com adicionar +
  // uma rodada real contra 127.0.0.1 (sempre vivo) e um IP de doc (sempre morto).

  mon.limpar();
  igual(mon.estado().ips.length, 0, 'começa vazio');

  // 127.0.0.1 responde na hora → vira 'ok'
  igual(mon.adicionar('127.0.0.1').ok, true, 'adiciona o loopback');
  ok(mon.estado().bloqueio === true || mon.estado().bloqueio === false, 'estado reporta o bloqueio');
  igual(mon.adicionar('127.0.0.1').ok, false, 'não adiciona o mesmo duas vezes');

  await mon._rodada();
  const loop = mon.estado().ips.find((x) => x.ip === '127.0.0.1');
  igual(loop.status, 'ok', 'loopback responde → ok');
  ok(loop.latencia === null || loop.latencia >= 0, 'latência é número ou null');

  // 192.0.2.1 (TEST-NET, morto): 1ª falha ainda NÃO alarma; 2ª sim.
  igual(mon.adicionar('192.0.2.1').ok, true, 'adiciona um IP que não responde');
  await mon._rodada();
  let morto = mon.estado().ips.find((x) => x.ip === '192.0.2.1');
  igual(morto.status, 'checando', 'após 1 falha ainda é "checando", não dispara a sirene');
  igual(morto.falhas, 1, 'contou 1 falha');
  await mon._rodada();
  morto = mon.estado().ips.find((x) => x.ip === '192.0.2.1');
  igual(morto.status, 'timeout', `após ${mon.LIMITE_ALARME} falhas seguidas → timeout (sirene)`);

  // remover volta ao normal; sem IPs, o bloqueio de tela é liberado
  mon.remover('192.0.2.1'); mon.remover('127.0.0.1');
  igual(mon.estado().ips.length, 0, 'removeu todos');
  igual(mon.estado().bloqueio, false, 'sem IPs, o bloqueio de tela é liberado');
  mon._pararLoop();

  // ---------- 5. bloqueio de tela: honesto (só sob Electron, quando injetado) ----------
  {
    igual(mon.estado().bloqueio, false, 'sem função injetada (navegador comum), NUNCA reporta bloqueio');
    const chamadas = [];
    mon.definirBloqueio((on) => chamadas.push(on));
    mon.adicionar('127.0.0.1');
    igual(mon.estado().bloqueio, true, 'com a função injetada e um IP, reporta bloqueio ativo');
    igual(chamadas, [true], 'e a função foi chamada para LIGAR o powerSaveBlocker');
    mon.remover('127.0.0.1');
    igual(mon.estado().bloqueio, false, 'sem IPs, reporta liberado');
    igual(chamadas, [true, false], 'e a função foi chamada para DESLIGAR');
    mon.definirBloqueio(null);
    mon._pararLoop();
  }

  console.log(`\n${n} verificações passaram`);
})().catch((e) => { console.error(e); process.exit(1); });
