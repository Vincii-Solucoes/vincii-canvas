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
//
// TUDO dentro de um IIFE, como subnet.js, senha.js, diff.js e janela.js: como
// script clássico, um `const` no topo divide o escopo global com os outros
// arquivos de public/ — e este era o ÚLTIMO que ainda declarava `API` lá fora.
(function () {

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
// O que a tecla Backspace manda. O xterm emite DEL (0x7f), que é o que Linux e
// SSH esperam — mas boa parte dos consoles seriais (OLT ZTE/Fiberhome, muitos
// switches, bootloaders) só apaga com BS (0x08, o Ctrl+H). Mandar o errado não
// dá erro: a tecla "não faz nada" ou imprime ^?. É o BSKey do Tera Term, cujo
// padrão é BS — e aqui também, porque console serial é quase sempre
// equipamento de rede, não um shell Linux (que, com readline, aceita os dois).
const BACKSPACES = ['bs', 'del'];

// Rótulos legíveis para a tela (a chave é o valor técnico).
const ROTULO_PARIDADE = { none: 'Nenhuma', even: 'Par', odd: 'Ímpar' };
const ROTULO_FLUXO = { none: 'Nenhum', hardware: 'Hardware (RTS/CTS)' };
const ROTULO_FIM = { cr: 'CR', lf: 'LF', crlf: 'CR+LF', none: 'Nenhum' };
const ROTULO_BACKSPACE = { bs: 'Ctrl+H (BS, 0x08)', del: 'DEL (0x7f)' };

// Padrões do Tera Term: 9600 8-N-1, sem fluxo, CR no envio, Backspace = BS,
// sem eco local.
const PADRAO = {
  baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1,
  flowControl: 'none', fimDeLinha: 'cr', backspace: 'bs', ecoLocal: false,
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
    backspace: umDe(BACKSPACES, String(b.backspace), PADRAO.backspace),
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

// O que o xterm entrega em `onData` vira o que sai na porta. Duas traduções:
// o Enter — o xterm manda '\r' (CR), e nós trocamos pelo fim de linha
// escolhido — e o Backspace — o xterm manda DEL (0x7f) e, se a escolha for BS,
// vai 0x08. Ctrl+Backspace (que o xterm entrega como 0x08) manda sempre o
// OUTRO código, à moda do PuTTY: é a saída de emergência de dentro da sessão
// quando a escolha estava errada, sem reconectar. Os outros caracteres
// (letras, setas, Ctrl+C) passam intactos.
const EOL = { cr: '\r', lf: '\n', crlf: '\r\n', none: '' };
function transformarEnvio(dado, fimDeLinha, backspace) {
  const eol = Object.prototype.hasOwnProperty.call(EOL, fimDeLinha) ? EOL[fimDeLinha] : '\r';
  // Troca cada CR (Enter) pelo terminador; um CRLF colado vira um terminador só.
  let s = String(dado).replace(/\r\n|\r/g, eol);
  // Troca simultânea (um replace só), senão o DEL virado BS viraria DEL de novo.
  if (backspace === 'bs') s = s.replace(/[\x7f\b]/g, (c) => (c === '\x7f' ? '\b' : '\x7f'));
  return s;
}

// O código que o Ctrl+Backspace manda, para a tela dizer.
function codigoOposto(backspace) { return backspace === 'bs' ? 'del' : 'bs'; }

// Eco local: o que o xterm deve MOSTRAR quando a pessoa digita e o equipamento
// não ecoa. Devolve { texto, tamanho }: o que escrever na tela e quantos
// caracteres a linha digitada passa a ter.
//
// Ecoar o byte cru fazia o Backspace não apagar (o xterm recebe DEL e não faz
// nada) e as setas (ESC[A…) andarem o cursor — o xterm INTERPRETA sequências
// de controle. Então: visível ecoa; Enter vira quebra de linha e zera a
// contagem; Backspace apaga UM caractere (\b + espaço + \b) só se há algo
// digitado — senão comeria o prompt do equipamento; Ctrl+C zera a linha (o
// equipamento a abandona); o resto dos controles (setas, Tab, ESC) fica mudo.
//
// Uma colagem chega como string inteira ("abc\rdef"): é tratada caractere a
// caractere, para o Enter do meio quebrar a linha e a contagem ficar certa.
// Só uma sequência de escape (setas, F1…, começa com ESC) é uma unidade — muda.
function ecoLocal(dado, tamanho) {
  const d = String(dado);
  let t = Number.isFinite(tamanho) && tamanho > 0 ? Math.floor(tamanho) : 0;
  if (d.startsWith('\x1b')) return { texto: '', tamanho: t };
  let texto = '';
  const chars = Array.from(d.replace(/\r\n/g, '\r'));
  for (const c of chars) {
    if (c === '\r' || c === '\n') { texto += '\r\n'; t = 0; continue; }
    if (c === '\x7f' || c === '\b') { if (t > 0) { texto += '\b \b'; t -= 1; } continue; }
    if (c === '\x03') { texto += '^C\r\n'; t = 0; continue; }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(c)) continue;
    texto += c; t += 1;
  }
  return { texto, tamanho: t };
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
  BAUDS, DATA_BITS, PARIDADES, STOP_BITS, FLUXOS, FINS_DE_LINHA, BACKSPACES,
  ROTULO_PARIDADE, ROTULO_FLUXO, ROTULO_FIM, ROTULO_BACKSPACE, PADRAO,
  normalizarConfig, opcoesDeAbertura, transformarEnvio, codigoOposto, ecoLocal, rotuloDaPorta, resumo,
  dicaSemPortas,
};

if (typeof window !== 'undefined') window.serialLib = API;
if (typeof module !== 'undefined' && module.exports) module.exports = API;

})();
