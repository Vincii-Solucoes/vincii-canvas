'use strict';

// Testes do ESPELHO: os sistemas do cliente aparecem como hosts, e o ERP manda.
//
// A promessa do recurso é "não digitar duas vezes o que o ERP já sabe". O que
// torna isso verdade não é a lista aparecer — é ela NÃO ser gravada:
//
//   - gravada, a cópia local sobreviveria à remoção no ERP e viraria um host
//     fantasma apontando para um sistema que não é mais daquele cliente;
//   - gravada, iria no backup, e restaurar noutra máquina traria a mesa de
//     trabalho de quem exportou, e não a de quem importou;
//   - gravada e editável, o campo mexido à mão seria apagado na renovação
//     seguinte, em silêncio.
//
// Por isso os testes abaixo insistem tanto no que o espelho NÃO faz.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-esp-'));
process.env.SSHC_DATA_DIR = DIR;

const fake = require('./vitruviano-local');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const naoOk = (c, m) => { assert.ok(!c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

(async () => {
  const store = require('../lib/store');
  const segredosDeCofre = require('../lib/cofresegredos');
  const dados = require('../lib/dadosdecofre');
  const horario = require('../public/horario');

  const servidor = fake.criar({});
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const porta = servidor.address().port;

  const d = store.get();
  d.cofres = [{ apelido: 'erp', tipo: 'vitruviano', nome: 'HV',
    config: { baseUrl: `http://127.0.0.1:${porta}/api/cofre/v1` } }];
  d.hosts = [];
  store.save();
  segredosDeCofre.definir('erp', { chave: fake.TOKEN });

  // ---------- 1. antes de buscar, nada ----------

  igual(dados.hostsEspelhados(), [],
    'sem ter falado com o ERP ainda, não há espelho — a tela abre com os hosts '
    + 'cadastrados e o resto chega depois, sem travar o carregamento');

  await dados.renovarAgora('erp');

  // ---------- 2. o que vira host, e o que não vira ----------

  {
    const hs = dados.hostsEspelhados();
    igual(hs.map((h) => h.name).sort(), ['IXC', 'OPA'],
      'os sistemas COM URL viram hosts');
    naoOk(hs.some((h) => h.name === 'Rede interna'),
      'sistema SEM url não vira host — não haveria o que abrir, e um host que '
      + 'não conecta é pior que a ausência dele');

    const opa = hs.find((h) => h.name === 'OPA');
    igual(opa.protocol, 'web', 'o sistema do cliente é uma página: host web');
    igual(opa.url, 'https://opa.velonic.com.br/atendente/', 'com a URL que o ERP deu');
    igual(opa.host, 'opa.velonic.com.br', 'e o endereço extraído dela, para a tela mostrar');
    igual(opa.group, 'Velonic', 'agrupado pelo CLIENTE — é assim que a mesa de trabalho '
      + 'de cada cliente fica junta na lista');
    igual(opa.auth.type, 'agent',
      'sem credencial no host: a senha, quando existir, vem do cofre na hora de entrar');
  }

  // ---------- 3. o id é ESTÁVEL entre renovações ----------

  {
    const antes = dados.hostsEspelhados().find((h) => h.name === 'OPA').id;
    await dados.renovarAgora('erp');
    const depois = dados.hostsEspelhados().find((h) => h.name === 'OPA').id;
    igual(depois, antes,
      'o id não muda a cada busca. É ele que amarra a aba aberta ao host: um id '
      + 'novo a cada cinco minutos faria a aba perder o dono, a agenda abrir uma '
      + 'segunda e a trava soltar sozinha');
    ok(dados.ehEspelhado(antes), 'e ele se identifica como espelho pelo prefixo');
    naoOk(dados.ehEspelhado('h-comum'), 'id de host cadastrado não se confunde com espelho');
  }

  // ---------- 4. o horário de atendimento do cliente vale aqui ----------

  {
    const opa = dados.hostsEspelhados().find((h) => h.name === 'OPA');
    const j = dados.janelaDoHost(opa);
    ok(j && j.janela,
      'o host espelhado herda a janela do CLIENTE dele — é o ponto todo: o sistema '
      + 'do cliente abre sozinho durante o expediente sem ninguém digitar horário');
    igual(j.cliente, 'Velonic', 'e a etiqueta sabe de quem é');
    ok(horario.noHorario({ janelaDoCofre: j }, new Date('2026-08-10T15:00:00Z')),
      'e a decisão de horário funciona de ponta a ponta (Velonic é 24 h)');
  }

  // ---------- 5. NÃO é gravado ----------

  {
    const salvo = JSON.parse(fs.readFileSync(path.join(DIR, 'data.json'), 'utf8'));
    igual(salvo.hosts, [],
      'nenhum espelhado no data.json — é o que faz o ERP mandar de verdade. '
      + 'Gravado, ele sobreviveria à remoção lá e viraria host fantasma');

    const { buildXml } = require('../lib/exportxml');
    const xml = buildXml({ hosts: salvo.hosts }, { includeSecrets: false });
    naoOk(/OPA|IXC/.test(xml),
      'nem no backup: restaurar noutra máquina traz o que o ERP disser PARA AQUELE '
      + 'analista, e não a mesa de trabalho de quem exportou');
  }

  // ---------- 6. some quando sai do ERP, muda quando muda lá ----------

  {
    const original = fake.SISTEMAS.splice(0, fake.SISTEMAS.length);
    fake.SISTEMAS.push({ ...original[0], nome: 'OPA renomeado no ERP' });
    await dados.renovarAgora('erp');
    const hs = dados.hostsEspelhados();
    igual(hs.map((h) => h.name), ['OPA renomeado no ERP'],
      'renomear no ERP renomeia aqui, e o que saiu de lá some daqui — sem isso o '
      + '"espelho" seria só uma cópia velha com outro nome');

    fake.SISTEMAS.splice(0, fake.SISTEMAS.length, ...original);
    await dados.renovarAgora('erp');
    igual(dados.hostsEspelhados().length, 2, 'e volta quando volta lá');
  }

  // ---------- 7. não duplica o que a pessoa já cadastrou ----------

  {
    const url = 'https://opa.velonic.com.br/atendente/';
    const hs = dados.hostsEspelhados([url]);
    naoOk(hs.some((h) => h.name === 'OPA'),
      'um sistema que a pessoa JÁ cadastrou à mão não aparece de novo — ela pode '
      + 'ter mudado nome, grupo ou ícone, e o espelho por cima desfaria isso');
    igual(hs.length, 1, 'os outros continuam');

    igual(dados.hostsEspelhados(['https://opa.velonic.com.br/atendente']).length, 1,
      'a comparação passa pela normalização de URL: barra final a mais não cria '
      + 'um segundo host do mesmo endereço');
  }

  // ---------- 8. o interruptor ----------

  {
    const c = store.get().cofres[0];
    c.espelharSistemas = false;
    store.save();
    igual(dados.hostsEspelhados(), [], 'desligado, some tudo');
    c.espelharSistemas = true;
    store.save();
    igual(dados.hostsEspelhados().length, 2, 'ligado, volta');
    delete c.espelharSistemas;
    store.save();
    igual(dados.hostsEspelhados().length, 2,
      'e cofre antigo, sem o campo, espelha: o recurso nasce ligado, como foi pedido');
  }

  // ---------- 9. busca por id, como o servidor faz ----------

  {
    const opa = dados.hostsEspelhados().find((h) => h.name === 'OPA');
    igual(dados.pegarHost(opa.id).name, 'OPA', 'o servidor acha o espelhado pelo id');
    igual(dados.pegarHost('qc_qualquer'), null, 'e não responde por id que não é dele');
    igual(dados.pegarHost(null), null, 'nem por id ausente');
  }

  // ---------- 10. as rotas de ESCRITA recusam ----------

  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    for (const rota of ["app.put('/api/hosts/:id'", "app.delete('/api/hosts/:id'"]) {
      const i = src.indexOf(rota);
      ok(i > 0, `achei ${rota}`);
      const bloco = src.slice(i, i + 420);
      ok(/dadosDeCofre\.ehEspelhado\(req\.params\.id\)/.test(bloco),
        `${rota} recusa host espelhado — sem isso a edição "funciona", devolve 200, `
        + 'e some na renovação seguinte sem nenhum aviso');
    }
  }

  await new Promise((r) => servidor.close(r));
  console.log(`\n${n} verificações passaram`);
})().catch((e) => { console.error(e); process.exit(1); });
