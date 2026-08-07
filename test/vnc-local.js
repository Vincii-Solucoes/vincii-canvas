'use strict';

// Servidor VNC (RFB 3.8) para testar o caminho de área de trabalho do app sem
// depender de máquina externa, Docker ou do Compartilhamento de Tela do macOS.
//
//   node test/vnc-local.js
//
// Sobe três portas, cada uma exercitando um caminho diferente:
//   5901  sem autenticação (security type None)
//   5902  com autenticação — aceita qualquer resposta ao desafio
//   5903  com autenticação — RECUSA sempre (para ver a mensagem de erro do app)
//
// Não valida o DES da resposta ao desafio: o DES saiu do provider padrão do
// OpenSSL 3, e implementá-lo aqui testaria a implementação DESTE arquivo, não a
// do app. O que interessa é provar que a senha chega ao fio — e isso o servidor
// mostra, registrando se a resposta veio preenchida e comparando entre senhas.

const net = require('net');

const LARGURA = 640;
const ALTURA = 480;
const NOME = 'Vincii VNC de teste';

// Faixas coloridas com um quadrado branco no meio: dá para conferir a
// fidelidade de cor canal por canal, não só "apareceu alguma coisa".
const CORES = [
  [0, 201, 177], [23, 33, 43], [207, 34, 46],
  [26, 127, 55], [154, 103, 0], [255, 255, 255],
];

// O cliente escolhe o formato de pixel; ignorar isso troca R por B e faz
// parecer bug do app quando é do servidor de teste. Já aconteceu aqui.
function quadro(fmt) {
  const px = Buffer.alloc(LARGURA * ALTURA * 4);
  for (let y = 0; y < ALTURA; y++) {
    const faixa = CORES[Math.floor(y / (ALTURA / CORES.length)) % CORES.length];
    for (let x = 0; x < LARGURA; x++) {
      const dentro = x > LARGURA / 3 && x < (LARGURA * 2) / 3
        && y > ALTURA / 3 && y < (ALTURA * 2) / 3;
      const c = dentro ? [255, 255, 255] : faixa;
      const v = ((c[0] & 0xff) << fmt.rs) | ((c[1] & 0xff) << fmt.gs) | ((c[2] & 0xff) << fmt.bs);
      const i = (y * LARGURA + x) * 4;
      if (fmt.bigEndian) px.writeUInt32BE(v >>> 0, i); else px.writeUInt32LE(v >>> 0, i);
    }
  }
  return px;
}

function serverInit() {
  const nome = Buffer.from(NOME, 'utf8');
  const b = Buffer.alloc(24 + nome.length);
  b.writeUInt16BE(LARGURA, 0);
  b.writeUInt16BE(ALTURA, 2);
  b[4] = 32; b[5] = 24; b[6] = 0; b[7] = 1;              // bpp, depth, LE, true-color
  b.writeUInt16BE(255, 8); b.writeUInt16BE(255, 10); b.writeUInt16BE(255, 12);
  b[14] = 16; b[15] = 8; b[16] = 0;                      // shifts R, G, B
  b.writeUInt32BE(nome.length, 20);
  nome.copy(b, 24);
  return b;
}

function atualizacao(fmt) {
  const cab = Buffer.alloc(16);
  cab.writeUInt16BE(1, 2);                               // 1 retângulo
  cab.writeUInt16BE(LARGURA, 8); cab.writeUInt16BE(ALTURA, 10);
  cab.writeInt32BE(0, 12);                               // encoding RAW
  return Buffer.concat([cab, quadro(fmt)]);
}

function servir(porta, { autenticar, aceitar }) {
  net.createServer((sock) => {
    sock.on('error', () => {});
    let fase = 'versao';
    let buf = Buffer.alloc(0);
    let quadros = 0;
    const fmt = { rs: 16, gs: 8, bs: 0, bigEndian: false };
    const log = (...a) => console.log(`[${porta}]`, ...a);
    log('conexão');
    sock.write('RFB 003.008\n');

    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (fase === 'versao') {
          if (buf.length < 12) return;
          buf = buf.slice(12);
          sock.write(Buffer.from([1, autenticar ? 2 : 1]));
          fase = 'escolha';
          continue;
        }
        if (fase === 'escolha') {
          if (buf.length < 1) return;
          const tipo = buf[0]; buf = buf.slice(1);
          log(`security type escolhido: ${tipo}`);
          if (tipo === 2) { sock.write(Buffer.alloc(16, 0x42)); fase = 'resposta'; }
          else { sock.write(Buffer.from([0, 0, 0, 0])); fase = 'clientinit'; }
          continue;
        }
        if (fase === 'resposta') {
          if (buf.length < 16) return;
          const resp = buf.slice(0, 16); buf = buf.slice(16);
          const zerada = resp.every((x) => x === 0);
          log(`resposta ao desafio: ${resp.toString('hex').slice(0, 24)}…`
            + ` ${zerada ? '(ZERADA — a senha não chegou)' : '(preenchida)'}`);
          if (!aceitar) {
            const r = Buffer.alloc(4); r.writeUInt32BE(1, 0);
            const m = Buffer.from('Senha recusada pelo servidor de teste');
            const t = Buffer.alloc(4); t.writeUInt32BE(m.length, 0);
            sock.write(Buffer.concat([r, t, m]));
            log('RECUSOU a autenticação');
            return sock.end();
          }
          sock.write(Buffer.from([0, 0, 0, 0]));
          fase = 'clientinit';
          continue;
        }
        if (fase === 'clientinit') {
          if (buf.length < 1) return;
          buf = buf.slice(1);
          sock.write(serverInit());
          log(`ServerInit enviado (${LARGURA}x${ALTURA})`);
          fase = 'mensagens';
          continue;
        }
        if (buf.length < 1) return;
        const tipo = buf[0];
        if (tipo === 0) {                                // SetPixelFormat
          if (buf.length < 20) return;
          fmt.bigEndian = buf[6] !== 0;
          fmt.rs = buf[14]; fmt.gs = buf[15]; fmt.bs = buf[16];
          log(`SetPixelFormat: shifts R${fmt.rs} G${fmt.gs} B${fmt.bs}`);
          buf = buf.slice(20);
          continue;
        }
        if (tipo === 2) {                                // SetEncodings
          if (buf.length < 4) return;
          const n = buf.readUInt16BE(2);
          if (buf.length < 4 + n * 4) return;
          buf = buf.slice(4 + n * 4);
          continue;
        }
        if (tipo === 6) {                                // ClientCutText
          if (buf.length < 8) return;
          const n = buf.readUInt32BE(4);
          if (buf.length < 8 + n) return;
          // Registra o texto: é assim que se confere se "colar variável" chegou
          // mesmo à área de transferência da máquina remota.
          log(`ClientCutText recebido (${n} bytes): ${JSON.stringify(buf.slice(8, 8 + n).toString('latin1'))}`);
          buf = buf.slice(8 + n);
          continue;
        }
        const tam = { 3: 10, 4: 8, 5: 6 }[tipo];
        if (tam == null) { log(`mensagem ${tipo} desconhecida, descartando`); buf = Buffer.alloc(0); return; }
        if (buf.length < tam) return;
        buf = buf.slice(tam);
        if (tipo === 3) {                                // FramebufferUpdateRequest
          sock.write(atualizacao(fmt));
          quadros += 1;
          if (quadros <= 2) log(`FramebufferUpdate #${quadros} enviado`);
        }
      }
    });
  }).listen(porta, '127.0.0.1', () => {
    console.log(`${porta}: ${autenticar ? (aceitar ? 'com senha (aceita)' : 'com senha (RECUSA)') : 'sem autenticação'}`);
  });
}

servir(5901, { autenticar: false });
servir(5902, { autenticar: true, aceitar: true });
servir(5903, { autenticar: true, aceitar: false });
