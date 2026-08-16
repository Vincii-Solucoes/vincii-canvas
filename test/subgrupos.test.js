'use strict';

// Subgrupos: um nível de hierarquia DENTRO do grupo.
//
// O invariante que este arquivo trava é um só: subgrupo não existe sem grupo.
// Ele parece óbvio, mas tem três portas de entrada (cadastro, edição e
// importação de backup) e cada uma podia deixá-lo passar por um caminho
// diferente — o cadastro validando e o import não, que é exatamente como o
// rdpDomain nasceu órfão.
//
// O resto é ordenação, e ordenação errada não quebra: só bagunça a lista em
// silêncio, host de produção aparecendo no meio dos de homologação.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-sub-'));
process.env.SSHC_DATA_DIR = DIR;
process.env.PORT = '0'; // porta efêmera: não briga com o app do usuário

const { agruparHosts, agruparHostsPlano, subgruposDe } = require('../public/agrupar');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// ---------- 1. a ordenação que a tela inteira assume ----------

{
  const hosts = [
    { name: 'zulu', group: '' },
    { name: 'web-2', group: 'Produção', subgroup: 'Web' },
    { name: 'db-1', group: 'Produção', subgroup: 'Banco' },
    { name: 'fw', group: 'Produção' },
    { name: 'web-1', group: 'Produção', subgroup: 'Web' },
    { name: 'lab', group: 'Homolog' },
    // "Zurich" vem DEPOIS de "Sem grupo" no alfabeto — sem um grupo assim, a
    // ordem alfabética pura deixava o "Sem grupo" por último por coincidência e
    // a regra especial podia sumir com o teste verde. Medido: sumiu, e passou.
    { name: 'zz', group: 'Zurich' },
  ];
  const gs = agruparHosts(hosts);
  igual(gs.map((g) => g.nome), ['Homolog', 'Produção', 'Zurich', 'Sem grupo'],
    'grupos em ordem alfabética, "Sem grupo" SEMPRE por último — MESMO quando o '
    + 'alfabeto o colocaria no meio, onde ele parece um grupo chamado Sem grupo');
  const prod = gs[1];
  igual(prod.total, 4,
    'o contador do grupo soma TUDO que está dentro, subgrupos inclusos — um "1 '
    + 'host(s)" num grupo com quatro mandaria a pessoa procurar os outros três '
    + 'em outro lugar');
  igual(prod.diretos.map((h) => h.name), ['fw'],
    'os sem subgrupo vêm ANTES das seções — o nível de cima primeiro, como '
    + 'numa listagem de pastas');
  igual(prod.subgrupos.map(([s]) => s), ['Banco', 'Web'],
    'subgrupos em ordem alfabética dentro do grupo');
  igual(prod.subgrupos[1][1].map((h) => h.name), ['web-2', 'web-1'],
    'dentro do subgrupo a ordem do cadastro se mantém — igual aos diretos');
}

// ---------- 2. a visão plana carrega o subgrupo no rótulo ----------

{
  const hosts = [
    { name: 'fw', group: 'Produção' },
    { name: 'web-1', group: 'Produção', subgroup: 'Web' },
    { name: 'avulso' },
  ];
  igual(agruparHostsPlano(hosts).map(([r]) => r),
    ['Produção', 'Produção › Web', 'Sem grupo'],
    'o rótulo plano é "Grupo › Subgrupo" — é ele que vai para a busca da barra '
    + 'lateral e para a aba Executar, e é por isso que buscar "Web" acha os hosts');
  // O rótulo do grupo só aparece se houver host DIRETO nele.
  const soSub = agruparHostsPlano([{ name: 'w', group: 'P', subgroup: 'S' }]);
  igual(soSub.map(([r]) => r), ['P › S'],
    'grupo sem host direto não vira seção vazia na visão plana');
}

// ---------- 3. subgrupo sem grupo NÃO cria seção dentro de "Sem grupo" ----------

{
  // O servidor não grava este estado; ele só chega de um data.json editado à
  // mão ou de versão antiga. A tela o trata como "sem grupo" simples — uma
  // seção de subgrupo dentro de "Sem grupo" é uma contradição em si.
  const gs = agruparHosts([{ name: 'x', group: '', subgroup: 'Órfão' }]);
  igual(gs.length, 1, 'um grupo só');
  igual(gs[0].nome, 'Sem grupo', 'e é o "Sem grupo"');
  igual(gs[0].subgrupos, [], 'sem seção de subgrupo dentro dele');
  igual(gs[0].diretos.map((h) => h.name), ['x'], 'o host fica como direto');
}

// ---------- 3b. grupo BATIZADO de "Sem grupo" não colide com o balde ----------

{
  // O balde dos sem-grupo é a chave '', não o texto. Agrupando pelo texto, um
  // grupo digitado literalmente como "Sem grupo" caía no balde: o servidor
  // gravava o subgrupo dele e a tela o engolia — gravado no data.json, visível
  // no formulário de edição, invisível na lista e na busca. Achado pela revisão
  // e confirmado contra o servidor de verdade antes desta guarda existir.
  const gs = agruparHosts([
    { name: 'batizado', group: 'Sem grupo', subgroup: 'Web' },
    { name: 'avulso' },
  ]);
  igual(gs.length, 2, 'são DOIS baldes: o grupo batizado e o dos sem grupo');
  igual(gs[0].nome, 'Sem grupo', 'o batizado ordena no alfabeto, como qualquer grupo');
  igual(gs[0].subgrupos.map(([s]) => s), ['Web'],
    'e MANTÉM os subgrupos — era aqui que o subgrupo gravado sumia da tela');
  igual(gs[1].diretos.map((h) => h.name), ['avulso'],
    'o balde dos sem grupo continua por último, só com os realmente sem grupo');
  igual(agruparHostsPlano([
    { name: 'batizado', group: 'Sem grupo', subgroup: 'Web' },
  ]).map(([r]) => r), ['Sem grupo › Web'],
    'e o rótulo plano carrega o subgrupo — buscá-lo na aba Executar acha o host');
}

// ---------- 3c. a busca da barra lateral casa pelo RÓTULO ----------

{
  // A promessa "buscar pelo subgrupo acha os hosts" valia na aba Executar e
  // era FALSA na barra lateral: o filtro de lá casava só nome/usuário@host, e
  // o rótulo era decoração. Duas buscas no mesmo app respondendo diferente à
  // mesma palavra. A guarda é de fonte, como as outras deste projeto: o
  // casamento da lateral tem que incluir o groupName.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const i = src.indexOf('const matches = hosts.filter');
  ok(i > 0, 'achei o filtro da busca da barra lateral em public/app.js');
  const linha = src.slice(i, src.indexOf('\n', i));
  ok(linha.includes('${groupName}'),
    'o filtro da lateral casa pelo rótulo do grupo (com o subgrupo dentro) — '
    + 'sem isso, buscar "Web" acha o host na aba Executar e devolve "Nenhum '
    + 'host encontrado" na lateral');
}

// ---------- 4. as sugestões do formulário não vazam entre grupos ----------

{
  const hosts = [
    { name: 'a', group: 'Cliente A', subgroup: 'Web' },
    { name: 'b', group: 'Cliente B', subgroup: 'Banco' },
    { name: 'c', group: 'Cliente A', subgroup: 'Web' },
  ];
  igual(subgruposDe(hosts, 'Cliente A'), ['Web'],
    'só os subgrupos DO grupo escolhido, sem repetir — sugerir "Banco" aqui '
    + 'espalharia a estrutura de um cliente no cadastro de outro');
  igual(subgruposDe(hosts, ''), [], 'sem grupo escolhido, nenhuma sugestão');
}

// ---------- 5. as três portas de entrada do invariante ----------

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
  const base = { host: '10.0.0.1', port: 22, username: 'root', protocol: 'ssh', auth: { type: 'agent' } };

  // Porta 1: o CADASTRO.
  let r = await pedir(porta, 'POST', '/api/hosts', { ...base, name: 'com-grupo', group: 'Produção', subgroup: '  Web  ' });
  igual(r.status, 200, 'cadastro com grupo e subgrupo passa');
  let estado = (await pedir(porta, 'GET', '/api/state')).corpo;
  let h = estado.hosts.find((x) => x.name === 'com-grupo');
  igual(h.subgroup, 'Web', 'o subgrupo entra aparado, como o grupo');

  r = await pedir(porta, 'POST', '/api/hosts', { ...base, name: 'sem-grupo', group: '', subgroup: 'Web' });
  igual(r.status, 200,
    'subgrupo sem grupo NÃO é erro no cadastro: recusar aqui faria apagar o '
    + 'grupo na edição virar erro por causa de um campo filho');
  estado = (await pedir(porta, 'GET', '/api/state')).corpo;
  igual(estado.hosts.find((x) => x.name === 'sem-grupo').subgroup, '',
    'mas o subgrupo é ZERADO — sem grupo, não há onde pendurá-lo');

  // Porta 2: a EDIÇÃO. Apagar o grupo derruba o subgrupo junto.
  h = estado.hosts.find((x) => x.name === 'com-grupo');
  r = await pedir(porta, 'PUT', `/api/hosts/${h.id}`, { ...base, name: 'com-grupo', group: '', subgroup: 'Web' });
  igual(r.status, 200, 'a edição que apaga o grupo passa');
  estado = (await pedir(porta, 'GET', '/api/state')).corpo;
  igual(estado.hosts.find((x) => x.name === 'com-grupo').subgroup, '',
    'e o subgrupo cai junto — um subgrupo que sobrevive ao grupo reaparece '
    + 'inteiro quando qualquer grupo for digitado de novo, apontando para onde '
    + 'ninguém mandou');

  // Porta 3: a IMPORTAÇÃO — que mescla, e por isso tem os casos cruzados.
  // 3a. o arquivo traz SÓ o subgrupo, o host daqui não tem grupo.
  r = await pedir(porta, 'POST', '/api/import', { hosts: [
    { ...base, name: 'com-grupo', subgroup: 'Web', auth: { type: 'agent' } },
  ] });
  igual(r.status, 200, 'import mesclando só o subgrupo passa');
  estado = (await pedir(porta, 'GET', '/api/state')).corpo;
  igual(estado.hosts.find((x) => x.name === 'com-grupo').subgroup, '',
    'o invariante vale para o RESULTADO da mesclagem: o host daqui não tem '
    + 'grupo, então o subgrupo do arquivo não tem onde entrar');

  // 3b. o arquivo devolve o grupo e o subgrupo juntos.
  r = await pedir(porta, 'POST', '/api/import', { hosts: [
    { ...base, name: 'com-grupo', group: 'Produção', subgroup: 'Web', auth: { type: 'agent' } },
  ] });
  igual(r.status, 200, 'import com os dois passa');
  estado = (await pedir(porta, 'GET', '/api/state')).corpo;
  igual(estado.hosts.find((x) => x.name === 'com-grupo').subgroup, 'Web', 'e os dois entram');

  // 3c. arquivo ANTIGO (sem o atributo) não apaga o subgrupo daqui.
  r = await pedir(porta, 'POST', '/api/import', { hosts: [
    { ...base, name: 'com-grupo', group: 'Produção', auth: { type: 'agent' } },
  ] });
  igual(r.status, 200, 'import de arquivo antigo passa');
  estado = (await pedir(porta, 'GET', '/api/state')).corpo;
  igual(estado.hosts.find((x) => x.name === 'com-grupo').subgroup, 'Web',
    'ausente no arquivo = "não sei", não "apague" — a mesma regra dos outros campos');

  // 3d. host NOVO vindo do arquivo com subgrupo órfão entra sem ele.
  r = await pedir(porta, 'POST', '/api/import', { hosts: [
    { ...base, name: 'novo-orfao', host: '10.0.0.9', subgroup: 'Web', auth: { type: 'agent' } },
  ] });
  igual(r.status, 200, 'import de host novo com subgrupo órfão passa');
  estado = (await pedir(porta, 'GET', '/api/state')).corpo;
  igual(estado.hosts.find((x) => x.name === 'novo-orfao').subgroup, '',
    'o host entra, o subgrupo órfão não — mesma regra do cadastro, terceira porta');

  server.close();
  console.log(`\n${n} verificações passaram`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
