// Área de trabalho remota no navegador.
//
// VNC → noVNC fala RFB direto pelo WebSocket; o servidor só repassa bytes.
// RDP → IronRDP compilado para WebAssembly fala RDP aqui mesmo, incluindo
//       NLA/CredSSP. O servidor entra só como proxy RDCleanPath (lib/rdp.js),
//       porque o navegador não abre TCP nem termina TLS. Não precisa de guacd,
//       Docker nem binário nativo.
//
// Consequência assumida: como o CredSSP roda no WASM, a senha do host precisa
// chegar até aqui — coisa que no caminho antigo (guacd) não acontecia. Ela vem
// por POST autenticado com o token do processo, nunca por query string, e não é
// guardada em lugar nenhum além da variável local desta conexão.
//
// Este arquivo é um módulo ES (precisa dos imports). O app.js, que é script
// clássico, conversa com ele pelo objeto window.vcDesktop.

import RFB from '/vendor/novnc/core/rfb.js';
import { scancodeDe } from '/scancodes.js';

// Cada conexão devolve uma ALÇA própria: o Terminal abre várias abas ao mesmo
// tempo, então não pode existir "a sessão atual" global aqui.

function urlWsPartes(caminho, params) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const q = new URLSearchParams(params);
  q.set('token', (window.VC_TOKEN || ''));
  return { base: `${proto}://${location.host}${caminho}`, query: String(q) };
}

function urlWs(caminho, params) {
  const { base, query } = urlWsPartes(caminho, params);
  return `${base}?${query}`;
}

function limpar(container) {
  while (container.firstChild) container.removeChild(container.firstChild);
}

function alcaVnc(rfb) {
  return {
    tipo: 'vnc',
    // Colar aqui é colar na área de transferência DA MÁQUINA REMOTA. Não dá
    // para "digitar" o texto: sintetizar tecla a tecla exigiria mapear cada
    // caractere para keysym e erraria em teclado não-ABNT. Com o texto na área
    // de transferência de lá, o Ctrl+V do próprio sistema remoto resolve.
    colar(texto) { rfb.clipboardPasteFrom(String(texto)); return 'clipboard'; },
    desconectar() { try { rfb.disconnect(); } catch {} },
    pausarTeclado(p) { try { rfb.focusOnClick = !p; if (!p) rfb.focus(); else rfb.blur(); } catch {} },
    ajustar() { try { rfb.scaleViewport = true; } catch {} },
  };
}

// ---------- VNC ----------
function conectarVnc({ hostId, container, onEstado }) {
  limpar(container);
  // A senha do VNC é validada DENTRO do noVNC (desafio-resposta com DES), então
  // ela precisa chegar ao navegador — mesmo caminho e mesmas barreiras do RDP.
  // Antes ia string vazia fixa daqui, e uma senha cadastrada no host
  // simplesmente não era usada: o servidor pedia autenticação e a conexão
  // morria com "cadastre a senha no host", com a senha cadastrada.
  // Busca já: o pedido de credencial pode chegar em milissegundos, e esperar o
  // evento para só então ir ao servidor perderia tempo à toa.
  const credencial = pegarCredencial(hostId).catch(() => null);
  const rfb = new RFB(container, urlWs('/api/vnc', { hostId }), { wsProtocols: [] });
  rfb.scaleViewport = true;      // ajusta a tela remota ao tamanho do painel
  rfb.resizeSession = false;     // não força o servidor a mudar de resolução
  rfb.background = '#0a0d12';
  rfb.addEventListener('connect', () => onEstado({ estado: 'conectado' }));
  rfb.addEventListener('disconnect', (e) => {
    const limpo = e.detail && e.detail.clean;
    onEstado({ estado: 'desconectado', erro: limpo ? '' : 'A conexão caiu.' });
  });
  rfb.addEventListener('credentialsrequired', async () => {
    // Responder pelo evento (e não setando credentials antes de conectar) evita
    // uma corrida: o RFB começa a falar com o servidor no mesmo instante em que
    // é construído, e a senha vem de uma requisição assíncrona.
    const cred = await credencial;
    if (cred && cred.password) { try { rfb.sendCredentials({ password: cred.password }); return; } catch {} }
    onEstado({ estado: 'erro', erro: 'O servidor VNC pediu senha. Cadastre a senha no host.' });
  });
  rfb.addEventListener('securityfailure', (e) => {
    onEstado({ estado: 'erro', erro: 'Falha de autenticação: ' + ((e.detail && e.detail.reason) || 'senha recusada') });
  });
  return alcaVnc(rfb);
}

// ---------- RDP (IronRDP em WebAssembly) ----------

// O .wasm tem 4 MB: carrega uma vez só, na primeira conexão RDP, e nunca no
// caminho do VNC nem na abertura do app.
let ironrdp = null;
async function carregarIronRdp() {
  if (!ironrdp) {
    const m = await import('/vendor/ironrdp/pkg/rdp_client.js');
    await m.default();
    try { m.setup('warn'); } catch {}
    ironrdp = m;
  }
  return ironrdp;
}

// Valores de IronErrorKind. Fixos aqui de propósito: o objeto de enum do
// wasm-bindgen nem sempre chega junto do erro, e a tradução não pode depender
// disso para funcionar.
const ERRO_SENHA_ERRADA = 1;
const ERRO_LOGIN = 2;
const ERRO_ACESSO_NEGADO = 3;
const ERRO_RDCLEANPATH = 4;
const ERRO_PROXY = 5;
const ERRO_NEGOCIACAO = 6;

// Sinal interno: erro genérico de RDCleanPath. NÃO dá para saber por ele o que
// houve — timeout, recusa e "precisa consentir" chegam todos com o mesmo
// código. Quem decide é o app.js, perguntando ao proxy.
const ERRO_RDCLEANPATH_GENERICO = '\u0000rdcleanpath';

// Erros do IronRDP vêm como IronError, cujo texto é técnico demais para a
// interface. Traduzimos os que o usuário consegue agir em cima.
//
// Atenção: `kind` e `backtrace` são MÉTODOS, não propriedades — ler
// `erro.kind` devolve a função, e a comparação com o número nunca casa.
function humanizaRdp(erro) {
  const ler = (nome) => {
    try { const v = erro && erro[nome]; return typeof v === 'function' ? v.call(erro) : v; } catch { return undefined; }
  };
  const texto = String(ler('backtrace') ?? erro ?? '');
  const tipo = ler('kind');

  // O proxy responde erro de negociação quando o servidor não sobe para TLS
  // (ver lib/rdp.js). É a falha mais comum e a única que o usuário resolve
  // sozinho, então merece a mensagem mais direta.
  if (tipo === ERRO_RDCLEANPATH || tipo === ERRO_NEGOCIACAO
      || /RDCleanPath negotiation|standard RDP security is not supported/i.test(texto)) {
    return ERRO_RDCLEANPATH_GENERICO;
  }
  if (tipo === ERRO_SENHA_ERRADA) return 'Senha incorreta.';
  if (tipo === ERRO_LOGIN) return 'Usuário ou senha recusados pelo servidor.';
  if (tipo === ERRO_ACESSO_NEGADO) return 'O servidor negou o acesso a este usuário.';
  if (tipo === ERRO_PROXY || /WebSocket/i.test(texto)) {
    return 'Não foi possível falar com o servidor. Ele está acessível na rede?';
  }
  if (/CredSSP|NTLM|Kerberos|logon/i.test(texto)) return 'Falha de autenticação no servidor.';
  return texto || 'Erro na sessão RDP.';
}

// Teclado e mouse: o IronRDP recebe eventos em lote, num InputTransaction.
function ligarEntrada(sessao, canvas, m) {
  let pausado = false;
  const enviar = (...eventos) => {
    if (pausado || !eventos.length) return;
    try {
      const t = new m.InputTransaction();
      for (const e of eventos) t.addEvent(e);
      sessao.applyInputs(t);
    } catch {}
  };

  // O canvas é redimensionado por CSS: converte a posição do ponteiro da tela
  // para a resolução real da área de trabalho remota.
  const posicao = (ev) => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const x = Math.round((ev.clientX - r.left) * (canvas.width / r.width));
    const y = Math.round((ev.clientY - r.top) * (canvas.height / r.height));
    return [Math.max(0, Math.min(canvas.width - 1, x)), Math.max(0, Math.min(canvas.height - 1, y))];
  };

  const aoMover = (ev) => { const p = posicao(ev); if (p) enviar(m.DeviceEvent.mouseMove(p[0], p[1])); };
  const aoApertar = (ev) => {
    ev.preventDefault();
    canvas.focus();
    const p = posicao(ev);
    // manda a posição junto: sem isso o clique cai onde o ponteiro remoto
    // estava, não onde o usuário clicou
    if (p) enviar(m.DeviceEvent.mouseMove(p[0], p[1]), m.DeviceEvent.mouseButtonPressed(ev.button));
    else enviar(m.DeviceEvent.mouseButtonPressed(ev.button));
  };
  const aoSoltar = (ev) => { ev.preventDefault(); enviar(m.DeviceEvent.mouseButtonReleased(ev.button)); };
  const aoMenu = (ev) => ev.preventDefault(); // o botão direito é do host remoto
  const aoRolar = (ev) => {
    ev.preventDefault();
    const unidade = ev.deltaMode === 1 ? m.RotationUnit.Line
      : ev.deltaMode === 2 ? m.RotationUnit.Page : m.RotationUnit.Pixel;
    const eventos = [];
    // sinal invertido: no DOM deltaY positivo é "para baixo"; no RDP a rotação
    // positiva é "para cima"
    if (ev.deltaY) eventos.push(m.DeviceEvent.wheelRotations(true, -ev.deltaY, unidade));
    if (ev.deltaX) eventos.push(m.DeviceEvent.wheelRotations(false, -ev.deltaX, unidade));
    enviar(...eventos);
  };

  const aoTeclaBaixo = (ev) => {
    const sc = scancodeDe(ev.code);
    if (sc === null) return;
    ev.preventDefault(); // impede que Tab, F5, Ctrl+W etc. mexam no app
    enviar(m.DeviceEvent.keyPressed(sc));
  };
  const aoTeclaCima = (ev) => {
    const sc = scancodeDe(ev.code);
    if (sc === null) return;
    ev.preventDefault();
    enviar(m.DeviceEvent.keyReleased(sc));
  };
  // Sair da janela com uma tecla presa deixaria ela "grudada" no servidor.
  const aoPerderFoco = () => { try { sessao.releaseAllInputs(); } catch {} };

  canvas.addEventListener('mousemove', aoMover);
  canvas.addEventListener('mousedown', aoApertar);
  canvas.addEventListener('mouseup', aoSoltar);
  canvas.addEventListener('contextmenu', aoMenu);
  canvas.addEventListener('wheel', aoRolar, { passive: false });
  canvas.addEventListener('keydown', aoTeclaBaixo);
  canvas.addEventListener('keyup', aoTeclaCima);
  canvas.addEventListener('blur', aoPerderFoco);
  window.addEventListener('blur', aoPerderFoco);

  return {
    pausar(p) {
      pausado = !!p;
      if (p) aoPerderFoco(); else { try { canvas.focus(); } catch {} }
    },
    soltar() {
      canvas.removeEventListener('mousemove', aoMover);
      canvas.removeEventListener('mousedown', aoApertar);
      canvas.removeEventListener('mouseup', aoSoltar);
      canvas.removeEventListener('contextmenu', aoMenu);
      canvas.removeEventListener('wheel', aoRolar);
      canvas.removeEventListener('keydown', aoTeclaBaixo);
      canvas.removeEventListener('keyup', aoTeclaCima);
      canvas.removeEventListener('blur', aoPerderFoco);
      window.removeEventListener('blur', aoPerderFoco);
    },
  };
}

function alcaRdp(sessao, entrada, canvas, m) {
  let vivo = true;
  return {
    tipo: 'rdp',
    // Mesma ideia do VNC: entrega o texto à área de transferência remota, e o
    // Ctrl+V de lá cola onde o cursor estiver. Sintetizar as teclas exigiria
    // scancode por caractere e quebraria em layout diferente do previsto.
    colar(texto) {
      const dados = new m.ClipboardData();
      dados.addText('text/plain', String(texto));
      sessao.onClipboardPaste(dados);
      return 'clipboard';
    },
    desconectar() {
      if (!vivo) return;
      vivo = false;
      try { entrada.soltar(); } catch {}
      try { sessao.shutdown(); } catch {}
    },
    // o teclado escuta no canvas: numa aba inativa ele não pode roubar teclas
    pausarTeclado(p) { if (vivo) entrada.pausar(p); },
    ajustar() {
      // O canvas tem a resolução da área remota; o CSS cuida de encaixá-lo no
      // painel. Redimensionar a SESSÃO exigiria a extensão DisplayControl e
      // cooperação do servidor — fica para depois.
      try { canvas.style.maxWidth = '100%'; canvas.style.maxHeight = '100%'; } catch {}
    },
  };
}

async function pegarCredencial(hostId) {
  const r = await fetch('/api/desktop/credencial', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hostId, token: window.VC_TOKEN || '' }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || 'Não foi possível ler as credenciais do host.');
  }
  return r.json();
}

function conectarRdp({ hostId, container, onEstado }) {
  limpar(container);
  const canvas = document.createElement('canvas');
  canvas.tabIndex = 0;                  // precisa ser focável para receber teclas
  canvas.style.outline = 'none';
  canvas.style.maxWidth = '100%';
  canvas.style.maxHeight = '100%';
  container.appendChild(canvas);

  const largura = Math.max(640, Math.round(container.clientWidth || 1280));
  const altura = Math.max(480, Math.round(container.clientHeight || 800));

  let alca = null;
  let cancelado = false;

  (async () => {
    let m;
    try {
      m = await carregarIronRdp();
      const cred = await pegarCredencial(hostId);
      if (cancelado) return;

      const { base, query } = urlWsPartes('/api/rdp', { hostId });
      const sessao = await new m.SessionBuilder()
        .username(cred.username || '')
        .password(cred.password || '')
        .serverDomain(cred.domain || '')
        // o proxy ignora este campo e usa o hostId, mas o builder exige um
        // destino bem formado
        .destination(cred.destino || '0.0.0.0:3389')
        .proxyAddress(`${base}?${query}`)
        .authToken(window.VC_TOKEN || '')
        .desktopSize(new m.DesktopSize(largura, altura))
        .renderCanvas(canvas)
        .setCursorStyleCallback(() => {})
        .setCursorStyleCallbackContext({})
        .canvasResizedCallback(() => {})
        .remoteClipboardChangedCallback(() => {})
        .forceClipboardUpdateCallback(() => {})
        .extension(new m.Extension('enable_credssp', true))
        .connect();

      if (cancelado) { try { sessao.shutdown(); } catch {} return; }

      const entrada = ligarEntrada(sessao, canvas, m);
      alca = alcaRdp(sessao, entrada, canvas, m);
      // troca a alça provisória pela real, para o app.js enxergar a de verdade
      Object.assign(provisoria, alca);
      onEstado({ estado: 'conectado' });
      try { canvas.focus(); } catch {}

      // run() só resolve quando a sessão termina
      sessao.run().then(
        (info) => {
          let motivo = '';
          try { motivo = info && typeof info.reason === 'function' ? info.reason() : ''; } catch {}
          onEstado({ estado: 'desconectado', erro: motivo });
        },
        (e) => onEstado({ estado: 'desconectado', erro: humanizaRdp(e) }),
      );
    } catch (e) {
      if (!cancelado) onEstado({ estado: 'erro', erro: humanizaRdp(e) });
    }
  })();

  // A conexão é assíncrona, mas o app.js precisa de uma alça agora — devolvemos
  // uma que já funciona para cancelar e é preenchida quando a sessão sobe.
  const provisoria = {
    tipo: 'rdp',
    desconectar() { cancelado = true; if (alca) alca.desconectar(); },
    pausarTeclado(p) { if (alca) alca.pausarTeclado(p); },
    ajustar() { if (alca) alca.ajustar(); },
  };
  return provisoria;
}

window.vcDesktop = { conectarVnc, conectarRdp, ERRO_RDCLEANPATH_GENERICO };
window.dispatchEvent(new Event('vc-desktop-pronto'));
