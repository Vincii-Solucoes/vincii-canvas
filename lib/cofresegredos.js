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
let api = null;
// null = ainda não perguntamos ao sistema; true/false = a resposta, guardada.
let respostaDoSistema = null;

// GUARDA a interface, sem perguntar nada.
//
// A versão anterior chamava `disponivel()` aqui dentro — e no macOS isso é
// `safeStorage.isEncryptionAvailable()`, que ABRE O KEYCHAIN. Como isto roda no
// arranque do app, o macOS pedia a senha de login TODA VEZ que o app abria,
// mesmo sem nenhum cofre configurado e sem nenhuma chave para proteger. Pior: o
// app é assinado ad-hoc e reassinado a cada versão, então a assinatura muda e o
// Keychain nunca reconhece o app de antes — a pergunta voltava sempre.
//
// Perguntar é caro e visível para quem usa. Só se pergunta quando há mesmo algo
// a proteger.
function usarCofreDoSistema(nova) {
  api = nova || null;
}

// Pergunta ao sistema, UMA vez por processo. Chame só quando houver chave a ler
// ou a gravar — nunca para desenhar tela.
function protegidoAgora() {
  if (respostaDoSistema !== null) return respostaDoSistema;
  respostaDoSistema = !!(api && api.disponivel && api.disponivel());
  return respostaDoSistema;
}

// Para a interface: descreve a situação SEM forçar a pergunta.
function estadoDaProtecao() {
  if (!api) return 'indisponivel';        // fora do Electron: não existe Keychain
  if (!usarSistemaPreferido()) return 'desligado-pelo-usuario';
  if (respostaDoSistema === null) return 'ainda-nao-perguntado';
  return respostaDoSistema ? 'sistema' : 'texto-claro';
}

// O usuário pode desligar o armazenamento do sistema.
//
// Não é capricho: sem certificado de desenvolvedor, o app é assinado ad-hoc e a
// assinatura muda a cada versão — então o macOS pede a senha de login na
// primeira vez que o app tocar no Keychain DEPOIS DE CADA ATUALIZAÇÃO. Quem
// achar essa pergunta pior que o ganho desliga aqui, e as chaves ficam no mesmo
// regime das outras credenciais do app: arquivo com permissão 600.
let preferencia = null;
function definirPreferencia(usarSistema) { preferencia = usarSistema !== false; }
function usarSistemaPreferido() { return preferencia !== false; }

const protegido = () => estadoDaProtecao() === 'sistema';

function ler() {
  if (!fs.existsSync(ARQUIVO)) return {};
  let cru;
  try { cru = fs.readFileSync(ARQUIVO); } catch { return {}; }
  try {
    const env = JSON.parse(cru.toString('utf8'));
    if (env && env.formato === 'protegido') {
      // Só AQUI o Keychain é tocado na leitura: existe arquivo, e ele está
      // cifrado. Sem arquivo, o `existsSync` acima já devolveu vazio.
      if (!protegidoAgora()) {
        // Arquivo protegido pelo Keychain e o app está rodando fora do Electron.
        // Devolver vazio é o certo: as chaves continuam lá, e voltam quando o
        // app desktop abrir. Apagar ou tentar adivinhar seria perder tudo.
        console.warn('[cofres] as chaves estão protegidas pelo sistema e este processo '
          + 'não alcança o Keychain. Abra pelo app desktop.');
        return {};
      }
      return JSON.parse(api.decifrar(Buffer.from(env.dados, 'base64')));
    }
    return (env && env.chaves) || {};
  } catch {
    console.warn(`[cofres] ${ARQUIVO} ilegível; começando sem chaves.`);
    return {};
  }
}

// Lê só o CABEÇALHO do arquivo atual para saber em que regime ele está, SEM
// tocar no Keychain (não decifra nada). Devolve 'protegido', 'texto-claro' ou
// null (sem arquivo ou ilegível).
function formatoNoDisco() {
  if (!fs.existsSync(ARQUIVO)) return null;
  try {
    const env = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
    return (env && env.formato) || null;
  } catch { return null; }
}

function gravar(mapa) {
  // Salvaguarda contra perda silenciosa de TODAS as chaves.
  //
  // Se o arquivo em disco está PROTEGIDO pelo sistema e este processo NÃO
  // alcança o Keychain, então `ler()` acabou de devolver vazio — e gravar por
  // cima rebaixaria o arquivo para texto claro com apenas o que este processo
  // tem em mãos, apagando as chaves cifradas que ele não conseguiu ler. Recusar
  // é o certo: as chaves continuam intactas no arquivo e voltam quando o app
  // desktop abrir e alcançar o Keychain. (Só perguntamos ao sistema quando o
  // arquivo é 'protegido' — desenhar/ler outro regime não abre o Keychain.)
  if (formatoNoDisco() === 'protegido' && !protegidoAgora()) {
    throw new Error('cofres: as chaves estão protegidas pelo sistema e este processo não '
      + 'alcança o Keychain — gravar agora apagaria as chaves cifradas. Abra pelo app desktop.');
  }
  // A gravação é o momento legítimo de perguntar: há uma chave de verdade para
  // proteger, e o usuário acabou de pedir para salvá-la.
  const usarSistema = usarSistemaPreferido() && protegidoAgora();
  const env = usarSistema
    ? { formato: 'protegido', dados: api.cifrar(JSON.stringify(mapa)).toString('base64') }
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

module.exports = { usarCofreDoSistema, protegido, estadoDaProtecao, definirPreferencia,
  pegar, definir, renomear, remover, ARQUIVO };
