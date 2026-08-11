'use strict';
// Verifica, no FONTE, que a recusa definitiva do cofre tira o host da lista de
// "abrir agora" sem tirá-lo da lista de "tem horário" (a aba continua travada).
const fs = require('fs'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n += 1; };

ok(/const COFRE_DEFINITIVO = new Set\(\[/.test(src), 'existe a lista de códigos que não melhoram com insistência');
for (const c of ['sem_permissao', 'cliente_inativo', 'chave_expirada']) {
  ok(new RegExp(`'${c}'`).test(src.slice(src.indexOf('COFRE_DEFINITIVO'), src.indexOf('COFRE_DEFINITIVO') + 400)),
    `"${c}" está na lista — é o que o cofre responde para analista desligado ou contrato encerrado`);
}
ok(/const paraAbrir = agendados\.filter\(\(h\) => !recusadoPeloCofre\.has\(h\.id\)\)/.test(src),
  'a lista de ABRIR exclui os recusados');
ok(/for \(const h of paraAbrir\) \{/.test(src),
  'e é essa lista que o laço percorre — usar `agendados` aqui refaria 480 tentativas por faixa');
ok(/recusadoPeloCofre\.delete\(id\)/.test(src),
  'a marca é esquecida quando o host sai da faixa: reentrar tenta de novo, porque o ERP pode ter sido corrigido');
ok(/sessaoTravada|noHorario\(h, new Date\(\)\)/.test(src),
  'a trava da aba continua olhando só o horário — um host recusado pelo cofre não destrava a aba que já está aberta');
ok(/if \(m\.cofre\) anotarRecusaDoCofre/.test(src),
  'o navegador só anota quando o SERVIDOR manda o código do cofre, e não por texto da mensagem');
console.log(`\n${n} verificações passaram`);
