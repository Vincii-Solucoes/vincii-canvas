'use strict';

// Gerador de senhas: pura, testável em Node (webcrypto do próprio Node).
// O que se trava aqui: composição garantida, respeito aos conjuntos marcados,
// exclusão de ambíguos, limites de tamanho, e que o sorteio só usa o pool.

const assert = require('assert');
const { gerar, forca, CONJUNTOS, AMBIGUOS, TAM_MIN, TAM_MAX } = require('../public/senha');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

const TUDO = { tamanho: 20, minusculas: true, maiusculas: true, numeros: true, simbolos: true };

// ---------- feliz: tamanho e composição ----------
{
  const r = gerar(TUDO);
  igual(r.erro, undefined, 'gera sem erro');
  igual(r.senha.length, 20, 'tamanho pedido');
  ok(/[a-z]/.test(r.senha), 'tem minúscula');
  ok(/[A-Z]/.test(r.senha), 'tem maiúscula');
  ok(/[0-9]/.test(r.senha), 'tem número');
  ok([...r.senha].some((ch) => CONJUNTOS.simbolos.includes(ch)), 'tem símbolo');
  ok(r.bits > 100, '20 chars com pool cheio passa de 100 bits');
}

// ---------- só números: nada além de dígitos ----------
{
  const r = gerar({ tamanho: 12, numeros: true });
  ok(/^[0-9]{12}$/.test(r.senha), 'só números gera só dígitos');
}

// ---------- todos os caracteres pertencem ao pool marcado ----------
{
  const r = gerar({ tamanho: 64, minusculas: true, simbolos: true });
  const pool = CONJUNTOS.minusculas + CONJUNTOS.simbolos;
  ok([...r.senha].every((ch) => pool.includes(ch)), 'nenhum caractere fora do pool');
}

// ---------- sem ambíguos ----------
{
  for (let i = 0; i < 20; i++) {
    const r = gerar({ ...TUDO, semAmbiguos: true });
    ok([...r.senha].every((ch) => !AMBIGUOS.has(ch)), 'rodada ' + i + ': sem 0/O/1/l/I/|/aspas');
  }
}

// ---------- erros ----------
igual(gerar({ tamanho: 20 }).erro !== undefined, true, 'nenhum conjunto marcado recusa');
igual(gerar({ tamanho: TAM_MIN - 1, minusculas: true }).erro !== undefined, true, 'abaixo do mínimo recusa');
igual(gerar({ tamanho: TAM_MAX + 1, minusculas: true }).erro !== undefined, true, 'acima do máximo recusa');
igual(gerar({ tamanho: 2, minusculas: true, maiusculas: true, numeros: true }).erro !== undefined, true,
  'tamanho menor que o nº de conjuntos recusa');
igual(gerar(null).erro !== undefined, true, 'entrada nula recusa sem estourar');

// ---------- duas chamadas não repetem (astronomicamente improvável) ----------
{
  const a = gerar(TUDO).senha; const b = gerar(TUDO).senha;
  ok(a !== b, 'duas gerações diferem');
}

// ---------- força ----------
igual(forca(30).classe, 'fraca', '30 bits é fraca');
igual(forca(50).classe, 'media', '50 bits é razoável');
igual(forca(70).classe, 'forte', '70 bits é forte');
igual(forca(120).classe, 'otima', '120 bits é excelente');

// ---------- distribuição: nenhum caractere domina de forma absurda ----------
// Sanidade grosseira (não é teste estatístico fino): em 200 senhas de 32 chars
// só de minúsculas (26 letras, ~246 por letra em média), nenhuma letra pode
// aparecer 3x a média — pegaria um viés grosseiro de módulo.
{
  const cont = new Map();
  for (let i = 0; i < 200; i++) {
    for (const ch of gerar({ tamanho: 32, minusculas: true }).senha) {
      cont.set(ch, (cont.get(ch) || 0) + 1);
    }
  }
  const media = (200 * 32) / 26;
  ok([...cont.values()].every((v) => v < media * 3), 'nenhuma letra 3x acima da média');
  igual(cont.size, 26, 'todas as 26 letras aparecem em 6400 sorteios');
}

console.log(`\n${n} verificações passaram`);
