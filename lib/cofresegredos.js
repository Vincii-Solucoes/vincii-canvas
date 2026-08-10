'use strict';

// Onde ficam as CHAVES DE API dos cofres.
//
// Em arquivo próprio, e não no data.json, de propósito.
//
// O backup é montado a partir do data.json. Se a chave morasse lá, "não exportar
// a chave" seria uma regra que alguém precisa lembrar de aplicar em
// lib/exportxml.js — e este projeto já perdeu campo três vezes exatamente assim.
// Morando fora, a garantia é ESTRUTURAL: o exportador não tem como alcançar o
// que não está no objeto que ele recebe.
//
// A chave de um cofre não é uma senha a mais: ela abre TODAS as senhas que
// aquele cofre guarda. Por isso, quando o Electron oferece armazenamento
// protegido do sistema (Keychain no macOS, DPAPI no Windows, libsecret no
// Linux), é ele que é usado. Fora do Electron — `npm start` — não existe esse
// recurso, e o arquivo fica em texto claro com permissão 600; quem chama avisa
// na tela, porque um app que guarda segredo em texto claro sem dizer é pior do
// que um que diz.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.SSHC_DATA_DIR || path.join(__dirname, '..');
const ARQUIVO = path.join(DATA_DIR, 'cofres-chaves.json');

// O Electron injeta isto no arranque (desktop/main.js). Fora dele, fica null e o
// módulo cai no texto claro, avisando.
let cofreDoSistema = null;
function usarCofreDoSistema(api) {
  // api: { disponivel(): bool, cifrar(txt): Buffer, decifrar(buf): string }
  cofreDoSistema = api && api.disponivel && api.disponivel() ? api : null;
}
const protegido = () => !!cofreDoSistema;

function ler() {
  if (!fs.existsSync(ARQUIVO)) return {};
  let cru;
  try { cru = fs.readFileSync(ARQUIVO); } catch { return {}; }
  try {
    const env = JSON.parse(cru.toString('utf8'));
    if (env && env.formato === 'protegido') {
      if (!cofreDoSistema) {
        // Arquivo protegido pelo Keychain e o app está rodando fora do Electron.
        // Devolver vazio é o certo: as chaves continuam lá, e voltam quando o
        // app desktop abrir. Apagar ou tentar adivinhar seria perder tudo.
        console.warn('[cofres] as chaves estão protegidas pelo sistema e este processo '
          + 'não alcança o Keychain. Abra pelo app desktop.');
        return {};
      }
      return JSON.parse(cofreDoSistema.decifrar(Buffer.from(env.dados, 'base64')));
    }
    return (env && env.chaves) || {};
  } catch {
    console.warn(`[cofres] ${ARQUIVO} ilegível; começando sem chaves.`);
    return {};
  }
}

function gravar(mapa) {
  const env = protegido()
    ? { formato: 'protegido', dados: cofreDoSistema.cifrar(JSON.stringify(mapa)).toString('base64') }
    : { formato: 'texto-claro', chaves: mapa };
  const tmp = ARQUIVO + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(env), { mode: 0o600 });
  fs.renameSync(tmp, ARQUIVO);
  try { fs.chmodSync(ARQUIVO, 0o600); } catch {}
}

// Os segredos são guardados por APELIDO do cofre, não por id gerado — mesma
// razão de o host apontar por apelido: sobreviver a uma restauração noutra
// máquina.
function pegar(apelido) {
  const m = ler();
  return (m && m[apelido]) || {};
}

function definir(apelido, campos) {
  const m = ler();
  const atual = m[apelido] || {};
  for (const [k, v] of Object.entries(campos || {})) {
    // Campo vazio significa "mantenha o que está aí" — é assim que a tela
    // reexibe um cofre já configurado sem devolver a chave ao navegador.
    if (v === undefined || v === null || v === '') continue;
    atual[k] = String(v);
  }
  m[apelido] = atual;
  gravar(m);
}

function renomear(de, para) {
  const m = ler();
  if (!m[de]) return false;
  m[para] = m[de];
  delete m[de];
  gravar(m);
  return true;
}

function remover(apelido) {
  const m = ler();
  if (!(apelido in m)) return false;
  delete m[apelido];
  gravar(m);
  return true;
}

module.exports = { usarCofreDoSistema, protegido, pegar, definir, renomear, remover, ARQUIVO };
