'use strict';

const fs = require('fs');
const path = require('path');

// SSHC_DATA_DIR permite ao app desktop guardar os dados no perfil do usuário
// (o pacote instalado é somente leitura); sem ela, fica na pasta do projeto.
const DATA_DIR = process.env.SSHC_DATA_DIR || path.join(__dirname, '..');
const FILE = path.join(DATA_DIR, 'data.json');
const DEFAULTS = { globals: {}, hosts: [], playbooks: [], profiles: [], favorites: [], settings: {} };

// Ajustes de formato aplicados ao LER, uma vez, no lugar de espalhar "se for do
// formato antigo" por toda parte.
//
// Hoje há um: a agenda de host teve dias da semana e não tem mais. Sem esta
// passagem, o `dias` morto continuava no data.json e era REGRAVADO a cada save
// (o store serializa o objeto inteiro), sobrevivendo indefinidamente como campo
// que ninguém lê — e a próxima pessoa a abrir o arquivo tentaria interpretá-lo.
// O comportamento não muda por causa disto: quem decide a faixa é `inicio`/`fim`,
// e a mudança de "só sábado" para "todo dia" é consequência da remoção, não
// desta limpeza. Quem tinha agenda é avisado na tela pela etiqueta do host, que
// diz "(todo dia)".
function migrar(d) {
  let mexeu = false;
  for (const h of Array.isArray(d.hosts) ? d.hosts : []) {
    if (h && h.agenda && typeof h.agenda === 'object' && 'dias' in h.agenda) {
      delete h.agenda.dias;
      mexeu = true;
    }
    // Agenda sem faixa nenhuma não é agenda: só ocuparia espaço e apareceria
    // como etiqueta vazia.
    if (h && h.agenda && !(h.agenda.inicio && h.agenda.fim)) { h.agenda = null; mexeu = true; }
  }
  if (mexeu) console.warn('[store] agenda de host migrada: os dias da semana foram removidos '
    + '— a faixa de horário passa a valer todo dia.');
  return d;
}

// Como o arranque terminou, para a tela poder DIZER quando algo deu errado — o
// achado alto da auditoria era justamente isto ser mudo: o app abria vazio sem
// uma palavra. `null` = carregou normal; senão, o que aconteceu e onde.
let diagnosticoDeArranque = null;

// Marca que o app JÁ rodou nesta pasta. Serve para distinguir "primeiro uso"
// (data.json nunca existiu) de "apagado" (existiu e sumiu) — a segunda é perda
// total, e o silêncio dela era o pior lado do achado da auditoria.
const SENTINELA = path.join(DATA_DIR, '.canvas-iniciado');

function load() {
  if (!fs.existsSync(FILE)) {
    if (fs.existsSync(SENTINELA)) {
      // Já rodou aqui e o data.json sumiu: perda total, não primeiro uso.
      diagnosticoDeArranque = {
        tipo: 'apagado',
        mensagem: 'O data.json desapareceu. O app abriu VAZIO. Se você tem backups '
          + 'automáticos, restaure um deles em Configurações → Backup automático.',
      };
      console.warn('[store] data.json ausente mas o app já rodou aqui — abrindo vazio.');
    }
    return { ...DEFAULTS };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return migrar({ ...DEFAULTS, ...parsed });
  } catch (err) {
    const copia = FILE + '.corrompido-' + Date.now();
    try { fs.copyFileSync(FILE, copia); } catch { /* sem espaço/permissão: seguimos */ }
    diagnosticoDeArranque = {
      tipo: 'corrompido',
      copia,
      // NÃO promete restauração — não há automática, e prometer no exato momento
      // do desastre faz o usuário parar de agir. Diz o que é: abriu vazio, e
      // onde está o caminho de volta.
      mensagem: `O data.json estava ilegível (uma cópia dele foi guardada em ${copia}). `
        + 'O app abriu VAZIO. Restaure um backup em Configurações → Backup automático '
        + 'ANTES de mexer em qualquer coisa.',
    };
    console.warn(`Aviso: data.json inválido; cópia em ${copia}. Abrindo vazio.`);
    return { ...DEFAULTS };
  }
}

const data = load();

// Depois de uma restauração, os saves são TRAVADOS até o app reiniciar: o
// data.json em memória ainda é o vazio pós-corrupção, e um save() tardio
// gravaria o vazio por cima do que acabou de ser restaurado no disco.
let travado = false;

// data.json guarda credenciais — escrita atômica e permissão restrita ao usuário
function save() {
  if (travado) return; // uma restauração está em curso; não gravar por cima
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  try { fs.chmodSync(FILE, 0o600); } catch {}
  // A sentinela nasce junto do primeiro save real: daqui em diante, data.json
  // ausente é perda, não primeiro uso.
  try { if (!fs.existsSync(SENTINELA)) fs.writeFileSync(SENTINELA, '', { mode: 0o600 }); } catch {}
}

// Restaura o data.json a partir de um arquivo de backup e TRAVA os saves — quem
// chama deve reiniciar o app logo em seguida, para tudo recarregar do arquivo
// restaurado (caches do servidor, cofre, sessões). Validado antes: nunca grava
// um backup ilegível por cima do que existe.
function restaurarDeArquivo(caminho) {
  const bruto = fs.readFileSync(caminho, 'utf8');
  JSON.parse(bruto); // valida — lança se não for JSON, e aí nada é sobrescrito
  const tmp = FILE + '.restore';
  fs.writeFileSync(tmp, bruto, { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  try { fs.chmodSync(FILE, 0o600); } catch {}
  travado = true; // nenhum save desta sessão pode desfazer a restauração
}

function get() { return data; }

// O diretório dos dados e o caminho do data.json: o motor de backup precisa
// saber ONDE está o que ele copia, e qual é a pasta-mãe do backup padrão.
function diretorio() { return DATA_DIR; }
function arquivo() { return FILE; }
function diagnostico() { return diagnosticoDeArranque; }

module.exports = { get, save, diretorio, arquivo, diagnostico, restaurarDeArquivo };
