'use strict';

// Prepara um texto para ser COLADO num terminal.
//
// Colar é o mesmo que digitar: o que sai daqui vai para o shell como se tivesse
// vindo do teclado. Por isso a regra é lista de PERMISSÃO, não de bloqueio.
//
// O que já aconteceu de verdade, medido no app:
//   - valor com "\n" era entregue com o Enter e EXECUTAVA sozinho, sem sequer
//     entrar no histórico (colar não passa pelo onData do xterm)
//   - tirar só \r \n ESC e BEL não bastou: 30 bytes 0x7f transformaram
//     "echo IMPORTANTE" em "FORJADO" na tela, antes do Enter do usuário;
//     0x08 faz o mesmo e 0x15 apaga a linha inteira
//   - acima de ~2 KB o terminal simplesmente não ecoa nada, e colar pela metade
//     em silêncio é pior do que recusar
//
// Carregado dos dois lados: <script defer> no navegador e require() no Node.

// Acima disto o terminal não recebe de uma vez (medido).
const TETO_COLAGEM = 2000;

// Devolve { texto, mudou, excedeu }. Quem chama decide o que dizer ao usuário.
function sanearParaTerminal(entrada) {
  const original = String(entrada == null ? '' : entrada);
  // Quebra de linha vira ESPAÇO: apagá-la colaria as palavras
  // ("primeira" + "touch" = "primeiratouch").
  let texto = original.replace(/\r\n/g, ' ').replace(/[\n\r\u2028\u2029]/g, ' ');
  // Todo controle C0 e o DEL saem: são exatamente os que apagam, reescrevem ou
  // escondem o que está na linha antes de o usuário conferir.
  // eslint-disable-next-line no-control-regex
  texto = texto.replace(/[\x00-\x1f\x7f]/g, '');
  return {
    texto: texto.slice(0, TETO_COLAGEM),
    mudou: texto !== original,
    excedeu: texto.length > TETO_COLAGEM,
  };
}

// Prepara um texto para ser IMPRESSO num relatório de comandos.
//
// O relatório é um .txt que vira anexo de chamado. Um comando com quebra de
// linha colava as linhas seguintes na margem, indistinguíveis da estrutura do
// arquivo — dava para forjar um cabeçalho de máquina e atribuir um comando
// destrutivo a um servidor onde ele nunca rodou. E um "\r" no meio faz o `cat`
// mostrar só o que vem depois, escondendo o resto.
function sanearParaRelatorio(entrada, recuo) {
  const pad = recuo == null ? '  ' : recuo;
  const texto = String(entrada == null ? '' : entrada)
    // eslint-disable-next-line no-control-regex
    .replace(/\r\n/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '·');
  // TODA linha recebe o recuo — sem isso, só a primeira ficava indentada e as
  // demais imitavam a estrutura do documento.
  return texto.split('\n').map((l) => pad + l).join('\n');
}

if (typeof window !== 'undefined') {
  window.sanearParaTerminal = sanearParaTerminal;
  window.sanearParaRelatorio = sanearParaRelatorio;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sanearParaTerminal, sanearParaRelatorio, TETO_COLAGEM };
}
