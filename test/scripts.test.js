'use strict';

// Normalização dos scripts do bloco de notas. Pura, testável sem servidor.
// As três portas de entrada (criar, editar, importar backup) passam por aqui —
// então é aqui que a invariante "subgrupo só existe dentro de grupo" e os
// limites de tamanho têm de valer, sob pena de uma porta deixar passar o que a
// outra barra (foi assim que o rdpDomain nasceu órfão).

const assert = require('assert');
const { normalizar, fundirImportados, MAX } = require('../lib/scripts');

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

// ---------- fusão do import: homônimos não colapsam (achado da auditoria) ----------
{
  let seq = 0;
  const gid = () => 'gerado-' + (++seq);
  // dois homônimos COM id, store vazio: ambos preservados
  const dest = [];
  fundirImportados(dest, [
    { id: 'aaa', name: 'Backup', body: 'A' },
    { id: 'bbb', name: 'Backup', body: 'B' },
  ], gid);
  igual(dest.length, 2, 'dois homônimos com id não colapsam');
  ok(dest.some((s) => s.body === 'A') && dest.some((s) => s.body === 'B'), 'os dois corpos sobrevivem');

  // reimport do mesmo arquivo não duplica (casa por id)
  fundirImportados(dest, [
    { id: 'aaa', name: 'Backup', body: 'A' },
    { id: 'bbb', name: 'Backup', body: 'B' },
  ], gid);
  igual(dest.length, 2, 'reimport idempotente (casa por id)');

  // arquivo ANTIGO sem id, dois homônimos, store vazio: não colapsa (o bug)
  const dest2 = [];
  fundirImportados(dest2, [{ name: 'Deploy', body: 'X' }, { name: 'Deploy', body: 'Y' }], gid);
  igual(dest2.length, 2, 'sem id, homônimos ainda não colapsam (consumo por rodada)');

  // reimport antigo sobre dupes existentes: cada um atualiza o SEU, sem trocar
  const dest3 = [{ id: 'x', name: 'D', body: 'A' }, { id: 'y', name: 'D', body: 'B' }];
  fundirImportados(dest3, [{ name: 'D', body: 'A2' }, { name: 'D', body: 'B2' }], gid);
  igual(dest3.find((s) => s.id === 'x').body, 'A2', 'primeiro homônimo casa o primeiro registro');
  igual(dest3.find((s) => s.id === 'y').body, 'B2', 'segundo homônimo casa o segundo — sem corromper');

  // inválido é reportado, não gravado
  const dest4 = [];
  const r = fundirImportados(dest4, [{ body: 'sem nome' }], gid);
  igual(dest4.length, 0, 'script sem nome não entra');
  igual(r.invalidos.length, 1, 'e é reportado como inválido');
}

console.log(`\n${n} verificações passaram`);
