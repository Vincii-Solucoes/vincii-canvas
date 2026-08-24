'use strict';

// Calculadora de sub-rede — IPv4 e IPv6. Aritmética pura, então tudo é
// testável sem rede. O que trava aqui é o cálculo estar CERTO: rede,
// broadcast, faixa de hosts, contagem, e o IPv6 com BigInt e compressão.

const assert = require('assert');
const s = require('../public/subnet');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// ---------- IPv4 ----------

{
  const r = s.calcular('192.168.1.10/24');
  igual(r.rede, '192.168.1.0', '/24: rede');
  igual(r.broadcast, '192.168.1.255', '/24: broadcast');
  igual(r.mascara, '255.255.255.0', '/24: máscara');
  igual(r.curinga, '0.0.0.255', '/24: curinga (wildcard)');
  igual(r.primeiroHost, '192.168.1.1', '/24: primeiro host');
  igual(r.ultimoHost, '192.168.1.254', '/24: último host');
  igual(r.totalEnderecos, '256', '/24: 256 endereços');
  igual(r.hostsUsaveis, '254', '/24: 254 usáveis');
  ok(r.privado, '192.168/16 é privado');

  const r30 = s.calcular('10.0.0.5/30');
  igual([r30.rede, r30.broadcast, r30.primeiroHost, r30.ultimoHost, r30.hostsUsaveis],
    ['10.0.0.4', '10.0.0.7', '10.0.0.5', '10.0.0.6', '2'], '/30: 2 hosts usáveis (ponto-a-ponto)');

  const r31 = s.calcular('10.0.0.0/31');
  igual([r31.primeiroHost, r31.ultimoHost, r31.hostsUsaveis], ['10.0.0.0', '10.0.0.1', '2'],
    '/31: RFC 3021, os 2 endereços são usáveis');

  const r32 = s.calcular('8.8.8.8/32');
  igual([r32.rede, r32.hostsUsaveis], ['8.8.8.8', '1'], '/32: host único');

  igual(s.calcular('999.1.1.1/24').erro !== undefined, true, 'octeto > 255 é recusado');
  igual(s.calcular('10.0.0.1/33').erro !== undefined, true, 'prefixo IPv4 > 32 é recusado');
  igual(s.calcular('10.0.0.1').erro !== undefined, true, 'sem prefixo é recusado');
}

// ---------- IPv6 ----------

{
  const r = s.calcular('2001:db8::/48');
  igual(r.versao, 6, 'detecta IPv6 pelo ":"');
  igual(r.rede, '2001:db8::', '/48: rede comprimida');
  igual(r.redeExpandida, '2001:0db8:0000:0000:0000:0000:0000:0000', '/48: rede expandida (8 grupos)');
  igual(r.ultimoHost, '2001:db8:0:ffff:ffff:ffff:ffff:ffff', '/48: último endereço');
  igual(r.totalEnderecos, (2n ** 80n).toString(), '/48: 2^80 endereços');
  igual(r.tipo, 'global unicast', '2001:db8 é global unicast');

  const r64 = s.calcular('fe80::1/64');
  igual(r64.tipo, 'link-local (fe80::/10)', 'fe80::/10 = link-local');
  igual(r64.rede, 'fe80::', '/64: rede');

  const ula = s.calcular('fd00:1234::abcd/32');
  igual(ula.tipo, 'ULA (privado, fc00::/7)', 'fd00::/8 = ULA (privado)');

  const full = s.calcular('2001:0db8:0000:0000:0000:0000:0000:0001/128');
  igual(full.endereco, '2001:db8::1', 'endereço cheio é comprimido na exibição');
  igual(full.totalEnderecos, '1', '/128: um endereço');

  igual(s.calcular('2001:db8::/129').erro !== undefined, true, 'prefixo IPv6 > 128 é recusado');
  igual(s.calcular('gggg::/64').erro !== undefined, true, 'hexadecimal inválido é recusado');
  igual(s.calcular('2001::db8::1/64').erro !== undefined, true, 'dois "::" é recusado');

  // má-formação que o filter() cego aceitava (auditoria)
  igual(s.calcular(':1:2:3:4:5:6:7:8/64').erro !== undefined, true, '":" no início é recusado');
  igual(s.calcular('2001:db8::1:/64').erro !== undefined, true, '":" no fim é recusado');
  igual(s.calcular('2001:db8:::1/64').erro !== undefined, true, '":::" é recusado');

  // IPv4 embutido (RFC 4291): forma legítima, deve ser aceita
  const mapped = s.calcular('::ffff:192.168.1.1/128');
  igual(mapped.erro, undefined, 'IPv4-mapped ::ffff:a.b.c.d é aceito');
  igual(mapped.rede, '::ffff:c0a8:101', '::ffff:192.168.1.1 vira ::ffff:c0a8:101');
  igual(s.calcular('64:ff9b::192.0.2.33/96').erro, undefined, 'NAT64 com IPv4 embutido é aceito');
  igual(s.calcular('::ffff:999.1.1.1/128').erro !== undefined, true, 'IPv4 embutido inválido é recusado');

  // classificação de tipo (auditoria)
  igual(s.calcular('fc00::/7').tipo, 'ULA (privado, fc00::/7)', 'fc00::/7 (o próprio bloco) é ULA, não global');
  igual(s.calcular('::1/128').tipo, 'loopback (::1)', '::1/128 é loopback, não global unicast');
  igual(s.calcular('::/128').tipo, 'não especificado (::)', ':: é não especificado');
}

// ---------- compressão ida-e-volta ----------

{
  igual(s._comprimirV6(['2001', 'db8', '0', '0', '0', '0', '0', '1']), '2001:db8::1', 'comprime a maior sequência de zeros');
  igual(s._comprimirV6(['fe80', '0', '0', '0', '0', '0', '0', '0']), 'fe80::', 'zeros no fim viram ::');
  igual(s._comprimirV6(['1', '0', '0', '2', '0', '0', '0', '3']), '1:0:0:2::3', 'comprime a MAIOR sequência (3 zeros), não a primeira (2 zeros) — RFC 5952');
}

console.log(`\n${n} verificações passaram`);
