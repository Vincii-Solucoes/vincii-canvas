'use strict';

// Valida e normaliza a URL de um host do tipo "web" (gerência de roteador,
// painel de serviço, site interno).
//
// Existe separado porque a URL é digitada pelo usuário — ou importada de um XML
// de terceiro — e vira `src` de um <webview>, que carrega a página DENTRO do
// app. Um esquema como `javascript:` ou `file:` ali não seria "um link ruim":
// seria execução no contexto do app. Por isso só http e https passam, e a
// checagem mora num lugar só, usado pelo servidor e pelo navegador.
//
// Carregado dos dois lados: <script defer> antes de app.js, e require() no Node.

const ESQUEMAS = ['http:', 'https:'];

// Aceita o que o usuário costuma digitar ("192.168.1.1", "roteador:8443/admin")
// e devolve a URL completa, ou null se não der para aproveitar.
function normalizarUrl(entrada) {
  // Só texto. Um número aqui viraria endereço por acidente — `0` é uma URL
  // válida para o parser (vira 0.0.0.0), e nada que chegue como número devia
  // estar virando endereço de equipamento.
  if (typeof entrada !== 'string') return null;
  const texto0 = entrada.trim();
  if (!texto0) return null;
  let texto = texto0;
  // Sem esquema, assume https: gerência de equipamento quase sempre é TLS, e
  // cair para http silenciosamente mandaria a senha em texto claro.
  //
  // "roteador:8443" NÃO tem esquema — tem porta. Sem esta distinção, o texto
  // mais natural de se digitar para um equipamento (`nome:porta`) era lido como
  // um esquema desconhecido e recusado.
  const temEsquema = /^[a-zA-Z][a-zA-Z0-9+.-]*:(?!\d)/.test(texto);
  if (!temEsquema) texto = 'https://' + texto;
  let u;
  try { u = new URL(texto); } catch { return null; }
  if (!ESQUEMAS.includes(u.protocol)) return null;
  if (!u.hostname) return null;
  return u.toString();
}

// Devolve { url, host, port } — os dois últimos para o resto do app continuar
// tratando este registro como um host qualquer (grupo, ícone, busca, ordenação).
function partesDaUrl(entrada) {
  const url = normalizarUrl(entrada);
  if (!url) return null;
  const u = new URL(url);
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  return { url, host: u.hostname, port };
}

if (typeof window !== 'undefined') {
  window.normalizarUrl = normalizarUrl;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizarUrl, partesDaUrl, ESQUEMAS };
}
