'use strict';

// TCP ping — o handshake TCP até host:porta, contínuo, como o monitor de IP.
// Testo contra um socket LOCAL controlado: porta aberta → 'aberta' com latência,
// porta sem serviço → 'fechada'; mais a validação, o refcount e o TTL de órfão.

const assert = require('assert');
const net = require('net');
const tp = require('../lib/tcpping');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// ---------- validação ----------

{
  ok(tp._alvoValido('8.8.8.8', 53) && tp._alvoValido('host.local', 443), 'host+porta válidos passam');
  ok(!tp._alvoValido('x', 0) && !tp._alvoValido('x', 70000), 'porta fora de 1–65535 não vale');
  ok(!tp._alvoValido('a;b', 22) && !tp._alvoValido('-x', 22), 'injeção/traço não valem');
}

(async () => {
  const srv = net.createServer(() => {});
  const porta = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

  // ---------- porta aberta ----------
  tp.limpar();
  igual(tp.iniciar('127.0.0.1', porta).ok, true, 'inicia o TCP ping na porta aberta');
  tp._pararLoop();
  await tp._rodada();
  const d = tp.detalhe('127.0.0.1', porta, 0);
  igual(d.status, 'aberta', 'porta com servidor → aberta');
  igual(d.perdidos, 0, 'sem perda');
  ok(d.ultima != null && d.media != null, 'latência e média medidas');
  igual(d.novos.length, 1, 'o log traz a sonda');

  // ---------- porta fechada ----------
  const p2 = porta + 1;
  tp.iniciar('127.0.0.1', p2);
  tp._pararLoop();
  await tp._rodada();
  const f = tp.detalhe('127.0.0.1', p2, 0);
  ok(f.status === 'fechada' || f.status === 'timeout', 'porta sem serviço → fechada/filtrada');
  ok(f.perda > 0, 'e conta como perda (o serviço não respondeu)');

  // ---------- refcount ----------
  tp.iniciar('127.0.0.1', porta); // 2ª janela
  tp.remover('127.0.0.1', porta); // fecha a 1ª
  ok(tp.detalhe('127.0.0.1', porta, 0) !== null, 'com 2 refs, remover uma mantém o alvo');
  tp.remover('127.0.0.1', porta);
  igual(tp.detalhe('127.0.0.1', porta, 0), null, 'sem refs, some');

  // ---------- TTL de órfão ----------
  tp.limpar();
  let t = 500000; tp._setAgora(() => t);
  tp.iniciar('127.0.0.1', porta); tp._pararLoop();
  t += tp.TTL_ORFAO_MS + 3000;
  await tp._rodada(); // a varredura no início da rodada solta o órfão
  igual(tp.detalhe('127.0.0.1', porta, 0), null, 'alvo sem batida além do TTL é solto');
  tp._setAgora(() => Date.now());

  srv.close();
  tp.limpar();
  console.log(`\n${n} verificações passaram`);
})().catch((e) => { console.error(e); process.exit(1); });
