'use strict';

// Pastas DECLARADAS: as que existem por vontade própria, mesmo vazias.
//
// A árvore da aba Hosts nasce dos hosts (public/agrupar.js): um host em
// "Rede/Core" faz "Rede" e "Rede/Core" existirem. O que os hosts não dizem é a
// pasta que a pessoa criou e ainda não pôs nada dentro — e a pasta que
// esvaziou e ela quer manter. Esta lista completa isso, e só isso: é um
// conjunto de { colecao, group, caminho }, sem id, sem pai, sem nada que a
// árvore já não saiba derivar. Toda pasta em que um host é gravado entra aqui
// também (com os níveis de cima), para a pasta continuar existindo quando o
// último host sair — como um diretório de verdade.
//
// Puro e testável: quem grava é o servidor; quem desenha é a tela.

const agrupar = require('../public/agrupar');

const MAX_DECLARADAS = 2000;
const MAX_CAMINHO = 200;
const COLECOES = new Set(['hosts', 'scripts']);
// Mesmo teto de grupo do cadastro de cada coleção (hosts: server.js; scripts:
// lib/scripts.js MAX.group). Cortar abaixo do que a coleção aceita inventaria
// um grupo truncado que nenhum item tem — um grupo fantasma na árvore.
const MAX_GRUPO = { hosts: 60, scripts: 80 };

function normalizar(entrada) {
  const e = entrada || {};
  const colecao = COLECOES.has(e.colecao) ? e.colecao : 'hosts';
  const group = String(e.group == null ? '' : e.group).trim().slice(0, MAX_GRUPO[colecao]).trim();
  const caminho = agrupar.limitarCaminho(e.caminho, MAX_CAMINHO);
  if (!group || !caminho) return null; // pasta só existe dentro de um grupo
  return { colecao, group, caminho };
}

const chave = (p) => `${p.colecao}|${p.group}|${p.caminho}`;

// Declara a pasta E os níveis acima dela ("Rede/Core/BGP" declara "Rede" e
// "Rede/Core" também). Idempotente. Devolve quantas entraram de fato.
function declarar(lista, colecao, group, caminho) {
  const base = normalizar({ colecao, group, caminho });
  if (!base) return 0;
  const existentes = new Set(lista.map(chave));
  const niveis = agrupar.segmentos(base.caminho);
  let novas = 0;
  for (let i = 1; i <= niveis.length; i += 1) {
    const p = { colecao: base.colecao, group: base.group, caminho: niveis.slice(0, i).join('/') };
    const k = chave(p);
    if (existentes.has(k)) continue;
    if (lista.length >= MAX_DECLARADAS) break;
    lista.push(p);
    existentes.add(k);
    novas += 1;
  }
  return novas;
}

// Remove a pasta e tudo que está dentro dela. Devolve quantas saíram.
function remover(lista, colecao, group, caminho) {
  const base = normalizar({ colecao, group, caminho });
  if (!base) return 0;
  let n = 0;
  for (let i = lista.length - 1; i >= 0; i -= 1) {
    const p = lista[i];
    if (p.colecao !== base.colecao || p.group !== base.group) continue;
    if (!agrupar.dentroDe(p.caminho, base.caminho)) continue;
    lista.splice(i, 1);
    n += 1;
  }
  return n;
}

// Renomeia/move a pasta e as de dentro, com a mesma regra de agrupar.moverCaminho
// (o trecho `de` vira `para`, o resto vai junto). `para` vazio dissolve: as
// pastas de dentro sobem um nível e a própria some. Duplicatas que a mudança
// crie são fundidas. Devolve quantas mudaram.
function mover(lista, colecao, group, de, para) {
  const origem = normalizar({ colecao, group, caminho: de });
  if (!origem) return 0;
  const destino = agrupar.normalizarCaminho(para);
  const vistas = new Set(lista.filter((p) => p.colecao !== origem.colecao || p.group !== origem.group
    || !agrupar.dentroDe(p.caminho, origem.caminho)).map(chave));
  let n = 0;
  for (let i = lista.length - 1; i >= 0; i -= 1) {
    const p = lista[i];
    if (p.colecao !== origem.colecao || p.group !== origem.group) continue;
    const novo = agrupar.moverCaminho(p.caminho, origem.caminho, destino);
    if (novo === null) continue;
    n += 1;
    if (!novo) { lista.splice(i, 1); continue; } // dissolvida no grupo
    const cand = { colecao: p.colecao, group: p.group, caminho: novo };
    const k = chave(cand);
    if (vistas.has(k)) { lista.splice(i, 1); continue; } // fundiu com uma que já existia
    vistas.add(k);
    lista[i] = cand;
  }
  // O destino (e os níveis acima dele) passam a existir — sem isto, mover
  // "Rede" para "Infra/Rede" deixaria "Infra" sem declaração própria.
  if (destino) declarar(lista, origem.colecao, origem.group, destino);
  return n;
}

// Os caminhos declarados de um grupo, para a árvore e para as sugestões.
function das(lista, colecao, group) {
  const g = String(group == null ? '' : group).trim();
  const c = COLECOES.has(colecao) ? colecao : 'hosts';
  return (lista || []).filter((p) => p && p.colecao === c && p.group === g).map((p) => p.caminho);
}

// Sanear a lista inteira ao carregar/importar: descarta o que não é pasta,
// funde duplicatas e respeita o teto.
function sanear(lista) {
  const out = [];
  const vistas = new Set();
  for (const e of Array.isArray(lista) ? lista : []) {
    const p = normalizar(e);
    if (!p) continue;
    const k = chave(p);
    if (vistas.has(k)) continue;
    vistas.add(k);
    out.push(p);
    if (out.length >= MAX_DECLARADAS) break;
  }
  return out;
}

// Completa a lista com as pastas em que hosts e scripts JÁ estão. Roda na
// carga do data.json: dados de antes desta lista existir tinham pastas só
// derivadas dos hosts, e elas sumiriam ao esvaziar — diferente das novas.
// Idempotente; devolve quantas entraram.
function completarDosItens(lista, d) {
  let n = 0;
  for (const h of (d && Array.isArray(d.hosts)) ? d.hosts : []) {
    if (h && h.group && h.subgroup) n += declarar(lista, 'hosts', h.group, h.subgroup);
  }
  for (const s of (d && Array.isArray(d.scripts)) ? d.scripts : []) {
    if (s && s.group && s.subgroup) n += declarar(lista, 'scripts', s.group, s.subgroup);
  }
  return n;
}

module.exports = { normalizar, declarar, remover, mover, das, sanear, completarDosItens, MAX_DECLARADAS, MAX_CAMINHO, MAX_GRUPO };
