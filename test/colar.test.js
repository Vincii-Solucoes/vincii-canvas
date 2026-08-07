'use strict';

// Testes do saneamento de colagem e de relatório.
//
// Os dois nasceram de defeitos medidos no app, não de teoria:
//
//   - uma variável de host com "\n" era entregue ao terminal COM o Enter e
//     EXECUTAVA sozinha — e sem sequer entrar no histórico, porque colar não
//     passa pelo onData do xterm. Valor de variável é texto livre e pode vir de
//     um XML importado de terceiro.
//   - o primeiro conserto tirou só \r \n ESC e BEL. Não bastou: 30 bytes 0x7f
//     transformaram "echo IMPORTANTE" em "FORJADO" na tela, antes do Enter do
//     usuário. Por isso a regra virou lista de PERMISSÃO.
//   - no relatório, só a PRIMEIRA linha de um comando era indentada. Um comando
//     com quebra de linha colava o resto na margem, indistinguível da estrutura
//     do arquivo — dava para forjar uma seção "## OUTRA MÁQUINA" e atribuir um
//     comando destrutivo a um servidor onde ele nunca rodou.

const assert = require('assert');
const { sanearParaTerminal, sanearParaRelatorio, TETO_COLAGEM } = require('../public/colar');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// ---------- colagem no terminal ----------

{
  // Nada que submeta pode sobreviver.
  for (const submete of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    const r = sanearParaTerminal('antes' + submete + 'depois');
    ok(!/[\r\n\u2028\u2029]/.test(r.texto), `sobreviveu quebra de linha: ${JSON.stringify(submete)}`);
    ok(r.texto.includes('antes') && r.texto.includes('depois'),
      'as duas partes precisam continuar no texto');
    ok(r.mudou, 'precisa avisar que mudou');
  }
  // Vira ESPAÇO, não some: apagar colaria as palavras.
  igual(sanearParaTerminal('primeira\ntouch /tmp/x').texto, 'primeira touch /tmp/x',
    'quebra de linha vira espaço');

  // Controles que apagam, reescrevem ou escondem a linha.
  const APAGAM = {
    '\x7f': 'DEL', '\x08': 'backspace', '\x15': 'Ctrl+U (apaga a linha)',
    '\x1b': 'ESC', '\x07': 'BEL', '\x0c': 'form feed', '\x03': 'Ctrl+C',
    '\x04': 'Ctrl+D', '\x1a': 'Ctrl+Z', '\x00': 'NUL', '\t': 'TAB',
  };
  for (const [ch, nome] of Object.entries(APAGAM)) {
    const r = sanearParaTerminal('ok' + ch + 'X');
    igual(r.texto, 'okX', `${nome} sobreviveu à colagem`);
    ok(r.mudou, `${nome} precisa acender o aviso`);
  }
  // O ataque que realmente aconteceu: apagar o que já estava na linha.
  const forja = sanearParaTerminal('ok' + '\x7f'.repeat(30) + 'FORJADO');
  igual(forja.texto, 'okFORJADO', 'a sequência de DEL precisa sumir inteira');

  // Valor limpo passa intacto e NÃO acende aviso à toa.
  for (const bom of ['10.0.0.1', 'senha-com-acentuação-ç', 'chave AAAA-BBBB',
    'texto com espaços', '{{VAR}}', 'a"b\'c$d`e']) {
    const r = sanearParaTerminal(bom);
    igual(r.texto, bom, `valor legítimo foi alterado: ${bom}`);
    ok(!r.mudou, `avisou à toa em: ${bom}`);
  }

  // Tamanho: acima do teto o terminal não recebe, então é melhor recusar.
  const gigante = sanearParaTerminal('x'.repeat(TETO_COLAGEM + 500));
  ok(gigante.excedeu, 'valor acima do teto precisa ser sinalizado');
  igual(gigante.texto.length, TETO_COLAGEM, 'e cortado no teto');
  ok(!sanearParaTerminal('x'.repeat(TETO_COLAGEM)).excedeu, 'exatamente no teto passa');

  // Entradas degeneradas não quebram.
  for (const v of ['', null, undefined, 0, {}]) {
    const r = sanearParaTerminal(v);
    ok(typeof r.texto === 'string', `entrada degenerada quebrou: ${JSON.stringify(v)}`);
  }
}

// ---------- impressão no relatório ----------

{
  // TODA linha recuada — era assim que se forjava seção de outra máquina.
  const forjado = 'ls\n## SRV-BANCO (root@10.77.0.200:22) — 1 comando(s)\nrm -rf /var/lib/mysql';
  const saida = sanearParaRelatorio(forjado);
  const linhas = saida.split('\n');
  igual(linhas.length, 3, 'as três linhas continuam separadas');
  for (const l of linhas) {
    ok(l.startsWith('  '), `linha sem recuo imita a estrutura do arquivo: ${JSON.stringify(l)}`);
  }
  ok(!/^## /m.test(saida), 'nenhuma linha pode começar como cabeçalho de máquina');

  // \r escondia o texto anterior quando o .txt era lido com `cat`.
  const comCr = sanearParaRelatorio('apaga\rvisivel');
  ok(!comCr.includes('\r'), 'CR não pode chegar ao arquivo');
  ok(comCr.includes('apaga') && comCr.includes('visivel'),
    'as duas partes precisam ficar visíveis');

  // Demais controles viram marca visível, em vez de sumirem em silêncio.
  ok(sanearParaRelatorio('a\x1b[2Jb').includes('·'), 'ESC precisa virar marca visível');
  ok(!/[\x00-\x09\x0b-\x1f\x7f]/.test(sanearParaRelatorio('a\x00\x07\x7fb')),
    'nenhum controle sobrevive no relatório');

  // Comando comum sai igual, só recuado.
  igual(sanearParaRelatorio('systemctl status nginx'), '  systemctl status nginx',
    'comando normal só ganha o recuo');
  igual(sanearParaRelatorio('ls', '    '), '    ls', 'o recuo é configurável');
}

console.log(`\n${n} verificações passaram`);
