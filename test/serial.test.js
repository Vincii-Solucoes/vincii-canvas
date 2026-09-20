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

// ---------- 3b. o Backspace vira o que o equipamento entende (v1.76.0) ----------
//
// O xterm manda DEL (0x7f) na tecla Backspace. OLTs, switches e bootloaders
// costumam só apagar com BS (0x08, Ctrl+H) — e o Backspace "não funcionava"
// no console serial do Ygor. Padrão BS, como o BSKey do Tera Term.

{
  igual(serial.PADRAO.backspace, 'bs', 'padrão é BS (Ctrl+H), o do Tera Term — console serial é equipamento de rede');
  igual(serial.normalizarConfig({ backspace: 'del' }).backspace, 'del', 'DEL é aceito');
  igual(serial.normalizarConfig({ backspace: 'ctrl-h' }).backspace, 'bs', 'valor fora da lista cai no padrão');
  igual(serial.normalizarConfig({}).backspace, 'bs', 'sem o campo (config antiga guardada) → padrão');
  igual(serial.BACKSPACES, ['bs', 'del'], 'as duas escolhas, BS primeiro');
  ok(serial.ROTULO_BACKSPACE.bs && serial.ROTULO_BACKSPACE.del, 'cada escolha tem rótulo para a tela');

  const cc = (s) => Array.from(s).map((ch) => ch.charCodeAt(0));
  igual(cc(serial.transformarEnvio('\x7f', 'cr', 'bs')), [8], 'BS: o DEL do xterm vira 0x08');
  igual(cc(serial.transformarEnvio('\x7f', 'cr', 'del')), [127], 'DEL: passa como veio');
  igual(cc(serial.transformarEnvio('\x7f', 'cr')), [127], 'sem escolha (chamada antiga), não mexe — compatível');
  igual(cc(serial.transformarEnvio('ab\x7f\x7fc\r', 'crlf', 'bs')), [97, 98, 8, 8, 99, 13, 10], 'vários Backspaces numa colagem, mais o Enter traduzido');
  // Ctrl+Backspace (o xterm entrega 0x08) manda o OUTRO código, à moda do
  // PuTTY: é a saída de emergência de dentro da sessão quando a escolha estava
  // errada — sem isso, com BS escolhido nenhuma tecla mandaria DEL.
  igual(cc(serial.transformarEnvio('\b', 'cr', 'bs')), [127], 'BS escolhido: Ctrl+Backspace manda DEL');
  igual(cc(serial.transformarEnvio('\b', 'cr', 'del')), [8], 'DEL escolhido: Ctrl+Backspace manda BS');
  igual(cc(serial.transformarEnvio('\x7f\b\x7f', 'cr', 'bs')), [8, 127, 8], 'a troca é simultânea — o DEL virado BS não vira DEL de novo');
  igual(cc(serial.transformarEnvio('\b', 'cr')), [8], 'sem escolha (chamada antiga), 0x08 passa como veio');
  igual(serial.codigoOposto('bs'), 'del', 'o oposto de BS é DEL (para a tela dizer o que o Ctrl+Backspace manda)');
  igual(serial.codigoOposto('del'), 'bs', 'e vice-versa');
  igual(cc(serial.transformarEnvio('\x1b[A', 'cr', 'bs')), [27, 91, 65], 'setas passam intactas');
}

// ---------- 3c. eco local: o que a tela mostra quando o equipamento não ecoa ----------

{
  igual(serial.ecoLocal('a', 0), { texto: 'a', tamanho: 1 }, 'letra visível ecoa e conta');
  igual(serial.ecoLocal('çã', 1), { texto: 'çã', tamanho: 3 }, 'conta por caractere, não por byte');
  igual(serial.ecoLocal('\r', 5), { texto: '\r\n', tamanho: 0 }, 'Enter vira quebra de linha e zera a linha');
  igual(serial.ecoLocal('\x7f', 3), { texto: '\b \b', tamanho: 2 }, 'Backspace (DEL) apaga um caractere da linha digitada');
  igual(serial.ecoLocal('\b', 3), { texto: '\b \b', tamanho: 2 }, 'Ctrl+Backspace (BS) também');
  igual(serial.ecoLocal('\x7f', 0), { texto: '', tamanho: 0 }, 'linha vazia: Backspace NÃO apaga — comeria o prompt do equipamento');
  igual(serial.ecoLocal('\x1b[A', 2), { texto: '', tamanho: 2 }, 'seta fica muda (o xterm interpretaria e andaria o cursor)');
  igual(serial.ecoLocal('\t', 2), { texto: '', tamanho: 2 }, 'Tab também');
  igual(serial.ecoLocal('\x03', 4), { texto: '^C\r\n', tamanho: 0 }, 'Ctrl+C mostra ^C e abandona a linha');
  igual(serial.ecoLocal('x', undefined), { texto: 'x', tamanho: 1 }, 'tamanho ausente vale zero');
  igual(serial.ecoLocal('x', -3), { texto: 'x', tamanho: 1 }, 'tamanho negativo vale zero');
  // colagem: string inteira, tratada caractere a caractere
  igual(serial.ecoLocal('ab\rcd', 0), { texto: 'ab\r\ncd', tamanho: 2 }, 'colagem com Enter no meio: quebra a linha e conta só a última');
  igual(serial.ecoLocal('ab\r\ncd', 0), { texto: 'ab\r\ncd', tamanho: 2 }, 'CRLF colado é UM Enter');
  igual(serial.ecoLocal('ab\x7f\x7f\x7fc', 0), { texto: 'ab\b \b\b \bc', tamanho: 1 }, 'Backspaces numa colagem apagam só o que a colagem pôs');
  igual(serial.ecoLocal('a\tb', 0), { texto: 'ab', tamanho: 2 }, 'controle no meio da colagem é descartado, o resto ecoa');
  igual(serial.ecoLocal('\x1b[1;5C', 3), { texto: '', tamanho: 3 }, 'sequência de escape inteira é uma unidade — muda, sem vazar "[1;5C"');
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

// ---------- 5. dica por plataforma quando a lista vem vazia ----------

{
  const dLinux = serial.dicaSemPortas('Linux x86_64');
  ok(dLinux.includes('dialout'), 'Linux: a dica fala do grupo dialout — sem ele a porta nem lista');
  ok(dLinux.includes('usermod'), 'e dá o comando pronto');
  const dWin = serial.dicaSemPortas('Win32');
  ok(dWin.includes('Gerenciador de Dispositivos'), 'Windows: aponta o driver no Gerenciador');
  const dMac = serial.dicaSemPortas('MacIntel');
  ok(dMac.includes('outra porta USB'), 'mac: encaixe/porta — visto ao vivo no dock do Ygor');
  ok(serial.dicaSemPortas(undefined).length > 0, 'plataforma desconhecida ainda tem dica');
}

// ---------- 6. a ponte de escolha de porta ----------

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

  // ---------- 7. a última configuração serial é lembrada no servidor ----------
  //
  // Quem descobre que o equipamento quer Ctrl+H não deveria escolher de novo a
  // cada conexão: o formulário nasce com a última config (prefs.serial), que
  // viaja no XML de backup e volta pela importação — sempre normalizada.
  {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const http = require('http');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-serial-'));
    process.env.SSHC_DATA_DIR = dir;
    const pedir = (porta, metodo, caminho, corpo, bruto) => new Promise((resolve, reject) => {
      const dados = corpo === undefined ? null : JSON.stringify(corpo);
      const req = http.request({ host: '127.0.0.1', port: porta, method: metodo, path: caminho,
        headers: dados ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dados) } : {} },
      (res) => {
        let c = '';
        res.on('data', (d) => { c += d; });
        res.on('end', () => resolve({ status: res.statusCode, corpo: bruto ? c : (c ? JSON.parse(c) : null) }));
      });
      req.on('error', reject);
      if (dados) req.write(dados);
      req.end();
    });
    const { start } = require('../server');
    const server = await start();
    const porta = server.address().port;

    let r = await pedir(porta, 'PUT', '/api/prefs', { serial: { baudRate: 115200, fimDeLinha: 'crlf', backspace: 'del', ecoLocal: true, parity: 'mark', lixo: 1 } });
    igual(r.status, 200, 'PUT /api/prefs aceita a config serial');
    igual(r.corpo.serial, { baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none', fimDeLinha: 'crlf', backspace: 'del', ecoLocal: true },
      'guardada NORMALIZADA: paridade inválida caiu no padrão, campo estranho não entrou');
    r = await pedir(porta, 'PUT', '/api/prefs', { serial: 'texto' });
    igual(r.corpo.serial.backspace, 'del', 'serial que não é objeto é ignorada (a anterior fica)');
    r = await pedir(porta, 'PUT', '/api/prefs', { serial: { backspace: 'bs' } });
    igual([r.corpo.serial.backspace, r.corpo.serial.baudRate], ['bs', 9600], 'config nova substitui inteira (o formulário manda tudo)');

    const html = (await pedir(porta, 'GET', '/', undefined, true)).corpo;
    ok(/"serial":\{[^}]*"backspace":"bs"/.test(html), 'a config chega injetada no HTML (window.VC_PREFS) — o formulário nasce com ela');

    const xml = (await pedir(porta, 'POST', '/api/export.xml', {}, true)).corpo;
    ok(xml.includes('<serial baudRate="9600"') && xml.includes('backspace="bs"'), 'e viaja no XML de backup');

    r = await pedir(porta, 'POST', '/api/import', { hosts: [], prefs: { serial: { backspace: 'del', baudRate: '38400', stopBits: 9 } } });
    igual(r.status, 200, 'importação com prefs.serial passa');
    r = await pedir(porta, 'GET', '/api/prefs');
    igual([r.corpo.serial.backspace, r.corpo.serial.baudRate, r.corpo.serial.stopBits], ['del', 38400, 1], 'importar aplica a serial, normalizada');

    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${n} verificações passaram`);
})().catch((e) => { console.error(e); process.exit(1); });
