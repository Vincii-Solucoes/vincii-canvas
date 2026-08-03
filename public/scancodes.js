// Tradução de KeyboardEvent.code para scancode PS/2 Set 1, que é o que o RDP
// transporta (MS-RDPBCGR 2.2.8.1.1.3.1.1.1).
//
// O IronRDP recebe o scancode como um u16 onde as teclas estendidas trazem o
// prefixo 0xE000 — em ironrdp-input: `extended = scancode & 0xE000 == 0xE000`.
//
// Usamos `code` (posição física da tecla) e não `key`: o servidor aplica o
// layout dele em cima do scancode. Mandar a posição é o certo — quem decide
// que a tecla ao lado do L é "ç" é o layout configurado no Windows.

const NORMAIS = {
  Escape: 0x01,
  Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06,
  Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b,
  Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14,
  KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
  BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d,
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22,
  KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26,
  Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b,
  KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32,
  Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36,
  NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a,
  F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f,
  F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
  Pause: 0x45, ScrollLock: 0x46,
  Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a,
  Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e,
  Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53,
  IntlBackslash: 0x56, F11: 0x57, F12: 0x58,
  // ABNT2 (teclado brasileiro): a tecla do "/" ao lado do shift direito e o
  // ponto do teclado numérico têm scancodes próprios.
  IntlRo: 0x73, NumpadComma: 0x7e,
  // teclados japoneses, de brinde — custam duas linhas
  KanaMode: 0x70, Convert: 0x79, NonConvert: 0x7b, IntlYen: 0x7d,
  F13: 0x64, F14: 0x65, F15: 0x66, F16: 0x67, F17: 0x68,
  F18: 0x69, F19: 0x6a, F20: 0x6b, F21: 0x6c, F22: 0x6d, F23: 0x6e,
};

// Precisam do prefixo 0xE0: são as gêmeas das teclas acima, à direita do
// teclado, mais o bloco de navegação e as teclas de sistema.
const ESTENDIDAS = {
  NumpadEnter: 0x1c, ControlRight: 0x1d, NumpadDivide: 0x35, AltRight: 0x38,
  NumLock: 0x45, Home: 0x47, ArrowUp: 0x48, PageUp: 0x49,
  ArrowLeft: 0x4b, ArrowRight: 0x4d, End: 0x4f, ArrowDown: 0x50,
  PageDown: 0x51, Insert: 0x52, Delete: 0x53,
  MetaLeft: 0x5b, MetaRight: 0x5c, ContextMenu: 0x5d,
  PrintScreen: 0x37,
  BrowserBack: 0x6a, BrowserForward: 0x69, BrowserRefresh: 0x67,
  AudioVolumeMute: 0x20, AudioVolumeDown: 0x2e, AudioVolumeUp: 0x30,
};

export function scancodeDe(code) {
  if (Object.prototype.hasOwnProperty.call(NORMAIS, code)) return NORMAIS[code];
  if (Object.prototype.hasOwnProperty.call(ESTENDIDAS, code)) return 0xe000 | ESTENDIDAS[code];
  return null; // tecla desconhecida: melhor ignorar do que mandar lixo
}

export const TOTAL_TECLAS = Object.keys(NORMAIS).length + Object.keys(ESTENDIDAS).length;
