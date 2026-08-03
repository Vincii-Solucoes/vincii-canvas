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

let sessao = null; // { tipo, cliente, teclado, mouse }

function urlWs(caminho, params) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const q = new URLSearchParams(params);
  q.set('token', (window.VC_TOKEN || ''));
  return `${proto}://${location.host}${caminho}?${q}`;
}

function limpar(container) {
  while (container.firstChild) container.removeChild(container.firstChild);
}

function desconectar() {
  if (!sessao) return;
  try {
    if (sessao.tipo === 'vnc') sessao.cliente.disconnect();
    else {
      if (sessao.teclado) sessao.teclado.onkeydown = sessao.teclado.onkeyup = null;
      if (sessao.mouse) sessao.mouse.onmousedown = sessao.mouse.onmouseup = sessao.mouse.onmousemove = null;
      sessao.cliente.disconnect();
    }
  } catch {}
  sessao = null;
}

// ---------- VNC ----------
function conectarVnc({ hostId, senha, container, onEstado }) {
  desconectar();
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
    sessao = null;
  });
  rfb.addEventListener('credentialsrequired', () => {
    onEstado({ estado: 'erro', erro: 'O servidor VNC pediu senha. Cadastre a senha no host.' });
  });
  rfb.addEventListener('securityfailure', (e) => {
    onEstado({ estado: 'erro', erro: 'Falha de autenticação: ' + ((e.detail && e.detail.reason) || 'senha recusada') });
  });
  sessao = { tipo: 'vnc', cliente: rfb };
  return rfb;
}

// ---------- RDP (via guacd) ----------
function conectarRdp({ hostId, container, onEstado }) {
  desconectar();
  limpar(container);
  const largura = Math.max(640, Math.round(container.clientWidth || 1280));
  const altura = Math.max(480, Math.round(container.clientHeight || 800));

  const tunel = new Guacamole.WebSocketTunnel(urlWs('/api/guac', { hostId, width: largura, height: altura, dpi: 96 }));
  const cliente = new Guacamole.Client(tunel);
  container.appendChild(cliente.getDisplay().getElement());

  tunel.onerror = (st) => onEstado({ estado: 'erro', erro: 'Túnel: ' + (st && st.message ? st.message : 'falhou') });
  cliente.onerror = (st) => onEstado({ estado: 'erro', erro: (st && st.message) ? st.message : 'Erro na sessão RDP.' });
  cliente.onstatechange = (estado) => {
    // 3 = conectado, 5 = desconectado (constantes do Guacamole.Client)
    if (estado === 3) onEstado({ estado: 'conectado' });
    if (estado === 5) { onEstado({ estado: 'desconectado' }); sessao = null; }
  };

  cliente.connect();

  const display = cliente.getDisplay();
  const mouse = new Guacamole.Mouse(display.getElement());
  mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (s) => cliente.sendMouseState(s);
  const teclado = new Guacamole.Keyboard(document);
  teclado.onkeydown = (k) => cliente.sendKeyEvent(1, k);
  teclado.onkeyup = (k) => cliente.sendKeyEvent(0, k);

  sessao = { tipo: 'rdp', cliente, teclado, mouse };
  return cliente;
}

function ativa() { return !!sessao; }

// controle de teclado: só captura enquanto a aba está visível
function pausarTeclado(pausar) {
  if (!sessao || sessao.tipo !== 'rdp' || !sessao.teclado) return;
  if (pausar) { sessao.teclado.onkeydown = sessao.teclado.onkeyup = null; }
  else {
    sessao.teclado.onkeydown = (k) => sessao.cliente.sendKeyEvent(1, k);
    sessao.teclado.onkeyup = (k) => sessao.cliente.sendKeyEvent(0, k);
  }
}

window.vcDesktop = { conectarVnc, conectarRdp, desconectar, ativa, pausarTeclado };
window.dispatchEvent(new Event('vc-desktop-pronto'));
