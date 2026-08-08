'use strict';

// Um lugar só para "que protocolos existem" e "qual a porta padrão de cada um".
//
// Antes disso a lista estava copiada em 5 pontos e o mapa de portas em 7 —
// server.js, public/app.js e lib/. Foi exatamente essa duplicação que causou o
// pior defeito do backup: quando RDP e VNC entraram, o servidor foi atualizado
// e o parser de importação em public/app.js ficou com ['telnet','ftp']. Na
// restauração, todo host RDP voltava como SSH e todo host VNC era descartado
// por "não ter usuário". Duas cópias tinham esquecido o FTP também.
//
// Este arquivo é carregado dos DOIS lados: <script defer> no navegador (antes
// de app.js) e require() no Node. Por isso nada de DOM e nada de módulo ES —
// só dados e funções puras, com a exportação no fim protegida por guarda.

const PROTOCOLOS = {
  ssh:    { porta: 22,   rotulo: 'SSH' },
  telnet: { porta: 23,   rotulo: 'Telnet' },
  ftp:    { porta: 21,   rotulo: 'FTP' },
  vnc:    { porta: 5900, rotulo: 'VNC' },
  rdp:    { porta: 3389, rotulo: 'RDP' },
  // Página web (gerência de roteador, painel de serviço). A porta padrão é a do
  // https, mas quem manda é a URL guardada no host — ver public/weburl.js.
  web:    { porta: 443,  rotulo: 'Web' },
};

const PROTOCOLO_PADRAO = 'ssh';

// hasOwnProperty em vez de `in`: sem isso "constructor" e "toString" passariam
// por protocolos válidos, e um arquivo de importação escolhe essa string.
function ehProtocolo(p) {
  return typeof p === 'string' && Object.prototype.hasOwnProperty.call(PROTOCOLOS, p);
}

function normalizarProtocolo(p) {
  return ehProtocolo(p) ? p : PROTOCOLO_PADRAO;
}

function portaPadrao(p) {
  return PROTOCOLOS[normalizarProtocolo(p)].porta;
}

// Protocolos que abrem SESSÃO. O FTP fica de fora: é transferência de arquivo,
// não tem aba de terminal nem de área de trabalho — por isso a conexão rápida
// não o oferece.
const PROTOCOLOS_SESSAO = Object.keys(PROTOCOLOS).filter((p) => p !== 'ftp');

// Modos de criptografia do FTP. Lista ÚNICA: ela viveu copiada no servidor
// (duas vezes) e no <select> do formulário, e a cópia do servidor esqueceu
// 'confia' — que existe em lib/files.js. A opção aparecia na tela, era
// escolhida, e virava 'auto' na gravação.
const FTPS_MODOS = ['auto', 'yes', 'confia', 'no'];

// Protocolos que NÃO abrem terminal nem executam comando: só desenham algo numa
// aba. O agente autônomo e a execução em lote precisam recusá-los.
const SEM_TERMINAL = ['vnc', 'rdp', 'web'];

// Área de trabalho remota: os dois protocolos que desenham tela em vez de texto.
function ehTela(p) {
  return p === 'vnc' || p === 'rdp';
}

// Toda porta que é padrão de ALGUM protocolo. Serve para decidir se o campo de
// porta do formulário pode ser sobrescrito ao trocar o protocolo: se o usuário
// digitou uma porta própria, ela é preservada.
const PORTAS_PADRAO = Object.keys(PROTOCOLOS).map((p) => PROTOCOLOS[p].porta);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PROTOCOLOS, PROTOCOLO_PADRAO, PROTOCOLOS_SESSAO, FTPS_MODOS, PORTAS_PADRAO,
    SEM_TERMINAL, ehProtocolo, normalizarProtocolo, portaPadrao, ehTela,
  };
}
