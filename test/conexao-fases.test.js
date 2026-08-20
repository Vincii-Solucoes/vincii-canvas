'use strict';

// "Não consegui logar no SSH, deu timeout" — e o timeout tinha DOIS sentidos
// que a tela colava numa frase só, mandando o usuário adivinhar o lado:
//
//   REDE     — o TCP nem abriu: IP errado, host em outra rede, Wi-Fi dormindo
//              (o clássico do Steam Deck), firewall. O `ssh` nativo só limita
//              ESTA fase; nós limitávamos o handshake inteiro e chamávamos tudo
//              de "tempo esgotado".
//   SERVIDOR — o TCP abriu, mas o SSH não respondeu ao handshake: sshd lento,
//              sobrecarregado, ou nem é SSH naquela porta.
//
// A conexão passou a ter DUAS fases com relógios e mensagens próprios. Este
// arquivo trava qual frase sai em cada situação — é a diferença entre a pessoa
// mexer na rede ou no servidor.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.SSHC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-conex-'));
const runner = require('../lib/runner');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const contem = (s, sub, m) => { assert.ok(String(s).includes(sub), `${m} — não achei "${sub}" em: ${s}`); n += 1; };

const host = { host: 'steamdeck', port: 22 };

// ---------- fase 1: falha de REDE (o TCP nem abriu) ----------

{
  const timeout = runner._mensagemDeRede(host, 22, { code: 'ETIMEDOUT' });
  contem(timeout, 'Não consegui abrir a conexão',
    'timeout de TCP fala em NÃO ter aberto a conexão — problema de rede, não de senha');
  contem(timeout, 'Steam Deck',
    'e cita o caso do Deck (Wi-Fi dormindo) — o motivo mais comum desse timeout');
  ok(!/senha|autentic/i.test(timeout),
    'e NÃO manda checar senha: a autenticação nem foi tentada');

  const inalcancavel = runner._mensagemDeRede(host, 22, { code: 'EHOSTUNREACH' });
  contem(inalcancavel, 'não respondeu', 'host inalcançável cai na mesma frase de rede');

  const recusado = runner._mensagemDeRede(host, 2222, { code: 'ECONNREFUSED' });
  contem(recusado, 'não há SSH ouvindo nessa porta',
    'recusa na fase TCP: o host existe, mas nada de SSH na porta — o sshd está ligado?');
  contem(recusado, ':2222', 'e diz a porta exata');

  const dns = runner._mensagemDeRede(host, 22, { code: 'ENOTFOUND' });
  contem(dns, 'DNS não resolveu', 'nome que não resolve é dito como problema de endereço/DNS');
  contem(dns, 'steamdeck', 'com o nome que falhou');
}

// ---------- fase 2: TCP abriu, mas o SERVIDOR SSH ficou mudo ----------

{
  const err = new Error('Timed out while waiting for handshake');
  const comTcp = runner._humanizeError(err, host, { tcpOk: true });
  contem(comTcp, 'Conectei em steamdeck:22',
    'com o TCP aberto, a mensagem AFIRMA que conectou — o silêncio é do servidor');
  contem(comTcp, 'servidor SSH não respondeu',
    'e aponta o servidor SSH, não a rede');
  contem(comTcp, 'não ser SSH nessa porta',
    'inclusive a hipótese de a porta não ser SSH de verdade');

  // Sem o tcpOk, o mesmo timeout continua genérico (é o caminho antigo, para
  // quem chama humanizeError fora da fase 2).
  const semTcp = runner._humanizeError(err, host, {});
  contem(semTcp, 'Tempo esgotado', 'sem contexto de TCP, mensagem genérica');
  ok(!/Conectei em/.test(semTcp), 'e sem afirmar uma conexão que não se sabe se houve');
}

// ---------- os outros erros de SSH seguem falando o que sempre falaram ----------

{
  contem(runner._humanizeError(new Error('All configured authentication methods failed'), host, { tcpOk: true }),
    'Falha de autenticação', 'auth falha continua sendo auth, mesmo com o TCP ok');
  contem(runner._humanizeError(new Error('connect ECONNREFUSED'), host),
    'Conexão recusada', 'ECONNREFUSED que chega ao ssh2 ainda é recusa');
  contem(runner._humanizeError(new Error('Cannot parse privateKey'), host),
    'chave privada', 'erro de chave privada continua nomeado');
}

// ---------- os dois relógios são distintos e a fase TCP é a mais curta ----------

{
  ok(runner._TCP_CONNECT_TIMEOUT_MS > 0 && runner._SSH_HANDSHAKE_TIMEOUT_MS > 0, 'os dois relógios existem');
  ok(runner._TCP_CONNECT_TIMEOUT_MS <= runner._SSH_HANDSHAKE_TIMEOUT_MS,
    'a fase TCP não espera mais que o handshake — falhar por rede é o caso mais comum e barato de decidir');
}

// ---------- a LIGAÇÃO: connect() usa a mensagem certa de verdade ----------
//
// Os testes acima cobrem os helpers; este cobre o FIO — que connect() chame
// `mensagemDeRede` quando o TCP falha, e não a genérica. A mutação que trocava
// uma pela outra passava despercebida sem isto. Dispara uma falha de TCP real
// (porta fechada em 127.0.0.1 = ECONNREFUSED imediato, sem esperar timeout).
(async () => {
  const hostRecusado = { host: '127.0.0.1', port: 1,
    auth: { type: 'password', password: 'x' } };
  try {
    await runner.connect(hostRecusado, { onSaveFingerprint: () => {} });
    ok(false, 'conectar na porta 1 deveria falhar');
  } catch (e) {
    // ECONNREFUSED na FASE TCP → a frase de rede, com o "sshd está ligado?".
    contem(e.message, 'não há SSH ouvindo nessa porta',
      'connect() usa a mensagem de REDE na falha de TCP — não a genérica de timeout');
    ok(!/autentic/i.test(e.message), 'e não fala em autenticação: o SSH nem começou');
  }

  console.log(`\n${n} verificações passaram`);
})().catch((e) => { console.error(e); process.exit(1); });
