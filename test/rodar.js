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
  // Sem prazo, um teste que abra servidor e não feche (ou um arquivo do iCloud
  // ainda não baixado, que bloqueia o require) pendura a suíte INTEIRA para
  // sempre — e o sinal disso era o terminal parado, sem uma linha de erro.
  const r = spawnSync(process.execPath, [path.join(dir, f)],
    { encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL' });
  const saida = (r.stdout || '') + (r.stderr || '');
  const ultima = saida.trim().split('\n').pop() || '';
  const conta = Number((/(\d+)\s+verifica/.exec(ultima) || [])[1] || 0);
  if (r.error && r.error.code === 'ETIMEDOUT') {
    quebrados.push(f);
    process.stdout.write(`✗ ${f} — passou de 120 s e foi morto (travou?)\n${saida}\n`);
  } else if (r.status !== 0) {
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
