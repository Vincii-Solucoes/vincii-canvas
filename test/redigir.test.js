'use strict';

// Testes da redação — a última barreira antes de o texto sair desta máquina.
//
// Existem DOIS caminhos que mandam texto do terminal para a API da Anthropic:
// o agente autônomo (lib/agent.js) e o assistente do lado (lib/ai.js). Enquanto
// a função vivia dentro de agent.js, o assistente NÃO redigia nada: o retrato da
// tela ia inteiro, e com ele a senha do cofre — a mesma que o resto do app trata
// com a política "nunca toca o disco".
//
// O que este arquivo trava:
//   1. os dois caminhos usam a MESMA função (conferido no código-fonte);
//   2. senha do cofre, que não está no data.json, é apagada;
//   3. chave privada é apagada inteira e por linha;
//   4. senha curta não vira ruído, e senha que é pedaço de outra não deixa resto.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-red-'));
process.env.SSHC_DATA_DIR = DIR;

const { redigir, MARCA } = require('../lib/redigir');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const naoOk = (c, m) => { assert.ok(!c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// ---------- 1. os dois caminhos usam a mesma função ----------

// Asserção de código-fonte, e de propósito: o defeito não era comportamental
// em ai.js — era a AUSÊNCIA da chamada. Um teste de comportamento em ai.js
// exigiria falar com a API da Anthropic; conferir a chamada não exige, e pega
// exatamente a regressão que aconteceu.
{
  const raiz = path.join(__dirname, '..');
  for (const arquivo of ['lib/ai.js', 'lib/agent.js']) {
    const src = fs.readFileSync(path.join(raiz, arquivo), 'utf8');
    ok(/require\(['"]\.\/redigir['"]\)/.test(src),
      `${arquivo} precisa usar lib/redigir.js — enquanto a função era privada de `
      + 'agent.js, o assistente mandava a tela do terminal sem apagar nada');
    ok(!/^function redigir\s*\(/m.test(src),
      `${arquivo} não pode ter a própria cópia de redigir(): duas cópias é uma `
      + 'cópia que um dia deixa de ser corrigida junto');
  }

  const ai = fs.readFileSync(path.join(raiz, 'lib/ai.js'), 'utf8');
  ok(/redigir\(String\(terminalContext\)/.test(ai),
    'o retrato da tela do terminal passa pela redação antes de virar prompt');
  ok(/redigir\(m\.content/.test(ai),
    'e as mensagens do usuário também — colar a saída dentro da pergunta é o '
    + 'jeito mais comum de a senha sair por esse caminho');
}

// ---------- 2. o que está no data.json ----------

{
  const store = require('../lib/store');
  const d = store.get();
  d.settings = { ...(d.settings || {}), apiKey: 'sk-ant-chave-da-api-do-usuario' };
  d.hosts = [
    { id: 'a', name: 'web', host: '10.0.0.1', port: 22, username: 'root',
      auth: { type: 'password', password: 'senha-do-cadastro' } },
    { id: 'b', name: 'ci', host: '10.0.0.2', port: 22, username: 'deploy',
      auth: { type: 'key', keyPath: '/x', passphrase: 'passphrase-do-cadastro' } },
  ];
  store.save();

  const tela = 'root@web:~$ echo $PASS\nsenha-do-cadastro\n'
    + 'root@web:~$ cat cfg\napiKey=sk-ant-chave-da-api-do-usuario\n'
    + 'deploy@ci:~$ echo $PP\npassphrase-do-cadastro';
  const limpo = redigir(tela);
  naoOk(limpo.includes('senha-do-cadastro'), 'senha do host sai da tela');
  naoOk(limpo.includes('sk-ant-chave-da-api-do-usuario'),
    'a chave da API do próprio usuário sai — mandá-la para a API seria irônico e real');
  naoOk(limpo.includes('passphrase-do-cadastro'), 'a passphrase sai');
  ok(limpo.includes('root@web:~$ echo $PASS'), 'e o resto do texto fica intacto');
  igual((limpo.match(/\[…segredo/g) || []).length, 3, 'três marcadores, um por segredo');
}

// ---------- 3. o segredo do COFRE, que não está no disco ----------

(async () => {
  const credenciais = require('../lib/credenciais');
  const segredosDeCofre = require('../lib/cofresegredos');
  const store = require('../lib/store');

  const CHAVE = '-----BEGIN OPENSSH PRIVATE KEY-----\n'
    + 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABlwAAAAdzc2gt\n'
    + '-----END OPENSSH PRIVATE KEY-----';

  let resposta = { tipo: 'senha', senha: 'senha-que-veio-do-cofre' };
  const servidor = http.createServer((q, r) => {
    r.writeHead(200, { 'Content-Type': 'application/json' });
    r.end(JSON.stringify(resposta));
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const porta = servidor.address().port;

  const d = store.get();
  d.cofres = [{ apelido: 'erp', tipo: 'vitruviano', nome: 'HV',
    config: { baseUrl: `http://127.0.0.1:${porta}/v1` } }];
  d.hosts.push({ id: 'c', name: 'do cofre', host: '10.0.0.3', port: 22, username: 'root',
    auth: { type: 'cofre' }, segredo: { cofre: 'erp', id: 's1' } });
  store.save();
  segredosDeCofre.definir('erp', { chave: 'hvk_t' });
  const host = () => store.get().hosts.find((h) => h.id === 'c');

  {
    const tela = 'Password: senha-que-veio-do-cofre\r\nrouter> enable';

    // ANTES de resolver, o app não conhece essa senha: ela não está no
    // data.json, e nenhuma sessão a buscou. Então ela NÃO é apagada — e é isso
    // que dá sentido à verificação seguinte. Sem esta linha, o teste passaria
    // igual se `redigir` apagasse por acidente (um regex de "Password:", por
    // exemplo) em vez de conhecer o valor de verdade.
    ok(redigir(tela).includes('senha-que-veio-do-cofre'),
      'antes de a sessão resolver, o app não conhece a senha do cofre — a linha '
      + 'existe para provar que a próxima verificação mede a coisa certa');

    const c = await credenciais.resolver(host());
    const limpo = redigir(tela);
    naoOk(limpo.includes('senha-que-veio-do-cofre'),
      'com a sessão VIVA, a senha do cofre é apagada da tela — ela não está no '
      + 'data.json, então só o cadastro em memória a conhece, e era exatamente '
      + 'esse caso que o assistente mandava inteiro para a API');
    ok(limpo.includes('router> enable'), 'sem estragar o resto');

    c.dispose();
    ok(redigir(tela).includes('senha-que-veio-do-cofre'),
      'e depois do dispose ela volta a ser desconhecida: o cadastro é uma '
      + 'contagem que ZERA, e não uma lista que só cresce');
  }

  {
    resposta = { tipo: 'chave-ssh', chavePrivada: CHAVE, passphrase: 'frase-do-cofre-longa' };
    const c = await credenciais.resolver(host());
    const miolo = 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABlwAAAAdzc2gt';

    const tela = `deploy@ci:~$ cat id_rsa\n${CHAVE}\n$ echo $PP\nfrase-do-cofre-longa`;
    naoOk(redigir(tela).includes(miolo), 'a chave privada do cofre é apagada');
    naoOk(redigir(tela).includes('frase-do-cofre-longa'), 'e a passphrase junto');
    naoOk(redigir(tela.replace(/\n/g, '\r\n')).includes(miolo),
      'inclusive quando a tela vem com \\r\\n, que é como um terminal entrega');
    c.dispose();
  }

  await new Promise((r) => servidor.close(r));

  // ---------- 4. o que NÃO deve virar ruído ----------

  {
    const store2 = require('../lib/store');
    const d2 = store2.get();
    d2.hosts = [{ id: 'x', name: 'p', host: '1.1.1.1', port: 22, username: 'r',
      auth: { type: 'password', password: 'abc' } }];
    store2.save();
    const tela = 'total 12\nabc.txt\nabcdef.log';
    igual(redigir(tela), tela,
      'senha de 3 letras é ignorada — apagá-la encheria toda saída de marcadores '
      + 'e escondia o que o usuário precisa ler');
  }

  {
    const store2 = require('../lib/store');
    const d2 = store2.get();
    // Uma senha que é PEDAÇO da outra.
    d2.hosts = [
      { id: 'p1', name: 'a', host: '1.1.1.1', port: 22, username: 'r',
        auth: { type: 'password', password: 'senha-comprida-de-verdade' } },
      { id: 'p2', name: 'b', host: '1.1.1.2', port: 22, username: 'r',
        auth: { type: 'password', password: 'senha-comprida' } },
    ];
    store2.save();
    const limpo = redigir('PASS=senha-comprida-de-verdade');
    naoOk(limpo.includes('senha-comprida'),
      'apagando da MAIS LONGA para a mais curta, não sobra "-de-verdade" solto na '
      + 'tela — pela ordem inversa, metade da senha longa continuaria legível');
    igual(limpo, `PASS=${MARCA}`, 'e o resultado é um marcador só, limpo');
  }

  {
    // Host AVULSO (conexão rápida): a senha vive só no quickhosts, nunca no
    // data.json. Sem a varredura do quickhosts, ela iria em claro para a API.
    const quickhosts = require('../lib/quickhosts');
    quickhosts.add({ host: '10.9.9.9', port: 23, protocol: 'telnet', username: 'admin',
      auth: { type: 'password', password: 'senhaAvulsaDoRoteador' } });
    const tela = redigir('Password: senhaAvulsaDoRoteador\r\nlogin ok');
    naoOk(tela.includes('senhaAvulsaDoRoteador'),
      'a senha de host avulso (conexão rápida) também é redigida — ela vive só na '
      + 'memória do quickhosts e escaparia para a API da IA pelo retrato da tela');
    ok(tela.includes(MARCA), 'trocada pelo marcador');
  }

  {
    igual(redigir(''), '', 'texto vazio passa');
    igual(redigir(null), null, 'e o que não é texto volta como veio');
  }

  console.log(`\n${n} verificações passaram`);
})().catch((e) => { console.error(e); process.exit(1); });
