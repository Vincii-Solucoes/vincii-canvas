'use strict';
const assert = require('assert');
const { normalizar, MAX } = require('../lib/capturas');
const { diffLinhas, compactar } = require('../public/diff');
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// ---------- normalização ----------
igual(normalizar({ texto: 'x' }).erro !== undefined, true, 'sem rótulo recusa');
igual(normalizar({ rotulo: 'a', texto: '   \n ' }).erro !== undefined, true, 'texto vazio recusa');
{
  const v = normalizar({ rotulo: ' BGP antes ', texto: 'l1\r\nl2\rl3', hostId: 'h1', hostName: ' web01 ' });
  igual(v.rotulo, 'BGP antes', 'rótulo trimado');
  igual(v.texto, 'l1\nl2\nl3', 'CRLF/CR viram LF');
  igual(v.hostName, 'web01', 'host trimado');
  igual(v.truncada, false, 'não truncou');
}
{
  const v = normalizar({ rotulo: 'g', texto: 'a'.repeat(MAX.texto + 10) });
  igual(v.texto.length, MAX.texto, 'texto acima do teto é cortado');
  igual(v.truncada, true, 'e avisa que truncou');
}
igual(normalizar(null).erro !== undefined, true, 'nulo não estoura');

// ---------- diff ----------
{
  const d = diffLinhas('a\nb\nc', 'a\nb\nc');
  igual(d.resumo, { iguais: 3, removidas: 0, adicionadas: 0, mudou: false }, 'iguais: nada mudou');
}
{
  // o caso do Rodrigo: contagem de prefixos muda numa linha do meio
  const antes = 'Neighbor   V  AS  MsgRcvd  PfxRcd\n10.0.0.1   4  65001  1200  812\n10.0.0.2   4  65002  900   410\nTotal 2';
  const depois = 'Neighbor   V  AS  MsgRcvd  PfxRcd\n10.0.0.1   4  65001  1250  809\n10.0.0.2   4  65002  900   410\nTotal 2';
  const d = diffLinhas(antes, depois);
  igual(d.resumo.removidas, 1, 'uma linha saiu (peer 1 antes)');
  igual(d.resumo.adicionadas, 1, 'uma linha entrou (peer 1 depois)');
  igual(d.resumo.iguais, 3, 'cabeçalho, peer 2 e total intactos');
  igual(d.ops.find((o) => o.tipo === '-').texto.includes('812'), true, 'a removida tem 812');
  igual(d.ops.find((o) => o.tipo === '+').texto.includes('809'), true, 'a adicionada tem 809');
  igual(d.degradado, false, 'não degradou');
}
{
  const d = diffLinhas('a\nb', 'a\nb\nc\nd');
  igual(d.resumo.adicionadas, 2, 'linhas só no depois são +');
  const d2 = diffLinhas('a\nb\nc', 'c');
  igual(d2.resumo.removidas, 2, 'linhas só no antes são -');
}
{
  // ordem: - antes de + no mesmo ponto, e cauda comum preservada
  const d = diffLinhas('x\nold\nz', 'x\nnew\nz');
  igual(d.ops.map((o) => o.tipo).join(''), '=-+=', 'sequência = - + =');
}
{
  // compactar: só diferenças + contexto
  const d = diffLinhas('1\n2\n3\n4\n5\n6\n7\n8\n9', '1\n2\n3\n4\nX\n6\n7\n8\n9');
  const c = compactar(d.ops, 1);
  igual(c[0].tipo, '…', 'começa com bloco pulado');
  igual(c[0].n, 3, 'pulou as 3 primeiras iguais (contexto 1 mantém a 4)');
  igual(c.filter((o) => o.tipo === '-').length, 1, 'mantém a removida');
  igual(c[c.length - 1].tipo, '…', 'termina com bloco pulado');
}
{
  // degradação honesta com miolo gigante (não trava)
  const big = (ch) => Array.from({ length: 2100 }, (_, i) => ch + i).join('\n');
  const t0 = Date.now();
  const d = diffLinhas(big('a'), big('b'));
  ok(Date.now() - t0 < 2000, 'miolo 2100x2100 responde rápido');
  igual(d.degradado, true, 'marcou como degradado');
  igual(d.resumo.removidas, 2100, 'tudo removido');
  igual(d.resumo.adicionadas, 2100, 'tudo adicionado');
}
{
  // quebra final não vira linha extra
  const d = diffLinhas('a\nb\n', 'a\nb');
  igual(d.resumo.mudou, false, 'quebra final ignorada');
}
console.log(`\n${n} verificações passaram`);

// ---------- casos da revisão adversária: mudanças DISTANTES em texto grande ----------
{
  // 2500 linhas, muda só a linha 10 e a 2490 -> exato, sem degradar
  const base = Array.from({ length: 2500 }, (_, i) => 'linha ' + i);
  const alt = base.slice(); alt[10] = 'linha 10 MUDOU'; alt[2490] = 'linha 2490 MUDOU';
  const d = diffLinhas(base.join('\n'), alt.join('\n'));
  igual(d.degradado, false, '2500 linhas com 2 mudanças distantes NÃO degrada (patience)');
  igual(d.resumo.removidas, 2, 'exatamente 2 removidas');
  igual(d.resumo.adicionadas, 2, 'exatamente 2 adicionadas');
  igual(d.resumo.iguais, 2498, 'o resto igual');
}
{
  // buffer que rolou: primeira e última linhas diferem, meio igual com 1 mudança
  const A = ['prompt-velho$ cmd1', ...Array.from({ length: 3000 }, (_, i) => 'r ' + i), 'prompt$ show'];
  const B = ['r -5', 'r -4', ...Array.from({ length: 3000 }, (_, i) => (i === 1500 ? 'r 1500 X' : 'r ' + i)), 'prompt$ show', 'prompt$ '];
  const d = diffLinhas(A.join('\n'), B.join('\n'));
  igual(d.degradado, false, 'buffer rolado não degrada');
  igual(d.resumo.removidas, 2, 'removidas: prompt-velho e r 1500');
  igual(d.resumo.adicionadas, 4, 'adicionadas: r -5, r -4, r 1500 X, prompt$');
}
{
  // linhas repetidas (não únicas) ainda funcionam nas folhas
  const d = diffLinhas('a\n\n\na\nb\n\n', 'a\n\n\nc\nb\n\n');
  igual(d.resumo.removidas, 1, 'repetidas: 1 removida');
  igual(d.resumo.adicionadas, 1, 'repetidas: 1 adicionada');
}
console.log(`\n${n} verificações passaram (com casos da revisão)`);
