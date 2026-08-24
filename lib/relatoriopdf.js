'use strict';

// Relatório do monitor de IP em PDF — no mesmo espírito do relatório de
// comandos (um arquivo baixado), mas em PDF de verdade, usando o printToPDF
// que o próprio Electron traz (zero dependência nova, fiel ao "funciona sem
// instalar nada").
//
// Divisão: este módulo monta o HTML do relatório (função PURA, testável) e
// guarda o GERADOR injetado pelo main do Electron — uma função html→Buffer
// que renderiza numa janela invisível e imprime em PDF. Em `npm start` (sem
// Electron) o gerador não existe e a rota devolve 501; a tela avisa que o PDF
// precisa do app instalado e oferece o copiar de sempre.

// Nunca confiar em texto que vai para HTML — mesmo vindo do próprio usuário.
function escapa(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Valida e normaliza o corpo vindo da tela. Devolve null se não fizer sentido.
function normalizarDados(b) {
  if (!b || typeof b !== 'object') return null;
  const ip = String(b.ip || '').trim();
  if (!ip || ip.length > 255 || !/^[a-zA-Z0-9.:_-]+$/.test(ip)) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const quedas = Array.isArray(b.quedas)
    ? b.quedas.slice(0, 200)
      .map((q) => ({ inicio: num(q && q.inicio), fim: num(q && q.fim) }))
      .filter((q) => q.inicio !== null)
    : [];
  return {
    ip,
    inicio: num(b.inicio) || Date.now(),
    fim: num(b.fim) || Date.now(),
    total: Math.max(0, Math.round(num(b.total) || 0)),
    perdidos: Math.max(0, Math.round(num(b.perdidos) || 0)),
    media: num(b.media), min: num(b.min), max: num(b.max),
    quedas,
  };
}

function fmtQuando(ms) {
  return new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
}
function fmtHora(ms) {
  return new Date(ms).toLocaleTimeString('pt-BR');
}
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  return `${hh}:${mm}:${String(s % 60).padStart(2, '0')}`;
}
function fmtMs(v) { return v != null ? `${Number(v).toFixed(1)} ms` : '—'; }

// O HTML do PDF: A4, limpo, com resumo em cartões e a tabela de quedas.
function htmlRelatorioMonitor(dados) {
  const d = dados;
  const perdaPct = d.total ? Math.round((d.perdidos / d.total) * 100) : 0;
  const linhasQuedas = d.quedas.map((q, i) => {
    const fimQ = q.fim || d.fim;
    const aberta = !q.fim;
    return `<tr>
      <td>${i + 1}ª</td>
      <td>${escapa(fmtHora(q.inicio))}</td>
      <td>${aberta ? 'em queda ao encerrar' : escapa(fmtHora(q.fim))}</td>
      <td>${escapa(fmtDur(fimQ - q.inicio))}</td>
    </tr>`;
  }).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; color: #1c2430; padding: 34px 40px; font-size: 13px; }
    .topo { display: flex; align-items: baseline; justify-content: space-between; border-bottom: 3px solid #00c9b1; padding-bottom: 12px; }
    .topo h1 { font-size: 20px; }
    .topo .marca { color: #667; font-size: 12px; }
    .host { font-size: 26px; font-weight: 800; font-family: 'SF Mono', Menlo, Consolas, monospace; margin: 18px 0 4px; }
    .periodo { color: #556; margin-bottom: 18px; }
    .cards { display: flex; gap: 10px; margin-bottom: 22px; }
    .card { flex: 1; border: 1px solid #d8dee6; border-radius: 8px; padding: 12px 10px; text-align: center; }
    .card b { display: block; font-size: 19px; font-family: 'SF Mono', Menlo, Consolas, monospace; }
    .card.ruim b { color: #c62828; }
    .card span { color: #667; font-size: 10.5px; text-transform: uppercase; letter-spacing: .4px; }
    h2 { font-size: 14px; margin: 20px 0 8px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #e3e8ee; font-size: 12.5px; }
    th { background: #f2f5f8; color: #445; text-transform: uppercase; font-size: 10.5px; letter-spacing: .4px; }
    .ok { color: #1b7f4d; font-weight: 600; }
    .rodape { margin-top: 28px; padding-top: 10px; border-top: 1px solid #e3e8ee; color: #778; font-size: 11px; display: flex; justify-content: space-between; }
  </style></head><body>
    <div class="topo"><h1>Relatório de monitoramento de IP</h1><span class="marca">Vincii Canvas</span></div>
    <div class="host">${escapa(d.ip)}</div>
    <div class="periodo">${escapa(fmtQuando(d.inicio))} &rarr; ${escapa(fmtQuando(d.fim))} &nbsp;·&nbsp; duração ${escapa(fmtDur(d.fim - d.inicio))}</div>
    <div class="cards">
      <div class="card"><b>${d.total}</b><span>pacotes enviados</span></div>
      <div class="card${d.perdidos ? ' ruim' : ''}"><b>${d.perdidos}</b><span>perdidos</span></div>
      <div class="card${perdaPct ? ' ruim' : ''}"><b>${perdaPct}%</b><span>perda</span></div>
      <div class="card"><b>${escapa(fmtMs(d.min))}</b><span>latência mín</span></div>
      <div class="card"><b>${escapa(fmtMs(d.media))}</b><span>latência média</span></div>
      <div class="card"><b>${escapa(fmtMs(d.max))}</b><span>latência máx</span></div>
    </div>
    <h2>Quedas registradas</h2>
    ${d.quedas.length
      ? `<table><thead><tr><th>#</th><th>Início</th><th>Fim</th><th>Duração</th></tr></thead><tbody>${linhasQuedas}</tbody></table>`
      : '<p class="ok">Nenhuma queda — o host respondeu durante todo o período monitorado.</p>'}
    <div class="rodape"><span>Gerado pelo Vincii Canvas em ${escapa(fmtQuando(Date.now()))}</span><span>ping a cada 1 s · alarme após 3 perdas seguidas</span></div>
  </body></html>`;
}

// ---------- relatório de MTR (rota + ping por salto) ----------

function normalizarDadosMtr(b) {
  if (!b || typeof b !== 'object') return null;
  const host = String(b.host || '').trim();
  if (!host || host.length > 255 || !/^[a-zA-Z0-9.:_-]+$/.test(host)) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const hops = Array.isArray(b.hops) ? b.hops.slice(0, 40).map((h) => ({
    n: Math.max(0, Math.round(num(h && h.n) || 0)),
    ip: (h && typeof h.ip === 'string' && /^[a-zA-Z0-9.:]+$/.test(h.ip)) ? h.ip : null,
    total: Math.max(0, Math.round(num(h && h.total) || 0)),
    perdidos: Math.max(0, Math.round(num(h && h.perdidos) || 0)),
    media: num(h && h.media), melhor: num(h && h.melhor), pior: num(h && h.pior),
  })) : [];
  return {
    host,
    inicio: num(b.inicio) || Date.now(),
    fim: num(b.fim) || Date.now(),
    hops,
  };
}

function htmlRelatorioMtr(d) {
  const linhas = d.hops.map((h) => {
    const perda = h.total ? Math.round((h.perdidos / h.total) * 100) : 0;
    return `<tr>
      <td>${h.n}</td>
      <td>${escapa(h.ip || '???')}</td>
      <td class="${perda > 0 ? 'ruim' : ''}">${perda}%</td>
      <td>${h.total}</td>
      <td>${escapa(fmtMs(h.melhor))}</td>
      <td>${escapa(fmtMs(h.media))}</td>
      <td>${escapa(fmtMs(h.pior))}</td>
    </tr>`;
  }).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; color: #1c2430; padding: 34px 40px; font-size: 13px; }
    .topo { display: flex; align-items: baseline; justify-content: space-between; border-bottom: 3px solid #00c9b1; padding-bottom: 12px; }
    .topo h1 { font-size: 20px; } .topo .marca { color: #667; font-size: 12px; }
    .host { font-size: 26px; font-weight: 800; font-family: 'SF Mono', Menlo, Consolas, monospace; margin: 18px 0 4px; }
    .periodo { color: #556; margin-bottom: 18px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #e3e8ee; font-size: 12.5px; font-family: 'SF Mono', Menlo, Consolas, monospace; }
    th { background: #f2f5f8; color: #445; text-transform: uppercase; font-size: 10.5px; letter-spacing: .4px; font-family: -apple-system, sans-serif; }
    td.ruim { color: #c62828; font-weight: 700; }
    .rodape { margin-top: 28px; padding-top: 10px; border-top: 1px solid #e3e8ee; color: #778; font-size: 11px; display: flex; justify-content: space-between; }
  </style></head><body>
    <div class="topo"><h1>Relatório de MTR — rota e ping por salto</h1><span class="marca">Vincii Canvas</span></div>
    <div class="host">${escapa(d.host)}</div>
    <div class="periodo">${escapa(fmtQuando(d.inicio))} &rarr; ${escapa(fmtQuando(d.fim))} &nbsp;·&nbsp; duração ${escapa(fmtDur(d.fim - d.inicio))} &nbsp;·&nbsp; ${d.hops.length} saltos</div>
    <table><thead><tr><th>#</th><th>Endereço</th><th>Perda</th><th>Enviados</th><th>Melhor</th><th>Média</th><th>Pior</th></tr></thead>
    <tbody>${linhas || '<tr><td colspan="7">Nenhum salto medido.</td></tr>'}</tbody></table>
    <div class="rodape"><span>Gerado pelo Vincii Canvas em ${escapa(fmtQuando(Date.now()))}</span><span>ping a cada 1 s em cada salto · rota via traceroute</span></div>
  </body></html>`;
}

// ---------- o gerador injetado pelo Electron ----------
let gerador = null; // (html) => Promise<Buffer>
function definirGerador(fn) { gerador = typeof fn === 'function' ? fn : null; }
function disponivel() { return !!gerador; }
function gerarPdf(html) {
  if (!gerador) return Promise.reject(new Error('PDF disponível apenas no app instalado.'));
  return gerador(html);
}

module.exports = {
  normalizarDados, htmlRelatorioMonitor,
  normalizarDadosMtr, htmlRelatorioMtr,
  definirGerador, disponivel, gerarPdf, _escapa: escapa,
};
