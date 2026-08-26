'use strict';

// Normalização dos scripts do bloco de notas. Pura, testável sem servidor.
// As três portas de entrada (criar, editar, importar backup) passam por aqui —
// então é aqui que a invariante "subgrupo só existe dentro de grupo" e os
// limites de tamanho têm de valer, sob pena de uma porta deixar passar o que a
// outra barra (foi assim que o rdpDomain nasceu órfão).

const assert = require('assert');
const { normalizar, MAX } = require('../lib/scripts');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// ---------- nome é obrigatório ----------
igual(normalizar({ body: 'echo oi' }).erro !== undefined, true, 'sem nome, recusa');
igual(normalizar({ name: '   ' }).erro !== undefined, true, 'nome só de espaços, recusa');
igual(normalizar({ name: 'x'.repeat(MAX.name + 1), body: '' }).erro !== undefined, true, 'nome longo demais, recusa');

// ---------- feliz ----------
{
  const v = normalizar({ name: '  Limpar Docker ', group: ' Docker ', subgroup: ' Limpeza ', description: ' tira lixo ', body: 'docker system prune\n' });
  igual(v.erro, undefined, 'caso válido passa');
  igual(v.name, 'Limpar Docker', 'nome é trimado');
  igual(v.group, 'Docker', 'grupo é trimado');
  igual(v.subgroup, 'Limpeza', 'subgrupo é trimado');
  igual(v.description, 'tira lixo', 'descrição é trimada');
  igual(v.body, 'docker system prune\n', 'corpo preservado');
}

// ---------- subgrupo só existe dentro de grupo ----------
{
  const v = normalizar({ name: 'x', subgroup: 'Órfão', body: 'echo' });
  igual(v.subgroup, '', 'subgrupo sem grupo é descartado (não vira seção órfã)');
}

// ---------- CRLF e CR viram LF ----------
{
  const v = normalizar({ name: 'x', body: 'a\r\nb\rc' });
  igual(v.body, 'a\nb\nc', 'CRLF e CR isolado normalizados para LF');
}

// ---------- corpo pode ser vazio (rascunho) ----------
igual(normalizar({ name: 'rascunho' }).body, '', 'corpo ausente vira string vazia, não recusa');

// ---------- corpo gigante é recusado ----------
igual(normalizar({ name: 'x', body: 'a'.repeat(MAX.body + 1) }).erro !== undefined, true, 'corpo acima do teto recusa');

// ---------- entrada nula não estoura ----------
igual(normalizar(null).erro !== undefined, true, 'entrada nula recusa sem estourar');
igual(normalizar(undefined).erro !== undefined, true, 'entrada undefined recusa sem estourar');

// ---------- tipos estranhos não estouram ----------
{
  const v = normalizar({ name: 123, group: 456, body: 789 });
  igual(v.name, '123', 'nome numérico vira string');
  igual(v.body, '789', 'corpo numérico vira string');
}

console.log(`\n${n} verificações passaram`);
