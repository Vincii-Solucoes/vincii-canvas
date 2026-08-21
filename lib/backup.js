'use strict';

// Backup automático do data.json — a rede contra a perda total.
//
// A auditoria achou o único risco alto do app: o data.json é cópia ÚNICA. Uma
// corrupção (queda de energia no meio de um save) ou um apagamento e some tudo
// — hosts, senhas, cofres, playbooks — sem uma palavra na tela.
//
// A defesa aqui é uma cópia ROTATIVA e DATADA do último estado bom, guardada
// numa pasta que o usuário escolhe. Três gatilhos:
//   - no ARRANQUE: antes de qualquer save desta sessão, o data.json que está no
//     disco é o último estado bom da sessão anterior — copia-se ele;
//   - PERIÓDICO: o app fica aberto por semanas; um snapshot a cada
//     INTERVALO_MS, mas só se o data.json mudou desde o último backup (não se
//     copia o que já se tem);
//   - MANUAL: o botão "Fazer backup agora".
//
// Retenção: mantém as N cópias mais novas e apaga o resto. O backup NÃO é o
// export XML (aquele é curado, sem fingerprint, com aviso de segredos): é uma
// cópia crua e fiel do data.json, para restaurar exatamente o que se tinha.

const fs = require('fs');
const path = require('path');
const store = require('./store');

const PREFIXO = 'canvas-data-';
const SUFIXO = '.json';
const MANTER_PADRAO = 10;
const MANTER_MAX = 100;
const INTERVALO_MS = 12 * 60 * 60 * 1000; // 12 h entre snapshots periódicos

// O seletor de pasta NATIVO. Só existe sob Electron (o main.js o injeta, como
// faz com o safeStorage do cofre); em `npm start` fica nulo e a tela sabe que
// não há como abrir o diálogo — o usuário digita o caminho.
let seletorDePasta = null;
function definirSeletor(fn) { seletorDePasta = typeof fn === 'function' ? fn : null; }
function podeEscolherPasta() { return !!seletorDePasta; }

let timer = null;

function pastaPadrao() {
  return path.join(store.diretorio(), 'backups');
}

// A config vive em settings.backup. `pasta` vazia = a padrão; assim, mudar o
// SSHC_DATA_DIR (dev x instalado) não deixa a pasta apontando para o lugar
// errado de uma instalação antiga.
function cfg() {
  const s = store.get().settings || (store.get().settings = {});
  const b = s.backup && typeof s.backup === 'object' && !Array.isArray(s.backup) ? s.backup : {};
  const pasta = (typeof b.pasta === 'string' && b.pasta.trim()) ? b.pasta.trim() : pastaPadrao();
  const manter = Number.isInteger(b.manter) ? Math.min(MANTER_MAX, Math.max(1, b.manter)) : MANTER_PADRAO;
  // Nasce LIGADO — a proteção só vale se for o padrão; quem não quiser desliga.
  const ativo = b.ativo !== false;
  return { ativo, pasta, manter };
}

function garantirPasta(pasta) {
  fs.mkdirSync(pasta, { recursive: true });
}

// Nome ordenável por tempo E legível: canvas-data-2026-08-18T14-30-00-123Z.json.
// O ':' não vale em nome de arquivo no Windows, então a hora usa '-'.
function nomeDoInstante(agora) {
  const iso = new Date(agora).toISOString().replace(/:/g, '-');
  return `${PREFIXO}${iso}${SUFIXO}`;
}

// Lista as cópias existentes, mais nova primeiro. Ignora o que não for nossa —
// a pasta pode ter outra coisa, e apagar arquivo alheio seria imperdoável.
// `lstatSync` (não `statSync`): um symlink com o nosso nome, apontando para
// fora, não pode roubar vaga da retenção nem virar o "último backup".
function listar(pasta) {
  let nomes;
  try { nomes = fs.readdirSync(pasta); } catch { return []; }
  const out = [];
  for (const nome of nomes) {
    if (!nome.startsWith(PREFIXO) || !nome.endsWith(SUFIXO)) continue;
    try {
      const st = fs.lstatSync(path.join(pasta, nome));
      if (st.isFile() && !st.isSymbolicLink()) out.push({ nome, quando: st.mtimeMs, tamanho: st.size });
    } catch { /* sumiu no meio da listagem: ignora */ }
  }
  return out.sort((a, b) => b.quando - a.quando);
}

// O app abriu vazio por CORRUPÇÃO/apagamento? Enquanto isso não é resolvido por
// uma restauração (que reinicia o app e limpa o diagnóstico), o motor NÃO grava
// nem poda: senão a rotação snapshota o estado vazio e expulsa as cópias boas —
// a rede se comeria sozinha justo no desastre que ela existe para cobrir.
function protegido() {
  const d = store.diagnostico();
  return !!(d && (d.tipo === 'corrompido' || d.tipo === 'apagado'));
}

function podar(pasta, manter) {
  const copias = listar(pasta);
  for (const c of copias.slice(manter)) {
    try { fs.unlinkSync(path.join(pasta, c.nome)); } catch { /* já foi */ }
  }
}

let ultimoErro = null;

// O trabalho de verdade. `forcar` pula a checagem de "mudou desde o último" —
// é o que o botão manual quer (copiar agora, mesmo idêntico).
function copiar(agora, { forcar = false } = {}) {
  // Arranque vazio por corrupção: não tocar na pasta até restaurar.
  if (protegido()) return { feito: false, motivo: 'arranque-corrompido' };
  const { pasta, manter } = cfg();
  const origem = store.arquivo();
  if (!fs.existsSync(origem)) return { feito: false, motivo: 'sem-dados' };
  // Nunca copiar um data.json ilegível como se fosse bom — validar antes.
  let conteudo;
  try { conteudo = fs.readFileSync(origem, 'utf8'); JSON.parse(conteudo); }
  catch { ultimoErro = 'O data.json atual está ilegível — o backup foi pulado para não gravar lixo.'; return { feito: false, motivo: 'origem-invalida' }; }

  if (!forcar) {
    // Não copiar de novo o que é idêntico byte a byte — o snapshot periódico
    // rodaria à toa a cada 12 h de app aberto sem mudança.
    const ultima = listar(pasta)[0];
    if (ultima && fsIguais(path.join(pasta, ultima.nome), conteudo)) {
      return { feito: false, motivo: 'sem-mudanca' };
    }
  }

  const destino = path.join(pasta, nomeDoInstante(agora));
  const tmp = destino + '.tmp';
  try {
    garantirPasta(pasta);
    fs.writeFileSync(tmp, conteudo, { mode: 0o600 });
    fs.renameSync(tmp, destino);
    podar(pasta, manter);
    ultimoErro = null;
    return { feito: true, arquivo: path.basename(destino) };
  } catch (e) {
    // Falha no meio (disco cheio, queda): o .tmp fica invisível para a
    // listagem (termina em .tmp, não .json) e nunca sairia sozinho. Limpa aqui.
    try { fs.unlinkSync(tmp); } catch { /* nem chegou a existir */ }
    ultimoErro = `Não foi possível gravar o backup em ${pasta}: ${e.message}`;
    return { feito: false, motivo: 'erro', erro: e.message };
  }
}

// Comparação de conteúdo, para o "mudou desde o último" ser exato e não só por
// tamanho (dois estados podem ter o mesmo tamanho e conteúdo diferente).
function fsIguais(caminhoBackup, conteudoAtual) {
  try { return fs.readFileSync(caminhoBackup, 'utf8') === conteudoAtual; }
  catch { return false; }
}

// ---------- ciclo de vida ----------

// No arranque: um snapshot do último estado bom, ANTES de a sessão mexer em
// nada. É o coração da proteção — sempre existe a cópia de como estava ao abrir.
function aoIniciar(agora = Date.now()) {
  if (!cfg().ativo) return { feito: false, motivo: 'desligado' };
  return copiar(agora);
}

// O timer periódico, para a sessão que fica aberta por semanas. `unref` para
// não segurar o processo vivo sozinho.
function iniciar() {
  aoIniciar();
  if (timer) clearInterval(timer);
  timer = setInterval(() => { if (cfg().ativo) copiar(Date.now()); }, INTERVALO_MS);
  if (timer.unref) timer.unref();
}

function parar() { if (timer) { clearInterval(timer); timer = null; } }

// Apaga UMA cópia — o "lixinho" da tela. Mesma guarda do restaurar: só um nome
// nosso, na pasta configurada, que esteja mesmo na listagem (nada de "../..",
// caminho absoluto, ou symlink apontando para fora). Não mexe no data.json.
function apagar(nome) {
  const base = path.basename(String(nome || ''));
  if (base !== nome || !base.startsWith(PREFIXO) || !base.endsWith(SUFIXO)) {
    return { ok: false, erro: 'Backup inválido.' };
  }
  const { pasta } = cfg();
  if (!listar(pasta).some((c) => c.nome === base)) {
    return { ok: false, erro: 'Este backup não está na pasta atual.' };
  }
  try {
    fs.unlinkSync(path.join(pasta, base));
  } catch (e) {
    return { ok: false, erro: `Não foi possível apagar: ${e.message}` };
  }
  return { ok: true };
}

// O botão manual: sempre grava, mesmo sem mudança.
function rodarAgora(agora = Date.now()) {
  if (!cfg().ativo) return { feito: false, motivo: 'desligado' };
  return copiar(agora, { forcar: true });
}

// ---------- o que a tela mostra e grava ----------

function estado() {
  const c = cfg();
  const copias = listar(c.pasta);
  const diag = store.diagnostico();
  return {
    ativo: c.ativo,
    pasta: c.pasta,
    pastaPadrao: pastaPadrao(),
    naPastaPadrao: c.pasta === pastaPadrao(),
    manter: c.manter,
    podeEscolherPasta: podeEscolherPasta(),
    copias: copias.map((x) => ({ nome: x.nome, quando: Math.round(x.quando), tamanho: x.tamanho })),
    ultimo: copias[0] ? { arquivo: copias[0].nome, quando: Math.round(copias[0].quando) } : null,
    erro: ultimoErro,
    // O aviso de corrupção/apagamento do arranque, para a tela poder DIZER — era
    // mudo. Enquanto ele existe, o motor está protegido (não grava nem poda) e a
    // tela oferece Restaurar.
    arranque: diag,
    protegido: protegido(),
    podeRestaurar: !!relaunch,
  };
}

// Valida e grava a config; devolve o estado novo. Uma pasta que não dá para
// criar é RECUSADA na hora, com mensagem — não se descobre isso no dia do
// desastre.
function aplicar(body) {
  const s = store.get().settings || (store.get().settings = {});
  const atual = cfg();
  const nova = { ativo: atual.ativo, pasta: '', manter: atual.manter };

  if (typeof body.ativo === 'boolean') nova.ativo = body.ativo;

  if (body.pasta !== undefined) {
    const p = String(body.pasta || '').trim();
    if (p && p !== pastaPadrao()) {
      if (!path.isAbsolute(p)) throw new Error('A pasta do backup precisa ser um caminho absoluto.');
      try { garantirPasta(p); fs.accessSync(p, fs.constants.W_OK); }
      catch (e) { throw new Error(`Não consigo escrever em "${p}": ${e.code === 'EACCES' ? 'sem permissão' : e.message}.`); }
      nova.pasta = p;
    } // pasta vazia OU igual à padrão → guarda vazio, que resolve para a padrão
  } else {
    nova.pasta = (s.backup && s.backup.pasta) || '';
  }

  if (body.manter !== undefined) {
    const n = Number(body.manter);
    if (!Number.isFinite(n)) throw new Error('Quantidade de cópias inválida.');
    nova.manter = Math.min(MANTER_MAX, Math.max(1, Math.round(n)));
  }

  s.backup = { ativo: nova.ativo, pasta: nova.pasta, manter: nova.manter };
  store.save();
  // Poda já com o novo teto, para diminuir "manter" ter efeito na hora — mas
  // NUNCA durante um arranque corrompido: podar ali apagaria as cópias boas.
  if (nova.ativo && !protegido()) podar(cfg().pasta, nova.manter);
  return estado();
}

// Abre o diálogo NATIVO de escolha de pasta (só sob Electron). Devolve o
// caminho escolhido ou null (cancelado / sem seletor).
async function escolherPasta() {
  if (!seletorDePasta) return null;
  const inicial = cfg().pasta;
  const escolhida = await seletorDePasta(inicial);
  return (typeof escolhida === 'string' && escolhida.trim()) ? escolhida.trim() : null;
}

// ---------- restauração: o caminho de volta que faltava ----------
//
// Um backup sem restauração não é rede de segurança, é enfeite. A cópia mora
// numa pasta que o usuário nem sempre sabe achar; aqui a tela lista e restaura.
//
// Reiniciar o app É parte da operação: o data.json em memória (e os caches do
// servidor, do cofre, das sessões) precisam recarregar do arquivo restaurado.
// O main.js injeta o `relaunch`; em `npm start` não há, e a tela pede reinício.
let relaunch = null;
function definirRelaunch(fn) { relaunch = typeof fn === 'function' ? fn : null; }

function restaurar(nome) {
  // Só um nome de arquivo NOSSO, na pasta configurada — nada de "../.." nem
  // caminho absoluto: a restauração lê de disco e sobrescreve o data.json.
  const base = path.basename(String(nome || ''));
  if (base !== nome || !base.startsWith(PREFIXO) || !base.endsWith(SUFIXO)) {
    return { ok: false, erro: 'Backup inválido.' };
  }
  const { pasta } = cfg();
  const alvo = path.join(pasta, base);
  if (!listar(pasta).some((c) => c.nome === base)) {
    return { ok: false, erro: 'Este backup não está na pasta atual.' };
  }
  try {
    store.restaurarDeArquivo(alvo);
  } catch (e) {
    return { ok: false, erro: `Não foi possível restaurar: ${e.message}` };
  }
  parar(); // sem mais snapshots automáticos desta sessão
  const reiniciou = !!relaunch;
  if (relaunch) { setTimeout(() => { try { relaunch(); } catch { /* segue */ } }, 150); }
  return { ok: true, reiniciou };
}

module.exports = {
  definirSeletor, definirRelaunch, podeEscolherPasta, pastaPadrao,
  aoIniciar, iniciar, parar, rodarAgora, restaurar, apagar,
  estado, aplicar, escolherPasta,
  // expostos para teste
  _cfg: cfg, _listar: listar, _copiar: copiar, _protegido: protegido, INTERVALO_MS, MANTER_PADRAO,
};
