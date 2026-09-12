'use strict';

// Pastas DECLARADAS: as que existem mesmo vazias (lib/pastas.js).
//
// A árvore nasce dos hosts; isto completa o que os hosts não dizem — a pasta
// recém-criada, ainda sem nada, e a que esvaziou e a pessoa quer manter. É o
// "Nova pasta" e o "Excluir pasta" do gerenciador de arquivos.

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-pastas-decl-'));
process.env.SSHC_DATA_DIR = dir;

const pastas = require('../lib/pastas');
const { agruparHosts, subgruposDe } = require('../public/agrupar');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// ---------- 1. declarar: a pasta e os níveis acima; idempotente ----------
{
  const L = [];
  igual(pastas.declarar(L, 'hosts', 'Infra', ' Rede / Core / BGP '), 3, 'declara a pasta e os dois níveis acima');
  igual(pastas.das(L, 'hosts', 'Infra'), ['Rede', 'Rede/Core', 'Rede/Core/BGP'], 'normalizada, com os prefixos');
  igual(pastas.declarar(L, 'hosts', 'Infra', 'Rede/Core'), 0, 'declarar de novo não duplica');
  igual(pastas.declarar(L, 'hosts', '', 'X'), 0, 'sem grupo não há onde pendurar');
  igual(pastas.declarar(L, 'hosts', 'Infra', '  '), 0, 'caminho vazio não é pasta');
  igual(pastas.das(L, 'scripts', 'Infra'), [], 'hosts e scripts têm árvores separadas');
  igual(pastas.das(L, 'hosts', 'Outro'), [], 'e cada grupo a sua');
}

// ---------- 2. mover e remover, com o que está dentro ----------
{
  const L = [];
  pastas.declarar(L, 'hosts', 'Infra', 'Rede/Core/BGP');
  pastas.declarar(L, 'hosts', 'Infra', 'Rede/Wifi');
  pastas.declarar(L, 'hosts', 'Infra', 'Acesso');
  igual(pastas.mover(L, 'hosts', 'Infra', 'Rede', 'Backbone/Rede'), 4, 'mover renomeia a pasta e as de dentro');
  igual(pastas.das(L, 'hosts', 'Infra').sort(),
    ['Acesso', 'Backbone', 'Backbone/Rede', 'Backbone/Rede/Core', 'Backbone/Rede/Core/BGP', 'Backbone/Rede/Wifi'],
    'o destino e o nível acima dele passam a existir');
  igual(pastas.mover(L, 'hosts', 'Infra', 'Backbone', ''), 5, 'dissolver: tudo sobe um nível');
  igual(pastas.das(L, 'hosts', 'Infra').sort(), ['Acesso', 'Rede', 'Rede/Core', 'Rede/Core/BGP', 'Rede/Wifi'],
    'e a dissolvida some');
  // fusão: mover "Acesso" para "Rede" (que já existe) não duplica "Rede"
  pastas.declarar(L, 'hosts', 'Infra', 'Acesso/GPON');
  pastas.mover(L, 'hosts', 'Infra', 'Acesso', 'Rede');
  igual(pastas.das(L, 'hosts', 'Infra').filter((c) => c === 'Rede').length, 1, 'fusão não duplica a pasta');
  ok(pastas.das(L, 'hosts', 'Infra').includes('Rede/GPON'), 'a de dentro foi junto para o destino');
  igual(pastas.remover(L, 'hosts', 'Infra', 'Rede/Core'), 2, 'remover tira a pasta e as de dentro');
  ok(!pastas.das(L, 'hosts', 'Infra').some((c) => c.startsWith('Rede/Core')), 'nada de Core sobrou');
  ok(pastas.das(L, 'hosts', 'Infra').includes('Rede'), 'a mãe fica');
}

// ---------- 2b. mover pasta que NÃO existe não inventa o destino ----------
{
  const L = [];
  pastas.declarar(L, 'hosts', 'Infra', 'Rede');
  igual(pastas.mover(L, 'hosts', 'Infra', 'NaoExiste', 'Fantasma/Sub'), 0, 'nada para mover');
  igual(pastas.das(L, 'hosts', 'Infra'), ['Rede'], 'e o destino NÃO foi declarado');
  igual(pastas.mover(L, 'hosts', 'OutroGrupo', 'Rede', 'X'), 0, 'grupo que não existe: nada');
  igual(pastas.das(L, 'hosts', 'OutroGrupo'), [], 'e nenhum grupo novo nasceu');
}

// ---------- 2c. limitarCaminho é linear ----------
{
  const { limitarCaminho } = require('../public/agrupar');
  const t0 = process.hrtime.bigint();
  const r = limitarCaminho('a/'.repeat(60000), 200);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  ok(ms < 100, `60 mil níveis em ${ms.toFixed(1)} ms (o laço antigo levava ~12 s)`);
  ok(r.length <= 200 && !r.endsWith('/'), 'resultado dentro do teto e canônico');
}

// ---------- 3. sanear: lista vinda de arquivo ----------
{
  const suja = [
    { colecao: 'hosts', group: 'Infra', caminho: ' Rede // Core ' },
    { colecao: 'hosts', group: 'Infra', caminho: 'Rede/Core' }, // duplicata
    { colecao: 'bogus', group: 'Infra', caminho: 'X' },          // coleção inválida → hosts
    { group: '', caminho: 'orfa' },                             // sem grupo: fora
    null, 'texto', { colecao: 'scripts', group: 'Infra' },     // lixo
  ];
  igual(pastas.sanear(suja), [
    { colecao: 'hosts', group: 'Infra', caminho: 'Rede/Core' },
    { colecao: 'hosts', group: 'Infra', caminho: 'X' },
  ], 'só o que é pasta, normalizado e sem duplicata');
  ok(pastas.sanear(Array.from({ length: 3000 }, (_, i) => ({ group: 'G', caminho: 'p' + i }))).length <= pastas.MAX_DECLARADAS,
    'o teto vale ao sanear');
}

// ---------- 3b. dados antigos: as pastas dos hosts viram declaradas na carga ----------
{
  const d = { hosts: [{ group: 'Infra', subgroup: 'Rede/Core' }, { group: 'Infra', subgroup: '' }, { group: '', subgroup: 'orfa' }],
    scripts: [{ group: 'Infra', subgroup: 'Util' }], pastas: [] };
  igual(pastas.completarDosItens(d.pastas, d), 3, 'declara Rede, Rede/Core e Util');
  igual(pastas.das(d.pastas, 'hosts', 'Infra'), ['Rede', 'Rede/Core'], 'as dos hosts');
  igual(pastas.das(d.pastas, 'scripts', 'Infra'), ['Util'], 'as dos scripts, separadas');
  igual(pastas.completarDosItens(d.pastas, d), 0, 'idempotente');
}

// ---------- 4. a árvore absorve as declaradas ----------
{
  const hosts = [{ id: 1, name: 'a', group: 'Infra', subgroup: 'Rede/Core' }];
  const decl = [{ group: 'Infra', caminho: 'Rede/Wifi' }, { group: 'Infra', caminho: 'Backup' }, { group: 'Novo', caminho: 'Srv' }];
  const g = agruparHosts(hosts, decl);
  igual(g.map((x) => [x.nome, x.total]), [['Infra', 1], ['Novo', 0]], 'grupo só com pastas declaradas aparece, com 0 hosts');
  const infra = g[0];
  igual(infra.pastas.map((p) => [p.nome, p.total]), [['Backup', 0], ['Rede', 1]], 'pasta vazia aparece com 0');
  igual(infra.pastas[1].pastas.map((p) => [p.nome, p.total]), [['Core', 1], ['Wifi', 0]], 'subpasta vazia idem');
  igual(infra.subgrupos.map(([c]) => c), ['Rede/Core'], 'a lista achatada continua só com quem tem host');
  igual(subgruposDe(hosts, 'Infra', decl), ['Backup', 'Rede', 'Rede/Core', 'Rede/Wifi'], 'sugestões incluem as vazias');
  igual(agruparHosts(hosts, [{ group: '', caminho: 'X' }]).length, 1, 'declarada sem grupo é ignorada');
}

// ---------- 5. as rotas ----------

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
  const decl = async (g) => (await estado()).pastas.filter((p) => p.colecao === 'hosts' && p.group === g).map((p) => p.caminho).sort();
  const acha = (e, nome) => e.hosts.find((x) => x.name === nome);

  // criar pasta vazia
  let r = await pedir(porta, 'POST', '/api/pastas', { colecao: 'hosts', group: 'Infra', caminho: ' Rede / Core ' });
  igual(r.status, 200, 'criar pasta passa');
  igual(r.corpo.criadas, 2, 'criou a pasta e o nível acima');
  igual(await decl('Infra'), ['Rede', 'Rede/Core'], 'as duas estão declaradas');
  r = await pedir(porta, 'POST', '/api/pastas', { colecao: 'hosts', group: 'Infra', caminho: 'Rede/Core' });
  igual(r.corpo.criadas, 0, 'criar de novo é inofensivo');
  r = await pedir(porta, 'POST', '/api/pastas', { colecao: 'hosts', group: '', caminho: 'X' });
  igual(r.status, 400, 'sem grupo é erro');
  r = await pedir(porta, 'POST', '/api/pastas', { colecao: 'lixo', group: 'Infra', caminho: 'X' });
  igual(r.status, 400, 'coleção desconhecida é erro');

  // a árvore do state mostra a pasta vazia
  let e = await estado();
  ok(e.pastas.some((p) => p.caminho === 'Rede/Core'), 'o /api/state devolve as pastas');

  // cadastrar host numa pasta NOVA declara a pasta (ela sobrevive ao host)
  r = await pedir(porta, 'POST', '/api/hosts', { ...base, host: '10.2.0.1', name: 'h1', group: 'Infra', subgroup: 'Acesso/GPON' });
  igual(r.status, 200, 'host em pasta nova');
  igual(await decl('Infra'), ['Acesso', 'Acesso/GPON', 'Rede', 'Rede/Core'], 'a pasta do host foi declarada, com o nível acima');
  const h1 = acha(await estado(), 'h1');
  r = await pedir(porta, 'DELETE', `/api/hosts/${h1.id}`);
  ok((await decl('Infra')).includes('Acesso/GPON'), 'excluir o host NÃO some com a pasta — é um diretório');

  // mover host por arrastar: só pasta e grupo mudam
  r = await pedir(porta, 'POST', '/api/hosts', { ...base, host: '10.2.0.2', name: 'h2', group: 'Infra', subgroup: 'Rede' });
  const h2 = acha(await estado(), 'h2');
  r = await pedir(porta, 'POST', `/api/hosts/${h2.id}/pasta`, { group: 'Infra', subgroup: 'Rede/Core' });
  igual(r.status, 200, 'arrastar passa');
  e = await estado();
  igual(acha(e, 'h2').subgroup, 'Rede/Core', 'o host mudou de pasta');
  igual(acha(e, 'h2').host, '10.2.0.2', 'e o resto do cadastro ficou');
  r = await pedir(porta, 'POST', `/api/hosts/${h2.id}/pasta`, { group: 'Outro', subgroup: 'Nova' });
  e = await estado();
  igual([acha(e, 'h2').group, acha(e, 'h2').subgroup], ['Outro', 'Nova'], 'arrastar para outro grupo muda os dois');
  igual(await decl('Outro'), ['Nova'], 'e declara a pasta lá');
  r = await pedir(porta, 'POST', '/api/hosts/nao-existe/pasta', { group: 'X', subgroup: '' });
  igual(r.status, 404, 'host inexistente é 404');
  r = await pedir(porta, 'POST', `/api/hosts/${h2.id}/pasta`, { group: 'Outro' });
  igual(acha(await estado(), 'h2').subgroup, 'Nova', 'pasta ausente no corpo mantém a atual (só string vazia zera)');
  r = await pedir(porta, 'POST', `/api/hosts/${h2.id}/pasta`, { group: '', subgroup: '' });
  igual([acha(await estado(), 'h2').group, acha(await estado(), 'h2').subgroup], ['', ''], 'arrastar para "Sem grupo" zera os dois');
  r = await pedir(porta, 'POST', `/api/hosts/${h2.id}/pasta`, { group: 'Outro', subgroup: 'Nova' }); // volta

  // o teto de 200 vale também para as pastas declaradas movidas
  r = await pedir(porta, 'POST', '/api/pastas', { colecao: 'hosts', group: 'Infra', caminho: 'Rede/' + 'x'.repeat(190) });
  igual(r.status, 200, 'pasta vazia perto do teto pode ser criada');
  r = await pedir(porta, 'POST', '/api/pastas/mover', { colecao: 'hosts', group: 'Infra', de: 'Rede', para: 'Backbone/Infra/Rede' });
  igual(r.status, 400, 'mover que faria uma pasta vazia passar do teto é recusado');
  ok((await decl('Infra')).every((c) => c.length <= 200), 'e nenhuma pasta ficou acima do teto');
  ok((await decl('Infra')).includes('Rede/Core'), 'nada foi movido');
  r = await pedir(porta, 'POST', '/api/pastas/excluir', { colecao: 'hosts', group: 'Infra', caminho: 'Rede/' + 'x'.repeat(190) });

  // subpasta homônima sobrevive à exclusão da mãe
  r = await pedir(porta, 'POST', '/api/pastas', { colecao: 'hosts', group: 'Infra', caminho: 'Dup/Dup/Vazia' });
  r = await pedir(porta, 'POST', '/api/pastas/excluir', { colecao: 'hosts', group: 'Infra', caminho: 'Dup' });
  ok((await decl('Infra')).includes('Dup/Vazia'), 'excluir "Dup" faz "Dup/Dup/Vazia" virar "Dup/Vazia" — a homônima que subiu não é apagada');
  r = await pedir(porta, 'POST', '/api/pastas/excluir', { colecao: 'hosts', group: 'Infra', caminho: 'Dup' });

  // grupo de script pode ter 80 caracteres: a pasta declarada não pode cortar em 60
  const grupoLongo = 'G'.repeat(75);
  r = await pedir(porta, 'POST', '/api/scripts', { name: 'longo', group: grupoLongo, subgroup: 'Testes', body: 'echo' });
  igual(r.status, 200, 'script com grupo de 75 chars passa');
  e = await estado();
  igual(e.pastas.filter((p) => p.colecao === 'scripts' && p.caminho === 'Testes').map((p) => p.group), [grupoLongo],
    'a pasta declarada fica sob o grupo INTEIRO, não sob um grupo cortado');

  // mover pasta leva as declaradas (inclusive vazias) junto
  r = await pedir(porta, 'POST', '/api/pastas/mover', { colecao: 'hosts', group: 'Infra', de: 'Rede', para: 'Backbone/Rede' });
  igual(r.status, 200, 'mover pasta passa');
  ok((await decl('Infra')).includes('Backbone/Rede/Core'), 'a pasta vazia de dentro foi junto');
  ok(!(await decl('Infra')).includes('Rede/Core'), 'e a antiga sumiu');

  // excluir pasta: o conteúdo sobe um nível, nunca some
  r = await pedir(porta, 'POST', '/api/hosts', { ...base, host: '10.2.0.3', name: 'h3', group: 'Infra', subgroup: 'Backbone/Rede/Core' });
  r = await pedir(porta, 'POST', '/api/pastas/excluir', { colecao: 'hosts', group: 'Infra', caminho: 'Backbone/Rede' });
  igual(r.status, 200, 'excluir pasta passa');
  igual(r.corpo.movidos, 1, 'um host subiu');
  e = await estado();
  igual(acha(e, 'h3').subgroup, 'Backbone/Core', 'o host subiu para a pasta de cima (Core foi junto)');
  const dInfra = await decl('Infra');
  ok(!dInfra.some((c) => c.startsWith('Backbone/Rede')), 'a excluída e o que estava nela saíram da lista');
  ok(dInfra.includes('Backbone/Core'), 'a subpasta subiu como declarada');
  r = await pedir(porta, 'POST', '/api/pastas/excluir', { colecao: 'hosts', group: 'Infra', caminho: 'Backbone' });
  igual(acha(await estado(), 'h3').subgroup, 'Core', 'excluir pasta de primeiro nível: o host cai na pasta de dentro, agora no grupo');

  // pastas no backup: export escreve, import lê (round-trip)
  const { buildXml } = require('../lib/exportxml');
  const xml = buildXml({ hosts: [], pastas: [{ colecao: 'hosts', group: 'Infra', caminho: 'Vazia/Mesmo' }] }, {});
  ok(xml.includes('<pasta colecao="hosts" group="Infra" caminho="Vazia/Mesmo"/>'), 'o export grava a pasta vazia');
  r = await pedir(porta, 'POST', '/api/import', { hosts: [], pastas: [{ colecao: 'hosts', group: 'Importado', caminho: 'A/B' }] });
  igual(r.status, 200, 'import com pastas passa');
  igual(r.corpo.pastas, 2, 'e conta o que entrou');
  igual(await decl('Importado'), ['A', 'A/B'], 'a pasta importada existe, vazia');

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${n} verificações passaram`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
