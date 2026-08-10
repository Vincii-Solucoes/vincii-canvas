'use strict';

// Gerenciador de arquivos: uma interface única para os três lados que o app
// manipula — a máquina local, servidores por SFTP (canal da própria conexão
// SSH) e servidores por FTP/FTPS. A aba "Arquivos" fala só com esta camada;
// quem escolhe o transporte é a função openRemote().
//
// SEGURANÇA
// - O lado LOCAL navega na máquina do usuário por design (é o painel esquerdo,
//   como em qualquer cliente FTP). O que impede uma página externa de usar isso
//   é a guarda de origem + token no server.js — não há restrição de caminho
//   aqui, porque o próprio usuário já tem shell na máquina.
// - FTP simples é TEXTO CLARO. Preferimos FTPS quando o servidor aceita
//   ("ftps: auto"), e a interface avisa quando a sessão não está criptografada.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const runner = require('./runner');
const credenciais = require('./credenciais');

const MAX_LIST = 5000;          // teto de itens por pasta (evita travar a tela)
const MAX_TEXT_BYTES = 512 * 1024; // teto para visualizar/editar arquivo texto

// ---------- utilidades ----------

function tipoDe(nome, ehPasta, ehLink) {
  if (ehLink) return 'link';
  return ehPasta ? 'dir' : 'file';
}

// junta caminhos no formato POSIX (servidores remotos), sem depender do SO local
function joinRemote(base, nome) {
  if (nome === '..') {
    const p = base.replace(/\/+$/, '');
    const i = p.lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
  }
  if (nome.startsWith('/')) return nome;
  return (base === '/' ? '' : base.replace(/\/+$/, '')) + '/' + nome;
}

// ---------- lado LOCAL ----------

const local = {
  tipo: 'local',
  async list(dir) {
    const alvo = dir && dir !== '~' ? dir : os.homedir();
    const abs = path.resolve(alvo);
    const nomes = await fsp.readdir(abs);
    const itens = [];
    for (const nome of nomes.slice(0, MAX_LIST)) {
      try {
        const st = await fsp.lstat(path.join(abs, nome));
        const link = st.isSymbolicLink();
        let real = st;
        if (link) { try { real = await fsp.stat(path.join(abs, nome)); } catch { real = st; } }
        itens.push({
          name: nome,
          type: tipoDe(nome, real.isDirectory(), link),
          size: real.isDirectory() ? 0 : real.size,
          mtime: st.mtimeMs,
          mode: st.mode & 0o777,
        });
      } catch { /* arquivo sumiu ou sem permissão: ignora na listagem */ }
    }
    return { path: abs, parent: path.dirname(abs) === abs ? null : path.dirname(abs), items: itens, truncated: nomes.length > MAX_LIST };
  },
  async mkdir(dir, nome) { await fsp.mkdir(path.join(dir, nome), { recursive: false }); },
  async rename(dir, de, para) { await fsp.rename(path.join(dir, de), path.join(dir, para)); },
  async remove(dir, nome) {
    const alvo = path.join(dir, nome);
    const st = await fsp.lstat(alvo);
    if (st.isDirectory()) await fsp.rm(alvo, { recursive: true });
    else await fsp.unlink(alvo);
  },
  async chmod(dir, nome, modo) { await fsp.chmod(path.join(dir, nome), modo); },
  async readText(arquivo) {
    const st = await fsp.stat(arquivo);
    if (!st.isFile()) throw new Error('Não é um arquivo comum.');
    if (st.size > MAX_TEXT_BYTES) throw new Error(`Arquivo grande demais para editar aqui (${Math.round(st.size / 1024)} KB; limite ${MAX_TEXT_BYTES / 1024} KB).`);
    // lê com teto real: /proc e dispositivos reportam tamanho 0 no stat
    const fh = await fsp.open(arquivo, 'r');
    try {
      const buf = Buffer.alloc(MAX_TEXT_BYTES);
      const { bytesRead } = await fh.read(buf, 0, MAX_TEXT_BYTES, 0);
      return buf.slice(0, bytesRead).toString('utf8');
    } finally { await fh.close(); }
  },
  async writeText(arquivo, conteudo) { await fsp.writeFile(arquivo, conteudo, 'utf8'); },
  readStream(arquivo) { return fs.createReadStream(arquivo); },
  writeStream(arquivo) { return fs.createWriteStream(arquivo); },
  home() { return os.homedir(); },
  async close() {},
};

// ---------- lado REMOTO: SFTP (usa a conexão SSH existente) ----------

function promisificaSftp(sftp) {
  const p = (fn, ...args) => new Promise((res, rej) => fn.call(sftp, ...args, (err, r) => (err ? rej(err) : res(r))));
  return {
    readdir: (d) => p(sftp.readdir, d),
    realpath: (d) => p(sftp.realpath, d),
    mkdir: (d) => p(sftp.mkdir, d),
    rmdir: (d) => p(sftp.rmdir, d),
    unlink: (f) => p(sftp.unlink, f),
    rename: (a, b) => p(sftp.rename, a, b),
    chmod: (f, m) => p(sftp.chmod, f, m),
    stat: (f) => p(sftp.stat, f),
  };
}

async function abrirSftp(host, opts) {
  const conn = await runner.connect(host, opts);
  const sftp = await new Promise((res, rej) => conn.sftp((err, s) => (err ? rej(err) : res(s))));
  const api = promisificaSftp(sftp);
  let inicial = '.';
  try { inicial = await api.realpath('.'); } catch { inicial = '/'; }

  return {
    tipo: 'sftp',
    seguro: true,
    inicial,
    async list(dir) {
      const alvo = dir && dir !== '~' ? dir : inicial;
      const abs = await api.realpath(alvo).catch(() => alvo);
      const lista = await api.readdir(abs);
      const itens = lista.slice(0, MAX_LIST).map((e) => {
        const a = e.attrs || {};
        const ehDir = typeof a.isDirectory === 'function' ? a.isDirectory() : false;
        const ehLink = typeof a.isSymbolicLink === 'function' ? a.isSymbolicLink() : false;
        return {
          name: e.filename,
          type: tipoDe(e.filename, ehDir, ehLink),
          size: ehDir ? 0 : (a.size || 0),
          mtime: (a.mtime || 0) * 1000,
          mode: (a.mode || 0) & 0o777,
        };
      });
      return { path: abs, parent: abs === '/' ? null : joinRemote(abs, '..'), items: itens, truncated: lista.length > MAX_LIST };
    },
    async mkdir(dir, nome) { await api.mkdir(joinRemote(dir, nome)); },
    async rename(dir, de, para) { await api.rename(joinRemote(dir, de), joinRemote(dir, para)); },
    async remove(dir, nome) {
      const alvo = joinRemote(dir, nome);
      const st = await api.stat(alvo);
      if (st.isDirectory && st.isDirectory()) await api.rmdir(alvo);
      else await api.unlink(alvo);
    },
    async chmod(dir, nome, modo) { await api.chmod(joinRemote(dir, nome), modo); },
    async readText(arquivo) {
      const st = await api.stat(arquivo);
      if (st.size > MAX_TEXT_BYTES) throw new Error(`Arquivo grande demais para editar aqui (${Math.round(st.size / 1024)} KB).`);
      // conta os bytes DE VERDADE: arquivos de /proc e dispositivos mentem no
      // stat (size 0) e encheriam a memória sem esse teto
      const pedacos = [];
      let total = 0;
      await new Promise((res, rej) => {
        const st2 = sftp.createReadStream(arquivo);
        st2.on('data', (d) => {
          total += d.length;
          if (total > MAX_TEXT_BYTES) { st2.destroy(); rej(new Error('Arquivo grande demais para editar aqui.')); return; }
          pedacos.push(d);
        });
        st2.on('end', res); st2.on('error', rej);
      });
      return Buffer.concat(pedacos).toString('utf8');
    },
    async writeText(arquivo, conteudo) {
      await new Promise((res, rej) => {
        const w = sftp.createWriteStream(arquivo);
        w.on('close', res); w.on('error', rej);
        w.end(Buffer.from(conteudo, 'utf8'));
      });
    },
    readStream(arquivo) { return sftp.createReadStream(arquivo); },
    writeStream(arquivo) { return sftp.createWriteStream(arquivo); },
    home() { return inicial; },
    async close() { try { conn.end(); } catch {} },
  };
}

// ---------- lado REMOTO: FTP / FTPS ----------

async function abrirFtp(host) {
  const { Client } = require('basic-ftp');
  const client = new Client(20000);
  client.ftp.verbose = false;
  // "auto": tenta TLS e cai para texto claro se o servidor não suportar
  const modo = host.ftps || 'auto';
  // Credencial pelo ponto único, inclusive quando vem de cofre. Ler
  // `host.auth.password` aqui fazia deste um dos sete leitores diretos.
  const cred = await credenciais.resolver(host);
  const base = {
    host: host.host,
    port: host.port || 21,
    user: host.username || cred.usuario || 'anonymous',
    password: cred.password || 'anonymous@',
  };
  let seguro = false;
  // O certificado é VALIDADO. Antes aceitávamos qualquer um (rejectUnauthorized
  // false) e ainda assim marcávamos a sessão como segura — um atacante ativo na
  // rede interceptava usuário, senha e arquivos com o app dizendo "FTPS".
  // "ftps: confia" continua permitindo certificado autoassinado, mas aí a
  // interface mostra que a identidade do servidor não foi verificada.
  const confiaCertificado = host.ftps === 'confia';
  const opcoesTls = confiaCertificado ? { rejectUnauthorized: false } : undefined;
  try {
    if (modo === 'no') {
      await client.access({ ...base, secure: false });
    } else {
      await client.access({ ...base, secure: true, secureOptions: opcoesTls });
      seguro = true;
    }
  } catch (err) {
    if (modo === 'auto') {
      try { client.close(); } catch {}
      const c2 = new Client(20000);
      await c2.access({ ...base, secure: false });
      return montaFtp(c2, false, false, cred);
    }
    try { client.close(); } catch {}
    throw new Error(humanizaFtp(err, host));
  }
  return montaFtp(client, seguro, seguro && !confiaCertificado, cred);
}

function montaFtp(client, seguro, certificadoVerificado, cred) {
  let atual = '/';
  return {
    tipo: 'ftp',
    seguro,
    certificadoVerificado: !!certificadoVerificado,
    inicial: '/',
    async list(dir) {
      const alvo = dir && dir !== '~' ? dir : '/';
      await client.cd(alvo);
      atual = await client.pwd();
      const lista = await client.list();
      const itens = lista.slice(0, MAX_LIST).map((e) => ({
        name: e.name,
        type: e.isDirectory ? 'dir' : (e.isSymbolicLink ? 'link' : 'file'),
        size: e.isDirectory ? 0 : (e.size || 0),
        mtime: e.modifiedAt ? new Date(e.modifiedAt).getTime() : 0,
        mode: 0, // FTP não expõe permissões de forma padronizada
      }));
      return { path: atual, parent: atual === '/' ? null : joinRemote(atual, '..'), items: itens, truncated: lista.length > MAX_LIST };
    },
    async mkdir(dir, nome) { await client.ensureDir(joinRemote(dir, nome)); await client.cd(dir); },
    async rename(dir, de, para) { await client.rename(joinRemote(dir, de), joinRemote(dir, para)); },
    async remove(dir, nome) {
      const alvo = joinRemote(dir, nome);
      try { await client.remove(alvo); }
      catch { await client.removeDir(alvo); }
    },
    async chmod() { throw new Error('Alterar permissões não é suportado em FTP.'); },
    async readText(arquivo) {
      const { Writable } = require('stream');
      const pedacos = [];
      let total = 0;
      const w = new Writable({
        write(chunk, _enc, cb) {
          total += chunk.length;
          if (total > MAX_TEXT_BYTES) return cb(new Error('Arquivo grande demais para editar aqui.'));
          pedacos.push(chunk); cb();
        },
      });
      await client.downloadTo(w, arquivo);
      return Buffer.concat(pedacos).toString('utf8');
    },
    async writeText(arquivo, conteudo) {
      const { Readable } = require('stream');
      await client.uploadFrom(Readable.from([Buffer.from(conteudo, 'utf8')]), arquivo);
    },
    // FTP trabalha com um canal de dados por vez: expõe download/upload diretos
    async downloadTo(dest, arquivo) { await client.downloadTo(dest, arquivo); },
    async uploadFrom(origem, arquivo) { await client.uploadFrom(origem, arquivo); },
    home() { return '/'; },
    // `dispose` tira a credencial do cadastro de redação. Esquecer aqui
    // deixaria o segredo do cofre protegido para sempre — vazamento silencioso.
    async close() { try { client.close(); } catch {} try { cred && cred.dispose(); } catch {} },
  };
}

function humanizaFtp(err, host) {
  const m = (err && err.message) || String(err);
  if (/ECONNREFUSED/.test(m)) return `Conexão recusada em ${host.host}:${host.port || 21} — o FTP está ativo nessa porta?`;
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return `Host não encontrado: ${host.host}`;
  if (/530/.test(m)) return 'Usuário ou senha rejeitados pelo servidor FTP.';
  if (/ETIMEDOUT|timeout/i.test(m)) return `Tempo esgotado ao conectar em ${host.host}:${host.port || 21}.`;
  if (/self[- ]signed|unable to verify|certificate|CERT_/i.test(m)) {
    return `O certificado TLS do servidor não pôde ser verificado (${m}). Se o certificado for autoassinado e você confia neste servidor, escolha "Confiar no certificado" no cadastro do host.`;
  }
  return m;
}

// ---------- fábrica ----------

// Abre o cliente certo conforme o protocolo do host.
async function openRemote(host, opts) {
  if (host.protocol === 'ftp') return abrirFtp(host);
  if (host.protocol === 'telnet') throw new Error('Telnet não transfere arquivos. Use SFTP (SSH) ou FTP.');
  return abrirSftp(host, opts || {});
}

module.exports = { local, openRemote, joinRemote, MAX_TEXT_BYTES };
