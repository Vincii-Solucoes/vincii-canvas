'use strict';

// Sondas: um diagnóstico (ping, MTU…) rodado a partir de VÁRIOS pontos de vista
// ao mesmo tempo — a máquina local e qualquer host SSH cadastrado.
//
// É a resposta do Canvas ao que o isp.tools chama de "probes" (medir de vários
// provedores). Aqui os pontos de vista são os que interessam a quem opera uma
// rede: o próprio notebook, o roteador de borda, a OLT, o servidor no data
// center — todos já cadastrados, com credencial resolvida do mesmo jeito que o
// terminal (lib/runner.js connect, inclusive cofre). O comando roda LÁ, a saída
// em texto volta para cá, e quem interpreta é o módulo da ferramenta
// (lib/pingtool.js, lib/mtu.js) — que por isso sabe ler a saída de várias
// implementações de ping, não só a do macOS.
//
// A conexão fica aberta enquanto a ferramenta precisar (a busca de MTU faz uma
// dúzia de pings seguidos) e é fechada por quem abriu.

const { spawn } = require('child_process');
const runner = require('./runner');

const TIMEOUT_DETECCAO_S = 15;
const MAX_SAIDA = 256 * 1024;

// A lista do seletor da tela: a máquina local e os hosts em que dá para rodar
// um comando (SSH). Telnet, RDP, VNC, web e FTP ficam de fora — não executam.
function listar(hosts) {
  const out = [{ id: 'local', tipo: 'local', rotulo: 'Esta máquina', grupo: '' }];
  for (const h of hosts || []) {
    if (!h || (h.protocol && h.protocol !== 'ssh')) continue;
    out.push({ id: h.id, tipo: 'host', rotulo: h.name || h.host, grupo: h.group || '', espelho: !!h.espelho });
  }
  return out;
}

// Que ping temos do outro lado? Uma execução só, com duas perguntas: o nome do
// sistema e a versão do ping. A ordem importa — RouterOS não tem `uname` e
// responde "bad command name", que é a assinatura dele.
const COMANDO_DETECCAO = 'uname -s 2>/dev/null; ping -V 2>&1 | head -n 1';

function detectarPlataforma(saida) {
  const s = String(saida || '');
  if (/bad command name|expected end of command|no such item/i.test(s)) return 'routeros';
  if (/busybox/i.test(s)) return 'busybox';
  if (/^darwin/im.test(s)) return 'darwin';
  if (/^freebsd|^openbsd|^netbsd/im.test(s)) return 'darwin'; // ping da família BSD
  if (/^linux/im.test(s)) return 'linux';
  if (/^(mingw|msys|cygwin)/im.test(s)) return 'win32';
  return 'linux'; // o mais provável num servidor — e o parser é tolerante
}

// Abre a sonda. Devolve { plataforma, rotulo, exec(montar), fechar() }.
//   montar(plataforma) → { cmd, args, linha } (o módulo da ferramenta monta)
//   exec(...) → { saida, codigo }
async function abrir(sonda, { onSaveFingerprint } = {}) {
  if (!sonda || sonda.tipo === 'local') {
    return {
      plataforma: process.platform,
      rotulo: 'Esta máquina',
      exec: (montar, { timeoutSec = 60 } = {}) => {
        const c = montar(process.platform);
        if (c && c.erro) return Promise.reject(new Error(c.erro));
        return execLocal(c, timeoutSec);
      },
      fechar: () => {},
    };
  }
  const host = sonda.host;
  if (!host) throw new Error('Host da sonda não encontrado.');
  // Primeiro contato: o fingerprint é guardado no host certo (o callback
  // recebe o host, porque a mesma tarefa abre várias sondas).
  const conn = await runner.connect(host, {
    onSaveFingerprint: (fp) => { if (typeof onSaveFingerprint === 'function') onSaveFingerprint(fp, host); },
  });
  let plataforma = 'linux';
  try {
    const d = await execRemoto(conn, COMANDO_DETECCAO, TIMEOUT_DETECCAO_S);
    plataforma = detectarPlataforma(d.saida);
  } catch { /* fica linux */ }
  return {
    plataforma,
    rotulo: host.name || host.host,
    exec: (montar, { timeoutSec = 60 } = {}) => {
      const c = montar(plataforma);
      if (!c) return Promise.reject(new Error(`Esta ferramenta não tem como rodar em ${plataforma}.`));
      if (c.erro) return Promise.reject(new Error(c.erro));
      return execRemoto(conn, c.linha, timeoutSec);
    },
    fechar: () => { try { conn.end(); } catch {} },
  };
}

function execLocal(c, timeoutSec) {
  return new Promise((resolve, reject) => {
    if (!c) { reject(new Error(`Esta ferramenta não tem como rodar em ${process.platform}.`)); return; }
    let saida = '';
    let child;
    try { child = spawn(c.cmd, c.args, { windowsHide: true }); }
    catch (e) { reject(e); return; }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutSec * 1000);
    const junta = (d) => { if (saida.length < MAX_SAIDA) saida += d.toString('utf8'); };
    child.stdout.on('data', junta);
    child.stderr.on('data', junta);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (codigo) => { clearTimeout(timer); resolve({ saida, codigo }); });
  });
}

async function execRemoto(conn, linha, timeoutSec) {
  let saida = '';
  const r = await runner.execCommand(conn, linha, {
    timeoutSec,
    onData: (_tipo, texto) => { if (saida.length < MAX_SAIDA) saida += texto; },
  });
  return { saida, codigo: r.code };
}

// Roda a mesma tarefa em todas as sondas em paralelo. `tarefa(sondaAberta)`
// devolve o resultado; falha numa sonda não derruba as outras — entra como
// { erro } no lugar dela. `aoMudar(i, estado)` informa progresso à tela.
async function emTodas(sondas, tarefa, { aoMudar = () => {}, onSaveFingerprint } = {}) {
  return Promise.all(sondas.map(async (s, i) => {
    aoMudar(i, { estado: 'conectando' });
    let aberta;
    try {
      aberta = await abrir(s, { onSaveFingerprint });
    } catch (e) {
      const r = { estado: 'erro', erro: e && e.message ? e.message : String(e) };
      aoMudar(i, r);
      return r;
    }
    aoMudar(i, { estado: 'rodando', plataforma: aberta.plataforma });
    try {
      const resultado = await tarefa(aberta);
      const r = { estado: 'ok', plataforma: aberta.plataforma, resultado };
      aoMudar(i, r);
      return r;
    } catch (e) {
      const r = { estado: 'erro', plataforma: aberta.plataforma, erro: e && e.message ? e.message : String(e) };
      aoMudar(i, r);
      return r;
    } finally {
      aberta.fechar();
    }
  }));
}

module.exports = { listar, abrir, emTodas, detectarPlataforma, COMANDO_DETECCAO };
