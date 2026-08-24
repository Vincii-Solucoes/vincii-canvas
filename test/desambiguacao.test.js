'use strict';

// Desambiguação de nomes repetidos.
//
// O problema real do usuário: ele tem um host "teampass" e um dia cria OUTRO
// "teampass" em outro grupo. Nas listas (barra lateral, recentes, filtro do
// histórico) o nome sozinho não diz qual é qual. A regra aqui: só nomes que se
// REPETEM ganham um sufixo "(grupo principal)"; nome único fica limpo. Entre
// homônimos o grupo costuma bastar, e quando nem ele separa (dois no mesmo
// grupo) entra o endereço. Função pura, testada sem subir servidor.

const assert = require('assert');
const { desambiguarHosts, rotuloDoGrupo } = require('../public/agrupar');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// ---------- 1. nome único não ganha sufixo ----------
{
  const suf = desambiguarHosts([
    { id: 'a', name: 'teampass', group: 'Infra' },
    { id: 'b', name: 'gitlab', group: 'Infra' },
  ]);
  igual(suf.get('a'), undefined, 'nome único fica sem sufixo (limpo)');
  igual(suf.get('b'), undefined, 'o outro nome único também');
  igual(suf.size, 0, 'nada a desambiguar');
}

// ---------- 2. o caso do usuário: dois "teampass" em grupos diferentes ----------
{
  const suf = desambiguarHosts([
    { id: 'a', name: 'teampass', group: 'Infra' },
    { id: 'b', name: 'teampass', group: 'Clientes' },
  ]);
  igual(suf.get('a'), 'Infra', 'um vira teampass (Infra)');
  igual(suf.get('b'), 'Clientes', 'o outro vira teampass (Clientes)');
}

// ---------- 3. maiúsculas/minúsculas contam como o mesmo nome ----------
{
  const suf = desambiguarHosts([
    { id: 'a', name: 'TeamPass', group: 'Infra' },
    { id: 'b', name: 'teampass', group: 'Clientes' },
  ]);
  ok(suf.get('a') === 'Infra' && suf.get('b') === 'Clientes', 'homônimo ignora caixa');
}

// ---------- 4. subgrupo entra no rótulo ----------
{
  const suf = desambiguarHosts([
    { id: 'a', name: 'web', group: 'Produção', subgroup: 'Front' },
    { id: 'b', name: 'web', group: 'Produção', subgroup: 'Back' },
  ]);
  igual(suf.get('a'), 'Produção › Front', 'mesmo grupo, subgrupos diferentes: usa o subgrupo');
  igual(suf.get('b'), 'Produção › Back', 'e o outro subgrupo');
}

// ---------- 5. homônimos no MESMO grupo: o endereço desempata ----------
{
  const suf = desambiguarHosts([
    { id: 'a', name: 'db', group: 'Infra', host: '10.0.0.1' },
    { id: 'b', name: 'db', group: 'Infra', host: '10.0.0.2' },
  ]);
  igual(suf.get('a'), 'Infra · 10.0.0.1', 'grupo igual: cai para o endereço');
  igual(suf.get('b'), 'Infra · 10.0.0.2', 'e o outro endereço');
}

// ---------- 6. sem grupo ainda desambigua ----------
{
  const suf = desambiguarHosts([
    { id: 'a', name: 'nas', group: '' },
    { id: 'b', name: 'nas', group: 'Casa' },
  ]);
  igual(suf.get('a'), 'Sem grupo', 'o sem-grupo vira "(Sem grupo)"');
  igual(suf.get('b'), 'Casa', 'o com grupo, o grupo');
}

// ---------- 7. rotuloDoGrupo sozinho ----------
{
  igual(rotuloDoGrupo({ group: 'Infra' }), 'Infra', 'só grupo');
  igual(rotuloDoGrupo({ group: 'Infra', subgroup: 'Web' }), 'Infra › Web', 'grupo › subgrupo');
  igual(rotuloDoGrupo({ group: '', subgroup: 'X' }), 'Sem grupo', 'subgrupo órfão é ignorado');
  igual(rotuloDoGrupo({}), 'Sem grupo', 'host pelado');
}

// ---------- 8. nomes vazios não quebram nem colidem entre si ----------
{
  const suf = desambiguarHosts([
    { id: 'a', name: '', group: 'X' },
    { id: 'b', name: '   ', group: 'Y' },
    { id: 'c', name: 'real', group: 'Z' },
  ]);
  igual(suf.size, 0, 'nomes vazios/em branco são ignorados, não viram homônimos');
}

// ---------- 9. três homônimos, mistura de grupos ----------
{
  const suf = desambiguarHosts([
    { id: 'a', name: 'app', group: 'A' },
    { id: 'b', name: 'app', group: 'B' },
    { id: 'c', name: 'app', group: 'A', host: '1.2.3.4' },
  ]);
  igual(suf.get('b'), 'B', 'o único do grupo B basta com o grupo');
  igual(suf.get('c'), 'A · 1.2.3.4', 'o do grupo A com endereço desempata pelo endereço');
  ok(suf.get('a') !== suf.get('c'), 'os dois do grupo A ficam distintos entre si');
}

console.log(`\n${n} verificações passaram`);
