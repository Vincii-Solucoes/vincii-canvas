'use strict';

// Conexão serial (porta COM) — a lógica pura e a ponte de escolha de porta.
//
// O I/O de verdade é Web Serial no renderer, com um dispositivo plugado, e não
// dá para testar aqui. O que ESTE arquivo trava é o que decide se a porta abre
// certa e se a escolha da porta funciona:
//
//   - a config nunca lança e cai no padrão Tera Term (9600 8-N-1) quando a tela
//     manda lixo — porta que abre com parâmetro inválido falha calada;
//   - só os campos que o Web Serial entende vão para o `open()`;
//   - o Enter vira o fim de linha ESCOLHIDO (mandar o errado deixa o comando
//     "sem efeito" no equipamento, sem erro);
//   - a ponte entrega a lista de portas para o dropdown e seleciona a escolhida
//     — e cancela em vez de mandar um id inventado ao Chromium.

const assert = require('assert');
const serial = require('../public/serial');
const ponte = require('../lib/serialbridge');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// ---------- 1. normalização: lixo cai no padrão, válido passa ----------

{
  const p = serial.normalizarConfig(undefined);
  igual(p.baudRate, 9600, 'sem nada, baud padrão Tera Term');
  igual([p.dataBits, p.parity, p.stopBits, p.flowControl], [8, 'none', 1, 'none'],
    '8-N-1 sem fluxo, o padrão clássico');
  igual([p.fimDeLinha, p.ecoLocal], ['cr', false], 'CR no envio, sem eco local');

  const bom = serial.normalizarConfig({ baudRate: '115200', dataBits: '7', parity: 'even', stopBits: '2', flowControl: 'hardware', fimDeLinha: 'crlf', ecoLocal: true });
  igual([bom.baudRate, bom.dataBits, bom.parity, bom.stopBits, bom.flowControl, bom.fimDeLinha, bom.ecoLocal],
    [115200, 7, 'even', 2, 'hardware', 'crlf', true], 'valores válidos (mesmo como string) passam');

  const lixo = serial.normalizarConfig({ baudRate: 7, dataBits: 99, parity: 'mark', stopBits: 5, flowControl: 'xonxoff', fimDeLinha: 'zzz' });
  igual([lixo.baudRate, lixo.dataBits, lixo.parity, lixo.stopBits, lixo.flowControl, lixo.fimDeLinha],
    [9600, 8, 'none', 1, 'none', 'cr'],
    'baud fora da lista, paridade mark e fluxo Xon/Xoff (que o Web Serial não tem) caem no padrão — '
    + 'nada disso pode chegar ao port.open e falhar calado');
}

// ---------- 2. só os campos do transporte vão para o open() ----------

{
  const o = serial.opcoesDeAbertura({ baudRate: 19200, fimDeLinha: 'lf', ecoLocal: true });
  igual(Object.keys(o).sort(), ['baudRate', 'dataBits', 'flowControl', 'parity', 'stopBits'],
    'fimDeLinha e ecoLocal são do APP, não do Web Serial — passá-los ao open() seria erro');
  igual(o.baudRate, 19200, 'com o que foi escolhido');
}

// ---------- 3. o Enter vira o fim de linha escolhido ----------

{
  igual(serial.transformarEnvio('\r', 'cr'), '\r', 'CR → CR');
  igual(serial.transformarEnvio('\r', 'lf'), '\n', 'CR → LF: o Enter do xterm (\\r) vira o LF pedido');
  igual(serial.transformarEnvio('\r', 'crlf'), '\r\n', 'CR → CR+LF');
  igual(serial.transformarEnvio('\r', 'none'), '', 'CR → nada: alguns equipamentos não querem terminador');
  igual(serial.transformarEnvio('ls -la', 'crlf'), 'ls -la', 'texto sem Enter passa intacto');
  igual(serial.transformarEnvio('a\rb\r', 'lf'), 'a\nb\n', 'cada Enter no meio também é traduzido');
  igual(serial.transformarEnvio('x\r\ny', 'lf'), 'x\ny', 'um CRLF colado vira UM terminador, não dois');
}

// ---------- 4. rótulo da porta: nome + descrição, o "acesso fácil" ----------

{
  igual(serial.rotuloDaPorta({ portName: 'COM3', displayName: 'USB Serial (COM3)' }),
    'COM3 — USB Serial (COM3)', 'Windows: COM3 com a descrição do driver');
  igual(serial.rotuloDaPorta({ portName: '/dev/tty.usbserial-1420', manufacturer: 'FTDI' }),
    '/dev/tty.usbserial-1420 — FTDI', 'mac/linux: caminho com o fabricante');
  igual(serial.rotuloDaPorta({ portName: 'COM1' }), 'COM1', 'sem descrição, só o nome');
  ok(serial.rotuloDaPorta({}).length > 0, 'porta sem dado nenhum ainda tem um rótulo, não vazio');
  igual(serial.resumo({ baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1 }), '115200 8-N-1',
    'o resumo para a aba/histórico');
}

// ---------- 5. a ponte de escolha de porta ----------

(async () => {
  ponte._reset();
  igual(ponte.disponivel(), false, 'sem Electron, a ponte não está disponível — a tela cai no seletor do navegador');
  ponte.marcarLigado();
  igual(ponte.disponivel(), true, 'sob Electron, disponível');

  const LISTA = [
    { portId: 'p1', portName: 'COM3', displayName: 'USB Serial' },
    { portId: 'p2', portName: 'COM4' },
  ];

  // ENUMERAR: o próximo select-serial-port entrega a lista e cancela a escolha.
  {
    ponte.definirModo('enumerar');
    const esperaLista = ponte.pendentes(1000);
    let escolhido = 'NAO-CHAMOU';
    ponte.aoSelecionar(LISTA, (id) => { escolhido = id; });
    const lista = await esperaLista;
    igual(lista.map((p) => p.portId), ['p1', 'p2'], 'a lista chega para o dropdown');
    igual(escolhido, '', 'e a escolha é CANCELADA (callback vazio) — só enumerou, não abriu');
  }

  // ABRIR: seleciona exatamente o id escolhido.
  {
    ponte.definirModo('abrir', 'p2');
    let escolhido = null;
    ponte.aoSelecionar(LISTA, (id) => { escolhido = id; });
    igual(escolhido, 'p2', 'no modo abrir, seleciona a porta pedida');
  }

  // ABRIR com id que não está na lista: cancela, não inventa.
  {
    ponte.definirModo('abrir', 'fantasma');
    let escolhido = null;
    ponte.aoSelecionar(LISTA, (id) => { escolhido = id; });
    igual(escolhido, '', 'id que não está na lista é recusado — nada de mandar id inventado ao Chromium');
  }

  // trocar de modo com um /api/serial/ports pendente RESOLVE ele — senão a
  // enumeração abandonada penduraria até o timeout (achado da revisão).
  {
    ponte._reset(); ponte.marcarLigado();
    ponte.definirModo('enumerar');
    ponte.aoSelecionar(LISTA, () => {}); // preenche ultimaLista, sem waiter ainda
    ponte.definirModo('enumerar');
    const espera = ponte.pendentes(3000);
    const t0 = Date.now();
    ponte.definirModo('abrir', 'p1'); // troca de modo: deve resolver o waiter na hora
    const lista = await espera;
    ok(Date.now() - t0 < 500, 'trocar de modo resolve o /api/serial/ports pendente SEM esperar o timeout');
    igual(lista.map((p) => p.portId), ['p1', 'p2'], 'e devolve a última lista conhecida');
  }

  // pendentes() sem evento: não pendura para sempre; devolve o que tiver.
  {
    ponte.definirModo('enumerar');
    const t0 = Date.now();
    const lista = await ponte.pendentes(150);
    ok(Date.now() - t0 >= 140, 'espera o teto e devolve — a requisição não fica pendurada se o evento nunca vier');
    ok(Array.isArray(lista), 'e devolve uma lista (a última conhecida), não trava');
  }

  console.log(`\n${n} verificações passaram`);
})().catch((e) => { console.error(e); process.exit(1); });
