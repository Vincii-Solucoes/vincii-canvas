'use strict';

// Monitorador de IP (aba Ferramentas) — UMA JANELA POR HOST. O ping real shella
// para o sistema e não dá para cravar; o que ESTE arquivo trava é o que decide o
// resultado: o comando certo por SO, a leitura vivo/morto+latência (robusta a
// idioma e ao Windows que sai com código 0 em "inacessível"), a validação de
// endereço, e o motor por host — contadores (enviados/perdidos), log de pings
// para o terminal, alarme após N perdas, e o refcount (duas janelas do mesmo IP).

const assert = require('assert');
const mon = require('../lib/monitor');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// ---------- 1. comando de ping por SO ----------

{
  igual(mon._comandoPing('10.0.0.1', 2000, 'win32').args, ['-n', '1', '-w', '2000', '10.0.0.1'], 'Windows: -n 1, -w em ms');
  igual(mon._comandoPing('10.0.0.1', 2000, 'darwin').args, ['-c', '1', '-t', '2', '10.0.0.1'], 'mac: -c 1, -t em segundos');
  igual(mon._comandoPing('10.0.0.1', 3000, 'linux').args, ['-c', '1', '-W', '3', '10.0.0.1'], 'linux: -c 1, -W em segundos');
}

// ---------- 2. parsing vivo/morto + latência ----------

{
  igual(mon._parsePing(0, '64 bytes from 8.8.8.8: icmp_seq=0 ttl=118 time=10.2 ms'), { vivo: true, latencia: 10.2 }, 'unix: TTL = vivo, 10.2ms');
  igual(mon._parsePing(0, 'Resposta de 8.8.8.8: bytes=32 tempo=13ms TTL=118'), { vivo: true, latencia: 13 }, 'Windows pt-BR');
  igual(mon._parsePing(0, 'Reply from 127.0.0.1: bytes=32 time<1ms TTL=128').latencia, 1, 'time<1ms lê 1');
  igual(mon._parsePing(0, 'Resposta de 192.168.0.1: Host de destino inacessível.').vivo, false, 'código 0 + inacessível = morto');
  igual(mon._parsePing(1, 'Esgotado o tempo limite do pedido.').vivo, false, 'timeout = morto');
}

// ---------- 3. validação de endereço (anti-injeção) ----------

{
  ok(mon._ipValido('192.168.0.1') && mon._ipValido('roteador.local') && mon._ipValido('fe80::1'), 'IPv4/host/IPv6 valem');
  ok(!mon._ipValido('8.8.8.8; rm -rf /') && !mon._ipValido('8.8.8.8 && x') && !mon._ipValido(''), 'metacaractere/espaço/vazio não valem');
}

// ---------- 4. motor por host: contadores, log, alarme, refcount ----------

(async () => {
  mon.limpar();
  igual(mon.detalhe('127.0.0.1', 0), null, 'sem adicionar, não há detalhe');

  // host morto: cada rodada conta um envio e uma perda; alarma após LIMITE.
  // Para o timer não somar rodadas por conta própria, controlo manualmente.
  igual(mon.adicionar('192.0.2.1').ok, true, 'adiciona um host morto (TEST-NET)');
  mon._pararLoop();
  for (let i = 0; i < mon.LIMITE_ALARME; i++) await mon._rodada();
  let d = mon.detalhe('192.0.2.1', 0);
  igual(d.total, mon.LIMITE_ALARME, 'contou um envio por rodada');
  igual(d.perdidos, mon.LIMITE_ALARME, 'todas foram perdas');
  igual(d.status, 'timeout', `após ${mon.LIMITE_ALARME} perdas seguidas → timeout (sirene)`);
  igual(d.novos.length, mon.LIMITE_ALARME, 'o log traz uma linha de ping por rodada');
  ok(d.novos.every((e) => e.vivo === false), 'todas marcadas como perda');
  // relatório: sem resposta não há média, e a QUEDA fica registrada em aberto
  igual(d.media, null, 'host que nunca respondeu não tem média');
  igual(d.quedas.length, 1, 'a virada para timeout registra UMA queda');
  ok(d.quedas[0].inicio > 0 && d.quedas[0].fim === null, 'a queda está em aberto (sem fim)');

  // `desde` (seq) só traz o que é NOVO — o terminal não repete linhas
  const ultimoSeq = d.seq;
  await mon._rodada();
  d = mon.detalhe('192.0.2.1', ultimoSeq);
  igual(d.novos.length, 1, 'com desde=último, só a linha nova volta');
  igual(d.novos[0].seq, ultimoSeq + 1, 'e é a seguinte');

  // host vivo: loopback responde → ok, sem perdas
  mon.adicionar('127.0.0.1');
  mon._pararLoop();
  await mon._rodada();
  const loop = mon.detalhe('127.0.0.1', 0);
  igual(loop.status, 'ok', 'loopback → ok');
  igual(loop.perdidos, 0, 'sem perdas no loopback');
  ok(loop.total >= 1, 'contou ao menos um envio');
  // média/mín/máx do relatório, com resposta real
  ok(loop.media != null && loop.media >= 0, 'a MÉDIA de ping existe com respostas');
  ok(loop.min != null && loop.max != null && loop.min <= loop.media && loop.media <= loop.max,
    'mín ≤ média ≤ máx');
  igual(loop.quedas.length, 0, 'sem queda no loopback');

  // refcount: duas janelas do MESMO host; fechar uma não para o monitor
  mon.adicionar('192.0.2.1'); // segunda janela
  mon.remover('192.0.2.1');   // fecha a primeira
  ok(mon.detalhe('192.0.2.1', 0) !== null, 'com 2 refs, remover uma mantém o host vivo');
  mon.remover('192.0.2.1');   // fecha a segunda
  igual(mon.detalhe('192.0.2.1', 0), null, 'sem refs, o host some');

  mon.remover('127.0.0.1');
  mon._pararLoop();

  // ---------- 4b. TTL de órfão: janela que morre por crash não pinga eterno ----------
  {
    mon.limpar();
    let t = 100000;
    mon._setAgora(() => t);
    mon.adicionar('127.0.0.1');
    mon._pararLoop();
    // a janela "bate ponto" pelo /detalhe: enquanto bate, o alvo fica
    t += 10000; mon.detalhe('127.0.0.1', 0); // batida em +10s
    await mon._rodada();
    ok(mon.detalhe('127.0.0.1', 0) !== null, 'com batida recente, o alvo permanece');
    // a janela some (crash): passa o TTL sem nova batida
    t += mon.TTL_ORFAO_MS + 5000;
    await mon._rodada(); // a varredura no início da rodada solta o órfão
    igual(mon.estado().ips.length, 0, 'passado o TTL sem batida, o alvo órfão é solto');
    mon._pararLoop();
    mon._setAgora(() => Date.now());
  }

  // ---------- 5. bloqueio de tela honesto ----------
  {
    igual(mon.estado().bloqueio, false, 'sem função injetada (navegador), nunca reporta bloqueio');
    const chamadas = [];
    mon.definirBloqueio((on) => chamadas.push(on));
    mon.adicionar('127.0.0.1');
    igual(mon.detalhe('127.0.0.1', 0).bloqueio, true, 'com função e um host, o detalhe reporta bloqueio');
    igual(chamadas, [true], 'e a função ligou o powerSaveBlocker');
    mon.remover('127.0.0.1');
    igual(chamadas, [true, false], 'e desligou ao sair o último host');
    mon.definirBloqueio(null); mon._pararLoop();
  }

  console.log(`\n${n} verificações passaram`);
})().catch((e) => { console.error(e); process.exit(1); });
