'use strict';

// Proxy RDCleanPath: dá RDP ao app sem guacd, sem Docker e sem binário nativo.
//
// Quem fala RDP de verdade é o IronRDP compilado para WebAssembly, rodando no
// navegador. Mas o navegador não abre socket TCP nem termina TLS, então ele
// delega essa parte a um proxy — é o que fazemos aqui:
//
//   1. o cliente manda um RDCleanPath Request com o X.224 Connection Request
//   2. abrimos TCP até o servidor RDP e repassamos esse X.224
//   3. lemos o Connection Confirm e subimos TLS
//   4. devolvemos um RDCleanPath Response com o CC e a CADEIA DE CERTIFICADOS
//   5. daí em diante é repasse binário puro
//
// O passo 4 é o pulo do gato: o CredSSP amarra a autenticação à chave pública
// do servidor (campo pubKeyAuth), e é o WASM que executa o CredSSP. Por isso
// ele precisa do certificado — nós terminamos o TLS, ele prova a identidade.
//
// Como o proxy roda no processo do app, ele enxerga a VPN e as rotas da
// máquina do usuário — coisa que um contêiner Docker notoriamente não faz.

const net = require('net');
const tls = require('tls');
const { WebSocketServer } = require('ws');
const store = require('./store');
const quickhosts = require('./quickhosts');
const rdcleanpath = require('./rdcleanpath');
const { fecharComMotivo } = require('./wsclose');
const { CERT_FACHADA } = require('./rdp-legado-cert');
const rdpLegado = require('./rdp-legado');
const quadros = require('./rdp-quadros');

const CONNECT_TIMEOUT_MS = 15000;
const TLS_TIMEOUT_MS = 15000;

// O certificado autoassinado que o Windows gera para o RDP costuma trazer
// keyUsage = keyEncipherment SEM digitalSignature. O BoringSSL do Electron
// recusa esse certificado em qualquer suite que assine o handshake (TLS 1.3 e
// todas as ECDHE), com ERR_SSL_KEY_USAGE_BIT_INCORRECT — e recusa ANTES de
// rejectUnauthorized:false valer alguma coisa. Em Node puro isso passa, então
// o problema só aparece no app empacotado.
//
// Saída: repetir o handshake usando troca de chave RSA, a única que combina
// com keyEncipherment. Perde-se sigilo futuro (forward secrecy) nessa
// retentativa, mas é isso ou não conectar — e o TLS aqui é só o envelope: quem
// autentica de verdade é o CredSSP, que continua intacto.
const CIFRAS_RSA = 'AES256-GCM-SHA384:AES128-GCM-SHA256:AES256-SHA256:AES128-SHA256:AES256-SHA:AES128-SHA';
const ERRO_KEY_USAGE = /KEY_USAGE_BIT_INCORRECT/;

// Modo RDP legado (Standard Security). EXPERIMENTAL e desligado por padrão:
// o servidor não é autenticado e a criptografia é obsoleta, então isso nunca
// pode ligar sozinho. Por enquanto só espia o comportamento do cliente.
const LEGADO = process.env.VC_RDP_LEGADO === '1';
// O handshake é minúsculo (~100 bytes). Se passar disso, alguém está falando
// outra coisa com a gente — corta antes de crescer na memória.
const MAX_HANDSHAKE = 8 * 1024;

function acharHost(id) {
  return store.get().hosts.find((h) => h.id === id) || quickhosts.get(id);
}

function humanizaRede(err, host, porta) {
  const m = (err && err.message) || String(err);
  if (/ECONNREFUSED/.test(m)) return `Conexão recusada em ${host}:${porta} — o RDP está habilitado nessa máquina?`;
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return `Host não encontrado: ${host}`;
  if (/EHOSTUNREACH|ENETUNREACH/.test(m)) return `Host inalcançável: ${host}`;
  if (/ETIMEDOUT/.test(m)) return `Tempo esgotado ao conectar em ${host}:${porta}.`;
  return m;
}

// O X.224 vem embrulhado em TPKT: 03 00 <tamanho total, 16 bits BE>.
// Precisamos do pacote inteiro antes de repassar, e o TCP pode parti-lo.
function tpktCompleto(buf) {
  if (buf.length < 4) return 0;
  if (buf[0] !== 3) return -1; // não é TPKT: o outro lado não fala RDP
  const total = buf.readUInt16BE(2);
  return buf.length >= total ? total : 0;
}

// Lê o RDP Negotiation Response embutido no Connection Confirm (MS-RDPBCGR
// 2.2.1.2.1/2.2.1.2.2). Depois do cabeçalho fixo de 11 bytes vem, quando
// presente, o tipo (2 = resposta, 3 = falha) e um u32 em little-endian.
function negociacao(cc) {
  if (cc.length < 19) return { tipo: 'ausente' };
  const t = cc[11];
  const valor = cc.readUInt32LE(15);
  if (t === 2) return { tipo: 'ok', protocolo: valor };
  if (t === 3) return { tipo: 'falha', codigo: valor };
  return { tipo: 'ausente' };
}

const MOTIVOS_FALHA = {
  1: 'o servidor exige TLS, mas recusou a nossa proposta',
  2: 'o servidor não permite TLS',
  3: 'o servidor não tem certificado instalado',
  4: 'sinalizadores inconsistentes na negociação',
  5: 'o servidor exige NLA/CredSSP',
  6: 'o servidor exige TLS com autenticação de usuário',
};

// A cadeia como o RDCleanPath quer: DER cru, do certificado do servidor para
// a raiz. getPeerCertificate(true) devolve os pais em .issuerCertificate,
// terminando quando o certificado aponta para si mesmo.
function cadeiaDer(socketTls) {
  const saida = [];
  const vistos = new Set();
  let c = socketTls.getPeerCertificate(true);
  while (c && c.raw && !vistos.has(c.fingerprint256)) {
    vistos.add(c.fingerprint256);
    saida.push(c.raw);
    c = c.issuerCertificate;
  }
  return saida;
}

const rdpWss = new WebSocketServer({ noServer: true });

rdpWss.on('connection', (ws, req) => {
  let fechado = false;
  let tcp = null;
  let seguro = null;
  // Ligada enquanto o primeiro handshake TLS está em curso. Quando ele falha,
  // o 'close' do socket chega ANTES do 'error' — se deixássemos o close
  // encerrar a sessão, a retentativa nunca aconteceria. Durante essa janela
  // quem decide é o handler de erro; o relógio do TLS cobre o caso de o erro
  // nunca chegar.
  let decidindoTls = false;
  // No modo legado de espia, guarda a função que registra o tráfego cru.
  let espiando = null;

  const encerrar = () => {
    if (fechado) return;
    fechado = true;
    try { if (seguro) seguro.destroy(); else if (tcp) tcp.destroy(); } catch {}
    try { ws.close(); } catch {}
  };
  // Fecha com motivo legível: o IronRDP mostra o reason ao usuário.
  const abortar = (msg) => {
    if (fechado) return;
    fecharComMotivo(ws, msg);
    encerrar();
  };
  // Erro no formato do protocolo, quando já dá para responder RDCleanPath.
  const erroProtocolo = (opcoes, msg) => {
    if (fechado) return;
    try { if (ws.readyState === ws.OPEN) ws.send(rdcleanpath.respostaErro(opcoes)); } catch {}
    abortar(msg);
  };
  // Falha de negociação: devolve junto o Connection Confirm, que é o que
  // permite ao cliente classificar como erro de negociação e não como erro
  // genérico do proxy.
  const erroNegociacao = (cc, msg) => {
    if (fechado) return;
    try { if (ws.readyState === ws.OPEN) ws.send(rdcleanpath.respostaErroNegociacao(cc)); } catch {}
    abortar(msg);
  };

  let url;
  try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return abortar('Requisição inválida.'); }
  const host = acharHost(url.searchParams.get('hostId'));
  if (!host) return abortar('Host não encontrado.');
  if (host.protocol !== 'rdp') return abortar('Este host não é RDP.');

  const alvo = host.host;
  const porta = host.port || 3389;

  // ---------- fase 1: ler o RDCleanPath Request ----------
  let entrada = Buffer.alloc(0);
  let emHandshake = true;

  const aoReceber = (data) => {
    if (fechado) return;
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data);

    if (!emHandshake) {
      // Já conectado: repasse cru para dentro do TLS.
      if (espiando) espiando('cliente→', b);
      if (seguro && seguro.writable) { try { seguro.write(b); } catch {} }
      return;
    }

    entrada = Buffer.concat([entrada, b]);
    if (entrada.length > MAX_HANDSHAKE) return abortar('Handshake RDCleanPath grande demais.');

    let lido;
    try { lido = rdcleanpath.decodificar(entrada); } catch (e) { return abortar('RDCleanPath inválido: ' + e.message); }
    if (!lido) return; // ainda faltam bytes

    const { pdu, consumido } = lido;
    if (pdu.version !== rdcleanpath.VERSAO) return abortar(`Versão RDCleanPath não suportada: ${pdu.version}`);
    if (!pdu.x224 || !pdu.x224.length) return abortar('RDCleanPath sem o X.224 Connection Request.');

    emHandshake = false;
    const sobra = entrada.slice(consumido);
    entrada = Buffer.alloc(0);

    // O destino que vale é o do host cadastrado, NÃO o campo `destination` do
    // cliente: senão a página poderia usar o proxy para varrer a rede interna.
    conectar(pdu.x224, sobra, null);
  };

  ws.on('message', aoReceber);
  ws.on('close', encerrar);
  ws.on('error', encerrar);

  // ---------- fase 2: X.224 + TLS contra o servidor ----------
  // `cifras` = null na primeira tentativa (TLS moderno); na retentativa vem
  // CIFRAS_RSA. Como um handshake TLS falho envenena o socket, a retentativa
  // refaz tudo: TCP novo e X.224 novo.
  function conectar(x224Cliente, sobra, cifras) {
    // VC_RDP_DEBUG=1 mostra a negociação — útil para diagnosticar um Windows
    // que recusa o handshake sem dizer por quê.
    if (process.env.VC_RDP_DEBUG) console.error(`[rdp] conectando em ${alvo}:${porta} (${cifras ? 'troca RSA' : 'TLS padrão'})`);
    tcp = net.createConnection({ host: alvo, port: porta });
    tcp.setNoDelay(true);
    tcp.setTimeout(CONNECT_TIMEOUT_MS);

    let respostaX224 = Buffer.alloc(0);

    tcp.on('connect', () => {
      tcp.setTimeout(0);
      try { tcp.write(x224Cliente); } catch (e) { erroProtocolo({}, 'Falha ao enviar o X.224: ' + e.message); }
    });

    tcp.on('timeout', () => erroProtocolo({}, `Tempo esgotado ao conectar em ${alvo}:${porta}.`));
    tcp.on('error', (err) => { if (!decidindoTls) erroProtocolo({}, humanizaRede(err, alvo, porta)); });
    tcp.on('close', () => { if (!decidindoTls) encerrar(); });

    const aoResponder = (d) => {
      respostaX224 = Buffer.concat([respostaX224, d]);
      const total = tpktCompleto(respostaX224);
      if (total < 0) return erroProtocolo({}, `${alvo}:${porta} respondeu algo que não é RDP.`);
      if (total === 0) return; // incompleto

      tcp.removeListener('data', aoResponder);
      const cc = respostaX224.slice(0, total);

      // Se o servidor não subir para TLS, não adianta seguir: o IronRDP não
      // implementa RDP Standard Security ("standard RDP security is not
      // supported"). Sem esta checagem o usuário receberia um erro de TLS
      // sem sentido, em vez de saber que precisa habilitar TLS no servidor.
      const neg = negociacao(cc);
      if (neg.tipo === 'falha') {
        const motivo = MOTIVOS_FALHA[neg.codigo] || `código ${neg.codigo}`;
        return erroNegociacao(cc, `${alvo}:${porta} recusou a negociação: ${motivo}.`);
      }
      if (neg.tipo === 'ok' && neg.protocolo === 0) {
        // EXPERIMENTAL, atrás de VC_RDP_LEGADO=1: nunca liga sozinho.
        if (LEGADO) return espiarLegado(cc, respostaX224.slice(total), sobra);
        // O motivo do fechamento do WebSocket NÃO chega ao usuário: enquanto
        // espera o Response, o IronRDP só enxerga "faltam bytes". O PDU de erro
        // de negociação, por outro lado, vira um erro tipado que a interface
        // sabe traduzir. Medido — não suponha o contrário.
        return erroNegociacao(cc, `${alvo}:${porta} está em RDP legado, sem TLS. `
          + 'Habilite TLS no servidor (no xrdp: security_layer=negotiate).');
      }

      subirTls(cc, respostaX224.slice(total), sobra, x224Cliente, cifras);
    };
    tcp.on('data', aoResponder);
  }

  // ---------- espia do modo legado (experimento da etapa 1) ----------
  //
  // A hipótese: o IronRDP, no caminho RDCleanPath, aceita o Connection Confirm
  // que NÓS mandarmos e pula o handshake TLS por construção. Se for verdade,
  // dá para forjar um CC dizendo "TLS" mesmo o servidor tendo escolhido RDP
  // legado, e o cliente segue a sequência de conexão em claro — que é o que
  // permitiria o proxy fazer a tradução de criptografia depois.
  //
  // Aqui NÃO traduzimos nada ainda: só repassamos os bytes crus e registramos
  // o que cada lado fala. O sucesso desta etapa é ver o cliente emitir um MCS
  // Connect Initial.
  function espiarLegado(cc, restoTcp, sobraWs) {
    // Diz ao cliente que houve TLS, para ele pular o próprio handshake. Quem
    // realmente protege (mal) esta perna é o RC4 que aplicamos daqui em diante.
    const forjado = Buffer.from(cc);
    forjado.writeUInt32LE(1, 15); // selectedProtocol: 0 (legado) → 1 (SSL)

    const registrar = (msg) => { if (process.env.VC_RDP_DEBUG) console.error(`[rdp-legado] ${msg}`); };
    const tradutor = rdpLegado.criarTradutor({ log: registrar });

    // Relatório periódico durante testes longos: mostra se a chave girou, se o
    // fast-path está fluindo e quanto do tempo está indo para o RC4.
    let relogioMetricas = null;
    if (process.env.VC_RDP_METRICAS) {
      const inicio = Date.now();
      relogioMetricas = setInterval(() => {
        const m = tradutor.estado.m;
        const s = (Date.now() - inicio) / 1000;
        const ms = Number(m.nsCripto / 1000000n);
        console.error(`[rdp-métricas] ${s.toFixed(0)}s`
          + ` | S→C ${m.pdusServidor} PDUs (${(m.bytesServidor / 1048576).toFixed(1)}MB, ${m.fastServidor} fast)`
          + ` | C→S ${m.pdusCliente} PDUs (${(m.bytesCliente / 1024).toFixed(0)}KB, ${m.fastCliente} fast)`
          + ` | cripto ${ms}ms (${(ms / (s * 10)).toFixed(1)}% da CPU)`
          + ` | renovações ${m.renovacoesEnvio}/${m.renovacoesRecepcao}`);
        const r = tradutor.retangulos();
        console.error(`[rdp-retângulos] ${r.total} desenhados, ${r.retificados} corrigidos, ${r.naoTratados} fora do padrão, ${r.foraDaTela} sairiam da tela`);
      }, 15000);
      relogioMetricas.unref();
      ws.on('close', () => clearInterval(relogioMetricas));
    }

    try {
      ws.send(rdcleanpath.respostaConectado({
        enderecoServidor: `${alvo}:${porta}`,
        x224: forjado,
        cadeiaDer: [CERT_FACHADA],
      }));
    } catch (e) { return abortar('Falha ao responder o RDCleanPath: ' + e.message); }

    // Cada lado precisa do próprio buffer: o TCP parte PDUs ao meio e o
    // tradutor só funciona sobre PDUs inteiros.
    const bufServidor = { b: Buffer.alloc(0) };
    const bufCliente = { b: Buffer.alloc(0) };

    // Consome PDUs completos de um buffer, traduz e entrega.
    const bombear = (acc, chegou, traduzir, entregar, quem) => {
      acc.b = acc.b.length ? Buffer.concat([acc.b, chegou]) : chegou;
      for (;;) {
        const n = quadros.tamanhoDoProximo(acc.b);
        if (n === 0) return;
        if (n < 0) return abortar(`Fluxo RDP inválido vindo do ${quem}.`);
        const pdu = acc.b.slice(0, n);
        acc.b = acc.b.slice(n);
        let saida;
        try { saida = traduzir(pdu); } catch (e) { return abortar(`RDP legado: ${e.message}`); }
        for (const p of (Array.isArray(saida) ? saida : [saida])) entregar(p);
      }
    };

    const paraCliente = (p) => { if (ws.readyState === ws.OPEN) ws.send(p); };
    const paraServidor = (p) => { if (tcp && tcp.writable) { try { tcp.write(p); } catch {} } };

    tcp.on('data', (d) => bombear(bufServidor, d, (p) => tradutor.doServidor(p), paraCliente, 'servidor'));
    if (restoTcp && restoTcp.length) bombear(bufServidor, restoTcp, (p) => tradutor.doServidor(p), paraCliente, 'servidor');

    // Daqui em diante o que vem do WebSocket passa pelo tradutor antes do TCP.
    espiando = (quem, b) => bombear(bufCliente, b, (p) => tradutor.doCliente(p), paraServidor, 'cliente');
    if (sobraWs && sobraWs.length) espiando('cliente→', sobraWs);
    // `aoReceber` escreve em `seguro` depois de chamar `espiando`; aqui o
    // tradutor já entregou tudo, então este destino precisa ser um sorvedouro.
    seguro = { writable: true, write: () => {}, destroy: () => tcp.destroy() };
  }

  function subirTls(cc, restoTcp, sobraWs, x224Cliente, cifras) {
    // Certificado autoassinado é a regra em Windows interno: quem valida a
    // identidade do servidor é o CredSSP no cliente, com a chave pública que
    // mandamos na cadeia — não uma cadeia de CA pública.
    const opcoes = {
      socket: tcp,
      rejectUnauthorized: false,
      servername: net.isIP(alvo) ? undefined : alvo,
    };
    if (cifras) { opcoes.ciphers = cifras; opcoes.maxVersion = 'TLSv1.2'; }

    decidindoTls = !cifras; // só na primeira tentativa há decisão a tomar
    seguro = tls.connect(opcoes);
    const relogio = setTimeout(() => {
      decidindoTls = false;
      erroProtocolo({}, `Tempo esgotado no TLS com ${alvo}:${porta}.`);
    }, TLS_TIMEOUT_MS);

    seguro.on('secureConnect', () => {
      clearTimeout(relogio);
      decidindoTls = false;
      if (fechado) return;
      const cadeia = cadeiaDer(seguro);
      if (!cadeia.length) return erroProtocolo({}, 'O servidor não apresentou certificado TLS.');

      try {
        ws.send(rdcleanpath.respostaConectado({
          enderecoServidor: `${alvo}:${porta}`,
          x224: cc,
          cadeiaDer: cadeia,
        }));
      } catch (e) { return abortar('Falha ao responder o RDCleanPath: ' + e.message); }

      // Bytes que chegaram antes da hora, dos dois lados.
      if (restoTcp && restoTcp.length && ws.readyState === ws.OPEN) ws.send(restoTcp);
      if (sobraWs && sobraWs.length && seguro.writable) { try { seguro.write(sobraWs); } catch {} }
    });

    seguro.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
    seguro.on('error', (err) => {
      clearTimeout(relogio);
      decidindoTls = false;
      const msg = (err && err.message) || String(err);
      if (process.env.VC_RDP_DEBUG) console.error(`[rdp] TLS falhou (${err && err.code}): ${msg.trim()}`);
      // Uma retentativa só, e só para este erro específico.
      if (!cifras && ERRO_KEY_USAGE.test(msg) && !fechado) {
        // Desliga os listeners ANTES de destruir: o 'close' do socket velho
        // chega depois que a conexão nova já está de pé e, sem isso, derruba
        // justamente a tentativa que deveria funcionar.
        const velhoTcp = tcp, velhoTls = seguro;
        seguro = null; tcp = null;
        try { velhoTls.removeAllListeners(); velhoTls.destroy(); } catch {}
        try { velhoTcp.removeAllListeners(); velhoTcp.destroy(); } catch {}
        return conectar(x224Cliente, sobraWs, CIFRAS_RSA);
      }
      erroProtocolo({}, `Falha no TLS com ${alvo}:${porta}: ${msg}`);
    });
    seguro.on('close', () => { if (!decidindoTls) encerrar(); });
  }
});

module.exports = { rdpWss };
