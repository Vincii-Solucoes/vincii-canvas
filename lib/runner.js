'use strict';

const MAX_EVENTS = 4000; // eventos guardados por execução (replay do SSE)

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Client } = require('ssh2');
const credenciais = require('./credenciais');

const MAX_RUNS = 30;
const MAX_OUTPUT_BYTES = 512 * 1024; // por stream, por comando
const CONNECT_TIMEOUT_MS = 12000;
const PARALLEL_HOSTS = 5;

const runs = new Map();

function writeEvent(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function emit(run, event) {
  event.ts = Date.now();
  run.events.push(event);
  // teto: sem isso a coleta de log em lote retém toda a saída em memória e o
  // replay do SSE (para quem abre a tela depois) trava o event loop
  if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
  for (const res of run.subscribers) writeEvent(res, event);
}

function getRun(id) {
  return runs.get(id);
}

function subscribe(run, res) {
  for (const event of run.events) writeEvent(res, event);
  if (run.status !== 'executando') {
    res.end();
    return;
  }
  run.subscribers.add(res);
}

function unsubscribe(run, res) {
  run.subscribers.delete(res);
}

function expandHome(p) {
  if (!p) return p;
  return p === '~' ? os.homedir() : p.replace(/^~(?=\/)/, os.homedir());
}

function humanizeError(err, host) {
  const msg = String((err && err.message) || err);
  if (/All configured authentication methods failed/i.test(msg)) {
    return 'Falha de autenticação — verifique usuário, senha ou chave.';
  }
  if (/ECONNREFUSED/.test(msg)) return `Conexão recusada em ${host.host}:${host.port || 22} — o SSH está ativo nessa porta?`;
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return `Host não encontrado: ${host.host}`;
  if (/Timed out|ETIMEDOUT/i.test(msg)) return 'Tempo esgotado ao conectar.';
  if (/Cannot parse privateKey/i.test(msg)) return 'Não foi possível ler a chave privada (formato ou passphrase incorretos).';
  if (/ENOENT/.test(msg)) return 'Arquivo de chave privada não encontrado: ' + msg;
  return msg;
}

// `cred` vem SEMPRE de lib/credenciais.resolver — nunca de host.auth direto.
// Era em `host.auth` que esta função lia, e ela era um dos sete leitores diretos
// espalhados pelo app. Com cofre externo no jogo, um leitor esquecido não
// devolve campo vazio: devolve conexão sem senha.
function buildConnectConfig(host, cred, state, onSaveFingerprint) {
  const cfg = {
    host: host.host,
    port: host.port || 22,
    // O cadastro do host manda; o usuário do cofre só entra quando o host não
    // define — senão editar o host deixaria de ter efeito, sem explicação.
    username: host.username || cred.usuario || '',
    readyTimeout: CONNECT_TIMEOUT_MS,
    hostHash: 'sha256',
    // TOFU: fixa o fingerprint na 1ª conexão e bloqueia se mudar depois
    hostVerifier(hash) {
      const fp = String(hash);
      if (!host.fingerprint) {
        onSaveFingerprint(fp);
        return true;
      }
      if (host.fingerprint === fp) return true;
      state.mismatch = { expected: host.fingerprint, got: fp };
      return false;
    },
  };
  if (cred.type === 'password') {
    cfg.password = cred.password || '';
    cfg.tryKeyboard = true;
  } else if (cred.type === 'key') {
    // Do cofre a chave vem em memória; do cadastro, de um arquivo no disco.
    cfg.privateKey = cred.privateKey || fs.readFileSync(expandHome(cred.keyPath));
    if (cred.passphrase) cfg.passphrase = cred.passphrase;
  } else {
    if (!process.env.SSH_AUTH_SOCK) {
      throw new Error('Agente SSH indisponível (SSH_AUTH_SOCK não definido). Use chave ou senha, ou inicie o app num terminal com o agente ativo.');
    }
    cfg.agent = process.env.SSH_AUTH_SOCK;
  }
  return cfg;
}

async function connect(host, { onSaveFingerprint, register }) {
  // A credencial é buscada ANTES de abrir o socket. Vinda de cofre, isto é uma
  // chamada de rede que pode falhar — e falhar aqui produz uma mensagem que diz
  // o que houve, em vez de um "falha ao autenticar" que manda o usuário procurar
  // no lugar errado.
  let cred;
  try {
    cred = await credenciais.resolver(host);
  } catch (err) {
    throw new Error(err.codigo ? `Cofre de credenciais: ${err.message}` : humanizeError(err, host));
  }
  return new Promise((resolve, reject) => {
    const state = {};
    let cfg;
    try {
      cfg = buildConnectConfig(host, cred, state, onSaveFingerprint);
    } catch (err) {
      cred.dispose();
      reject(new Error(humanizeError(err, host)));
      return;
    }
    const conn = new Client();
    // A credencial vive enquanto a conexão viver. `dispose` tira o valor do
    // cadastro de redação; esquecer disto deixaria o segredo protegido para
    // sempre (vazamento de memória) ou desprotegido cedo demais.
    conn.on('close', () => cred.dispose());
    if (register) register(conn);
    let settled = false;
    conn.on('ready', () => {
      settled = true;
      resolve(conn);
    });
    conn.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (state.mismatch) {
        reject(new Error(`A identidade do servidor mudou! Fingerprint esperado ${state.mismatch.expected}, recebido ${state.mismatch.got}. Se a mudança for legítima, use "esquecer fingerprint" no cadastro do host.`));
      } else {
        reject(new Error(humanizeError(err, host)));
      }
    });
    conn.on('close', () => {
      if (!settled) {
        settled = true;
        reject(new Error('Conexão encerrada antes de autenticar.'));
      }
    });
    if ((host.auth || {}).type === 'password') {
      conn.on('keyboard-interactive', (n, i, l, prompts, finish) => finish(prompts.map(() => host.auth.password || '')));
    }
    conn.connect(cfg);
  });
}

// `aoAbrir` recebe o stream assim que ele existe. Sem isso não há como matar o
// comando no servidor: fechar a conexão faz o cliente parar de ouvir, mas o
// processo remoto continua rodando — o agente prometia "Parar imediato" e só
// parava de olhar.
function execCommand(conn, command, { timeoutSec, onData, aoAbrir }) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (!err && stream && typeof aoAbrir === 'function') { try { aoAbrir(stream); } catch {} }
      if (err) {
        reject(err);
        return;
      }
      const started = Date.now();
      const written = { out: 0, err: 0 };
      const truncated = { out: false, err: false };
      let timer = null;
      let timedOut = false;
      let done = false;

      const finish = (code, signal) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        conn.removeListener('close', onConnClose);
        resolve({ code, signal: signal || null, durationMs: Date.now() - started, timedOut });
      };
      // conexão caiu ou foi cancelada no meio do comando
      const onConnClose = () => finish(null, null);
      conn.on('close', onConnClose);

      if (timeoutSec > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          try { stream.close(); } catch {}
          try { conn.end(); } catch {}
        }, timeoutSec * 1000);
      }

      const push = (kind, chunk) => {
        written[kind] += chunk.length;
        if (written[kind] <= MAX_OUTPUT_BYTES) {
          onData(kind, chunk.toString('utf8'));
        } else if (!truncated[kind]) {
          truncated[kind] = true;
          onData(kind, `\n[saída truncada em ${Math.round(MAX_OUTPUT_BYTES / 1024)} KB]\n`);
        }
      };
      stream.on('data', (c) => push('out', c));
      stream.stderr.on('data', (c) => push('err', c));
      stream.on('close', (code, signal) => finish(code === undefined ? null : code, signal));
    });
  });
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(lanes);
  return results;
}

function startRun({ perHost, playbookName, options, saveData }) {
  const run = {
    id: crypto.randomUUID(),
    status: 'executando',
    startedAt: Date.now(),
    canceled: false,
    events: [],
    subscribers: new Set(),
    active: new Map(),
  };
  runs.set(run.id, run);
  for (const [id, r] of runs) {
    if (runs.size <= MAX_RUNS) break;
    if (r.status !== 'executando') runs.delete(id);
  }

  emit(run, {
    type: 'run-start',
    playbookName: playbookName || null,
    hostCount: perHost.length,
    // com @cada a contagem pode variar por host — soma o total real
    commandCount: perHost.reduce((sum, p) => sum + p.items.length, 0),
    options,
  });

  const worker = async ({ host, items }) => {
    emit(run, {
      type: 'host-start',
      host: host.id,
      name: host.name,
      address: `${host.username}@${host.host}:${host.port || 22}`,
    });
    if (run.canceled) {
      emit(run, { type: 'host-end', host: host.id, status: 'cancelado' });
      return 'cancelado';
    }

    let conn;
    try {
      conn = await connect(host, {
        register: (c) => run.active.set(host.id, c),
        onSaveFingerprint: (fp) => {
          host.fingerprint = fp;
          saveData();
          emit(run, { type: 'notice', host: host.id, message: `Fingerprint do servidor registrado (primeira conexão): ${fp.slice(0, 20)}…` });
        },
      });
    } catch (err) {
      run.active.delete(host.id);
      const status = run.canceled ? 'cancelado' : 'erro';
      emit(run, { type: 'host-end', host: host.id, status, error: run.canceled ? undefined : err.message });
      return status;
    }

    let status = 'ok';
    for (let i = 0; i < items.length; i++) {
      if (run.canceled) {
        status = 'cancelado';
        break;
      }
      const command = items[i].resolved;
      emit(run, { type: 'cmd-start', host: host.id, index: i, command });
      let result;
      try {
        result = await execCommand(conn, command, {
          timeoutSec: options.timeoutSec,
          onData: (kind, text) => emit(run, { type: 'data', host: host.id, index: i, kind, text }),
        });
      } catch (err) {
        emit(run, { type: 'cmd-end', host: host.id, index: i, code: null, signal: null, durationMs: 0, timedOut: false, error: err.message });
        status = run.canceled ? 'cancelado' : 'erro';
        break;
      }
      emit(run, {
        type: 'cmd-end',
        host: host.id,
        index: i,
        code: result.code,
        signal: result.signal,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
      });
      if (run.canceled && result.code === null) {
        status = 'cancelado';
        break;
      }
      if (result.timedOut) {
        status = 'erro';
        emit(run, { type: 'notice', host: host.id, message: 'Timeout — a conexão com este host foi encerrada.' });
        break;
      }
      if (result.code !== 0) {
        status = 'erro';
        if (options.stopOnError) {
          if (i < items.length - 1) {
            emit(run, { type: 'notice', host: host.id, message: 'Execução interrompida neste host (parar no primeiro erro).' });
          }
          break;
        }
      }
    }

    run.active.delete(host.id);
    try { conn.end(); } catch {}
    emit(run, { type: 'host-end', host: host.id, status });
    return status;
  };

  (async () => {
    const results = await pool(perHost, options.sequential ? 1 : PARALLEL_HOSTS, worker);
    const counts = { ok: 0, erro: 0, cancelado: 0 };
    for (const s of results) counts[s] = (counts[s] || 0) + 1;
    run.status = run.canceled ? 'cancelado' : counts.erro ? 'erro' : 'ok';
    emit(run, { type: 'run-end', status: run.status, durationMs: Date.now() - run.startedAt, counts });
    setTimeout(() => {
      for (const res of run.subscribers) {
        try { res.end(); } catch {}
      }
      run.subscribers.clear();
    }, 200);
  })();

  return run;
}

function cancel(run) {
  if (run.status !== 'executando') return false;
  run.canceled = true;
  emit(run, { type: 'notice', message: 'Cancelamento solicitado — encerrando conexões…' });
  for (const conn of run.active.values()) {
    try { conn.end(); } catch {}
  }
  return true;
}

async function testHost(host, { saveData }) {
  let conn;
  try {
    conn = await connect(host, {
      onSaveFingerprint: (fp) => {
        host.fingerprint = fp;
        saveData();
      },
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  try {
    const result = await execCommand(conn, 'echo conexao-ok', { timeoutSec: 10, onData: () => {} });
    if (result.code === 0) return { ok: true, fingerprint: host.fingerprint || null };
    return { ok: false, error: `Comando de teste retornou código ${result.code}.` };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    try { conn.end(); } catch {}
  }
}

module.exports = { startRun, cancel, testHost, getRun, subscribe, unsubscribe, connect, execCommand };
