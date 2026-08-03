'use strict';

// Tradutor de RDP Standard Security.
//
// O cliente (IronRDP em WebAssembly) só fala Enhanced Security e acredita estar
// numa sessão SEM criptografia própria — o TLS faria esse papel. O servidor
// legado exige RC4 em tudo. Este módulo fica no meio e conserta os dois lados.
//
// A assimetria que organiza o código: o cliente acha que criptografia é
// problema da camada de baixo, então manda PDUs nus e não entende Security
// Header. O servidor exige Security Header com assinatura em todo PDU. Logo:
//
//   cliente → servidor : ADICIONA cabeçalho, assina e cifra
//   servidor → cliente : decifra, confere nada, REMOVE cabeçalho
//
// A exceção são os PDUs que carregam cabeçalho básico mesmo sem criptografia
// (Client Info e licenciamento): nesses o cabeçalho de 4 bytes é preservado,
// só as flags e a assinatura mudam.
//
// AVISO: nada aqui autentica o servidor. O certificado do RDP legado é
// assinado com uma chave privada publicada na própria especificação.

const cripto = require('./rdp-cripto');
const mcs = require('./rdp-mcs');
const q = require('./rdp-quadros');

// Canal de I/O padrão do MCS. Só é usado se não conseguirmos observar o canal
// real na conexão — o que não deve acontecer, porque injetamos o Security
// Exchange reaproveitando o canal do próprio Client Info.
const CANAL_IO_PADRAO = 1003;

// Permite desligar o contorno para comparar lado a lado.
const SEM_ALINHAR = process.env.VC_RDP_SEM_ALINHAR === '1';

function criarTradutor({ log = () => {} } = {}) {
  const st = {
    fase: 'inicio',        // inicio → negociado → cifrado
    metodo: 0,
    nivel: 0,
    serverRandom: null,
    chavePublica: null,
    clientRandom: null,
    envio: null,           // sentido cliente → servidor
    recepcao: null,        // sentido servidor → cliente
    trocaFeita: false,
    // O licenciamento é a única fase em que o cliente inclui cabeçalho de
    // segurança por conta própria. Sai dela no primeiro PDU do servidor que
    // não é de licença — na prática o Demand Active.
    licenciando: false,
    // Contadores para o teste de longa duração: sem número, "funcionou" não
    // quer dizer nada.
    m: {
      pdusCliente: 0, pdusServidor: 0,
      bytesCliente: 0, bytesServidor: 0,
      fastServidor: 0, fastCliente: 0,
      nsCripto: 0n,
      renovacoesEnvio: 0, renovacoesRecepcao: 0,
    },
  };

  // Cronometra a criptografia e detecta a renovação de chave: `processar` zera
  // o contador de pacotes quando renova, então voltar a zero com total > 0 é a
  // assinatura de que a chave girou.
  function cronometrar(sentido, dados, qual) {
    const t0 = process.hrtime.bigint();
    const r = cripto.processar(sentido, dados);
    st.m.nsCripto += process.hrtime.bigint() - t0;
    if (sentido.pacotes === 0 && sentido.total > 0) {
      st.m[qual] += 1;
      log(`chave renovada (${qual === 'renovacoesEnvio' ? 'envio' : 'recepção'}) no pacote ${sentido.total}`);
    }
    return r;
  }

  // ---------- Security Exchange (§2.2.1.10.1) ----------
  function montarSecurityExchange(initiator, canal, prioridade) {
    const cifrado = mcs.cifrarClientRandom(st.clientRandom, st.chavePublica);
    // O campo `length` conta o random cifrado MAIS os 8 bytes de enchimento
    // que a spec exige depois dele.
    const dados = Buffer.alloc(8 + cifrado.length + 8);
    dados.writeUInt16LE(q.SEC_EXCHANGE_PKT, 0);
    dados.writeUInt16LE(0, 2);
    dados.writeUInt32LE(cifrado.length + 8, 4);
    cifrado.copy(dados, 8);
    return q.montarSendData(initiator, canal, prioridade, dados);
  }

  function derivarChaves() {
    const k = cripto.derivarChaves(st.clientRandom, st.serverRandom, st.metodo);
    st.envio = cripto.criarSentido(k.chaveCifrar, k.macKey, st.metodo);
    st.recepcao = cripto.criarSentido(k.chaveDecifrar, k.macKey, st.metodo);
    log(`chaves derivadas (método 0x${st.metodo.toString(16)}, nível ${st.nivel})`);
  }

  // Confere a assinatura que o servidor mandou contra a que calculamos sobre o
  // texto decifrado. Só conta divergências: derrubar a sessão por causa disso
  // seria pior que renderizar imperfeito, mas o número precisa aparecer.
  let macsOk = 0, macsRuins = 0, amostrasFast = 0;
  const contagem = {}, bytesPorCodigo = {};
  const slow = {}, slowBytes = {};

  // Share Control Header: totalLength(2) pduType(2) pduSource(2). pduType 0x17
  // com o low nibble 7 = PDUTYPE_DATAPDU. Depois vem o Share Data Header, cujo
  // pduType2 diz o que é; 2 = PDUTYPE2_UPDATE, e aí o updateType de 2 bytes.
  function contarSlowPath(c) {
    if (c.length < 6) return;
    const pduType = c.readUInt16LE(2) & 0x0f;
    if (pduType !== 7) { const k = `controle:0x${pduType.toString(16)}`; slow[k]=(slow[k]||0)+1; slowBytes[k]=(slowBytes[k]||0)+c.length; return; }
    // Share Data Header: shareId(4) pad1(1) streamId(1) uncompressedLength(2)
    // pduType2(1) compressedType(1) compressedLength(2) — pduType2 no byte 14,
    // contando do início do Share Control Header.
    if (c.length < 18) return;
    const pduType2 = c[14];
    if (pduType2 !== 2) { const k = `dados:${pduType2}`; slow[k]=(slow[k]||0)+1; slowBytes[k]=(slowBytes[k]||0)+c.length; return; }
    const upd = c.length >= 20 ? c.readUInt16LE(18) : -1;
    // §2.2.9.1.1.3.1: 0=ORDERS, 1=BITMAP, 2=PALETTE, 3=SYNCHRONIZE
    const nomes = { 0: 'ORDERS', 1: 'BITMAP', 2: 'PALETTE', 3: 'SYNCHRONIZE' };
    const k = `update:${nomes[upd] || upd}`;
    slow[k]=(slow[k]||0)+1; slowBytes[k]=(slowBytes[k]||0)+c.length;
    if (process.env.VC_RDP_DUMP && upd === 1) {
      // grava o Bitmap Update inteiro: precisa dele completo para analisar
      try { require('fs').appendFileSync(process.env.VC_RDP_DUMP + '.bmp',
        c.slice(18).toString('hex') + '\n'); } catch {}
    }
  }
  function conferirMac(recebida, claro, onde, salgado) {
    const esperada = salgado
      ? cripto.assinarSalgado(st.recepcao.macKey, claro, st.recepcao.total - 1)
      : cripto.assinar(st.recepcao.macKey, claro);
    if (esperada.equals(recebida)) { macsOk += 1; return true; }
    macsRuins += 1;
    if (macsRuins <= 5) {
      log(`MAC divergente em ${onde} (#${macsRuins}, salgado=${!!salgado})`
        + ` esperado ${esperada.toString('hex')} recebido ${recebida.toString('hex')}`);
    }
    return false;
  }

  // O Confirm Active carrega as capacidades REAIS do cliente. O
  // bitmapCompressionFlag é o que decide se o servidor comprime a tela; zerá-lo
  // faz ele mandar bitmap cru, o que tira o decodificador do cliente da
  // equação. Serve como diagnóstico e, se o custo de banda couber, como
  // conserto.
  let viuConfirm = false;
  let telaLargura = 0;
  function tratarConfirmActive(c) {
    if (viuConfirm || c.length < 24) return;
    if ((c.readUInt16LE(2) & 0x0f) !== 3) return; // PDUTYPE_CONFIRMACTIVEPDU
    viuConfirm = true;
    // §2.2.1.13.2.1: shareControlHeader(6) shareId(4) originatorId(2)
    // lengthSourceDescriptor(2) lengthCombinedCapabilities(2) sourceDescriptor(n)
    const tamFonte = c.readUInt16LE(12);
    let off = 16 + tamFonte;
    if (off + 4 > c.length) { log('Confirm Active: cabeçalho curto'); return; }
    const n = c.readUInt16LE(off);
    off += 4;
    const notas = [];
    for (let i = 0; i < n && off + 4 <= c.length; i++) {
      const tipo = c.readUInt16LE(off);
      const tam = c.readUInt16LE(off + 2);
      if (tam < 4 || off + tam > c.length) break;
      if (tipo === 2 && tam >= 26) {              // CAPSTYPE_BITMAP
        telaLargura = c.readUInt16LE(off + 12);
        const compr = c.readUInt16LE(off + 20);
        notas.push(`BITMAP bpp=${c.readUInt16LE(off + 4)}`
          + ` tela=${c.readUInt16LE(off + 12)}x${c.readUInt16LE(off + 14)} compressão=${compr}`);
        if (process.env.VC_RDP_SEMCOMPR === '1' && compr !== 0) {
          c.writeUInt16LE(0, off + 20);
          notas.push('→ compressão DESLIGADA pelo proxy');
        }
      }
      off += tam;
    }
    log(`Confirm Active: ${n} capacidades | ${notas.join(' | ') || 'sem CAPSTYPE_BITMAP'}`);
  }

  // Contorna um bug do IronRDP embutido no ironrdp-wasm 1.1.0 (commit d0e18e3).
  //
  // Ao desenhar um Bitmap Update, ele fatia o buffer decodificado pela largura
  // do RETÂNGULO DE DESTINO em vez da largura do BITMAP. Quando o xrdp alinha o
  // bitmap a múltiplos de 4 — e ele faz isso em 60% dos retângulos — as duas
  // larguras diferem em 1 a 3 pixels, cada linha sai deslocada da anterior, e a
  // tela aparece cisalhada na diagonal.
  //
  // Conserto: esticar o retângulo de destino até a largura real do bitmap. As
  // colunas de alinhamento passam a ser desenhadas (invadem 1-3 pixels do
  // vizinho à direita, que redesenha por cima), mas as larguras batem e o
  // fatiamento volta a ficar correto. É in-place: nenhum tamanho muda.
  //
  // Corrigido no upstream pelos PRs #1486 e #1524, posteriores a este build.
  // Quando o wasm for atualizado, isto sai.
  let retificados = 0, retTotal = 0, naoTratados = 0, foraDaTela = 0;
  function alinharRetangulos(c) {
    if (c.length < 22) return;
    if ((c.readUInt16LE(2) & 0x0f) !== 7) return;   // PDUTYPE_DATAPDU
    if (c[14] !== 2) return;                        // PDUTYPE2_UPDATE
    if (c.readUInt16LE(18) !== 1) return;           // UPDATETYPE_BITMAP
    const n = c.readUInt16LE(20);
    let off = 22;
    for (let i = 0; i < n && off + 18 <= c.length; i++) {
      const destLeft = c.readUInt16LE(off);
      const destRight = c.readUInt16LE(off + 4);
      const largura = c.readUInt16LE(off + 8);
      const tam = c.readUInt16LE(off + 16);
      if (off + 18 + tam > c.length) break;
      retTotal += 1;
      const cx = destRight - destLeft + 1;
      const sobra = largura - cx;
      // O xrdp alinha a largura a múltiplos de 4, então a sobra legítima é de
      // 1 a 3 pixels. Diferença maior não é alinhamento — é outra coisa, e
      // esticar nesse caso pinta um bloco enorme por cima da tela.
      const novoDireita = destLeft + largura - 1;
      // Esticar para fora da tela faz o cliente descartar a região inteira —
      // apareceu como um bloco preto de 336 colunas na primeira versão deste
      // contorno. Na dúvida, deixa cisalhar aquele retângulo.
      const cabeNaTela = !telaLargura || novoDireita < telaLargura;
      if (sobra > 0 && sobra <= 3 && cabeNaTela) {
        c.writeUInt16LE(novoDireita, off + 4);
        retificados += 1;
      } else if (sobra > 0 && !cabeNaTela) {
        foraDaTela += 1;
      } else if (sobra > 3) {
        naoTratados += 1;
      }
      off += 18 + tam;
    }
  }

  // ---------- cliente → servidor ----------

  // Devolve uma lista de PDUs para escrever no servidor: normalmente um, mas
  // dois no momento em que o Security Exchange é injetado.
  function doCliente(pdu) {
    st.m.pdusCliente += 1; st.m.bytesCliente += pdu.length;
    if (!q.ehTpkt(pdu)) { st.m.fastCliente += 1; return [envelopeFastpath(pdu)]; }

    // MCS Connect Initial: anunciar métodos de criptografia que o cliente
    // jamais anunciaria sozinho.
    if (pdu.length > 9 && pdu[7] === 0x7f && pdu[8] === 0x65) {
      const r = mcs.anunciarMetodos(pdu);
      log(r.ok ? `CS_SECURITY: ${r.antes} → 0x${r.depois.toString(16)}` : `CS_SECURITY: ${r.motivo}`);
      const c = mcs.pedir32bpp(pdu);
      log(c.ok
        ? `CS_CORE: cor ${c.antes.high}bpp/sup 0x${c.antes.suportadas.toString(16)}/early 0x${c.antes.early.toString(16)}`
          + ` → 32bpp (sup 0x${c.depois.suportadas.toString(16)}, early 0x${c.depois.early.toString(16)})`
        : `CS_CORE: ${c.motivo}`);
      return [pdu];
    }

    const d = q.cargaSendData(pdu);
    if (!d) return [pdu];
    if (d.tipo !== q.MCS_SEND_DATA_REQUEST) return [pdu];

    const flags = q.lerFlagsSeguranca(d.carga);

    // O Client Info é o gatilho: é o primeiro PDU que precisa ir cifrado, e o
    // Security Exchange tem que chegar antes dele. O cliente nunca vai produzir
    // esse PDU, então nós o injetamos reaproveitando o canal deste aqui.
    if (!st.trocaFeita && flags && (flags.flags & q.SEC_INFO_PKT)) {
      if (!st.chavePublica) throw new Error('Client Info chegou antes do certificado do servidor.');
      st.trocaFeita = true;
      st.licenciando = true;
      const troca = montarSecurityExchange(d.initiator, d.canal, d.prioridade);
      derivarChaves();
      st.fase = 'cifrado';
      log(`Security Exchange injetado (${troca.length}B, canal ${d.canal})`);
      // O Client Info mantém o cabeçalho básico e ganha SEC_ENCRYPT.
      return [troca, cifrarComCabecalho(pdu, d, flags.flags, d.carga.slice(4))];
    }

    if (st.fase !== 'cifrado') return [pdu];

    // Nem todo PDU do cliente vem nu. Mesmo achando que não há criptografia, o
    // cliente inclui cabeçalho básico nos PDUs de licenciamento — e se
    // envelopássemos esse cabeçalho junto com os dados, o servidor receberia um
    // PDU sem SEC_LICENSE_PKT e com 4 bytes a mais, e simplesmente pararia de
    // responder. Foi exatamente o que aconteceu na primeira tentativa.
    if (st.licenciando && flags && flags.flagsHi === 0
        && (flags.flags & (q.SEC_LICENSE_PKT | q.SEC_INFO_PKT))) {
      return [cifrarComCabecalho(pdu, d, flags.flags, d.carga.slice(4))];
    }

    // Fora do licenciamento o cliente manda PDUs nus: o cabeçalho é todo nosso.
    tratarConfirmActive(d.carga);
    return [cifrarComCabecalho(pdu, d, 0, d.carga)];
  }

  // Monta [flags|SEC_ENCRYPT][flagsHi][assinatura 8B][dados cifrados].
  function cifrarComCabecalho(pdu, d, flagsOriginais, dados) {
    const salgado = false; // MAC salgado só depois da troca de capacidades
    const assinatura = salgado
      ? cripto.assinarSalgado(st.envio.macKey, dados, st.envio.total)
      : cripto.assinar(st.envio.macKey, dados);
    const cifrado = cronometrar(st.envio, dados, 'renovacoesEnvio');
    const cabecalho = q.cabecalhoNaoFips(flagsOriginais | q.SEC_ENCRYPT, assinatura);
    return q.remontarSendData(pdu, Buffer.concat([cabecalho, cifrado]));
  }

  // Fast-path de entrada (teclado/mouse): o cliente manda sem assinatura.
  function envelopeFastpath(pdu) {
    if (st.fase !== 'cifrado') return pdu;
    const cab = q.tamCabecalhoFastpath(pdu);
    const dados = pdu.slice(cab);
    const assinatura = cripto.assinar(st.envio.macKey, dados);
    const cifrado = cronometrar(st.envio, dados, 'renovacoesEnvio');
    const corpo = Buffer.concat([assinatura, cifrado]);
    const total = 2 + corpo.length + (corpo.length + 2 >= 128 ? 1 : 0);
    const saida = Buffer.alloc(total);
    saida[0] = pdu[0] | q.FASTPATH_ENCRYPTED;
    if (total < 128) { saida[1] = total; corpo.copy(saida, 2); }
    else { saida.writeUInt16BE(total | 0x8000, 1); corpo.copy(saida, 3); }
    return saida;
  }

  // ---------- servidor → cliente ----------

  function doServidor(pdu) {
    st.m.pdusServidor += 1; st.m.bytesServidor += pdu.length;
    if (!q.ehTpkt(pdu)) { st.m.fastServidor += 1; return desenvelopeFastpath(pdu); }

    // MCS Connect Response: guardar o material de criptografia e apagar o
    // bloco antes que ele chegue ao navegador.
    if (pdu.length > 9 && pdu[7] === 0x7f && pdu[8] === 0x66) {
      const g = mcs.lerSegurancaDoServidor(pdu);
      if (!g.ok) throw new Error(`SC_SECURITY ilegível: ${g.motivo}`);
      st.metodo = g.metodo;
      st.nivel = g.nivel;
      st.serverRandom = g.serverRandom;
      if (g.metodo !== 0) {
        if (g.metodo === cripto.METODO_FIPS) throw new Error('O servidor exige FIPS (3DES), que não é suportado.');
        st.chavePublica = mcs.lerChavePublica(g.certificado);
        if (!st.chavePublica) throw new Error('Não consegui ler a chave pública do servidor.');
        log(`servidor: método 0x${g.metodo.toString(16)}, nível ${g.nivel}, RSA ${st.chavePublica.bits} bits`);
        st.clientRandom = require('crypto').randomBytes(32);
      } else {
        log('servidor sem criptografia — nada a traduzir');
        st.fase = 'negociado';
      }
      mcs.neutralizarSegurancaDoServidor(pdu);
      return pdu;
    }

    const d = q.cargaSendData(pdu);
    if (!d) return pdu;
    if (d.tipo !== q.MCS_SEND_DATA_INDICATION) return pdu;

    const flags = q.lerFlagsSeguranca(d.carga);
    if (st.licenciando && flags && !(flags.flags & q.SEC_LICENSE_PKT)) {
      st.licenciando = false;
      log('licenciamento encerrado');
    }
    if (!flags || !(flags.flags & q.SEC_ENCRYPT)) return pdu;
    if (!st.recepcao) throw new Error('PDU cifrado chegou antes das chaves.');
    if (d.carga.length < 12) throw new Error('PDU cifrado sem espaço para a assinatura.');

    const claro = cronometrar(st.recepcao, d.carga.slice(12), 'renovacoesRecepcao');
    conferirMac(d.carga.slice(4, 12), claro, 'slow-path', flags.flags & q.SEC_SECURE_CHECKSUM);
    if (!SEM_ALINHAR) alinharRetangulos(claro);
    contarSlowPath(claro);
    const limpas = flags.flags & ~(q.SEC_ENCRYPT | q.SEC_SECURE_CHECKSUM);

    // Licenciamento e Client Info levam cabeçalho básico mesmo sem criptografia;
    // os demais PDUs, em modo NONE, não levam cabeçalho nenhum. Entregar um
    // cabeçalho onde o cliente não espera desalinharia tudo o que vem depois.
    const carga = (limpas & (q.SEC_LICENSE_PKT | q.SEC_INFO_PKT))
      ? Buffer.concat([q.cabecalhoBasico(limpas), claro])
      : claro;
    return q.remontarSendData(pdu, carga);
  }

  function desenvelopeFastpath(pdu) {
    if (!(pdu[0] & q.FASTPATH_ENCRYPTED)) return pdu;
    if (!st.recepcao) throw new Error('fast-path cifrado chegou antes das chaves.');
    const cab = q.tamCabecalhoFastpath(pdu);
    const assinaturaRecebida = pdu.slice(cab, cab + 8);
    const claro = cronometrar(st.recepcao, pdu.slice(cab + 8), 'renovacoesRecepcao'); // pula a assinatura
    // O MAC do servidor é o único juiz de que a decifragem está certa. Sem
    // conferir, um fluxo RC4 dessincronizado entrega lixo silenciosamente — e o
    // sintoma aparece só na tela, cisalhada, longe da causa.
    conferirMac(assinaturaRecebida, claro, 'fast-path', pdu[0] & q.FASTPATH_SECURE_CHECKSUM);
    // Conta os tipos de atualização que chegam: sem isso não dá para saber por
    // onde a tela está vindo.
    if (claro.length) {
      const cod = claro[0] & 0x0f;
      contagem[cod] = (contagem[cod] || 0) + 1;
      bytesPorCodigo[cod] = (bytesPorCodigo[cod] || 0) + claro.length;
      if (process.env.VC_RDP_DUMP) {
        try {
          require('fs').appendFileSync(process.env.VC_RDP_DUMP,
            `${cod} ${claro.length} ${claro.slice(0, 64).toString('hex')}\n`);
        } catch {}
      }
    }
    if (amostrasFast < 4) {
      amostrasFast += 1;
      const tamOrig = (pdu[1] & 0x80) ? (pdu.readUInt16BE(1) & 0x7fff) : pdu[1];
      log(`fast-path #${amostrasFast}: recebido ${pdu.length}B (campo=${tamOrig}, cab=${cab})`
        + ` cabByte=0x${pdu[0].toString(16)} → carga ${claro.length}B updateCode=0x${(claro[0] & 0x0f).toString(16)}`
        + ` frag=${(claro[0] >> 4) & 0x3} compr=${(claro[0] >> 6) & 0x3}`);
    }
    const total = 2 + claro.length + (claro.length + 2 >= 128 ? 1 : 0);
    const saida = Buffer.alloc(total);
    saida[0] = pdu[0] & ~(q.FASTPATH_ENCRYPTED | q.FASTPATH_SECURE_CHECKSUM);
    if (total < 128) { saida[1] = total; claro.copy(saida, 2); }
    else { saida.writeUInt16BE(total | 0x8000, 1); claro.copy(saida, 3); }
    return saida;
  }

  const NOMES = ['ORDERS', 'BITMAP', 'PALETTE', 'SYNCHRONIZE', 'SURFCMDS', 'PTR_NULL',
    'PTR_DEFAULT', 'PTR_POSITION', 'COLOR_POINTER', 'CACHED_POINTER', 'POINTER', 'LARGE_POINTER'];
  return {
    estado: st, doCliente, doServidor,
    macs: () => ({ ok: macsOk, ruins: macsRuins }),
    retangulos: () => ({ total: retTotal, retificados, naoTratados, foraDaTela }),
    atualizacoes: () => [
      ...Object.entries(contagem).map(([c, n]) => `fast ${NOMES[c] || c}: ${n}/${bytesPorCodigo[c]}B`),
      ...Object.entries(slow).map(([k, n]) => `slow ${k}: ${n}/${slowBytes[k]}B`),
    ],
  };
}

module.exports = { criarTradutor, CANAL_IO_PADRAO };
