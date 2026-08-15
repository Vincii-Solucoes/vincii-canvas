'use strict';

// Escrita atômica e DURÁVEL, num só lugar.
//
// O padrão "grava .tmp, faz rename" vivia copiado em store.js, history.js e
// cofresegredos.js — sempre sem fsync e com um nome de temporário FIXO. Dois
// problemas concretos que este módulo resolve:
//
//   • Durabilidade: o rename garante que ninguém leia o arquivo pela metade,
//     mas SEM fsync uma queda de energia logo depois pode deixar a entrada de
//     diretório apontando para conteúdo que nunca chegou ao disco. Fazemos
//     fsync do arquivo E do diretório.
//   • Colisão entre instâncias: com o temporário de nome fixo (`arquivo.tmp`),
//     duas instâncias apontadas ao mesmo diretório de dados escreviam no MESMO
//     `.tmp` e se sobrepunham. O temporário agora leva o pid do processo.
//
// Nota honesta de alcance: isto NÃO é um lock. Duas instâncias ainda podem
// perder a escrita uma da outra pelo "último rename vence" — o que evitamos é a
// corrupção do próprio arquivo temporário. O app desktop já barra a segunda
// instância (requestSingleInstanceLock); o caso que sobra é `npm start` em
// paralelo ao app apontando para o mesmo SSHC_DATA_DIR.

const fs = require('fs');
const path = require('path');

function gravarAtomico(arquivo, conteudo, modo = 0o600) {
  const tmp = `${arquivo}.tmp.${process.pid}`;
  const fd = fs.openSync(tmp, 'w', modo);
  try {
    fs.writeFileSync(fd, conteudo);
    try { fs.fsyncSync(fd); } catch {}
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, arquivo);
  try { fs.chmodSync(arquivo, modo); } catch {}
  // fsync do diretório para o próprio rename sobreviver a uma queda de energia.
  // Em alguns sistemas (Windows) abrir o diretório para fsync não é permitido —
  // é best-effort.
  try {
    const dfd = fs.openSync(path.dirname(arquivo), 'r');
    try { fs.fsyncSync(dfd); } catch {} finally { fs.closeSync(dfd); }
  } catch {}
}

module.exports = { gravarAtomico };
