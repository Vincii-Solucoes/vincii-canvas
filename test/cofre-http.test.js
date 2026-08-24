'use strict';

// Testes do transporte dos cofres — o arquivo que carrega o TOKEN.
//
// Ele não tinha teste nenhum, e por isso um defeito grave viveu ali sem ser
// notado: `aoFixar` era o SEXTO parâmetro posicional de `pedir()`, e nenhum dos
// oito pontos de chamada passava. O efeito combinava mal com a outra decisão do
// arquivo (`rejectUnauthorized = false`, para aceitar cofre com certificado
// autoassinado): o pino nunca era gravado, a conferência nunca rodava, e
// QUALQUER certificado era aceito — com o token indo junto para quem o
// apresentasse. A tela dizia "certificado autoassinado fixado" o tempo todo.
//
// As quatro coisas travadas aqui são todas de segurança, e todas silenciosas:
//   1. o pino é gravado na primeira conexão e CONFERIDO nas seguintes;
//   2. o token vai em cabeçalho, nunca na URL;
//   3. http:// só passa em loopback;
//   4. resposta gigante é cortada, e acento não quebra na fronteira de chunk.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { execSync } = require('child_process');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-http-'));
process.env.SSHC_DATA_DIR = DIR;

const { pedir, ErroDeCofre } = require('../lib/cofres/http');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const naoOk = (c, m) => { assert.ok(!c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

async function falha(fn, msg) {
  try { await fn(); } catch (e) { n += 1; return e; }
  assert.fail(`${msg} — mas a chamada funcionou`);
}

const traduzir = (status, corpo) =>
  new ErroDeCofre((corpo && corpo.erro && corpo.erro.codigo) || 'indisponivel', `status ${status}`);

// Par de certificados autoassinados diferentes: um é "o cofre", o outro é quem
// tomou o lugar dele.
function certificado(cn) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-'));
  execSync(`openssl req -x509 -newkey rsa:2048 -keyout ${d}/k.pem -out ${d}/c.pem `
    + `-days 1 -nodes -subj "/CN=${cn}"`, { stdio: 'ignore' });
  return { key: fs.readFileSync(`${d}/k.pem`), cert: fs.readFileSync(`${d}/c.pem`) };
}

const subir = (servidor, porta) =>
  new Promise((r) => servidor.listen(porta || 0, '127.0.0.1', () => r(servidor.address().port)));
// Derruba as conexões abertas antes de fechar.
//
// O teste do teto de corpo faz o cliente destruir a requisição no meio; o
// servidor fica escrevendo num socket que ninguém lê, e `close()` sozinho
// espera essa conexão terminar — o teste inteiro trava sem dizer por quê.
const baixar = (servidor) => new Promise((r) => {
  if (servidor.closeAllConnections) servidor.closeAllConnections();
  servidor.close(() => r());
});

(async () => {

  // ---------- 1. TOFU: fixa na primeira, confere nas seguintes ----------

  {
    const doCofre = certificado('cofre-de-verdade');
    const doImpostor = certificado('impostor');
    const responder = (q, r) => {
      r.writeHead(200, { 'Content-Type': 'application/json' });
      r.end(JSON.stringify({ ok: true }));
    };

    let s = https.createServer(doCofre, responder);
    const porta = await subir(s);

    let fixado = null;
    const cfg = () => ({ baseUrl: `https://127.0.0.1:${porta}/v1`, chave: 'hvk_segredo',
      certificadoFixado: fixado, aoFixar: (p) => { fixado = p; } });

    await pedir(cfg(), 'GET', '/ping', null, traduzir);
    ok(fixado && fixado.startsWith('sha256/'),
      'a primeira conexão FIXA a impressão do certificado — sem isto, e com '
      + 'rejectUnauthorized:false, qualquer certificado passaria para sempre');

    const primeiro = fixado;
    await pedir(cfg(), 'GET', '/ping', null, traduzir);
    igual(fixado, primeiro, 'a segunda conexão com o mesmo certificado passa e não refixa');

    // Agora o impostor, com o MESMO pino guardado na configuração.
    //
    // Ele sobe noutra porta de propósito: reusar a porta faz o teste tropeçar
    // num socket keep-alive morto (ECONNRESET) antes de qualquer certificado
    // ser apresentado, e o teste passaria a medir o socket em vez do pino. O
    // que importa é o invariante — "a config tem o pino A, o servidor apresenta
    // o B, recusa" — e ele não depende da porta.
    // O impostor GRAVA todo request que chegar. O pino é conferido no
    // HANDSHAKE, antes de qualquer byte de aplicação sair — então o impostor
    // não pode nem ver o token. (Antes, a conferência era no callback da
    // resposta, depois de req.end() já ter mandado o Authorization: o token
    // vazava e SÓ ENTÃO a chamada era recusada.)
    const recebidosImpostor = [];
    const outro = https.createServer(doImpostor, (q, r) => {
      recebidosImpostor.push(q.headers.authorization || '(sem auth)');
      responder(q, r);
    });
    const portaImpostor = await subir(outro);
    const cfgImpostor = { ...cfg(), baseUrl: `https://127.0.0.1:${portaImpostor}/v1` };

    const e = await falha(() => pedir(cfgImpostor, 'GET', '/ping', null, traduzir),
      'certificado trocado deveria ser recusado');
    igual(e.codigo, 'certificado_mudou',
      'certificado diferente do fixado é RECUSADO — é o momento em que o token '
      + 'iria para quem tomou o lugar do cofre');
    ok(/certificado do cofre mudou/i.test(e.message),
      'com mensagem que diz o que houve, e o que fazer se a troca foi legítima');
    igual(fixado, primeiro, 'e o pino NÃO é sobrescrito pelo impostor');
    igual(recebidosImpostor, [],
      'e o impostor NÃO recebeu request nenhum — o token nunca saiu por um socket '
      + 'não verificado (a conferência é no handshake, antes de o Authorization ir)');

    await baixar(outro);
    await baixar(s);
  }

  // ---------- 2. o token vai em cabeçalho, nunca na URL ----------

  {
    const vistos = [];
    const s = http.createServer((q, r) => {
      vistos.push({ url: q.url, auth: q.headers.authorization });
      r.writeHead(200, { 'Content-Type': 'application/json' });
      r.end('{}');
    });
    const porta = await subir(s);
    const cfg = { baseUrl: `http://127.0.0.1:${porta}/v1`, chave: 'hvk_nao_pode_vazar' };

    await pedir(cfg, 'GET', '/secrets?busca=root', null, traduzir);
    igual(vistos[0].auth, 'Bearer hvk_nao_pode_vazar', 'o token vai no Authorization');
    naoOk(vistos[0].url.includes('hvk_nao_pode_vazar'),
      'e NUNCA na URL — ali ele entraria em log de servidor, histórico de proxy '
      + 'e em toda mensagem de erro que cita o endereço');
    ok(vistos[0].url.includes('busca=root'), 'os parâmetros normais seguem na URL');

    await baixar(s);
  }

  // ---------- 3. http:// só em loopback ----------

  {
    const e = await falha(
      () => pedir({ baseUrl: 'http://cofre.example.com/v1', chave: 'k' }, 'GET', '/ping', null, traduzir),
      'http em endereço de rede deveria ser recusado');
    igual(e.codigo, 'config_invalida',
      'http:// fora do loopback é recusado ANTES de conectar — mandar o token em '
      + 'texto claro pela rede entrega o cofre inteiro a quem estiver no caminho');

    // E o loopback continua passando, que é como os testes rodam.
    const s = http.createServer((q, r) => { r.writeHead(200); r.end('{}'); });
    const porta = await subir(s);
    const r = await pedir({ baseUrl: `http://127.0.0.1:${porta}/v1`, chave: 'k' },
      'GET', '/ping', null, traduzir);
    igual(r, {}, '127.0.0.1 em http continua permitido, para o cofre de mentira dos testes');
    await baixar(s);
  }

  // ---------- 4. o corpo da resposta ----------

  {
    // Acento partido na fronteira entre dois chunks do socket.
    //
    // "Produção" em UTF-8 tem um caractere de 2 bytes. Mandando o primeiro byte
    // num pacote e o segundo noutro, `dados += chunk` converteria cada metade
    // sozinha e devolveria lixo. É exatamente o que acontece com nome de cliente
    // e caminho de pasta vindos do ERP.
    const corpo = Buffer.from(JSON.stringify({ nome: 'Produção', cliente: 'Vincii Soluções' }), 'utf8');
    const corte = corpo.indexOf(Buffer.from('ç', 'utf8')) + 1; // no MEIO do "ç"
    const s = http.createServer((q, r) => {
      r.writeHead(200, { 'Content-Type': 'application/json' });
      r.write(corpo.subarray(0, corte));
      setTimeout(() => r.end(corpo.subarray(corte)), 20);
    });
    const porta = await subir(s);
    const r = await pedir({ baseUrl: `http://127.0.0.1:${porta}/v1`, chave: 'k' },
      'GET', '/ping', null, traduzir);
    igual(r.nome, 'Produção',
      'acento partido entre dois pacotes chega inteiro — sem setEncoding, o '
      + 'decodificador converte cada metade sozinha e devolve lixo na tela');
    igual(r.cliente, 'Vincii Soluções', 'e o resto do texto também');
    await baixar(s);
  }

  {
    // Resposta gigante é cortada em vez de virar memória do app.
    const s = http.createServer((q, r) => {
      r.writeHead(200, { 'Content-Type': 'application/json' });
      r.write('{"lixo":"');
      const bloco = 'x'.repeat(64 * 1024);
      let i = 0;
      const escrever = () => {
        if (i++ > 60 || r.destroyed) { try { r.end('"}'); } catch {} return; }
        if (r.write(bloco)) setImmediate(escrever); else r.once('drain', escrever);
      };
      escrever();
    });
    const porta = await subir(s);
    const e = await falha(() => pedir({ baseUrl: `http://127.0.0.1:${porta}/v1`, chave: 'k' },
      'GET', '/ping', null, traduzir), 'resposta gigante deveria ser recusada');
    igual(e.codigo, 'resposta_invalida',
      'resposta acima do teto é cortada — um servidor que não é o cofre (ou um '
      + 'cofre em pane) não pode consumir a memória do app');
    await baixar(s);
  }

  {
    // Resposta que não é JSON.
    const s = http.createServer((q, r) => { r.writeHead(200); r.end('<html>login</html>'); });
    const porta = await subir(s);
    const e = await falha(() => pedir({ baseUrl: `http://127.0.0.1:${porta}/v1`, chave: 'k' },
      'GET', '/ping', null, traduzir), 'HTML deveria ser recusado');
    igual(e.codigo, 'resposta_invalida',
      'HTML no lugar de JSON é erro claro — é o que um portal de autenticação '
      + 'no caminho devolve, e tratá-lo como resposta vazia esconderia isso');
    await baixar(s);
  }

  // ---------- 5. endereço inválido ----------

  {
    const e = await falha(() => pedir({ baseUrl: 'nao é uma url', chave: 'k' },
      'GET', '/ping', null, traduzir), 'endereço ilegível deveria falhar');
    igual(e.codigo, 'config_invalida', 'endereço ilegível falha na configuração, não na rede');
  }

  // ---------- 6. o erro do cofre chega traduzido ----------

  {
    const s = http.createServer((q, r) => {
      r.writeHead(403, { 'Content-Type': 'application/json' });
      r.end(JSON.stringify({ erro: { codigo: 'sem_permissao', mensagem: 'fora do horário' } }));
    });
    const porta = await subir(s);
    const e = await falha(() => pedir({ baseUrl: `http://127.0.0.1:${porta}/v1`, chave: 'k' },
      'GET', '/ping', null, traduzir), '403 deveria falhar');
    igual(e.codigo, 'sem_permissao',
      'o transporte não decide nada sobre o erro: entrega o corpo ao tradutor do '
      + 'adaptador e devolve o que ele disser');
    await baixar(s);
  }

  console.log(`\n${n} verificações passaram`);
})().catch((e) => { console.error(e); process.exit(1); });
