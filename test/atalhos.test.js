'use strict';

// Copiar e colar no terminal, pelo TECLADO.
//
// A queixa que gerou isto (29/set/2026): "Ctrl+C e Ctrl+V não funcionam dentro
// da tela do terminal". E não funcionavam mesmo: o xterm não joga a seleção na
// textarea escondida, então o copiar nativo do Chromium pega uma seleção de DOM
// vazia e não copia nada — quem tem de tratar o atalho é o app.
//
// O que estes testes protegem é o acordo com o shell: Ctrl+C sem seleção
// PRECISA continuar sendo o SIGINT (é como se interrompe um comando). O 'colar'
// tem uma regra que mora em quem chama: nada de preventDefault, porque o
// Chromium também cola sozinho em alguns sistemas — a colagem própria só entra
// se nenhum evento `paste` aparecer (public/app.js, colarSeNinguemColou).

const assert = require('assert');
const { decidirAtalhoDeTerminal } = require('../public/atalhos.js');

let n = 0;
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

const tecla = (o) => Object.assign(
  { key: 'c', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }, o);
const win = (ev, temSelecao) => decidirAtalhoDeTerminal(ev, { ehMac: false, temSelecao });
const mac = (ev, temSelecao) => decidirAtalhoDeTerminal(ev, { ehMac: true, temSelecao });

// ---------- 1. Windows e Linux: o modificador é o Ctrl ----------

{
  igual(win(tecla({ ctrlKey: true }), true), 'copiar', 'Ctrl+C com seleção copia');
  igual(win(tecla({ ctrlKey: true }), false), null,
    'Ctrl+C SEM seleção não é tratado — tem de chegar ao shell como SIGINT');
  igual(win(tecla({ key: 'v', ctrlKey: true }), false), 'colar', 'Ctrl+V cola');
  igual(win(tecla({ key: 'C', ctrlKey: true, shiftKey: true }), true), 'copiar', 'Ctrl+Shift+C copia');
  igual(win(tecla({ key: 'V', ctrlKey: true, shiftKey: true }), false), 'colar', 'Ctrl+Shift+V cola');
  igual(win(tecla({ key: 'C', ctrlKey: true, shiftKey: true }), false), null,
    'Ctrl+Shift+C sem seleção não engole a tecla');
  igual(win(tecla({ key: 'Insert', ctrlKey: true }), true), 'copiar', 'Ctrl+Insert copia (clássico do Windows)');
  igual(win(tecla({ key: 'Insert', shiftKey: true }), false), 'colar', 'Shift+Insert cola');
}

// ---------- 2. macOS: o modificador é o Cmd, e o Ctrl+C é SEMPRE SIGINT ----------

{
  igual(mac(tecla({ metaKey: true }), true), 'copiar', 'Cmd+C com seleção copia');
  igual(mac(tecla({ metaKey: true }), false), null, 'Cmd+C sem seleção não faz nada');
  igual(mac(tecla({ ctrlKey: true }), true), null,
    'Ctrl+C no mac continua SIGINT mesmo com texto selecionado — lá quem copia é o Cmd');
  igual(mac(tecla({ key: 'v', metaKey: true }), false), 'colar', 'Cmd+V cola');
  igual(mac(tecla({ key: 'v', ctrlKey: true }), false), null,
    'Ctrl+V no mac NÃO é colar — é o ^V literal do readline');
  igual(mac(tecla({ key: 'C', ctrlKey: true, shiftKey: true }), true), 'copiar',
    'Ctrl+Shift+C também vale no mac (não conflita com nada)');
}

// ---------- 3. o que NÃO pode ser confundido com copiar/colar ----------

{
  igual(win(tecla({ key: 'a', ctrlKey: true }), true), null, 'Ctrl+A é do shell (início da linha, prefixo do tmux)');
  igual(win(tecla({ key: 'z', ctrlKey: true }), true), null, 'Ctrl+Z é do shell (suspende)');
  igual(win(tecla({ key: 'd', ctrlKey: true }), true), null, 'Ctrl+D é do shell (fim de arquivo)');
  igual(win(tecla({ ctrlKey: true, altKey: true }), true), null, 'Ctrl+Alt+C não é o atalho');
  igual(win(tecla({ ctrlKey: true, metaKey: true }), true), null, 'com a outra tecla junto, não');
  igual(mac(tecla({ metaKey: true, ctrlKey: true }), true), null, 'idem no mac');
  igual(win(tecla({}), true), null, 'a letra c sozinha é texto');
  igual(win(tecla({ key: 'Insert' }), true), null, 'Insert puro não é copiar nem colar');
  igual(decidirAtalhoDeTerminal(null, null), null, 'sem evento e sem opções, não decide nada');
  igual(decidirAtalhoDeTerminal(tecla({ ctrlKey: true }), undefined), null,
    'sem opções, trata como se não houvesse seleção (deixa o SIGINT passar)');
}

console.log(`\n${n} verificações passaram`);
