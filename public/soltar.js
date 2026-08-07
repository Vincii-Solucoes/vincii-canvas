'use strict';

// Contrato entre a janela que solta uma aba e a janela que nasce com ela.
//
// As duas pontas ficavam em funções distantes dentro de app.js: uma montava a
// query string, a outra lia. Nada obrigava as duas a concordarem — bastava
// escrever `protocol` de um lado e ler `protocolo` do outro para a janela nova
// abrir sem saber o que exibir, em silêncio. Aqui elas são um módulo só, com
// teste de ida-e-volta.
//
// Só o terminal transfere a sessão VIVA (`sessao`): o shell mora no servidor e
// o socket é apenas a tela do momento. RDP, VNC e página web moram no renderer
// — canvas, wasm, webview — e a janela nova reconecta. Como não há estado de
// shell do outro lado, a diferença não aparece para quem usa.

const CHAVES = ['tipo', 'hostId', 'nome', 'protocolo', 'url', 'local', 'sessao'];

// Aba -> query string da janela nova.
function montarParamsSoltos(s) {
  const p = { solo: '1', tipo: s.kind };
  if (s.hostId) p.hostId = s.hostId;
  if (s.hostName) p.nome = s.hostName;
  if (s.protocol) p.protocolo = s.protocol;
  if (s.url) p.url = s.url;
  if (s.isLocal) p.local = '1';
  // um id de sessão só faz sentido para terminal, e só se o servidor mandou um
  if (s.kind === 'term' && s.sessaoId) p.sessao = s.sessaoId;
  return p;
}

function montarUrlSolta(s) {
  return '/?' + new URLSearchParams(montarParamsSoltos(s)).toString();
}

// Query string da janela nova -> o que abrir nela.
function lerParamsSoltos(busca) {
  const p = new URLSearchParams(String(busca || '').replace(/^\?/, ''));
  const lido = { solo: p.get('solo') === '1' };
  for (const k of CHAVES) lido[k] = p.get(k) || '';
  return {
    solo: lido.solo,
    tipo: lido.tipo || 'term',
    hostId: lido.hostId || null,
    nome: lido.nome || 'Sessão',
    protocolo: lido.protocolo || null,
    url: lido.url || null,
    isLocal: lido.local === '1',
    sessaoId: lido.sessao || null,
  };
}

if (typeof window !== 'undefined') {
  window.montarUrlSolta = montarUrlSolta;
  window.lerParamsSoltos = lerParamsSoltos;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { montarParamsSoltos, montarUrlSolta, lerParamsSoltos, CHAVES };
}
