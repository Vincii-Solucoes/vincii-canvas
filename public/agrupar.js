'use strict';

// Agrupamento de hosts: grupo > pastas.
//
// Vive num módulo próprio (e não dentro de app.js) porque é decisão de
// ORDENAÇÃO, e ordenação errada não quebra nada — só bagunça a lista em
// silêncio. Aqui ela é testável em Node, no mesmo modelo de uso duplo de
// horario.js e agenda.js.
//
// O campo `subgroup` é um CAMINHO: "Rede/Core/BGP" é a pasta BGP dentro de
// Core dentro de Rede, com quantos níveis a pessoa quiser. Nasceu assim porque
// um nível só não bastava ("múltiplos subgrupos"), e a alternativa — pasta com
// id, pai, cadastro próprio — traria pasta vazia, pasta órfã, mover árvore e
// exportar a árvore à parte, tudo para um app de uma pessoa. Um caminho de
// texto dá a mesma árvore sem nada disso: a pasta existe porque há alguém
// dentro dela, exatamente como o grupo sempre existiu. E backup, importação e
// data.json não mudam — caminho é texto, subgrupo sempre foi texto.
//
// As regras, que a tela inteira assume:
//   - grupos em ordem alfabética pt-BR; os SEM grupo sempre por último, sob o
//     rótulo "Sem grupo";
//   - dentro de qualquer nível, os hosts DIRETOS vêm antes das pastas — o
//     nível de cima primeiro, como numa listagem de diretório;
//   - pastas em ordem alfabética pt-BR, em cada nível;
//   - pasta só existe DENTRO de um grupo. Um host com pasta e sem grupo é um
//     estado que o servidor não grava — se aparecer (data.json editado à mão,
//     versão antiga), a pasta é ignorada em vez de criar uma seção dentro de
//     "Sem grupo", que é uma contradição em si.
//
// O balde dos sem-grupo é a chave '' — NÃO o texto "Sem grupo". Agrupar pelo
// texto fazia um grupo batizado literalmente de "Sem grupo" colidir com o
// balde: o servidor gravava o subgrupo dele e a tela o engolia, mudo. Digitado,
// "Sem grupo" é um grupo como outro qualquer: ordena no alfabeto e mantém os
// subgrupos — ficar esquisito na tela é problema de quem o batizou assim.

const SEM_GRUPO = 'Sem grupo';
const SEPARADOR = '/';
// O que separa os níveis na TELA. Diferente do separador do dado de propósito:
// "Rede › Core" lê como caminho, "Rede/Core" lê como uma coisa só chamada assim.
const SETA = ' › ';

// Um caminho de pasta como a pessoa digitou → como o app guarda. Os níveis são
// separados por "/" (a barra invertida do Windows também vale), cada nível é
// aparado, e nível vazio some: " Rede // Core / " vira "Rede/Core". Sem isto,
// "Rede/Core" e "Rede / Core" seriam duas pastas diferentes com o mesmo nome.
function normalizarCaminho(caminho) {
  return segmentos(caminho).join(SEPARADOR);
}

// Caminho normalizado E dentro do teto, cortando por NÍVEL inteiro: cortar por
// caractere partia um nível ao meio ("Rede/Core/BGP" virava "Rede/Core/B", uma
// pasta que ninguém digitou) ou deixava barra pendurada no fim. Se nem o
// primeiro nível couber, fica só ele, aparado.
function limitarCaminho(caminho, max) {
  const segs = segmentos(caminho);
  while (segs.length > 1 && segs.join(SEPARADOR).length > max) segs.pop();
  return segs.join(SEPARADOR).slice(0, max);
}

// Os níveis de um caminho, já aparados e sem os vazios.
function segmentos(caminho) {
  return String(caminho == null ? '' : caminho)
    .split(/[\/\\]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// A pasta de um host, já normalizada — e só se ele tiver grupo (regra acima).
function pastaDe(h) {
  const g = ((h && h.group) || '').trim();
  return g ? normalizarCaminho(h.subgroup) : '';
}

const ordemPt = (a, b) => a.localeCompare(b, 'pt-BR');

// Um nó da árvore: { nome, caminho, total, diretos: [host], pastas: [nó] }.
// `caminho` é o caminho completo desde o grupo ("Rede/Core"), que é o que a
// tela usa como chave para lembrar o que está recolhido e para mover a pasta.
function novoNo(nome, caminho) {
  return { nome, caminho, total: 0, diretos: [], pastas: new Map() };
}

function fecharNo(no) {
  return {
    nome: no.nome,
    caminho: no.caminho,
    total: no.total,
    diretos: no.diretos,
    pastas: [...no.pastas.values()].sort((a, b) => ordemPt(a.nome, b.nome)).map(fecharNo),
  };
}

// Todas as pastas de um grupo, achatadas em pré-ordem (a pasta antes das suas
// filhas, irmãs em ordem alfabética), como pares [caminho, hosts]. Só entram
// pastas que têm host DIRETO — uma pasta que só existe por causa das filhas
// não é uma seção com conteúdo. É a forma antiga de `subgrupos`, mantida para
// quem só precisa da lista e não da árvore.
function achatar(pastas, out) {
  for (const p of pastas) {
    if (p.diretos.length) out.push([p.caminho, p.diretos]);
    achatar(p.pastas, out);
  }
  return out;
}

// [{ nome, grupo, total, diretos: [host], pastas: [nó], subgrupos: [[caminho, [host]]] }]
// `nome` é o rótulo da tela ("Sem grupo" para o balde vazio); `grupo` é a chave
// crua ('' para o balde) — é ela que identifica o grupo, porque um grupo pode
// se chamar literalmente "Sem grupo".
function agruparHosts(hosts) {
  const grupos = new Map(); // chave: o grupo como digitado; '' = sem grupo
  for (const h of hosts || []) {
    const g = ((h && h.group) || '').trim();
    if (!grupos.has(g)) grupos.set(g, novoNo(g || SEM_GRUPO, ''));
    const raiz = grupos.get(g);
    raiz.total += 1;
    const niveis = g ? segmentos(h.subgroup) : [];
    if (!niveis.length) { raiz.diretos.push(h); continue; }
    // Desce a árvore criando os níveis que faltam.
    let no = raiz;
    let caminho = '';
    for (const nome of niveis) {
      caminho = caminho ? caminho + SEPARADOR + nome : nome;
      if (!no.pastas.has(nome)) no.pastas.set(nome, novoNo(nome, caminho));
      no = no.pastas.get(nome);
      no.total += 1;
    }
    no.diretos.push(h);
  }
  return [...grupos.entries()]
    .sort((a, b) => {
      if (a[0] === '') return 1;
      if (b[0] === '') return -1;
      return ordemPt(a[0], b[0]);
    })
    .map(([chave, raiz]) => {
      const fechado = fecharNo(raiz);
      fechado.grupo = chave;
      fechado.subgrupos = achatar(fechado.pastas, []);
      return fechado;
    });
}

// Rótulo de um caminho para a tela: "Rede › Core".
function rotuloDoCaminho(caminho) {
  return segmentos(caminho).join(SETA);
}

// A visão CHATA da mesma hierarquia: pares [rótulo, hosts], com a pasta no
// rótulo ("Produção › Rede › Core"). É o que as listas planas usam — a busca da
// barra lateral e a seleção da aba Executar — e é por a pasta estar no rótulo
// que buscar pelo nome de qualquer nível encontra os hosts.
function agruparHostsPlano(hosts) {
  const out = [];
  for (const g of agruparHosts(hosts)) {
    if (g.diretos.length) out.push([g.nome, g.diretos]);
    for (const [caminho, lista] of g.subgrupos) out.push([g.nome + SETA + rotuloDoCaminho(caminho), lista]);
  }
  return out;
}

// Rótulo do grupo principal de um host, para desambiguar homônimos: "Infra",
// "Infra › Rede › Core" quando há pasta, ou "Sem grupo" quando não tem grupo.
function rotuloDoGrupo(h) {
  const g = ((h && h.group) || '').trim();
  const s = pastaDe(h);
  if (g && s) return g + SETA + rotuloDoCaminho(s);
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

// Pastas que já existem DENTRO de um grupo, para o datalist do formulário —
// sugerir as de outro grupo espalharia nomes de um cliente no cadastro de outro.
// Entram também os PREFIXOS: se existe "Rede/Core", "Rede" é sugerida, porque
// é uma pasta real da árvore mesmo sem host direto nela.
function subgruposDe(hosts, grupo) {
  const g = (grupo || '').trim();
  if (!g) return [];
  const out = new Set();
  for (const h of hosts || []) {
    if (((h && h.group) || '').trim() !== g) continue;
    const niveis = segmentos(h.subgroup);
    for (let i = 1; i <= niveis.length; i += 1) out.add(niveis.slice(0, i).join(SEPARADOR));
  }
  return [...out].sort(ordemPt);
}

// Uma pasta é a própria ou está dentro da outra? "Rede/Core" está em "Rede";
// "Redes" NÃO está em "Rede" — o teste é por nível, não por prefixo de texto.
function dentroDe(caminho, pasta) {
  const a = segmentos(caminho);
  const b = segmentos(pasta);
  if (!b.length || a.length < b.length) return false;
  return b.every((nome, i) => a[i] === nome);
}

// Move/renomeia uma pasta: devolve o caminho novo de `caminho` se ele estiver
// em `de` (trocando esse trecho por `para`), ou null se não estiver. Mover
// "Rede" para "Infra/Rede" leva "Rede/Core" para "Infra/Rede/Core". `para`
// vazio significa "tirar da pasta": os hosts sobem para o grupo.
function moverCaminho(caminho, de, para) {
  if (!dentroDe(caminho, de)) return null;
  const resto = segmentos(caminho).slice(segmentos(de).length);
  return [...segmentos(para), ...resto].join(SEPARADOR);
}

if (typeof window !== 'undefined') {
  window.agruparHosts = agruparHosts;
  window.agruparHostsPlano = agruparHostsPlano;
  window.subgruposDe = subgruposDe;
  window.desambiguarHosts = desambiguarHosts;
  window.rotuloDoGrupo = rotuloDoGrupo;
  window.rotuloDoCaminho = rotuloDoCaminho;
  window.normalizarCaminho = normalizarCaminho;
  window.limitarCaminho = limitarCaminho;
  window.segmentosDoCaminho = segmentos;
  window.pastaDentroDe = dentroDe;
  window.moverCaminho = moverCaminho;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    agruparHosts, agruparHostsPlano, subgruposDe, desambiguarHosts, rotuloDoGrupo,
    rotuloDoCaminho, normalizarCaminho, limitarCaminho, segmentos, pastaDe, dentroDe, moverCaminho, SETA, SEPARADOR,
  };
}
