'use strict';

// Ferramentas de rede de uma consulta. DNS e HTTP batem em rede externa (não
// dá para cravar), então aqui testo a lógica PURA (validação, normalização de
// URL, achatamento das respostas DNS) e a varredura de portas contra um socket
// LOCAL controlado — determinístico.

const assert = require('assert');
const net = require('net');
const rt = require('../lib/redetools');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// ---------- validação e normalização ----------

{
  ok(rt._alvoValido('google.com') && rt._alvoValido('8.8.8.8'), 'host/IP valem');
  ok(!rt._alvoValido('a;b') && !rt._alvoValido('-x') && !rt._alvoValido(''), 'injeção/traço/vazio não valem');

  igual(rt._normalizarUrl('github.com').protocol, 'https:', 'sem esquema → assume https');
  igual(rt._normalizarUrl('http://x.com').protocol, 'http:', 'http explícito é respeitado');
  igual(rt._normalizarUrl('ftp://x.com'), null, 'esquema não-http é recusado');
  igual(rt._normalizarUrl(''), null, 'vazio é recusado');

  igual(rt._achatarDns('MX', [{ priority: 10, exchange: 'mail.x.com' }]), ['10 mail.x.com'], 'MX vira "prioridade servidor"');
  igual(rt._achatarDns('TXT', [['v=spf1', ' -all']]), ['v=spf1 -all'], 'TXT junta os pedaços');
  igual(rt._achatarDns('A', ['1.2.3.4']), ['1.2.3.4'], 'A passa direto');
}

// ---------- varredura de portas contra sockets locais ----------

(async () => {
  // sobe um servidor numa porta efêmera → deve dar 'aberta'
  const srv = net.createServer(() => {});
  const porta = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

  const r = await rt.portScan('127.0.0.1', [porta, porta + 1]);
  const aberta = r.portas.find((p) => p.porta === porta);
  igual(aberta.estado, 'aberta', 'porta com servidor ouvindo → aberta');
  ok(aberta.tempoMs >= 0, 'com tempo de conexão medido');
  // a porta vizinha (sem ninguém) → fechada (recusada) no loopback
  const vizinha = r.portas.find((p) => p.porta === porta + 1);
  ok(vizinha.estado === 'fechada' || vizinha.estado === 'filtrada', 'porta sem serviço → fechada/filtrada');
  igual(r.resumo.abertas, 1, 'o resumo conta 1 aberta');

  srv.close();

  // rótulo de serviço nas portas comuns
  const comuns = new Map(rt.PORTAS_COMUNS);
  igual(comuns.get(443), 'HTTPS', '443 é rotulado HTTPS');
  igual(comuns.get(22), 'SSH', '22 é rotulado SSH');

  // host inválido é recusado antes de sondar
  igual((await rt.portScan('a;rm', 'comuns')).erro !== undefined, true, 'host com metacaractere é recusado');

  console.log(`\n${n} verificações passaram`);
})().catch((e) => { console.error(e); process.exit(1); });
