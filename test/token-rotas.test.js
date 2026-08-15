'use strict';

// Rotas que entregam ou executam algo sensível exigem o TOKEN do processo — não
// só a guarda de origem. O token vai no HTML servido (que só a própria origem
// consegue ler) e é sorteado a cada abertura do app; a guarda de origem sozinha
// deixa passar qualquer cliente local sem cabeçalho Origin (curl, script, outro
// app), que é o modelo de ameaça que o README descreve. Estas três rotas
// passaram a exigir o token porque cada uma é uma via direta de dano:
//
//   • POST /api/export.xml?secrets=1 — exporta TODOS os segredos de uma vez;
//   • POST /api/files/*              — lê/grava qualquer caminho do disco;
//   • POST /api/agent/start          — dispara o agente que executa comandos.
//
// Teste de integração: sobe o servidor de verdade, sem Origin (cliente local),
// e exige 403 sem o token e a passagem pelo portão com ele.

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Diretório de dados próprio, antes de qualquer require do app.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-token-'));
process.env.SSHC_DATA_DIR = DIR;

let n = 0;
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };
const ok = (c, m) => { assert.ok(c, m); n += 1; };

function pedir(porta, metodo, caminho, corpo) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? null : Buffer.from(JSON.stringify(corpo));
    const req = http.request({
      host: '127.0.0.1', port: porta, path: caminho, method: metodo,
      // Sem cabeçalho Origin: é o cliente local que a guarda de origem deixa
      // passar de propósito. Assim o teste isola o portão do TOKEN.
      headers: dados ? { 'Content-Type': 'application/json', 'Content-Length': dados.length } : {},
    }, (res) => {
      let c = '';
      res.on('data', (d) => { c += d; });
      res.on('end', () => resolve({ status: res.statusCode, corpo: c }));
    });
    req.on('error', reject);
    if (dados) req.write(dados);
    req.end();
  });
}

(async () => {
  process.env.PORT = '0';
  const { start } = require('../server');
  const server = await start();
  const porta = server.address().port;

  // O token do processo vai no HTML servido.
  const home = await pedir(porta, 'GET', '/');
  const token = (home.corpo.match(/"([a-f0-9]{64})"/) || [])[1];
  ok(!!token, 'achei o token do processo no HTML servido');

  // ---------- export.xml ----------
  {
    const semToken = await pedir(porta, 'POST', '/api/export.xml?secrets=1', {});
    igual(semToken.status, 403, 'export COM segredos sem token: recusado');

    const tokenErrado = await pedir(porta, 'POST', '/api/export.xml?secrets=1', { token: 'x'.repeat(64) });
    igual(tokenErrado.status, 403, 'export COM segredos e token errado: recusado');

    const comToken = await pedir(porta, 'POST', '/api/export.xml?secrets=1', { token });
    igual(comToken.status, 200, 'export COM segredos e token certo: liberado');
    ok(/^<\?xml/.test(comToken.corpo.trim()), 'e devolve o XML');

    const semSegredos = await pedir(porta, 'POST', '/api/export.xml', {});
    igual(semSegredos.status, 200, 'export SEM segredos segue livre: só leva marcadores, não há o que proteger');
  }

  // ---------- /api/files/* ----------
  {
    const semToken = await pedir(porta, 'POST', '/api/files/close', { sessionId: 'nao-existe' });
    igual(semToken.status, 403, 'rota de arquivo sem token: recusada');

    const comToken = await pedir(porta, 'POST', '/api/files/close', { sessionId: 'nao-existe', token });
    igual(comToken.status, 200, 'rota de arquivo com token: passa o portão (close é tolerante a sessão inexistente)');

    const listSemToken = await pedir(porta, 'POST', '/api/files/list', { side: 'local', path: DIR });
    igual(listSemToken.status, 403, 'listar arquivos sem token: recusado');
  }

  // ---------- /api/agent/start ----------
  {
    const semToken = await pedir(porta, 'POST', '/api/agent/start', { local: true, goal: 'oi' });
    igual(semToken.status, 403, 'iniciar agente sem token: recusado');

    // Com token, mas SEM goal: passa o portão do token e para na validação
    // seguinte (400) — assim o teste prova o portão sem de fato iniciar um agente
    // (o que exigiria a SDK e a chave da API).
    const semGoal = await pedir(porta, 'POST', '/api/agent/start', { local: true, goal: '', token });
    igual(semGoal.status, 400, 'com token e sem tarefa: passa o portão e para na validação da tarefa');
  }

  server.close();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
  console.log(`\n${n} verificações passaram`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
