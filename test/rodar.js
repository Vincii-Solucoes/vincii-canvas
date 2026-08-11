'use strict';

// Roda todos os *.test.js, cada um no seu processo.
//
// Processo separado de propósito: vários testes trocam SSHC_DATA_DIR, mexem no
// require.cache ou sobem servidor. Num processo só, um teste passa a depender de
// quem rodou antes — e o dia em que ele quebrar sozinho ninguém vai saber por quê.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const arquivos = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();

let total = 0;
const quebrados = [];

for (const f of arquivos) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8' });
  const saida = (r.stdout || '') + (r.stderr || '');
  const ultima = saida.trim().split('\n').pop() || '';
  const conta = Number((/(\d+)\s+verifica/.exec(ultima) || [])[1] || 0);
  if (r.status !== 0) {
    quebrados.push(f);
    process.stdout.write(`✗ ${f}\n${saida}\n`);
  } else {
    total += conta;
    process.stdout.write(`✓ ${f.padEnd(28)} ${ultima}\n`);
  }
}

console.log(`\n${arquivos.length - quebrados.length}/${arquivos.length} arquivos, `
  + `${total} verificações.`);
if (quebrados.length) {
  console.error(`Quebrados: ${quebrados.join(', ')}`);
  process.exit(1);
}
