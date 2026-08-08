'use strict';

// Testes dos CAMINHOS DE ERRO do WebSocket de terminal, contra o servidor de
// verdade.
//
// Existem por causa de um defeito que nenhum teste de unidade pegaria e que
// `node --check` não vê: `lib/terminal.js` recusava um host inexistente com
//
//     send({ t: 'e', d: 'Host não encontrado.' });
//
// e `send` só passava a existir umas linhas ADIANTE, junto com a sessão. Era um
// ReferenceError de zona morta temporal dentro do 'connection' de um
// EventEmitter — ninguém captura isso, e o PROCESSO INTEIRO morria. Medido:
//
//     ReferenceError: Cannot access 'send' before initialization
//         at WebSocketServer.handleConnection (lib/terminal.js:60:5)
//
// O estrago é o oposto exato da funcionalidade que essas sessões existem para
// dar: elas sobrevivem ao fechamento da janela, e uma requisição com um id de
// host apagado matava TODAS de uma vez. Chegar num host apagado não é hipótese
// remota — basta a interface reconectar com um id que outra janela excluiu.
//
// Por isso o teste é de integração: sobe o servidor, bate em cada recusa e
// exige que o processo continue de pé e que a recusa CHEGUE ao cliente.

const assert = require('assert');
const crypto = require('crypto');
const net = require('net');
const http = require('http');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// Cliente WebSocket mínimo: só o que basta para abrir, ler quadros do servidor
// (sem máscara) e fechar. Instalar um cliente inteiro para isto não se paga.
function abrirWs(porta, caminho) {
  return new Promise((resolve) => {
    const recebidas = [];
    const sock = net.connect(porta, '127.0.0.1', () => {
      sock.write(`GET ${caminho} HTTP/1.1\r\nHost: 127.0.0.1:${porta}\r\n`
        + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        + `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n`
        + 'Sec-WebSocket-Version: 13\r\n\r\n');
    });
    let apertou = false;
    let buf = Buffer.alloc(0);
    let statusLine = '';
    const terminar = () => resolve({ statusLine, recebidas });
    sock.on('data', (d) => {
      if (!apertou) {
        const fim = d.indexOf('\r\n\r\n');
        if (fim < 0) return;
        statusLine = d.slice(0, d.indexOf('\r\n')).toString();
        apertou = true;
        d = d.slice(fim + 4);
        if (!d.length) return;
      }
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        let tam = buf[1] & 127;
        let i = 2;
        if (tam === 126) { if (buf.length < 4) return; tam = buf.readUInt16BE(2); i = 4; }
        else if (tam === 127) { if (buf.length < 10) return; tam = Number(buf.readBigUInt64BE(2)); i = 10; }
        if (buf.length < i + tam) return;
        const carga = buf.slice(i, i + tam).toString();
        buf = buf.slice(i + tam);
        if (opcode === 1) { try { recebidas.push(JSON.parse(carga)); } catch { recebidas.push(carga); } }
      }
    });
    sock.on('close', terminar);
    sock.on('error', terminar);
    setTimeout(() => { try { sock.destroy(); } catch {} terminar(); }, 4000);
  });
}

function pegar(porta, caminho) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: porta, path: caminho }, (res) => {
      let c = '';
      res.on('data', (d) => { c += d; });
      res.on('end', () => resolve({ status: res.statusCode, corpo: c }));
    }).on('error', reject);
  });
}

(async () => {
  process.env.PORT = '0'; // porta efêmera: não briga com o app do usuário
  const { start } = require('../server');
  const server = await start();
  const porta = server.address().port;

  // O token do processo vai no HTML servido; é a segunda barreira do upgrade.
  const home = await pegar(porta, '/');
  const token = (home.corpo.match(/"([a-f0-9]{64})"/) || [])[1];
  ok(!!token, 'achei o token do processo no HTML servido');

  const vivo = async () => {
    try { return (await pegar(porta, '/api/janelas')).status === 200; } catch { return false; }
  };
  const erroDe = (r) => (r.recebidas.find((m) => m && m.t === 'e') || {}).d || '';

  // ---------- as barreiras antes do terminal ----------

  {
    const r = await abrirWs(porta, '/api/terminal?hostId=qualquer');
    ok(/403/.test(r.statusLine), 'sem token, o upgrade é recusado com 403');
    ok(await vivo(), 'e o servidor continua de pé');
  }

  // ---------- as recusas que rodam DENTRO do handler ----------
  //
  // Cada uma destas linhas roda antes de a sessão existir. É onde o defeito
  // morava, e onde ele voltaria a morar se alguém acrescentar uma recusa nova
  // usando `send`.

  {
    // O caso que derrubava o processo.
    const r = await abrirWs(porta, `/api/terminal?token=${token}&hostId=nao-existe-mesmo`);
    ok(/101/.test(r.statusLine), 'o upgrade acontece (o token está certo)');
    ok(/não encontrado/i.test(erroDe(r)), 'o cliente RECEBE o motivo da recusa, em vez de '
      + 'ficar sem resposta com o servidor morto do outro lado');
    ok(r.recebidas.some((m) => m && m.t === 'x'), 'e o fim da sessão é anunciado');
    ok(await vivo(), 'O SERVIDOR PRECISA CONTINUAR VIVO — este era o defeito');
  }

  {
    const r = await abrirWs(porta, `/api/terminal?token=${token}&sessao=ts_nao-existe`);
    ok(/não existe mais/i.test(erroDe(r)), 'reatar a uma sessão inexistente explica o motivo');
    ok(await vivo(), 'e não derruba o servidor');
  }

  {
    // Host sem hostId nenhum: cai na mesma recusa de "não encontrado".
    const r = await abrirWs(porta, `/api/terminal?token=${token}`);
    ok(erroDe(r).length > 0, 'sem hostId também há recusa explicada');
    ok(await vivo(), 'e o servidor sobrevive');
  }

  {
    // Terminal local: o mesmo handler, outro caminho.
    const r = await abrirWs(porta, `/api/localterminal?token=${token}&sessao=ts_nao-existe`);
    ok(/não existe mais/i.test(erroDe(r)), 'o terminal local recusa igual');
    ok(await vivo(), 'e sobrevive igual');
  }

  // ---------- uma rajada de requisições ruins não pode derrubar nada ----------

  {
    await Promise.all(Array.from({ length: 12 }, (_, i) =>
      abrirWs(porta, `/api/terminal?token=${token}&hostId=lixo-${i}`)));
    ok(await vivo(), 'doze recusas seguidas e o servidor continua respondendo');
    const j = JSON.parse((await pegar(porta, '/api/janelas')).corpo);
    igual(j.sessoes.filter((s) => s.hostId && String(s.hostId).startsWith('lixo-')).length, 0,
      'e nenhuma sessão fantasma ficou no registro');
  }

  server.close();
  console.log(`\n${n} verificações passaram`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
