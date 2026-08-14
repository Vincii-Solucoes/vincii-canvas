'use strict';

// Teclado-interativo: a senha do COFRE precisa chegar igual à salva.
//
// `PasswordAuthentication no` + `KbdInteractiveAuthentication yes` é a
// configuração de quem usa PAM ou MFA — comum em servidor de cliente. Nela o
// ssh2 não manda a senha: ele espera o evento `keyboard-interactive` e responde
// aos prompts.
//
// O respondedor era registrado sob `host.auth.type === 'password'`, e lia
// `host.auth.password` direto. Num host de cofre `auth.type` é 'cofre', então
// ele NUNCA era registrado — mas `cfg.tryKeyboard` era ligado do mesmo jeito,
// porque a credencial RESOLVIDA tem type 'password'. O ssh2 anunciava que sabia
// responder e depois não respondia: a conexão pendurava até o readyTimeout e
// morria com "Tempo esgotado ao conectar", que manda investigar rede quando o
// problema é autenticação.
//
// Ou seja: a senha salva no cadastro funcionava e a MESMA senha vinda do cofre
// não — exatamente o caso que a integração existe para atender.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { generateKeyPairSync } = require('crypto');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-ki-'));
process.env.SSHC_DATA_DIR = DIR;

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };

const SENHA = 'senha-que-so-o-cofre-conhece';

// Servidor SSH que recusa tudo e oferece SÓ keyboard-interactive.
function sshdSoTeclado() {
  const ssh2 = require('ssh2');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  const srv = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'keyboard-interactive') {
        return ctx.prompt([{ prompt: 'Password: ', echo: false }], (r) =>
          (r && r[0] === SENHA ? ctx.accept() : ctx.reject()));
      }
      return ctx.reject(['keyboard-interactive']);
    });
    client.on('ready', () => client.on('session', (a, rej) => rej()));
  });
  return srv;
}

(async () => {
  const store = require('../lib/store');
  const segredosDeCofre = require('../lib/cofresegredos');
  const runner = require('../lib/runner');

  const sshd = sshdSoTeclado();
  await new Promise((r) => sshd.listen(0, '127.0.0.1', r));
  const portaSsh = sshd.address().port;

  const cofre = http.createServer((q, r) => {
    r.writeHead(200, { 'Content-Type': 'application/json' });
    r.end(JSON.stringify({ id: 's', tipo: 'senha', senha: SENHA }));
  });
  await new Promise((r) => cofre.listen(0, '127.0.0.1', r));

  const d = store.get();
  d.cofres = [{ apelido: 'erp', tipo: 'vitruviano', nome: 'HV',
    config: { baseUrl: `http://127.0.0.1:${cofre.address().port}/v1` } }];
  store.save();
  segredosDeCofre.definir('erp', { chave: 't' });

  const conectar = async (auth, segredo) => {
    const host = { id: 'h', name: 'ki', host: '127.0.0.1', port: portaSsh,
      username: 'u', auth, segredo };
    try {
      const c = await runner.connect(host, { onSaveFingerprint: () => {} });
      c.end();
      return 'ok';
    } catch (e) { return e.message; }
  };

  ok(await conectar({ type: 'password', password: SENHA }) === 'ok',
    'senha salva no cadastro autentica num servidor só-teclado-interativo');

  ok(await conectar({ type: 'cofre' }, { cofre: 'erp', id: 's' }) === 'ok',
    'e a MESMA senha vinda do COFRE também. O respondedor do teclado-interativo '
    + 'precisa ser registrado pela credencial RESOLVIDA (cred.type), e não pelo '
    + 'cadastro (host.auth.type) — senão o host de cofre anuncia que sabe '
    + 'responder, não responde, e a conexão morre por tempo esgotado');

  // A guarda no fonte, porque o defeito é a CONDIÇÃO, e reescrevê-la errado
  // volta a passar despercebido num servidor que aceita senha comum.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'runner.js'), 'utf8');
  ok(/if \(cred\.type === 'password'\) \{\s*\n\s*conn\.on\('keyboard-interactive'/.test(src),
    'a condição olha a credencial resolvida');
  ok(!/finish\(prompts\.map\(\(\) => host\.auth\.password/.test(src),
    'e a resposta não lê `host.auth.password` direto — esse era o oitavo leitor '
    + 'direto que lib/credenciais.js existe para eliminar');

  await new Promise((r) => cofre.close(r));
  await new Promise((r) => sshd.close(r));
  console.log(`\n${n} verificações passaram`);
})().catch((e) => { console.error(e); process.exit(1); });
