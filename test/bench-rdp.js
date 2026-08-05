'use strict';

// Mede o custo do caminho quente do RDP legado: RC4, MAC e o enquadramento.
//
// Rode DENTRO do Electron, não no Node do sistema — é lá que o proxy roda, e a
// versão do V8 e do BoringSSL é outra:
//
//   npx electron test/bench-rdp.js
//
// A pergunta que isto responde é uma só: a criptografia em JavaScript aguenta o
// tráfego de uma sessão de área de trabalho sem travar o processo principal?
// Travar o processo principal não é lentidão de vídeo — é a janela inteira
// congelando, com os terminais SSH junto.

const cripto = require('../lib/rdp-cripto');
const q = require('../lib/rdp-quadros');

const MB = 1024 * 1024;

function medir(nome, bytesAlvo, fn) {
  const t0 = process.hrtime.bigint();
  const bytes = fn();
  const ns = Number(process.hrtime.bigint() - t0);
  const mbs = (bytes / MB) / (ns / 1e9);
  console.log(`  ${nome.padEnd(42)} ${(bytes / MB).toFixed(0).padStart(5)} MB em ${(ns / 1e6).toFixed(0).padStart(5)} ms  →  ${mbs.toFixed(0).padStart(5)} MB/s`);
  return mbs;
}

console.log(`\nAmbiente: ${process.versions.electron ? 'Electron ' + process.versions.electron : 'Node ' + process.versions.node}`
  + ` | V8 ${process.versions.v8}`);

// ---------- 1. as primitivas, isoladas ----------
console.log('\n1. Primitivas de criptografia');

const clientRandom = Buffer.alloc(32, 0x11);
const serverRandom = Buffer.alloc(32, 0x22);
const k = cripto.derivarChaves(clientRandom, serverRandom, cripto.METODO_128);

// Tamanho típico de um retângulo de tela comprimido, medido na sessão real:
// os 242 retângulos capturados do xrdp somaram 158 KB, média ~670 bytes, com
// picos de 6 KB. Medimos nos dois extremos.
for (const [rotulo, tam] of [['PDU pequeno (670 B, média real)', 670], ['PDU grande (6 KB, pico real)', 6144], ['bloco de 64 KB', 65536]]) {
  const dados = Buffer.alloc(tam, 0xa5);
  const s = cripto.criarSentido(k.chaveCifrar, k.macKey, cripto.METODO_128);
  const voltas = Math.max(1, Math.floor((64 * MB) / tam));
  medir(`RC4 — ${rotulo}`, voltas * tam, () => {
    for (let i = 0; i < voltas; i++) cripto.processar(s, dados);
    return voltas * tam;
  });
}

for (const [rotulo, tam] of [['PDU pequeno (670 B)', 670], ['PDU grande (6 KB)', 6144]]) {
  const dados = Buffer.alloc(tam, 0xa5);
  const voltas = Math.max(1, Math.floor((64 * MB) / tam));
  medir(`MAC (MD5+SHA1) — ${rotulo}`, voltas * tam, () => {
    for (let i = 0; i < voltas; i++) cripto.assinar(k.macKey, dados);
    return voltas * tam;
  });
}

// ---------- 2. o caminho completo de um PDU do servidor ----------
console.log('\n2. Caminho completo por PDU (decifra + MAC + reenquadra)');

function montarSendDataCifrado(sentidoServidor, carga) {
  const assinatura = cripto.assinar(k.macKey, carga);
  const cifrado = cripto.processar(sentidoServidor, carga);
  const cabecalho = q.cabecalhoNaoFips(q.SEC_ENCRYPT, assinatura);
  return q.montarSendData(1004, 1003, 0x70, Buffer.concat([cabecalho, cifrado]));
}

for (const [rotulo, tam] of [['670 B', 670], ['6 KB', 6144]]) {
  const carga = Buffer.alloc(tam, 0x5a);
  const cifrador = cripto.criarSentido(k.chaveCifrar, k.macKey, cripto.METODO_128);
  const decifrador = cripto.criarSentido(k.chaveCifrar, k.macKey, cripto.METODO_128);
  const voltas = Math.floor((32 * MB) / tam);

  // pré-monta para não medir a montagem
  const pdus = [];
  for (let i = 0; i < Math.min(voltas, 2000); i++) pdus.push(montarSendDataCifrado(cifrador, carga));

  let n = 0;
  medir(`PDU de ${rotulo}: decifra + confere MAC + remonta`, voltas * tam, () => {
    for (let i = 0; i < voltas; i++) {
      const pdu = pdus[i % pdus.length];
      const d = q.cargaSendData(pdu);
      const claro = cripto.processar(decifrador, d.carga.slice(12));
      cripto.assinar(k.macKey, claro);          // a verificação que o proxy faz
      q.remontarSendData(pdu, claro);
      n += 1;
    }
    return voltas * tam;
  });
  // o decifrador precisa recomeçar entre medições (fluxo RC4 tem estado)
}

// ---------- 3. o que isso significa em tela ----------
console.log('\n3. Tradução para carga real');

const s2 = cripto.criarSentido(k.chaveCifrar, k.macKey, cripto.METODO_128);
const bloco = Buffer.alloc(670, 0xa5);
const t0 = process.hrtime.bigint();
const VOLTAS = 100000;
for (let i = 0; i < VOLTAS; i++) { cripto.assinar(k.macKey, bloco); cripto.processar(s2, bloco); }
const nsPorPdu = Number(process.hrtime.bigint() - t0) / VOLTAS;
const mbsReal = (670 / MB) / (nsPorPdu / 1e9);

console.log(`  custo por PDU típico (670 B, cifra + MAC): ${(nsPorPdu / 1000).toFixed(1)} µs`);
console.log(`  vazão sustentada nesse tamanho: ${mbsReal.toFixed(0)} MB/s`);
console.log('');
// Referências: a sessão real do xrdp mandou 0,1 MB em 280 s (tela de login
// parada). Uma sessão ATIVA de 1080p em RDP costuma ficar entre 0,5 e 5 MB/s;
// vídeo em tela cheia pode chegar a 20 MB/s.
for (const [cenario, mbps] of [['tela de login parada (medido)', 0.0004], ['trabalho de escritório', 0.5], ['rolagem intensa', 5], ['vídeo em tela cheia', 20]]) {
  const pct = (mbps / mbsReal) * 100;
  const veredito = pct < 5 ? 'irrelevante' : pct < 25 ? 'confortável' : pct < 60 ? 'aperta' : 'GARGALO';
  console.log(`  ${cenario.padEnd(32)} ${String(mbps).padStart(6)} MB/s  →  ${pct.toFixed(1).padStart(5)}% de um núcleo  ${veredito}`);
}

// ---------- 4. o processo trava? ----------
console.log('\n4. Atraso do laço de eventos sob carga');
console.log('  (o que decide se a JANELA congela, não se o vídeo fica lento)');

function medirAtraso(ms) {
  return new Promise((resolve) => {
    const amostras = [];
    let ultimo = process.hrtime.bigint();
    const t = setInterval(() => {
      const agora = process.hrtime.bigint();
      amostras.push(Number(agora - ultimo) / 1e6 - 10); // esperado: 10 ms
      ultimo = agora;
    }, 10);
    setTimeout(() => {
      clearInterval(t);
      amostras.sort((a, b) => a - b);
      resolve({
        mediana: amostras[Math.floor(amostras.length / 2)],
        p95: amostras[Math.floor(amostras.length * 0.95)],
        pior: amostras[amostras.length - 1],
      });
    }, ms);
  });
}

(async () => {
  // A PRIMEIRA medição sempre traz um pico de dezenas de milissegundos que é
  // aquecimento do V8, não atraso real — medido: 68 ms na primeira, 1,3 ms nas
  // seguintes. Descartamos uma rodada antes de valer.
  await medirAtraso(800);
  const ocioso = await medirAtraso(1500);
  console.log(`  ocioso:              mediana ${ocioso.mediana.toFixed(2)} ms | p95 ${ocioso.p95.toFixed(2)} ms | pior ${ocioso.pior.toFixed(2)} ms`);

  // simula 5 MB/s (rolagem intensa) processando em rajadas, como o socket entrega
  const sentido = cripto.criarSentido(k.chaveCifrar, k.macKey, cripto.METODO_128);
  const rajada = Buffer.alloc(670, 0xa5);
  const pdusPorTick = Math.round((5 * MB) / 670 / 100); // 100 ticks por segundo
  const carga = setInterval(() => {
    for (let i = 0; i < pdusPorTick; i++) { cripto.assinar(k.macKey, rajada); cripto.processar(sentido, rajada); }
  }, 10);
  const sob = await medirAtraso(3000);
  clearInterval(carga);
  console.log(`  sob 5 MB/s:          mediana ${sob.mediana.toFixed(2)} ms | p95 ${sob.p95.toFixed(2)} ms | pior ${sob.pior.toFixed(2)} ms`);

  const sentido2 = cripto.criarSentido(k.chaveCifrar, k.macKey, cripto.METODO_128);
  const pdus20 = Math.round((20 * MB) / 670 / 100);
  const carga2 = setInterval(() => {
    for (let i = 0; i < pdus20; i++) { cripto.assinar(k.macKey, rajada); cripto.processar(sentido2, rajada); }
  }, 10);
  const sob20 = await medirAtraso(3000);
  clearInterval(carga2);
  console.log(`  sob 20 MB/s (vídeo): mediana ${sob20.mediana.toFixed(2)} ms | p95 ${sob20.p95.toFixed(2)} ms | pior ${sob20.pior.toFixed(2)} ms`);

  console.log('');
  const limite = 50; // acima disso o usuário PERCEBE a janela travando
  const veredito = sob20.p95 < limite ? 'o processo continua responsivo mesmo no pior caso'
    : sob.p95 < limite ? 'aguenta uso normal; vídeo em tela cheia trava a janela'
      : 'TRAVA a janela sob carga normal';
  console.log(`  Veredito: ${veredito}`);
  if (sob20.pior > 30) {
    console.log('  Nota: picos isolados sob carga extrema vêm da coleta de lixo —');
    console.log('        um Buffer novo por PDU. A mediana e o p95 é que valem.');
  }
  if (process.versions.electron) require('electron').app.exit(0);
})();
