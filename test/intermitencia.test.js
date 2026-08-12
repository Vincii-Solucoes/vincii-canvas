'use strict';

// "Hora ou outra conecta, hora não."
//
// Foi assim que o sintoma chegou, e a causa não era o host nem a URL: era o ERP
// devolvendo 502 de vez em quando (o proxy respondendo enquanto o app atrás dele
// reinicia). O Canvas tratava esse 502 EXATAMENTE como o `indisponivel` do
// contrato — que quer dizer outra coisa, "cofre sem chave de cifra", e para o
// qual a documentação manda NÃO reintentar.
//
// Resultado: um blip de dois segundos derrubava a busca sem nenhuma
// retentativa, os sistemas do cliente sumiam da lista, e nada na tela dizia por
// quê. Abriu na hora certa, funciona; abriu na hora errada, não funciona.
//
// Três defeitos, três guardas aqui:
//   1. falha de ESTRADA (502/504/408, sem envelope) é transitória; o
//      `indisponivel` DO CONTRATO continua definitivo;
//   2. redirecionamento era lido como sucesso de corpo vazio — virava "cofre com
//      zero cliente", calado;
//   3. a carência depois da falha era de um minuto fixo, e um minuto é uma
//      eternidade para um blip de dois segundos.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-int-'));
process.env.SSHC_DATA_DIR = DIR;

const adaptador = require('../lib/cofres/vitruviano');
const { pedir, ErroDeCofre } = require('../lib/cofres/http');
const dados = require('../lib/dadosdecofre');
const fake = require('./vitruviano-local');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const naoOk = (c, m) => { assert.ok(!c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

async function falha(fn, msg) {
  try { await fn(); } catch (e) { n += 1; return e; }
  assert.fail(`${msg} — mas a chamada funcionou`);
}

const subir = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const baixar = (s) => new Promise((r) => { if (s.closeAllConnections) s.closeAllConnections(); s.close(() => r()); });

// ---------- 1. estrada x cofre ----------

{
  const t = adaptador._traduzirErro;

  for (const st of [502, 504, 408]) {
    const e = t(st, null, {});
    ok(e.transitorio,
      `${st} SEM envelope é falha de infraestrutura e PASSA sozinha — era tratada `
      + 'como definitiva, e um blip do proxy tirava a mesa de trabalho da tela '
      + 'até a carência seguinte');
    ok(/passar sozinho/i.test(e.message),
      `e a mensagem do ${st} diz isso, em vez de acusar o cofre de algo que não é dele`);
  }

  const doContrato = t(503, { erro: { codigo: 'indisponivel', mensagem: 'sem chave de cifra' } }, {});
  naoOk(doContrato.transitorio,
    'o `indisponivel` DO CONTRATO continua definitivo: ali insistir é gastar o '
    + 'limite de taxa contra uma parede, e a documentação manda avisar o admin');
  igual(doContrato.message, 'sem chave de cifra', 'com a mensagem do cofre, inteira');

  // O que separa os dois é o ENVELOPE, não o número.
  const comEnvelope = t(502, { erro: { codigo: 'indisponivel', mensagem: 'sem chave' } }, {});
  naoOk(comEnvelope.transitorio,
    'um 502 que TRAZ o envelope do cofre é o cofre falando, e vale o que ele diz — '
    + 'quem decide é o envelope, não o status');

  const erp500 = t(500, { error: { code: 'internal_error', message: 'x' } }, {});
  naoOk(erp500.transitorio, 'internal_error do ERP também não é para insistir');
}

// ---------- 2. redirecionamento não é sucesso ----------

(async () => {
  {
    const s = http.createServer((q, r) => {
      r.writeHead(302, { Location: 'https://sso.example/login' });
      r.end();
    });
    const porta = await subir(s);
    const e = await falha(
      () => pedir({ baseUrl: `http://127.0.0.1:${porta}/v1`, chave: 'k' }, 'GET', '/ping', null,
        adaptador._traduzirErro),
      'um 302 deveria falhar');
    igual(e.codigo, 'indisponivel',
      'redirecionamento é ERRO. Era lido como resposta boa, e o corpo de um 302 é '
      + 'vazio: virava `{}`, o ping devolvia zero cliente, e a mesa de trabalho '
      + 'sumia da tela sem erro nenhum — indistinguível de "você não atende ninguém"');
    ok(e.transitorio, 'e é transitório: costuma ser o proxy mandando para o login, ou o app subindo');
    ok(e.message.includes('sso.example'),
      'a mensagem diz PARA ONDE mandaram — é o que identifica um portal de '
      + 'autenticação no caminho');
    await baixar(s);
  }

  // ---------- 3. a carência cresce, e zera no sucesso ----------

  igual(dados.ESPERAS_MS, [5000, 15000, 60000],
    'a carência é 5s, 15s, 60s. Era um minuto fixo — e um minuto é uma eternidade '
    + 'para um blip de dois segundos, que é a esmagadora maioria das falhas');

  // ---------- 4. o blip é ABSORVIDO, e a falha longa aparece ----------

  {
    const erp = fake.criar({});
    const portaErp = await subir(erp);

    // Gateway que devolve 502 nas duas primeiras e depois passa adiante, como
    // um nginx com o app reiniciando atrás dele.
    let chamadas = 0;
    const gw = http.createServer((q, r) => {
      chamadas += 1;
      if (chamadas <= 2) { r.writeHead(502, { 'Content-Type': 'text/html' }); r.end('<h1>502</h1>'); return; }
      const p = http.request({ host: '127.0.0.1', port: portaErp, path: q.url, method: q.method,
        headers: q.headers }, (u) => { r.writeHead(u.statusCode, u.headers); u.pipe(r); });
      p.on('error', () => { try { r.writeHead(502); r.end(); } catch { /* já foi */ } });
      q.pipe(p);
    });
    const portaGw = await subir(gw);

    const store = require('../lib/store');
    const segredosDeCofre = require('../lib/cofresegredos');
    const d = store.get();
    d.cofres = [{ apelido: 'erp', tipo: 'vitruviano', nome: 'HV',
      config: { baseUrl: `http://127.0.0.1:${portaGw}/api/cofre/v1` } }];
    d.hosts = [];
    store.save();
    segredosDeCofre.definir('erp', { chave: fake.TOKEN });

    await dados.renovarAgora('erp');
    igual(dados.hostsEspelhados().length, 2,
      'os dois 502 do gateway foram ABSORVIDOS pela retentativa: o usuário não vê '
      + 'nada. Era exatamente aqui que a mesa de trabalho sumia');
    igual(dados.avisos(), [], 'e não há aviso, porque não houve prejuízo');

    await baixar(gw);
    await baixar(erp);
  }

  // ---------- 5. ERP fora do ar: mantém o que sabia, e não avisa ----------

  {
    // O gateway morreu; a busca falha, mas o cache está cheio.
    await dados.renovarAgora('erp');
    igual(dados.hostsEspelhados().length, 2,
      'com o ERP fora, os sistemas conhecidos CONTINUAM na lista — sumir com eles '
      + 'a cada tropeço de rede é a intermitência de novo, por outro caminho');
    igual(dados.avisos(), [],
      'e sem aviso: nada está faltando na tela, então não há o que avisar');
  }

  // ---------- 6. ERP fora desde a partida: aí sim, avisa ----------

  {
    dados.esquecer('erp');
    await dados.renovarAgora('erp');
    igual(dados.hostsEspelhados().length, 0, 'sem cache e sem ERP, não há o que mostrar');
    const av = dados.avisos();
    igual(av.length, 1,
      'e A TELA PRECISA DIZER. Sem isto, os sistemas do cliente simplesmente não '
      + 'estavam lá, sem uma palavra — e a pessoa descreve como "às vezes aparece, '
      + 'às vezes não", que foi literalmente o que aconteceu');
    igual(av[0].cofre, 'erp', 'o aviso diz de qual cofre');
    ok(av[0].tentandoDeNovo && av[0].emSegundos > 0,
      'e que já vai tentar de novo, com quantos segundos — a diferença entre '
      + '"quebrou" e "aguarde"');
  }

  // ---------- 7. o aviso some quando o espelho está desligado ----------

  {
    const store = require('../lib/store');
    store.get().cofres[0].espelharSistemas = false;
    store.save();
    igual(dados.avisos(), [],
      'quem desligou o espelho não quer saber que o espelho falhou');
    store.get().cofres[0].espelharSistemas = true;
    store.save();
  }

  console.log(`\n${n} verificações passaram`);
})().catch((e) => { console.error(e); process.exit(1); });
