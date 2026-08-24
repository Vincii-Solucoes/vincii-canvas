'use strict';

// MTR — o parsing do traceroute (por SO) e o motor de agregação por salto. O
// traceroute real e o ping shellam para o sistema; o que ESTE arquivo trava é
// o que decide o resultado: extrair a rota certa de cada formato, e agregar
// perda/latência por salto sem quebrar nos saltos mudos ('*').

const assert = require('assert');
const mtr = require('../lib/mtr');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// ---------- 1. comando por SO ----------

{
  const u = mtr._comandoTraceroute('8.8.8.8', 'linux');
  igual([u.cmd, u.args[0], u.args[1]], ['traceroute', '-n', '-q'], 'unix: traceroute -n -q 1 numérico');
  igual(u.args[u.args.length - 1], '8.8.8.8', 'com o host no fim');
  const w = mtr._comandoTraceroute('8.8.8.8', 'win32');
  igual([w.cmd, w.args[0]], ['tracert', '-d'], 'Windows: tracert -d');
}

// ---------- 2. parsing do traceroute unix ----------

{
  const saidaUnix = [
    'traceroute to 8.8.8.8 (8.8.8.8), 30 hops max, 40 byte packets',
    ' 1  192.168.1.1  2.320 ms',
    ' 2  100.118.0.2  7.325 ms',
    ' 3  *',
    ' 4  142.250.63.175  7.065 ms',
  ].join('\n');
  const hops = mtr._parseTraceroute(saidaUnix, 'linux');
  igual(hops.length, 4, 'quatro saltos (o cabeçalho é ignorado)');
  igual(hops[0], { n: 1, ip: '192.168.1.1' }, 'primeiro salto: o gateway');
  igual(hops[2], { n: 3, ip: null }, 'salto mudo (*) vira ip null, mas mantém a posição');
  igual(hops[3].ip, '142.250.63.175', 'último salto com IP');
}

// ---------- 3. parsing do traceroute Windows ----------

{
  const saidaWin = [
    'Tracing route to 8.8.8.8 over a maximum of 30 hops',
    '',
    '  1     2 ms     2 ms     2 ms  192.168.1.1',
    '  2     *        *        *     Request timed out.',
    '  3     7 ms     7 ms     7 ms  8.8.8.8',
  ].join('\r\n');
  const hops = mtr._parseTraceroute(saidaWin, 'win32');
  igual(hops.length, 3, 'três saltos (o IP fica no FIM da linha no Windows)');
  igual(hops[0].ip, '192.168.1.1', 'salto 1');
  igual(hops[1].ip, null, '"Request timed out" → sem ip');
  igual(hops[2].ip, '8.8.8.8', 'salto final');
}

// ---------- 4. validação de host (anti-injeção) ----------

{
  ok(mtr._hostValido('8.8.8.8') && mtr._hostValido('google.com'), 'IP e host valem');
  ok(!mtr._hostValido('8.8.8.8; rm -rf /') && !mtr._hostValido('-c1') && !mtr._hostValido(''),
    'metacaractere, traço inicial e vazio NÃO valem');
}

// ---------- 5. motor: traça o loopback e agrega o ping por salto ----------

(async () => {
  mtr.limpar();
  igual(mtr.detalhe('127.0.0.1'), null, 'sem iniciar, não há detalhe');

  igual(mtr.iniciar('127.0.0.1').ok, true, 'inicia o traçado do loopback');
  mtr._pararLoop(); // controlo as rodadas à mão

  // espera o traceroute (assíncrono) descobrir a rota
  const t0 = Date.now();
  while (mtr.detalhe('127.0.0.1').tracando && Date.now() - t0 < 8000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const d = mtr.detalhe('127.0.0.1');
  ok(!d.tracando, 'terminou de traçar a rota');
  ok(d.hops.length >= 1, 'achou ao menos um salto (o próprio loopback)');
  ok(d.hops.some((h) => h.ip === '127.0.0.1'), 'e o loopback está entre os saltos');

  // uma rodada de ping: o salto vivo ganha stats, sem perda
  await mtr._rodada();
  const d2 = mtr.detalhe('127.0.0.1');
  const loop = d2.hops.find((h) => h.ip === '127.0.0.1');
  igual(loop.status, 'ok', 'o loopback responde → ok');
  igual(loop.perdidos, 0, 'sem perda');
  ok(loop.total >= 1, 'contou ao menos um envio');
  ok(loop.media != null && loop.melhor != null && loop.pior != null, 'média/melhor/pior preenchidos');

  // refcount + TTL órfão
  mtr.iniciar('127.0.0.1'); // 2ª janela
  mtr.remover('127.0.0.1'); // fecha a 1ª
  ok(mtr.detalhe('127.0.0.1') !== null, 'com 2 refs, remover uma mantém o traçado');
  mtr.remover('127.0.0.1');
  igual(mtr.detalhe('127.0.0.1'), null, 'sem refs, some');

  mtr._pararLoop();
  console.log(`\n${n} verificações passaram`);
})().catch((e) => { console.error(e); process.exit(1); });
