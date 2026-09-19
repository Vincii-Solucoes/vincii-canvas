'use strict';

// Registro de sessões de terminal que SOBREVIVEM ao WebSocket.
//
// Até aqui a conexão (SSH, Telnet, PTY local) nascia e morria junto com o
// socket: fechar a aba matava o shell. Isso impedia soltar uma aba numa janela
// própria sem perder o diretório atual, as variáveis de ambiente e qualquer
// programa em execução.
//
// Agora a conexão pertence à SESSÃO, e o socket é só o canal de exibição do
// momento. Quando o socket cai, a sessão fica ÓRFÃ: continua rodando, continua
// acumulando saída, e outra janela pode reatar a ela pelo id.
//
// Duas guardas importantes, porque órfã sem limite é vazamento:
//   - a saída guardada é um buffer em ANEL, com teto em bytes;
//   - órfã sem ninguém reatando é encerrada depois do TTL.
//
// O que NÃO passa por aqui: RDP, VNC e página web. A sessão deles vive no
// navegador (canvas, WebAssembly, webview), não no servidor — não há o que
// transferir, e reconectar é imperceptível.

const crypto = require('crypto');

// Saída recente guardada para reexibir ao reatar. 256 KB cobre uma tela cheia
// com folga; acima disso o começo é descartado.
// Teto do buffer de reanexar, em bytes. Acompanha a configuração de linhas da
// rolagem (settings.termScrollback): de nada adianta guardar 50 mil linhas no
// xterm se, ao soltar a aba em outra janela, só os últimos 256 KB voltassem.
// ~160 bytes por linha é uma média folgada; "sem limite" (0) cai no teto
// absoluto — o servidor não pode crescer sem fim por causa de 40 sessões.
const MAX_BUFFER_MIN = 256 * 1024;
const MAX_BUFFER_ABS = 64 * 1024 * 1024;
const BYTES_POR_LINHA = 160;
// Quem sabe a configuração é o servidor (store); o módulo só recebe a função,
// para continuar puro e testável sem data.json.
let linhasConfiguradas = () => undefined;
function configurarLinhas(fn) { linhasConfiguradas = typeof fn === 'function' ? fn : () => undefined; }
function tetoDoBuffer() {
  let linhas;
  try { linhas = linhasConfiguradas(); } catch { linhas = undefined; }
  if (linhas === 0) return MAX_BUFFER_ABS;
  const n = Number(linhas);
  if (!Number.isFinite(n) || n <= 0) return Math.max(MAX_BUFFER_MIN, 50000 * BYTES_POR_LINHA);
  return Math.min(MAX_BUFFER_ABS, Math.max(MAX_BUFFER_MIN, Math.round(n) * BYTES_POR_LINHA));
}

// Quanto tempo uma sessão sem janela continua viva. Cinco minutos cobrem o
// tempo de soltar/arrastar/reabrir uma janela e ainda liberam recursos de quem
// simplesmente fechou o app.
const TTL_ORFA_MS = Number(process.env.VC_TERM_TTL_MS || 5 * 60 * 1000);

// Teto de sessões vivas ao mesmo tempo, para um laço de reconexão não encher a
// memória com shells esquecidos.
const MAX_SESSOES = 40;

const sessoes = new Map();

function criar({ rotulo, hostId }) {
  // Despeja órfãs até caber — no plural, e não uma só.
  //
  // O `if` que havia aqui derrubava UMA órfã por chamada, então bastava criar
  // sessões mais rápido do que elas eram despejadas para o registro passar do
  // teto e continuar crescendo. E se TODAS estivessem ligadas a alguma janela,
  // nada era despejado e nada impedia a criação: o "teto" não era teto nenhum.
  //
  // Sessão LIGADA continua intocada de propósito: derrubar o terminal que a
  // pessoa está usando para caber mais um seria pior que recusar o novo. Por
  // isso, esgotadas as órfãs, a criação é RECUSADA — com erro, para quem pediu
  // saber que não abriu.
  while (sessoes.size >= MAX_SESSOES) {
    const maisVelha = [...sessoes.values()]
      .filter((s) => !s.ws && s.orfaDesde)
      .sort((a, b) => a.orfaDesde - b.orfaDesde)[0];
    if (!maisVelha) {
      throw new Error(`Limite de ${MAX_SESSOES} sessões abertas atingido. `
        + 'Feche uma aba de terminal antes de abrir outra.');
    }
    maisVelha.encerrar('limite de sessões atingido');
  }

  const s = {
    id: 'ts_' + crypto.randomUUID(),
    rotulo: rotulo || '',
    hostId: hostId || null,
    criadaEm: Date.now(),
    ws: null,
    orfaDesde: null,
    relogioOrfa: null,
    encerrada: false,
    // Preenchidos pelo protocolo quando o canal fica pronto.
    canal: null,
    // Saída acumulada, para reexibir a tela ao reatar. Lista de pedaços com o
    // total em bytes: concatenar numa string e cortar com slice a cada mensagem
    // copiava o buffer inteiro por pacote (64 MB × cada linha do tail -f).
    pedacos: [],
    bufferBytes: 0,
    prontaEnviada: false,
  };

  // Manda para a janela atual E guarda o que for saída, para quem reatar depois
  // ver a tela como ela está.
  s.enviar = (obj) => {
    if (s.encerrada) return;
    if (obj && (obj.t === 'o' || obj.t === 'e') && typeof obj.d === 'string' && obj.d) {
      s.pedacos.push(obj.d);
      s.bufferBytes += obj.d.length;
      const teto = tetoDoBuffer();
      // Descarta do começo, pedaço a pedaço — O(1) amortizado, sem copiar o resto.
      while (s.bufferBytes > teto && s.pedacos.length > 1) s.bufferBytes -= s.pedacos.shift().length;
      if (s.bufferBytes > teto && s.pedacos.length === 1) { s.pedacos[0] = s.pedacos[0].slice(-teto); s.bufferBytes = s.pedacos[0].length; }
    }
    if (obj && obj.t === 'ready') s.prontaEnviada = true;
    const ws = s.ws;
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(obj)); } catch {}
    }
  };

  // O protocolo entrega aqui como escrever, redimensionar e derrubar. Fica
  // guardado na sessão (não no socket) justamente para sobreviver à troca.
  s.definirCanal = ({ escrever, redimensionar, encerrar }) => {
    s.canal = { escrever, redimensionar, encerrar };
  };

  s.atacar = (ws) => {
    if (s.encerrada) return false;
    // Uma janela por vez: reatar rouba o canal da anterior, em vez de duplicar a
    // entrada de teclado em duas telas.
    if (s.ws && s.ws !== ws && s.ws.readyState === 1) {
      try { s.ws.send(JSON.stringify({ t: 'e', d: '\r\n[esta sessão foi aberta em outra janela]\r\n' })); } catch {}
      try { s.ws.close(); } catch {}
    }
    s.ws = ws;
    s.orfaDesde = null;
    if (s.relogioOrfa) { clearTimeout(s.relogioOrfa); s.relogioOrfa = null; }
    // Reexibe a tela: um envio só, para o xterm não piscar linha a linha.
    try {
      ws.send(JSON.stringify({ t: 'sessao', id: s.id }));
      if (s.bufferBytes) ws.send(JSON.stringify({ t: 'o', d: s.pedacos.join('') }));
      if (s.prontaEnviada) ws.send(JSON.stringify({ t: 'ready' }));
    } catch {}

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!s.canal) return;
      if (msg.t === 'i' && typeof msg.d === 'string') s.canal.escrever(msg.d);
      else if (msg.t === 'r') s.canal.redimensionar(msg.cols, msg.rows);
      // A janela avisa quando o FECHAMENTO é intencional: aí a sessão morre em
      // vez de ficar órfã esperando alguém reatar.
      else if (msg.t === 'fim') s.encerrar('a janela encerrou a sessão');
    });
    ws.on('close', () => { if (s.ws === ws) s.desatacar(); });
    ws.on('error', () => { if (s.ws === ws) s.desatacar(); });
    return true;
  };

  // Socket caiu, mas a conexão continua: a sessão fica órfã, acumulando saída,
  // até alguém reatar ou o TTL vencer.
  s.desatacar = () => {
    s.ws = null;
    if (s.encerrada) return;
    s.orfaDesde = Date.now();
    if (s.relogioOrfa) clearTimeout(s.relogioOrfa);
    s.relogioOrfa = setTimeout(() => s.encerrar('ninguém reatou a tempo'), TTL_ORFA_MS);
    if (s.relogioOrfa.unref) s.relogioOrfa.unref();
  };

  s.encerrar = (motivo) => {
    if (s.encerrada) return;
    s.encerrada = true;
    if (s.relogioOrfa) { clearTimeout(s.relogioOrfa); s.relogioOrfa = null; }
    try { if (s.canal && s.canal.encerrar) s.canal.encerrar(); } catch {}
    const ws = s.ws;
    s.ws = null;
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify({ t: 'x' })); } catch {}
      try { ws.close(); } catch {}
    }
    sessoes.delete(s.id);
    if (process.env.VC_TERM_DEBUG) console.error(`[term] sessão ${s.id} encerrada: ${motivo || 'sem motivo'}`);
  };

  sessoes.set(s.id, s);
  return s;
}

const pegar = (id) => sessoes.get(id);

// Quem está vivo, e ligado a quê.
//
// Deixou de ser só diagnóstico quando a AGENDA passou a depender dela: a
// janela principal usa `orfaDesde` para saber que uma sessão perdeu a janela
// (e trazê-la de volta para uma aba) e `ligada` para saber que outra janela
// está com ela (e não abrir uma segunda conexão ao mesmo servidor). É a via
// da rota GET /api/janelas, e mudar estes campos muda o comportamento do app.
function listar() {
  return [...sessoes.values()].map((s) => ({
    id: s.id, rotulo: s.rotulo, hostId: s.hostId,
    ligada: !!s.ws, orfaDesde: s.orfaDesde, bytes: s.bufferBytes,
  }));
}

module.exports = { criar, pegar, listar, configurarLinhas, tetoDoBuffer, MAX_BUFFER_MIN, MAX_BUFFER_ABS, BYTES_POR_LINHA, TTL_ORFA_MS, MAX_SESSOES };
