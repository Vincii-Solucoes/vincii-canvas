'use strict';

// Que atalho de teclado o TERMINAL deve tratar como copiar/colar — a parte
// pura, sem DOM e sem xterm, para dar para testar os dois sistemas sem ter as
// duas máquinas.
//
// Por que isto existe: o xterm não copia sozinho. Ele não joga a seleção na
// textarea escondida (só faz isso no gesto do X11), então o "copiar" nativo do
// Chromium pega uma seleção de DOM vazia e não copia nada — foi a queixa que
// chegou ("Ctrl+C e Ctrl+V não funcionam no terminal").
//
// As regras seguem o que os terminais fazem:
//   - Ctrl+C só copia QUANDO HÁ SELEÇÃO. Sem seleção ele continua sendo o
//     SIGINT, que é o motivo de a tecla existir num terminal (mesmo acordo do
//     Windows Terminal). No macOS quem copia é o Cmd+C, e o Ctrl+C é SEMPRE
//     SIGINT.
//   - Ctrl+Shift+C / Ctrl+Shift+V: convenção do GNOME Terminal, vale em todos.
//   - Ctrl+Insert / Shift+Insert: o par clássico do Windows.
//   - Ctrl+V / Cmd+V devolve 'colar', com uma regra de ouro para quem chama:
//     NÃO chamar preventDefault nessa tecla. O Chromium também cola sozinho
//     (dispara o evento `paste`, que o xterm entrega ao shell) — mas isso não
//     acontece em todo lugar. Então quem chama deixa a colagem nativa seguir e
//     só cola por conta própria se nenhum evento `paste` aparecer: funciona
//     onde o nativo funciona e onde não funciona, sem colar duas vezes.
//     Devolver false no handler já impede o ^V (0x16) de chegar ao shell — o
//     xterm sai ANTES de qualquer preventDefault (conferido no código dele).
(function () {

function decidirAtalhoDeTerminal(ev, opcoes) {
  const e = ev || {};
  const o = opcoes || {};
  const ehMac = !!o.ehMac;
  const temSelecao = !!o.temSelecao;
  const k = String(e.key || '').toLowerCase();

  // Ctrl+Shift+C/V — o par do GNOME Terminal (não conflita com nada do shell).
  if (e.ctrlKey && e.shiftKey && !e.altKey && k === 'c') return temSelecao ? 'copiar' : null;
  if (e.ctrlKey && e.shiftKey && !e.altKey && k === 'v') return 'colar';

  // Insert — o par clássico do Windows.
  if (k === 'insert' && e.ctrlKey && !e.shiftKey && !e.altKey) return temSelecao ? 'copiar' : null;
  if (k === 'insert' && e.shiftKey && !e.ctrlKey && !e.altKey) return 'colar';

  // O modificador do sistema: Cmd no mac, Ctrl no resto.
  const mod = ehMac ? !!e.metaKey : !!e.ctrlKey;
  const outroMod = ehMac ? !!e.ctrlKey : !!e.metaKey;
  if (mod && !outroMod && !e.altKey && !e.shiftKey && k === 'c') {
    return temSelecao ? 'copiar' : null; // sem seleção: SIGINT segue o seu caminho
  }
  if (mod && !outroMod && !e.altKey && !e.shiftKey && k === 'v') return 'colar';
  return null;
}

const API = { decidirAtalhoDeTerminal };
if (typeof window !== 'undefined') window.atalhosLib = API;
if (typeof module !== 'undefined' && module.exports) module.exports = API;

})();
