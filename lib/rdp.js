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

const CONNECT_TIMEOUT_MS = 15000;
const TLS_TIMEOUT_MS = 15000;
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

  const encerrar = () => {
    if (fechado) return;
    fechado = true;
    try { if (seguro) seguro.destroy(); else if (tcp) tcp.destroy(); } catch {}
    try { ws.close(); } catch {}
  };
  // Fecha com motivo legível: o IronRDP mostra o reason ao usuário.
  const abortar = (msg) => {
    if (fechado) return;
    try { ws.close(4000, String(msg).slice(0, 120)); } catch {}
    encerrar();
  };
  // Erro no formato do protocolo, quando já dá para responder RDCleanPath.
  const erroProtocolo = (opcoes, msg) => {
    if (fechado) return;
    try { if (ws.readyState === ws.OPEN) ws.send(rdcleanpath.respostaErro(opcoes)); } catch {}
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
    conectar(pdu.x224, sobra);
  };

  ws.on('message', aoReceber);
  ws.on('close', encerrar);
  ws.on('error', encerrar);

  // ---------- fase 2: X.224 + TLS contra o servidor ----------
  function conectar(x224Cliente, sobra) {
    tcp = net.createConnection({ host: alvo, port: porta });
    tcp.setNoDelay(true);
    tcp.setTimeout(CONNECT_TIMEOUT_MS);

    let respostaX224 = Buffer.alloc(0);

    tcp.on('connect', () => {
      tcp.setTimeout(0);
      try { tcp.write(x224Cliente); } catch (e) { erroProtocolo({}, 'Falha ao enviar o X.224: ' + e.message); }
    });

    tcp.on('timeout', () => erroProtocolo({}, `Tempo esgotado ao conectar em ${alvo}:${porta}.`));
    tcp.on('error', (err) => erroProtocolo({}, humanizaRede(err, alvo, porta)));
    tcp.on('close', encerrar);

    const aoResponder = (d) => {
      respostaX224 = Buffer.concat([respostaX224, d]);
      const total = tpktCompleto(respostaX224);
      if (total < 0) return erroProtocolo({}, `${alvo}:${porta} respondeu algo que não é RDP.`);
      if (total === 0) return; // incompleto

      tcp.removeListener('data', aoResponder);
      const cc = respostaX224.slice(0, total);
      subirTls(cc, respostaX224.slice(total), sobra);
    };
    tcp.on('data', aoResponder);
  }

  function subirTls(cc, restoTcp, sobraWs) {
    // Certificado autoassinado é a regra em Windows interno: quem valida a
    // identidade do servidor é o CredSSP no cliente, com a chave pública que
    // mandamos na cadeia — não uma cadeia de CA pública.
    seguro = tls.connect({
      socket: tcp,
      rejectUnauthorized: false,
      servername: net.isIP(alvo) ? undefined : alvo,
    });
    const relogio = setTimeout(() => erroProtocolo({}, `Tempo esgotado no TLS com ${alvo}:${porta}.`), TLS_TIMEOUT_MS);

    seguro.on('secureConnect', () => {
      clearTimeout(relogio);
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
      erroProtocolo({}, `Falha no TLS com ${alvo}:${porta}: ${(err && err.message) || err}`);
    });
    seguro.on('close', encerrar);
  }
});

module.exports = { rdpWss };
