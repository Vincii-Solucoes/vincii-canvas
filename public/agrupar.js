'use strict';

// Agrupamento de hosts: grupo > subgrupo.
//
// Vive num módulo próprio (e não dentro de app.js) porque é decisão de
// ORDENAÇÃO, e ordenação errada não quebra nada — só bagunça a lista em
// silêncio. Aqui ela é testável em Node, no mesmo modelo de uso duplo de
// horario.js e agenda.js.
//
// As regras, que a tela inteira assume:
//   - grupos em ordem alfabética pt-BR; os SEM grupo sempre por último, sob o
//     rótulo "Sem grupo";
//   - dentro do grupo, os hosts sem subgrupo vêm ANTES das seções de
//     subgrupo — o nível de cima primeiro, como numa listagem de pastas;
//   - subgrupos em ordem alfabética pt-BR;
//   - subgrupo só existe DENTRO de um grupo. Um host com subgrupo e sem grupo
//     é um estado que o servidor não grava — se aparecer (data.json editado à
//     mão, versão antiga), o subgrupo é ignorado em vez de criar uma seção
//     dentro de "Sem grupo", que é uma contradição em si.
//
// O balde dos sem-grupo é a chave '' — NÃO o texto "Sem grupo". Agrupar pelo
// texto fazia um grupo batizado literalmente de "Sem grupo" colidir com o
// balde: o servidor gravava o subgrupo dele e a tela o engolia, mudo. Digitado,
// "Sem grupo" é um grupo como outro qualquer: ordena no alfabeto e mantém os
// subgrupos — ficar esquisito na tela é problema de quem o batizou assim.

const SEM_GRUPO = 'Sem grupo';

// [{ nome, total, diretos: [host], subgrupos: [[nome, [host]]] }]
function agruparHosts(hosts) {
  const grupos = new Map(); // chave: o grupo como digitado; '' = sem grupo
  for (const h of hosts || []) {
    const g = (h.group || '').trim();
    const s = g ? (h.subgroup || '').trim() : '';
    if (!grupos.has(g)) grupos.set(g, { diretos: [], subs: new Map(), total: 0 });
    const ent = grupos.get(g);
    ent.total += 1;
    if (!s) { ent.diretos.push(h); continue; }
    if (!ent.subs.has(s)) ent.subs.set(s, []);
    ent.subs.get(s).push(h);
  }
  return [...grupos.entries()]
    .sort((a, b) => {
      if (a[0] === '') return 1;
      if (b[0] === '') return -1;
      return a[0].localeCompare(b[0], 'pt-BR');
    })
    .map(([chave, ent]) => ({
      nome: chave || SEM_GRUPO,
      total: ent.total,
      diretos: ent.diretos,
      subgrupos: [...ent.subs.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR')),
    }));
}

// A visão CHATA da mesma hierarquia: pares [rótulo, hosts], com o subgrupo no
// rótulo ("Produção › Web"). É o que as listas planas usam — a busca da barra
// lateral e a seleção da aba Executar — e é por o subgrupo estar no rótulo que
// buscar pelo nome dele encontra os hosts.
function agruparHostsPlano(hosts) {
  const out = [];
  for (const g of agruparHosts(hosts)) {
    if (g.diretos.length) out.push([g.nome, g.diretos]);
    for (const [sub, lista] of g.subgrupos) out.push([`${g.nome} › ${sub}`, lista]);
  }
  return out;
}

// Rótulo do grupo principal de um host, para desambiguar homônimos: "Infra",
// "Infra › Web" quando há subgrupo, ou "Sem grupo" quando não tem grupo.
function rotuloDoGrupo(h) {
  const g = ((h && h.group) || '').trim();
  const s = g ? ((h.subgroup || '').trim()) : '';
  if (g && s) return `${g} › ${s}`;
  if (g) return g;
  return SEM_GRUPO;
}

// Endereço enxuto, só para o desempate final entre dois homônimos do MESMO
// grupo — não precisa ser bonito, precisa ser único.
function enderecoCurto(h) {
  if (!h) return '';
  if (h.host) return String(h.host);
  if (h.url) return String(h.url);
  return '';
}

// Desambiguação de nomes repetidos. Dois hosts chamados "teampass" viram
// "teampass (Infra)" e "teampass (Clientes)": o nome sozinho não diz qual é.
// Devolve um Map id->sufixo (SEM parênteses); nomes ÚNICOS não entram no mapa —
// ficam limpos, sem poluição. Entre homônimos, o grupo principal costuma bastar;
// quando nem ele separa (dois "teampass" no mesmo grupo), entra o endereço.
function desambiguarHosts(hosts) {
  const porNome = new Map();
  for (const h of hosts || []) {
    const n = ((h && h.name) || '').trim().toLowerCase();
    if (!n) continue;
    if (!porNome.has(n)) porNome.set(n, []);
    porNome.get(n).push(h);
  }
  const suf = new Map();
  for (const lista of porNome.values()) {
    if (lista.length < 2) continue; // nome único: sem sufixo
    const porTag = new Map();
    for (const h of lista) {
      const tag = rotuloDoGrupo(h);
      if (!porTag.has(tag)) porTag.set(tag, []);
      porTag.get(tag).push(h);
    }
    for (const [tag, mesmos] of porTag) {
      if (mesmos.length === 1) { suf.set(mesmos[0].id, tag); continue; }
      // homônimos no MESMO grupo: o grupo não basta, o endereço desempata
      for (const h of mesmos) {
        const addr = enderecoCurto(h);
        suf.set(h.id, addr ? `${tag} · ${addr}` : tag);
      }
    }
  }
  return suf;
}

// Subgrupos que já existem DENTRO de um grupo, para o datalist do formulário —
// sugerir os de outro grupo espalharia nomes de um cliente no cadastro de outro.
function subgruposDe(hosts, grupo) {
  const g = (grupo || '').trim();
  if (!g) return [];
  return [...new Set((hosts || [])
    .filter((h) => (h.group || '').trim() === g)
    .map((h) => (h.subgroup || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

if (typeof window !== 'undefined') {
  window.agruparHosts = agruparHosts;
  window.agruparHostsPlano = agruparHostsPlano;
  window.subgruposDe = subgruposDe;
  window.desambiguarHosts = desambiguarHosts;
  window.rotuloDoGrupo = rotuloDoGrupo;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { agruparHosts, agruparHostsPlano, subgruposDe, desambiguarHosts, rotuloDoGrupo };
}
