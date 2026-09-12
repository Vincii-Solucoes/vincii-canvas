'use strict';

// Pastas em vários níveis: o subgrupo virou CAMINHO ("Rede/Core/BGP").
//
// O pedido era "múltiplos subgrupos". A saída escolhida foi caminho de texto,
// não pasta com id — a pasta existe porque há alguém dentro dela, e backup,
// importação e data.json não mudam de formato. Este arquivo fixa as regras que
// a tela e o servidor assumem sobre esse caminho.

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-pastas-'));
process.env.SSHC_DATA_DIR = dir;

const {
  agruparHosts, agruparHostsPlano, subgruposDe, rotuloDoGrupo, rotuloDoCaminho,
  normalizarCaminho, limitarCaminho, segmentos, dentroDe, moverCaminho, desambiguarHosts,
} = require('../public/agrupar');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

const H = (id, group, subgroup, extra) => ({ id, name: id, group, subgroup, host: `10.0.0.${id}`, ...extra });

// ---------- 1. normalização: uma pasta, uma grafia ----------

// "Rede / Core", "Rede//Core", "/Rede/Core/" e "Rede\Core" são a MESMA pasta.
// Sem isto a tela desenharia várias pastas com o mesmo nome, lado a lado.
{
  for (const grafia of ['Rede/Core', ' Rede / Core ', 'Rede//Core', '/Rede/Core/', 'Rede\\Core', 'Rede / /Core']) {
    igual(normalizarCaminho(grafia), 'Rede/Core', `normaliza ${JSON.stringify(grafia)}`);
  }
  igual(normalizarCaminho(''), '', 'vazio continua vazio');
  igual(normalizarCaminho(null), '', 'nulo vira vazio');
  igual(normalizarCaminho('   /  / '), '', 'só separadores é vazio');
  igual(segmentos('a/b/c'), ['a', 'b', 'c'], 'os níveis, na ordem');

  // O teto corta por NÍVEL inteiro. Cortar por caractere partia um nível ao
  // meio — "Rede/Core/BGP" virava "Rede/Core/B", uma pasta que ninguém digitou
  // — ou deixava barra pendurada no fim, fora da forma canônica.
  igual(limitarCaminho('Rede/Core/BGP', 12), 'Rede/Core', 'corta o último nível inteiro, não no meio');
  igual(limitarCaminho('Rede/Core/BGP', 9), 'Rede/Core', 'cabe exato');
  igual(limitarCaminho('Rede/Core/BGP', 8), 'Rede', 'dois níveis não cabem: fica um');
  igual(limitarCaminho('Redeeeeeee/Core', 4), 'Rede', 'nem o primeiro cabe: o primeiro é aparado');
  igual(limitarCaminho(' Rede // Core ', 50), 'Rede/Core', 'normaliza antes de medir');
  ok(!/\/$/.test(limitarCaminho('a'.repeat(199) + '/bc', 200)), 'nunca sobra barra no fim');
  igual(rotuloDoCaminho('Rede/Core'), 'Rede › Core', 'a tela separa com a seta, não com a barra');
}

// ---------- 2. a árvore: diretos antes das pastas, pastas em ordem, em CADA nível ----------
{
  const hosts = [
    H(1, 'Infra', 'Rede/Core/BGP'),
    H(2, 'Infra', 'Rede/Core'),
    H(3, 'Infra', 'Rede'),
    H(4, 'Infra', ''),
    H(5, 'Infra', 'Acesso'),
    H(6, 'Infra', 'Rede/Wifi'),
    H(7, '', 'orfao'),
  ];
  const [infra, semGrupo] = agruparHosts(hosts);
  igual(infra.nome, 'Infra', 'grupo com nome vem antes do balde');
  igual(infra.grupo, 'Infra', 'a chave crua do grupo é exposta');
  igual(infra.total, 6, 'o total do grupo conta TODOS os níveis');
  igual(infra.diretos.map((h) => h.id), [4], 'host direto do grupo primeiro');
  igual(infra.pastas.map((p) => p.nome), ['Acesso', 'Rede'], 'pastas do primeiro nível em ordem pt-BR');
  const rede = infra.pastas[1];
  igual(rede.caminho, 'Rede', 'a pasta sabe o próprio caminho');
  igual(rede.total, 4, 'o total da pasta conta o que está dentro, em qualquer profundidade');
  igual(rede.diretos.map((h) => h.id), [3], 'host direto da pasta antes das filhas');
  igual(rede.pastas.map((p) => p.nome), ['Core', 'Wifi'], 'filhas em ordem');
  const core = rede.pastas[0];
  igual(core.caminho, 'Rede/Core', 'o caminho da filha inclui a mãe');
  igual(core.diretos.map((h) => h.id), [2], 'direto de Core');
  igual(core.pastas[0].caminho, 'Rede/Core/BGP', 'terceiro nível');
  igual(core.pastas[0].diretos.map((h) => h.id), [1], 'host do terceiro nível');

  igual(semGrupo.nome, 'Sem grupo', 'o balde por último');
  igual(semGrupo.grupo, '', 'chave crua do balde é vazia');
  igual(semGrupo.pastas, [], 'pasta sem grupo é ignorada, não vira seção');
  igual(semGrupo.diretos.map((h) => h.id), [7], 'o host órfão fica direto no balde');

  // A forma antiga (`subgrupos`) continua existindo: a lista achatada em
  // pré-ordem, com o caminho completo — para quem só precisa da lista.
  igual(infra.subgrupos.map(([c, l]) => [c, l.map((h) => h.id)]),
    [['Acesso', [5]], ['Rede', [3]], ['Rede/Core', [2]], ['Rede/Core/BGP', [1]], ['Rede/Wifi', [6]]],
    'subgrupos achatados em pré-ordem, com caminho completo');
}

// ---------- 3. pasta que só existe por causa das filhas ----------

// "Rede" sem host direto, só com "Rede/Core": a árvore precisa do nó Rede (é
// a mãe), mas a lista achatada NÃO ganha uma seção "Rede" vazia.
{
  const hosts = [H(1, 'Infra', 'Rede/Core'), H(2, 'Infra', 'Rede/Wifi')];
  const [infra] = agruparHosts(hosts);
  igual(infra.pastas.map((p) => p.nome), ['Rede'], 'o nó intermediário existe na árvore');
  igual(infra.pastas[0].diretos, [], 'sem host direto');
  igual(infra.pastas[0].total, 2, 'mas o total conta as filhas');
  igual(infra.subgrupos.map(([c]) => c), ['Rede/Core', 'Rede/Wifi'], 'a lista achatada pula a pasta vazia');
  igual(agruparHostsPlano(hosts).map(([r]) => r), ['Infra › Rede › Core', 'Infra › Rede › Wifi'],
    'o rótulo plano leva o caminho inteiro — é por isso que buscar "Core" acha o host');
}

// ---------- 4. sugestões do formulário trazem os níveis intermediários ----------
{
  const hosts = [H(1, 'Infra', 'Rede/Core/BGP'), H(2, 'Infra', 'Acesso'), H(3, 'Clientes', 'Rede/X')];
  igual(subgruposDe(hosts, 'Infra'), ['Acesso', 'Rede', 'Rede/Core', 'Rede/Core/BGP'],
    '"Rede" e "Rede/Core" são sugeridas mesmo sem host direto — são pastas reais');
  igual(subgruposDe(hosts, 'Clientes'), ['Rede', 'Rede/X'], 'e as de um grupo não vazam para outro');
}

// ---------- 5. rótulo para desambiguar homônimos leva o caminho ----------
{
  igual(rotuloDoGrupo(H(1, 'Infra', 'Rede/Core')), 'Infra › Rede › Core', 'grupo e caminho');
  igual(rotuloDoGrupo(H(1, 'Infra', ' Rede // Core ')), 'Infra › Rede › Core', 'normalizado antes de rotular');
  const suf = desambiguarHosts([H(1, 'Infra', 'Rede/Core', { name: 'sw' }), H(2, 'Infra', 'Rede/Wifi', { name: 'sw' })]);
  igual(suf.get(1), 'Infra › Rede › Core', 'dois "sw" em pastas diferentes se distinguem pela pasta');
  igual(suf.get(2), 'Infra › Rede › Wifi', 'idem');
}

// ---------- 6. dentroDe e moverCaminho: por NÍVEL, não por prefixo de texto ----------
{
  ok(dentroDe('Rede/Core', 'Rede'), 'Rede/Core está em Rede');
  ok(dentroDe('Rede', 'Rede'), 'a própria pasta está nela mesma');
  ok(!dentroDe('Redes', 'Rede'), '"Redes" NÃO está em "Rede" — prefixo de texto não é hierarquia');
  ok(!dentroDe('Rede', 'Rede/Core'), 'a mãe não está na filha');
  ok(!dentroDe('Rede/Core', ''), 'nada está na pasta vazia');

  igual(moverCaminho('Rede/Core/BGP', 'Rede', 'Infra/Rede'), 'Infra/Rede/Core/BGP', 'mover leva o resto do caminho junto');
  igual(moverCaminho('Rede', 'Rede', 'Backbone'), 'Backbone', 'renomear a própria pasta');
  igual(moverCaminho('Rede/Core', 'Rede', ''), 'Core', 'tirar da pasta: o que estava dentro sobe um nível');
  igual(moverCaminho('Rede', 'Rede', ''), '', 'tirar a própria pasta: vai para o grupo');
  igual(moverCaminho('Redes/X', 'Rede', 'Y'), null, 'quem não está na pasta não é tocado');
  igual(moverCaminho('', 'Rede', 'Y'), null, 'host direto do grupo não é tocado');
}

// ---------- 7. as portas do servidor: cadastro, edição, importação e mover ----------

function pedir(porta, metodo, caminho, corpo) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? null : JSON.stringify(corpo);
    const req = http.request({ host: '127.0.0.1', port: porta, method: metodo, path: caminho,
      headers: dados ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dados) } : {} },
    (res) => {
      let c = '';
      res.on('data', (d) => { c += d; });
      res.on('end', () => resolve({ status: res.statusCode, corpo: c ? JSON.parse(c) : null }));
    });
    req.on('error', reject);
    if (dados) req.write(dados);
    req.end();
  });
}

(async () => {
  const { start } = require('../server');
  const server = await start();
  const porta = server.address().port;
  const base = { port: 22, username: 'root', protocol: 'ssh', auth: { type: 'agent' } };
  const estado = async () => (await pedir(porta, 'GET', '/api/state')).corpo;
  const acha = (e, nome) => e.hosts.find((x) => x.name === nome);

  // cadastro: o caminho entra normalizado
  let r = await pedir(porta, 'POST', '/api/hosts', { ...base, host: '10.1.0.1', name: 'bgp', group: 'Infra', subgroup: ' Rede / Core / BGP ' });
  igual(r.status, 200, 'cadastro com caminho de três níveis passa');
  igual(acha(await estado(), 'bgp').subgroup, 'Rede/Core/BGP', 'o caminho é gravado normalizado');

  r = await pedir(porta, 'POST', '/api/hosts', { ...base, host: '10.1.0.2', name: 'core', group: 'Infra', subgroup: 'Rede\\Core' });
  igual(acha(await estado(), 'core').subgroup, 'Rede/Core', 'barra invertida vira barra');

  r = await pedir(porta, 'POST', '/api/hosts', { ...base, host: '10.1.0.3', name: 'wifi', group: 'Infra', subgroup: 'Rede/Wifi' });
  r = await pedir(porta, 'POST', '/api/hosts', { ...base, host: '10.1.0.4', name: 'redes', group: 'Infra', subgroup: 'Redes' });
  r = await pedir(porta, 'POST', '/api/hosts', { ...base, host: '10.1.0.5', name: 'outro', group: 'Clientes', subgroup: 'Rede/Core' });

  // teto: caminho longo demais é cortado, não recusado
  r = await pedir(porta, 'POST', '/api/hosts', { ...base, host: '10.1.0.6', name: 'longo', group: 'Infra', subgroup: 'a/'.repeat(200) + 'fim' });
  igual(r.status, 200, 'caminho longo passa');
  const longo = acha(await estado(), 'longo').subgroup;
  ok(longo.length <= 200, 'e é cortado no teto');
  igual(longo, normalizarCaminho(longo), 'o que foi gravado está na forma canônica (sem barra pendurada)');

  // importação: mesma normalização
  r = await pedir(porta, 'POST', '/api/import', { hosts: [{ ...base, host: '10.1.0.7', name: 'importado', group: 'Infra', subgroup: '/Rede//Core/' }] });
  igual(r.status, 200, 'import com caminho sujo passa');
  igual(acha(await estado(), 'importado').subgroup, 'Rede/Core', 'e entra normalizado');

  // mover: "Rede" → "Infra/Rede" leva Core, BGP e Wifi; não toca "Redes" nem o outro grupo
  r = await pedir(porta, 'POST', '/api/pastas/mover', { colecao: 'hosts', group: 'Infra', de: 'Rede', para: 'Backbone/Rede' });
  igual(r.status, 200, 'mover pasta passa');
  igual(r.corpo.movidos, 4, 'moveu bgp, core, wifi e importado — e só eles');
  let e = await estado();
  igual(acha(e, 'bgp').subgroup, 'Backbone/Rede/Core/BGP', 'o resto do caminho vai junto');
  igual(acha(e, 'wifi').subgroup, 'Backbone/Rede/Wifi', 'a irmã também');
  igual(acha(e, 'redes').subgroup, 'Redes', '"Redes" não é "Rede": ficou onde estava');
  igual(acha(e, 'outro').subgroup, 'Rede/Core', 'o outro grupo não é tocado');

  // tirar da pasta: `para` vazio sobe todo mundo
  r = await pedir(porta, 'POST', '/api/pastas/mover', { colecao: 'hosts', group: 'Infra', de: 'Backbone', para: '' });
  igual(r.corpo.movidos, 4, 'tirar da pasta conta os mesmos quatro');
  e = await estado();
  igual(acha(e, 'bgp').subgroup, 'Rede/Core/BGP', 'quem estava em Backbone/Rede/Core/BGP sobe para Rede/Core/BGP');

  // entradas ruins
  r = await pedir(porta, 'POST', '/api/pastas/mover', { colecao: 'hosts', group: '', de: 'Rede', para: 'X' });
  igual(r.status, 400, 'sem grupo é erro');
  r = await pedir(porta, 'POST', '/api/pastas/mover', { colecao: 'hosts', group: 'Infra', de: '', para: 'X' });
  igual(r.status, 400, 'sem pasta de origem é erro');
  r = await pedir(porta, 'POST', '/api/pastas/mover', { colecao: 'hosts', group: 'Infra', de: 'NaoExiste', para: 'X' });
  igual(r.corpo.movidos, 0, 'pasta que não existe: zero movidos, sem erro');
  r = await pedir(porta, 'POST', '/api/pastas/mover', { colecao: 'script', group: 'Infra', de: 'Rede', para: 'X' });
  igual(r.status, 400, 'coleção desconhecida é erro — não vira "hosts" em silêncio');
  r = await pedir(porta, 'POST', '/api/pastas/mover', { colecao: 'hosts', group: 'Infra', de: 'Rede', para: 'Rede/Dentro' });
  igual(r.status, 400, 'o servidor também recusa pasta dentro dela mesma, não só a tela');

  // O teto vale para o RESULTADO do mover: "para" curto + resto do caminho pode
  // passar de 200, e a próxima edição do host cortaria isso no meio, trocando-o
  // de pasta em silêncio. Recusa ANTES de tocar em qualquer item.
  const antesDoTeto = acha(await estado(), 'bgp').subgroup;
  r = await pedir(porta, 'POST', '/api/pastas/mover', { colecao: 'hosts', group: 'Infra', de: 'Rede', para: 'x'.repeat(195) });
  igual(r.status, 400, 'resultado acima do teto é recusado');
  e = await estado();
  igual(acha(e, 'bgp').subgroup, antesDoTeto, 'e NENHUM host foi tocado (gravação atômica)');
  igual(acha(e, 'wifi').subgroup, 'Rede/Wifi', 'nem o irmão que caberia');

  // scripts: mesma regra, mesma rota
  r = await pedir(porta, 'POST', '/api/scripts', { name: 's1', group: 'Infra', subgroup: ' Rede / Core ', body: 'echo 1' });
  igual(r.status, 200, 'script com caminho passa');
  e = await estado();
  igual(e.scripts.find((s) => s.name === 's1').subgroup, 'Rede/Core', 'script grava o caminho normalizado');
  r = await pedir(porta, 'POST', '/api/pastas/mover', { colecao: 'scripts', group: 'Infra', de: 'Rede', para: 'Net' });
  igual(r.corpo.movidos, 1, 'mover pasta de scripts');
  e = await estado();
  igual(e.scripts.find((s) => s.name === 's1').subgroup, 'Net/Core', 'e o script foi');

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${n} verificações passaram`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
