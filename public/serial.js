'use strict';

// Conexão serial (porta COM) — a LÓGICA PURA, sem DOM e sem Web Serial.
//
// A conexão de verdade acontece no renderer via `navigator.serial` (Web Serial,
// embutido no Chromium/Electron — zero módulo nativo, fiel à promessa do app de
// "funciona sem instalar nada"). Este arquivo é só o que dá para testar sem um
// dispositivo plugado: os parâmetros válidos (estilo Tera Term), a normalização
// da configuração, a transformação de fim de linha no envio e o rótulo legível
// de cada porta. Uso duplo (navegador via <script> e Node via require), como
// protocolos.js e horario.js.

// As opções que o Web Serial aceita — que são um subconjunto do Tera Term
// (sem paridade mark/space, sem 5/6 data bits, sem fluxo por software Xon/Xoff).
// Cobrir só o que o transporte entrega evita oferecer na tela algo que falha na
// hora de abrir a porta.
const BAUDS = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const DATA_BITS = [7, 8];
const PARIDADES = ['none', 'even', 'odd'];
const STOP_BITS = [1, 2];
const FLUXOS = ['none', 'hardware'];
// Fim de linha enviado quando a pessoa tecla Enter. Serial é cru: cada
// equipamento espera um terminador, e mandar o errado deixa o comando "sem
// efeito" sem nenhum erro. CR é o mais comum em equipamento de rede.
const FINS_DE_LINHA = ['cr', 'lf', 'crlf', 'none'];

// Rótulos legíveis para a tela (a chave é o valor técnico).
const ROTULO_PARIDADE = { none: 'Nenhuma', even: 'Par', odd: 'Ímpar' };
const ROTULO_FLUXO = { none: 'Nenhum', hardware: 'Hardware (RTS/CTS)' };
const ROTULO_FIM = { cr: 'CR', lf: 'LF', crlf: 'CR+LF', none: 'Nenhum' };

// Padrões do Tera Term: 9600 8-N-1, sem fluxo, CR no envio, sem eco local.
const PADRAO = {
  baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1,
  flowControl: 'none', fimDeLinha: 'cr', ecoLocal: false,
};

function umDe(lista, v, padrao) {
  return lista.includes(v) ? v : padrao;
}

// Recebe o que a tela mandou (strings, números) e devolve uma config válida —
// nunca lança: valor fora da lista cai no padrão, para a porta abrir com algo
// coerente em vez de estourar no `port.open`.
function normalizarConfig(bruto) {
  const b = bruto || {};
  return {
    baudRate: umDe(BAUDS, Number(b.baudRate), PADRAO.baudRate),
    dataBits: umDe(DATA_BITS, Number(b.dataBits), PADRAO.dataBits),
    parity: umDe(PARIDADES, String(b.parity), PADRAO.parity),
    stopBits: umDe(STOP_BITS, Number(b.stopBits), PADRAO.stopBits),
    flowControl: umDe(FLUXOS, String(b.flowControl), PADRAO.flowControl),
    fimDeLinha: umDe(FINS_DE_LINHA, String(b.fimDeLinha), PADRAO.fimDeLinha),
    ecoLocal: !!b.ecoLocal,
  };
}

// Só os campos que o `SerialPort.open()` do Web Serial entende — `fimDeLinha` e
// `ecoLocal` são do app, não do transporte, e passá-los ao open() seria erro.
function opcoesDeAbertura(cfg) {
  const c = normalizarConfig(cfg);
  return {
    baudRate: c.baudRate, dataBits: c.dataBits, parity: c.parity,
    stopBits: c.stopBits, flowControl: c.flowControl,
  };
}

// O que o xterm entrega em `onData` vira o que sai na porta. A única tradução é
// o Enter: o xterm manda '\r' (CR), e nós trocamos pelo fim de linha escolhido.
// Os outros caracteres (letras, backspace, setas) passam intactos.
const EOL = { cr: '\r', lf: '\n', crlf: '\r\n', none: '' };
function transformarEnvio(dado, fimDeLinha) {
  const eol = Object.prototype.hasOwnProperty.call(EOL, fimDeLinha) ? EOL[fimDeLinha] : '\r';
  // Troca cada CR (Enter) pelo terminador; um CRLF colado vira um terminador só.
  return String(dado).replace(/\r\n|\r/g, eol);
}

// Rótulo de uma porta, a partir do que o Electron entrega em `select-serial-port`
// (portName tipo COM3 ou /dev/tty.usbserial-XXXX, mais fabricante/descrição
// quando houver). É o "acesso fácil às portas COM" que o usuário pediu.
function rotuloDaPorta(p) {
  const nome = (p && (p.portName || p.displayName || p.path)) || 'porta serial';
  const extra = (p && (p.displayName && p.displayName !== nome ? p.displayName : p.manufacturer)) || '';
  return extra ? `${nome} — ${extra}` : nome;
}

// Resumo "9600 8-N-1" para a etiqueta da aba e o histórico.
function resumo(cfg) {
  const c = normalizarConfig(cfg);
  const par = c.parity === 'none' ? 'N' : c.parity === 'even' ? 'E' : 'O';
  return `${c.baudRate} ${c.dataBits}-${par}-${c.stopBits}`;
}

// Dica quando a enumeração volta VAZIA — por plataforma, porque a causa muda:
// no Linux o clássico é permissão (o usuário precisa estar no grupo dialout;
// sem isso a porta existe no /dev mas o Chromium nem lista), no Windows é
// driver, e no mac é encaixe/porta (visto ao vivo com o dock do Ygor).
function dicaSemPortas(plataforma) {
  const p = String(plataforma || '');
  if (/linux/i.test(p)) {
    return 'Conecte o adaptador e clique em Atualizar. No Linux, seu usuário precisa '
      + 'estar no grupo "dialout" (sudo usermod -a -G dialout $USER, e entre de novo '
      + 'na sessão) — sem isso a porta nem aparece na lista.';
  }
  if (/win/i.test(p)) {
    return 'Conecte o adaptador e clique em Atualizar. No Windows, se a porta COM não '
      + 'aparecer, confira no Gerenciador de Dispositivos se o driver do adaptador '
      + 'foi instalado (FTDI e CH340 costumam vir pelo Windows Update).';
  }
  return 'Conecte o cabo/adaptador e clique em Atualizar. Se não aparecer, tente '
    + 'outra porta USB — encaixe ruim é a causa mais comum.';
}

const API = {
  BAUDS, DATA_BITS, PARIDADES, STOP_BITS, FLUXOS, FINS_DE_LINHA,
  ROTULO_PARIDADE, ROTULO_FLUXO, ROTULO_FIM, PADRAO,
  normalizarConfig, opcoesDeAbertura, transformarEnvio, rotuloDaPorta, resumo,
  dicaSemPortas,
};

if (typeof window !== 'undefined') window.serialLib = API;
if (typeof module !== 'undefined' && module.exports) module.exports = API;
