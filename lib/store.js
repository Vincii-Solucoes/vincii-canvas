'use strict';

const fs = require('fs');
const path = require('path');
const { gravarAtomico } = require('./gravaratomico');

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

function load() {
  if (!fs.existsSync(FILE)) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return migrar({ ...DEFAULTS, ...parsed });
  } catch (err) {
    const backup = FILE + '.corrompido-' + Date.now();
    fs.copyFileSync(FILE, backup);
    console.warn(`Aviso: data.json inválido; backup salvo em ${backup}. Começando com dados vazios.`);
    return { ...DEFAULTS };
  }
}

const data = load();

// data.json guarda credenciais — escrita atômica, durável e permissão restrita
// ao usuário (ver lib/gravaratomico.js)
function save() {
  gravarAtomico(FILE, JSON.stringify(data, null, 2), 0o600);
}

function get() { return data; }

module.exports = { get, save };
