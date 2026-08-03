// Área de trabalho remota no navegador.
//
// VNC → noVNC fala RFB direto pelo WebSocket; o servidor só repassa bytes.
// RDP → guacamole-common-js fala o protocolo Guacamole; o servidor faz o
//       handshake com o guacd (as credenciais não passam por aqui).
//
// Este arquivo é um módulo ES (precisa dos imports). O app.js, que é script
// clássico, conversa com ele pelo objeto window.vcDesktop.

import RFB from '/vendor/novnc/core/rfb.js';
import Guacamole from '/vendor/guacamole/dist/esm/guacamole-common.min.js';

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
    desconectar() { try { rfb.disconnect(); } catch {} },
    pausarTeclado(p) { try { rfb.focusOnClick = !p; if (!p) rfb.focus(); else rfb.blur(); } catch {} },
    ajustar() { try { rfb.scaleViewport = true; } catch {} },
  };
}

function alcaRdp(cliente, teclado, mouse) {
  const ligarTeclado = () => {
    teclado.onkeydown = (k) => cliente.sendKeyEvent(1, k);
    teclado.onkeyup = (k) => cliente.sendKeyEvent(0, k);
  };
  return {
    tipo: 'rdp',
    desconectar() {
      try { teclado.onkeydown = teclado.onkeyup = null; } catch {}
      try { mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = null; } catch {}
      try { cliente.disconnect(); } catch {}
    },
    // o teclado do Guacamole é global (document): só captura na aba ativa
    pausarTeclado(p) { if (p) { teclado.onkeydown = teclado.onkeyup = null; } else ligarTeclado(); },
    ajustar() {},
  };
}

// ---------- VNC ----------
function conectarVnc({ hostId, senha, container, onEstado }) {
  limpar(container);
  const rfb = new RFB(container, urlWs('/api/vnc', { hostId }), {
    credentials: senha ? { password: senha } : undefined,
    wsProtocols: [],
  });
  rfb.scaleViewport = true;      // ajusta a tela remota ao tamanho do painel
  rfb.resizeSession = false;     // não força o servidor a mudar de resolução
  rfb.background = '#0a0d12';
  rfb.addEventListener('connect', () => onEstado({ estado: 'conectado' }));
  rfb.addEventListener('disconnect', (e) => {
    const limpo = e.detail && e.detail.clean;
    onEstado({ estado: 'desconectado', erro: limpo ? '' : 'A conexão caiu.' });
  });
  rfb.addEventListener('credentialsrequired', () => {
    onEstado({ estado: 'erro', erro: 'O servidor VNC pediu senha. Cadastre a senha no host.' });
  });
  rfb.addEventListener('securityfailure', (e) => {
    onEstado({ estado: 'erro', erro: 'Falha de autenticação: ' + ((e.detail && e.detail.reason) || 'senha recusada') });
  });
  return alcaVnc(rfb);
}

// ---------- RDP (via guacd) ----------
function conectarRdp({ hostId, container, onEstado }) {
  limpar(container);
  const largura = Math.max(640, Math.round(container.clientWidth || 1280));
  const altura = Math.max(480, Math.round(container.clientHeight || 800));

  // O WebSocketTunnel monta a URL como `base + "?" + data`, onde data é o argumento
  // de connect(). Passar a query já embutida na base gera `...&token=X?undefined`,
  // o token chega corrompido e o upgrade toma 403 — por isso vão separados.
  const { base, query } = urlWsPartes('/api/guac', { hostId, width: largura, height: altura, dpi: 96 });
  const tunel = new Guacamole.WebSocketTunnel(base);
  const cliente = new Guacamole.Client(tunel);
  container.appendChild(cliente.getDisplay().getElement());

  tunel.onerror = (st) => onEstado({ estado: 'erro', erro: 'Túnel: ' + (st && st.message ? st.message : 'falhou') });
  cliente.onerror = (st) => onEstado({ estado: 'erro', erro: (st && st.message) ? st.message : 'Erro na sessão RDP.' });
  cliente.onstatechange = (estado) => {
    // 3 = conectado, 5 = desconectado (constantes do Guacamole.Client)
    if (estado === 3) onEstado({ estado: 'conectado' });
    if (estado === 5) onEstado({ estado: 'desconectado' });
  };

  cliente.connect(query);

  const display = cliente.getDisplay();
  const mouse = new Guacamole.Mouse(display.getElement());
  mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (s) => cliente.sendMouseState(s);
  const teclado = new Guacamole.Keyboard(document);
  teclado.onkeydown = (k) => cliente.sendKeyEvent(1, k);
  teclado.onkeyup = (k) => cliente.sendKeyEvent(0, k);

  return alcaRdp(cliente, teclado, mouse);
}

window.vcDesktop = { conectarVnc, conectarRdp };
window.dispatchEvent(new Event('vc-desktop-pronto'));
