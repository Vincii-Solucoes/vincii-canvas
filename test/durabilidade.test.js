'use strict';

// Durabilidade da persistência em arquivo:
//   1. gravarAtomico grava de forma atômica, com permissão 600, sem deixar
//      temporário para trás e sobrescrevendo o destino existente;
//   2. history.json corrompido NÃO é apagado em silêncio — vira um backup
//      .corrompido-* e o app começa vazio (mesma política do data.json).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// ---------- gravarAtomico ----------
{
  const { gravarAtomico } = require('../lib/gravaratomico');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-grav-'));
  const alvo = path.join(dir, 'coisa.json');

  gravarAtomico(alvo, '{"a":1}', 0o600);
  igual(fs.readFileSync(alvo, 'utf8'), '{"a":1}', 'grava o conteúdo');
  if (process.platform !== 'win32') {
    igual(fs.statSync(alvo).mode & 0o777, 0o600, 'com permissão 600');
  } else { ok(true, '(permissão não conferida no Windows)'); }

  gravarAtomico(alvo, '{"a":2}', 0o600);
  igual(fs.readFileSync(alvo, 'utf8'), '{"a":2}', 'sobrescreve o destino existente');

  const sobrando = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  igual(sobrando, [], 'não deixa temporário para trás');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ---------- history.json corrompido vira backup ----------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-hist-'));
  const antes = process.env.SSHC_DATA_DIR;
  process.env.SSHC_DATA_DIR = dir;

  const arq = path.join(dir, 'history.json');
  fs.writeFileSync(arq, '{ isto não é JSON válido');

  // Silencia o aviso esperado para não virar a última linha da saída (o runner
  // lê a contagem da última linha de stdout+stderr).
  const warnOrig = console.warn;
  console.warn = () => {};
  delete require.cache[require.resolve('../lib/history')];
  const history = require('../lib/history');
  console.warn = warnOrig;

  igual(history.list(), [], 'começa vazio em vez de estourar');
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith('history.json.corrompido-'));
  igual(backups.length, 1, 'e preserva uma cópia do arquivo corrompido');
  ok(fs.readFileSync(path.join(dir, backups[0]), 'utf8').includes('não é JSON'),
    'o backup contém o conteúdo original, para não perder a trilha de auditoria');

  process.env.SSHC_DATA_DIR = antes;
  delete require.cache[require.resolve('../lib/history')];
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

console.log(`\n${n} verificações passaram`);
