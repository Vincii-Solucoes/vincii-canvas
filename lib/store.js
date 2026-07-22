'use strict';

const fs = require('fs');
const path = require('path');

// SSHC_DATA_DIR permite ao app desktop guardar os dados no perfil do usuário
// (o pacote instalado é somente leitura); sem ela, fica na pasta do projeto.
const DATA_DIR = process.env.SSHC_DATA_DIR || path.join(__dirname, '..');
const FILE = path.join(DATA_DIR, 'data.json');
const DEFAULTS = { globals: {}, hosts: [], playbooks: [], profiles: [], settings: {} };

function load() {
  if (!fs.existsSync(FILE)) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { ...DEFAULTS, ...parsed };
  } catch (err) {
    const backup = FILE + '.corrompido-' + Date.now();
    fs.copyFileSync(FILE, backup);
    console.warn(`Aviso: data.json inválido; backup salvo em ${backup}. Começando com dados vazios.`);
    return { ...DEFAULTS };
  }
}

const data = load();

// data.json guarda credenciais — escrita atômica e permissão restrita ao usuário
function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  try { fs.chmodSync(FILE, 0o600); } catch {}
}

function get() { return data; }

module.exports = { get, save };
