'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const express = require('express');

const store = require('./lib/store');
const runner = require('./lib/runner');
const { wss: termWss } = require('./lib/terminal');
const { wss: localWss } = require('./lib/localterm');
const ai = require('./lib/ai');
const agent = require('./lib/agent');
const history = require('./lib/history');
const quickhosts = require('./lib/quickhosts');
const files = require('./lib/files');
const desktop = require('./lib/desktop');
const rdp = require('./lib/rdp');
const { mergeVars, parseCommands, expandAndResolve, VAR_NAME_RE } = require('./lib/vars');
const { buildXml } = require('./lib/exportxml');
const proto = require('./public/protocolos');
const weburl = require('./public/weburl');
const agendaLib = require('./public/agenda');
const presenca = require('./lib/presenca');
const credenciais = require('./lib/credenciais');
const cofres = require('./lib/cofres');
const segredosDeCofre = require('./lib/cofresegredos');
const janelasDeCofre = require('./lib/janelasdecofre');
const termsessions = require('./lib/termsessions');
const pkg = require('./package.json');

// Uma lista só. Ela vivia copiada em TRÊS pontos deste arquivo (cadastro,
// atualização e importação), e acrescentar 'cofre' em dois de três produziria
// exatamente o defeito que o backup já teve: o campo entra pela tela e some na
// restauração, sem erro nenhum.
const TIPOS_DE_AUTH = ['agent', 'key', 'password', 'cofre'];

const HOST = '127.0.0.1'; // apenas esta máquina — o app guarda credenciais e executa comandos
const PORT = Number(process.env.PORT || 3033);

const app = express();

// ---------- proteção contra acesso de páginas externas ----------
// O app escuta em 127.0.0.1, mas isso NÃO basta: (a) WebSocket não é coberto
// pela política de mesma origem — qualquer site aberto no navegador poderia
// abrir ws://localhost:3033/api/localterminal e ganhar um shell na máquina;
// (b) DNS rebinding faz um domínio do atacante resolver para 127.0.0.1 e as
// requisições passam a ser "mesma origem". Por isso validamos Host e Origin.
const ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// A ORIGEM completa (com porta) do próprio app, preenchida quando o servidor
// começa a escutar. Comparar só o hostname não basta: "localhost" sem porta
// deixaria qualquer outra página em localhost:<outra porta> — um servidor de
// desenvolvimento, um Jupyter, um painel local com XSS — abrir o terminal desta
// máquina pelo WebSocket (que não é coberto por CORS nem pela mesma origem).
let ALLOWED_ORIGINS = new Set();
function setAllowedOrigins(port) {
  ALLOWED_ORIGINS = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);
}

// Segredo por processo: vai no HTML servido (que só a própria origem consegue
// ler) e é exigido no WebSocket. Assim, mesmo que a checagem de origem falhe,
// uma página de fora não abre um terminal — ela não tem como descobrir o token.
const SESSION_TOKEN = crypto.randomBytes(32).toString('hex');
function tokenValido(valor) {
  const a = Buffer.from(String(valor || ''), 'utf8');
  const b = Buffer.from(SESSION_TOKEN, 'utf8');
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

function hostnameOf(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  // remove a porta preservando IPv6 entre colchetes
  const m = s.match(/^(\[[^\]]+\]|[^:]+)(?::\d+)?$/);
  return m ? m[1].toLowerCase() : null; // não parseável → falha fechando
}

// Origin ausente = cliente não navegador (curl, app nativo): permitido, pois
// já roda com os privilégios do usuário. Origin presente PRECISA ser este app,
// com a porta exata — não basta ser "algum localhost".
function originAllowed(origin) {
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(String(origin).trim());
}

function requestAllowed(req) {
  const host = hostnameOf(req.headers && req.headers.host);
  if (host !== null && !ALLOWED_HOSTNAMES.has(host)) return false; // DNS rebinding
  if (host === null && req.headers && req.headers.host) return false; // Host estranho
  return originAllowed(req.headers && req.headers.origin);
}

app.use((req, res, next) => {
  if (!requestAllowed(req)) {
    res.status(403).json({ error: 'Origem não autorizada.' });
    return;
  }
  next();
});

app.use(express.json({ limit: '1mb' }));
// ---------- preferências da interface ----------
// No app desktop o servidor sobe numa porta ALEATÓRIA a cada abertura, e o
// localStorage do navegador é por origem — então tudo que ficasse só no
// navegador se perderia a cada reinício (recentes, tema, painéis…). Por isso as
// preferências moram no data.json e são injetadas no HTML já na carga da
// página, evitando também o "flash" de tema errado.
function uiPrefs() {
  const d = store.get();
  if (!d.settings || typeof d.settings !== 'object' || Array.isArray(d.settings)) d.settings = {};
  if (!d.settings.ui || typeof d.settings.ui !== 'object' || Array.isArray(d.settings.ui)) d.settings.ui = {};
  return d.settings.ui;
}

const INDEX_PATH = path.join(__dirname, 'public', 'index.html');
function serveIndex(req, res) {
  let html;
  try { html = fs.readFileSync(INDEX_PATH, 'utf8'); } catch { return fail(res, 500, 'index.html não encontrado.'); }
  // "<" escapado para o JSON nunca fechar a tag <script> por acidente.
  // A substituição usa FUNÇÃO: como string, o replace interpretaria $&, $` e $'
  // dentro do JSON e injetaria pedaços do HTML de volta no script.
  const json = JSON.stringify(uiPrefs()).replace(/</g, '\\u003c');
  const token = JSON.stringify(SESSION_TOKEN);
  res.type('html')
    .set('X-Frame-Options', 'DENY')
    .set('X-Content-Type-Options', 'nosniff')
    .set('Referrer-Policy', 'no-referrer')
    .send(html
      .replace('/*__VC_PREFS__*/ null', () => json)
      .replace('/*__VC_TOKEN__*/ ""', () => token));
}
app.get('/', serveIndex);
app.get('/index.html', serveIndex);

app.use(express.static(path.join(__dirname, 'public')));

// Assets do terminal (xterm.js) servidos direto do pacote instalado.
// Alguns pacotes (noVNC) bloqueiam "./package.json" no campo exports, então
// require.resolve falha — nesses casos caímos para o caminho em node_modules.
function pkgDir(id) {
  try {
    return path.dirname(require.resolve(id + '/package.json'));
  } catch {
    return path.join(__dirname, 'node_modules', ...id.split('/'));
  }
}
app.use('/vendor/xterm', express.static(pkgDir('@xterm/xterm')));
app.use('/vendor/addon-fit', express.static(pkgDir('@xterm/addon-fit')));
// Clientes de área de trabalho remota: noVNC (VNC) e ironrdp-wasm (RDP).
app.use('/vendor/novnc', express.static(pkgDir('@novnc/novnc')));
app.use('/vendor/ironrdp', express.static(pkgDir('ironrdp-wasm')));

function fail(res, status, error) {
  res.status(status).json({ error });
  return null;
}

// ---------- verificação de atualização (GitHub Releases, modo "avisar") ----------
// Lê o repositório do campo "repository" do package.json. Enquanto estiver com o
// placeholder (OWNER/REPO), a verificação fica desligada silenciosamente.
function parseRepo() {
  let r = pkg.repository;
  if (r && typeof r === 'object') r = r.url;
  if (!r || typeof r !== 'string') return null;
  const m = r.match(/github\.com[:/]+([^/]+)\/([^/#?]+)/i) || r.match(/^github:([^/]+)\/(.+)$/i);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/i, '');
  if (/^(owner|seu-usuario|example|usuario)$/i.test(owner) || /^(repo|repositorio|example)$/i.test(repo)) return null;
  return { owner, repo };
}

function cmpVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

let updateCache = { at: 0, data: null };

app.get('/api/update-check', async (req, res) => {
  const repo = parseRepo();
  if (!repo) return res.json({ configured: false, current: pkg.version, updateAvailable: false });
  const now = Date.now();
  if (updateCache.data && now - updateCache.at < 3600000) return res.json(updateCache.data);
  try {
    const r = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'vincii-canvas' },
    });
    if (!r.ok) throw new Error('GitHub respondeu ' + r.status);
    const j = await r.json();
    const latest = String(j.tag_name || j.name || '').replace(/^v/i, '').trim();
    const data = {
      configured: true,
      current: pkg.version,
      latest,
      updateAvailable: !!latest && cmpVersions(latest, pkg.version) > 0,
      url: j.html_url || `https://github.com/${repo.owner}/${repo.repo}/releases/latest`,
      name: j.name || latest,
      notes: String(j.body || '').slice(0, 4000),
      desktop: process.env.SSHC_DESKTOP === '1',
      platform: process.platform,
    };
    updateCache = { at: now, data };
    res.json(data);
  } catch (e) {
    res.json({ configured: true, current: pkg.version, updateAvailable: false, error: e.message });
  }
});

// Info da máquina local (para o botão "Meu computador" mostrar o login e o SO)
app.get('/api/local-info', (req, res) => {
  let user = '';
  try { user = os.userInfo().username; } catch {}
  const host = String(os.hostname() || '').replace(/\.local$/i, '');
  const shell = process.platform === 'win32'
    ? path.basename(process.env.COMSPEC || 'powershell.exe')
    : path.basename(process.env.SHELL || 'shell');
  res.json({ user, host, shell, platform: process.platform });
});

// ---------- coordenação entre janelas (agenda de hosts) ----------
//
// Um host com agenda precisa estar aberto durante a faixa de horário dele. Quem
// cuida disso é a janela principal — mas ela só enxerga as próprias abas, e uma
// aba solta numa janela separada é invisível para ela. Sem estas três rotas, um
// host agendado e solto numa janela própria abriria uma conexão DUPLICADA a cada
// tique do relógio.
//
// Nada aqui é persistido: é estado de tela, morre com o processo.

// Batida de ponto: "esta janela existe e está mostrando estes hosts".
app.post('/api/presenca', (req, res) => {
  const b = req.body || {};
  presenca.anunciar(b.janela, b.itens);
  res.status(204).end();
});

// Aviso de fechamento (via sendBeacon). Só antecipa o que o prazo já faria —
// por isso responde 204 mesmo para janela desconhecida.
app.post('/api/presenca/sair', (req, res) => {
  presenca.sair((req.body || {}).janela);
  res.status(204).end();
});

// O que a janela principal precisa saber para decidir se abre algo:
// quem está com o quê, e quais sessões de terminal estão vivas mas sem janela
// (o caso de alguém ter fechado a janela solta — a sessão continua rodando e
// precisa VOLTAR para a aba do Terminal, não morrer nem duplicar).
app.get('/api/janelas', (req, res) => {
  res.json({
    presenca: presenca.listar(),
    // O `id` só sai para sessões ÓRFÃS.
    //
    // Quem tem o id reata: `atacar` expulsa a janela anterior, entrega os
    // últimos 256 KB de saída acumulada e passa a escrever no shell. Publicar o
    // id de toda sessão VIVA transformava esta rota numa lista de alvos — e a
    // janela principal nunca precisou disso: para saber que outra janela está
    // com um host, basta CONTAR as sessões ligadas e comparar com as próprias.
    //
    // Órfã é outra coisa: ela não tem janela nenhuma olhando, existe justamente
    // para ser reatada, e morre no TTL de 5 min. O id dela é o mecanismo.
    //
    // Isto reduz a exposição, não fecha a porta: o token do processo vai no HTML
    // e qualquer processo local que fale HTTP consegue lê-lo — o que é anterior
    // a esta rota e vale para o app inteiro (ver a seção Segurança do README).
    sessoes: termsessions.listar().map((s) => ({
      id: s.orfaDesde ? s.id : null,
      hostId: s.hostId,
      ligada: s.ligada,
      orfa: !!s.orfaDesde,
    })),
  });
});

// ---------- cofres de credenciais ----------
//
// A senha de um host pode morar num cofre externo. Estas rotas configuram os
// cofres e ajudam a escolher o segredo — NENHUMA delas devolve valor de
// segredo ao navegador. A leitura do valor acontece só no momento da conexão,
// dentro do processo (lib/credenciais.js), e para RDP/VNC pela rota própria.

function cofrePublico(c) {
  const adapt = cofres.pegar(c.tipo);
  const guardados = segredosDeCofre.pegar(c.apelido);
  return {
    apelido: c.apelido,
    tipo: c.tipo,
    nome: c.nome || (adapt ? adapt.nome : c.tipo),
    config: { ...(c.config || {}) },       // só os campos NÃO secretos moram aqui
    // Nunca o valor: só se existe. É o que a tela precisa para mostrar
    // "(preenchido — deixe em branco para manter)".
    preenchidos: (adapt ? adapt.config.filter((f) => f.segredo).map((f) => f.chave) : [])
      .filter((k) => !!guardados[k]),
    certificadoFixado: c.certificadoFixado || null,
    desconhecido: !adapt,
  };
}

app.get('/api/cofres', (req, res) => {
  janelasDeCofre.renovarSeVencido();
  res.json({
    catalogo: cofres.catalogo(),
    cofres: credenciais.listaDeCofres().map(cofrePublico),
    // Estado descritivo, e NÃO um booleano obtido perguntando ao sistema: a
    // pergunta abre o Keychain, e desenhar tela não é motivo para isso.
    protecao: segredosDeCofre.estadoDaProtecao(),
    usarSistema: (store.get().settings || {}).cofreChavesNoSistema !== false,
    // Clientes e horários de atendimento já conhecidos, para a tela mostrar sem
    // ir ao ERP. Pode vir vazio na primeira abertura: a busca é assíncrona.
    janelas: janelasDeCofre.estado(),
  });
});

// Liga ou desliga o armazenamento protegido do sistema para as chaves de cofre.
app.put('/api/cofres/protecao', (req, res) => {
  const usar = (req.body || {}).usarSistema !== false;
  const d = store.get();
  if (!d.settings || typeof d.settings !== 'object') d.settings = {};
  d.settings.cofreChavesNoSistema = usar;
  store.save();
  segredosDeCofre.definirPreferencia(usar);
  // Regrava o que já existe no regime novo. Sem isto, desligar deixaria as
  // chaves antigas presas no Keychain — e o usuário seguiria sendo perguntado.
  let regravadas = 0;
  for (const c of d.cofres || []) {
    const atual = segredosDeCofre.pegar(c.apelido);
    if (Object.keys(atual).length) { segredosDeCofre.definir(c.apelido, atual); regravadas += 1; }
  }
  res.json({ protecao: segredosDeCofre.estadoDaProtecao(), regravadas });
});

const RE_APELIDO = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

app.post('/api/cofres', (req, res) => {
  const b = req.body || {};
  const apelido = String(b.apelido || '').trim().toLowerCase();
  // O apelido é o que o backup carrega, e é por ele que o host encontra o cofre
  // noutra máquina. Formato restrito para não virar um id frágil cheio de
  // espaço e acento.
  if (!RE_APELIDO.test(apelido)) {
    return fail(res, 400, 'Apelido inválido. Use letras minúsculas, números e hífen (3 a 40).');
  }
  const adapt = cofres.pegar(b.tipo);
  if (!adapt) return fail(res, 400, 'Tipo de cofre desconhecido.');

  const d = store.get();
  if (!Array.isArray(d.cofres)) d.cofres = [];
  const existente = d.cofres.find((c) => c.apelido === apelido);
  const editando = String(b.apelidoAtual || '').trim().toLowerCase();
  if (existente && existente.apelido !== editando) {
    return fail(res, 400, `Já existe um cofre com o apelido "${apelido}".`);
  }

  const config = {};
  const segredos = {};
  for (const campo of adapt.config) {
    const valor = (b.config || {})[campo.chave];
    if (campo.segredo) {
      // Campo em branco = manter o que está guardado. É como a tela reexibe um
      // cofre já configurado sem nunca receber a chave de volta.
      if (valor) segredos[campo.chave] = String(valor);
      continue;
    }
    const texto = String(valor === undefined || valor === null ? (campo.padrao || '') : valor).trim();
    if (campo.obrigatorio && !texto) return fail(res, 400, `Preencha "${campo.rotulo}".`);
    config[campo.chave] = texto.slice(0, 500);
  }

  const alvo = editando ? d.cofres.find((c) => c.apelido === editando) : null;
  if (alvo) {
    const mudouApelido = alvo.apelido !== apelido;
    const anterior = alvo.apelido;
    Object.assign(alvo, { apelido, tipo: adapt.tipo, nome: String(b.nome || adapt.nome).slice(0, 80), config });
    if (mudouApelido) {
      segredosDeCofre.renomear(anterior, apelido);
      // O cache de janelas é indexado por apelido; sem esquecer o antigo, ele
      // vira lixo permanente na memória e os hosts reapontados ficam sem
      // horário até a próxima renovação.
      janelasDeCofre.esquecer(anterior);
      // Renomear reaponta todo host que usava o apelido antigo. Sem isto eles
      // ficariam órfãos silenciosamente, com o erro só aparecendo na conexão.
      let reapontados = 0;
      for (const h of d.hosts || []) {
        if (h.segredo && h.segredo.cofre === anterior) { h.segredo.cofre = apelido; reapontados += 1; }
      }
      if (reapontados) console.error(`[cofres] ${reapontados} host(s) reapontados de "${anterior}" para "${apelido}"`);
    }
  } else {
    d.cofres.push({ apelido, tipo: adapt.tipo, nome: String(b.nome || adapt.nome).slice(0, 80), config });
  }
  if (Object.keys(segredos).length) segredosDeCofre.definir(apelido, segredos);
  store.save();
  res.json({ cofre: cofrePublico(credenciais.cofrePorApelido(apelido)) });
});

app.delete('/api/cofres/:apelido', (req, res) => {
  const apelido = String(req.params.apelido || '');
  const d = store.get();
  const i = (d.cofres || []).findIndex((c) => c.apelido === apelido);
  if (i < 0) return fail(res, 404, 'Cofre não encontrado.');
  const orfaos = (d.hosts || []).filter((h) => h.segredo && h.segredo.cofre === apelido).map((h) => h.name);
  d.cofres.splice(i, 1);
  store.save();
  segredosDeCofre.remover(apelido);
  janelasDeCofre.esquecer(apelido);
  // Os hosts NÃO são apagados junto: eles continuam lá, apontando para um cofre
  // que não existe mais, e a tela mostra isso. Apagar host por causa de uma
  // configuração removida seria destruir dado que o usuário não mandou destruir.
  res.json({ removido: apelido, hostsOrfaos: orfaos });
});

app.post('/api/cofres/:apelido/testar', async (req, res) => {
  const apelido = String(req.params.apelido || '');
  try {
    const info = await credenciais.ping(apelido);
    // O teste já falou com o cofre; aproveitar a resposta evita o usuário salvar
    // e ficar até cinco minutos sem ver o horário de atendimento aparecer.
    janelasDeCofre.renovarAgora(apelido).catch(() => {});
    res.json({ ok: true, info });
  } catch (e) {
    res.status(200).json({ ok: false, codigo: e.codigo || 'indisponivel', mensagem: e.message });
  }
});

app.post('/api/cofres/:apelido/esquecer-certificado', (req, res) => {
  const c = credenciais.cofrePorApelido(String(req.params.apelido || ''));
  if (!c) return fail(res, 404, 'Cofre não encontrado.');
  delete c.certificadoFixado;
  store.save();
  res.json({ ok: true });
});

app.get('/api/cofres/:apelido/segredos', async (req, res) => {
  try {
    const r = await credenciais.listarSegredos(String(req.params.apelido || ''), {
      busca: req.query.busca, cursor: req.query.cursor, limite: req.query.limite,
      // O adaptador chama de "cofre" o que a tela chama de "cliente" — é o mesmo
      // id. A tradução acontece AQUI, num lugar só, para a tela não precisar
      // aprender o vocabulário de cada produto.
      cofre: req.query.cliente,
    });
    res.set('Cache-Control', 'no-store');
    res.json(r);
  } catch (e) {
    res.status(200).json({ erro: { codigo: e.codigo || 'indisponivel', mensagem: e.message }, itens: [] });
  }
});

app.get('/api/prefs', (req, res) => res.json(uiPrefs()));

app.put('/api/prefs', (req, res) => {
  const b = req.body || {};
  const ui = uiPrefs();
  if (b.theme === 'light' || b.theme === 'dark') ui.theme = b.theme;
  if (Array.isArray(b.recentHosts)) {
    ui.recentHosts = b.recentHosts.filter((x) => typeof x === 'string' && x.length < 80).slice(0, 30);
  }
  for (const k of ['greetHidden', 'aiCollapsed', 'sidebarCollapsed']) {
    if (typeof b[k] === 'boolean') ui[k] = b[k];
  }
  if (typeof b.updateDismissed === 'string') ui.updateDismissed = b.updateDismissed.slice(0, 40);
  store.save();
  res.json(ui);
});

// ---------- gerenciador de arquivos (SFTP / FTP / local) ----------
// Sessões de arquivo ficam em memória, uma por painel remoto aberto. A
// transferência entre painéis é feita AQUI, servidor↔servidor: o conteúdo não
// passa pelo navegador, então arquivo grande não vira memória na aba.
const fileSessions = new Map();
const FILE_SESSION_TTL = 30 * 60 * 1000;

function limpaFileSessions() {
  const agora = Date.now();
  for (const [id, s] of fileSessions) {
    if (agora - s.usadaEm > FILE_SESSION_TTL) {
      try { s.client.close(); } catch {}
      fileSessions.delete(id);
    }
  }
}

function ladoDe(body, res) {
  limpaFileSessions(); // recicla sessões vencidas em toda operação, não só ao abrir
  const lado = (body && body.side) || 'local';
  if (lado === 'local') return files.local;
  const s = fileSessions.get(String((body && body.sessionId) || ''));
  if (!s) { fail(res, 400, 'Sessão de arquivos expirada — reconecte o painel.'); return null; }
  s.usadaEm = Date.now();
  return s.client;
}

app.post('/api/files/open', async (req, res) => {
  limpaFileSessions();
  const b = req.body || {};
  const host = store.get().hosts.find((h) => h.id === b.hostId) || quickhosts.get(b.hostId);
  if (!host) return fail(res, 400, 'Host não encontrado.');
  if (fileSessions.size >= 20) return fail(res, 400, 'Muitos painéis de arquivo abertos.');
  try {
    const client = await files.openRemote(host, {
      onSaveFingerprint: (fp) => { host.fingerprint = fp; store.save(); },
    });
    const id = 'fs_' + crypto.randomUUID();
    fileSessions.set(id, { client, host, usadaEm: Date.now() });
    res.json({
      sessionId: id,
      protocol: client.tipo,
      secure: !!client.seguro,
      certVerificado: client.certificadoVerificado !== false,
      path: client.home(),
      hostName: host.name,
    });
  } catch (err) {
    fail(res, 400, err && err.message ? err.message : String(err));
  }
});

app.post('/api/files/close', (req, res) => {
  const s = fileSessions.get(String((req.body || {}).sessionId || ''));
  if (s) { try { s.client.close(); } catch {} fileSessions.delete(String(req.body.sessionId)); }
  res.json({ ok: true });
});

app.post('/api/files/list', async (req, res) => {
  const c = ladoDe(req.body, res);
  if (!c) return;
  try { res.json(await c.list(String((req.body || {}).path || ''))); }
  catch (err) { fail(res, 400, err && err.message ? err.message : String(err)); }
});

// operações simples: criar pasta, renomear, excluir, permissões
for (const [rota, exec] of [
  ['mkdir', (c, b) => c.mkdir(b.path, b.name)],
  ['rename', (c, b) => c.rename(b.path, b.name, b.newName)],
  ['delete', (c, b) => c.remove(b.path, b.name)],
  ['chmod', (c, b) => c.chmod(b.path, b.name, parseInt(String(b.mode), 8) & 0o777)],
]) {
  app.post('/api/files/' + rota, async (req, res) => {
    const c = ladoDe(req.body, res);
    if (!c) return;
    const b = req.body || {};
    const nome = String(b.name || '');
    if (!nome || nome === '.' || nome === '..' || nome.includes('/')) return fail(res, 400, 'Nome inválido.');
    if (rota === 'rename') {
      const novo = String(b.newName || '');
      if (!novo || novo.includes('/') || novo === '.' || novo === '..') return fail(res, 400, 'Novo nome inválido.');
    }
    try { await exec(c, b); res.json({ ok: true }); }
    catch (err) { fail(res, 400, err && err.message ? err.message : String(err)); }
  });
}

app.post('/api/files/read', async (req, res) => {
  const c = ladoDe(req.body, res);
  if (!c) return;
  try { res.json({ content: await c.readText(String((req.body || {}).file || '')) }); }
  catch (err) { fail(res, 400, err && err.message ? err.message : String(err)); }
});

app.post('/api/files/write', async (req, res) => {
  const c = ladoDe(req.body, res);
  if (!c) return;
  const b = req.body || {};
  if (typeof b.content !== 'string') return fail(res, 400, 'Conteúdo inválido.');
  if (b.content.length > files.MAX_TEXT_BYTES) return fail(res, 400, 'Conteúdo grande demais.');
  try { await c.writeText(String(b.file || ''), b.content); res.json({ ok: true }); }
  catch (err) { fail(res, 400, err && err.message ? err.message : String(err)); }
});

// Transferência entre painéis (local↔remoto), feita no servidor.
app.post('/api/files/transfer', async (req, res) => {
  const b = req.body || {};
  const origem = ladoDe({ side: b.fromSide, sessionId: b.sessionId }, res);
  if (!origem) return;
  const destino = ladoDe({ side: b.toSide, sessionId: b.sessionId }, res);
  if (!destino) return;
  const nome = String(b.name || '');
  if (!nome || nome.includes('/') || nome === '.' || nome === '..') return fail(res, 400, 'Nome inválido.');
  const de = files.joinRemote(String(b.fromPath || ''), nome).replace(/^\/\//, '/');
  const paraDir = String(b.toPath || '');
  const para = (b.toSide === 'local' ? path.join(paraDir, nome) : files.joinRemote(paraDir, nome));
  const deLocal = (b.fromSide === 'local' ? path.join(String(b.fromPath || ''), nome) : de);
  try {
    await transferir(origem, deLocal, destino, para);
    res.json({ ok: true });
  } catch (err) {
    fail(res, 400, err && err.message ? err.message : String(err));
  }
});

// Copia um arquivo de um cliente para outro. O FTP não expõe streams soltos
// (usa um canal de dados por vez), então tem caminho próprio.
function transferir(origem, caminhoOrigem, destino, caminhoDestino) {
  return new Promise((resolve, reject) => {
    if (origem.tipo === 'ftp') {
      // FTP → (local/sftp): o cliente FTP escreve no stream de destino
      const w = destino.writeStream(caminhoDestino);
      w.on('error', reject);
      origem.downloadTo(w, caminhoOrigem).then(resolve, reject);
      return;
    }
    if (destino.tipo === 'ftp') {
      // (local/sftp) → FTP: o cliente FTP lê do stream de origem
      const r = origem.readStream(caminhoOrigem);
      r.on('error', reject);
      destino.uploadFrom(r, caminhoDestino).then(resolve, reject);
      return;
    }
    const r = origem.readStream(caminhoOrigem);
    const w = destino.writeStream(caminhoDestino);
    r.on('error', reject);
    w.on('error', reject);
    w.on('close', resolve);
    w.on('finish', resolve);
    r.pipe(w);
  });
}

// Diz como a última conexão RDP a este host foi negociada. A interface usa
// isto para avisar quando a sessão caiu no modo legado, em que o servidor não
// é autenticado — o usuário não escolhe o modo, mas tem que saber qual saiu.
app.get('/api/rdp/modo', (req, res) => {
  res.json(rdp.modoDe(String(req.query.hostId || '')));
});

// Registra que o usuário aceitou falar RDP antigo com este host. Fica na
// memória do processo para hosts avulsos e no data.json para hosts salvos —
// perguntar de novo a cada abertura do app seria ruído, e o usuário já decidiu.
app.post('/api/rdp/consentir', (req, res) => {
  const corpo = req.body || {};
  if (!tokenValido(corpo.token)) return fail(res, 403, 'Token inválido.');
  const id = String(corpo.hostId || '');
  const host = store.get().hosts.find((h) => h.id === id) || quickhosts.get(id);
  if (!host) return fail(res, 404, 'Host não encontrado.');
  if (host.protocol !== 'rdp') return fail(res, 400, 'Este host não é RDP.');
  rdp.consentir(id);
  const salvo = store.get().hosts.find((h) => h.id === id);
  if (salvo) { salvo.rdpLegadoOk = true; store.save(); }
  res.json({ ok: true });
});

// A senha de um host NUNCA sai daqui pelas rotas normais (ver publicHost).
// Esta é a única exceção, e é deliberada: quem autentica nas áreas de trabalho
// remotas é o código que roda no navegador — o CredSSP do RDP no WebAssembly, e
// a autenticação do VNC dentro do noVNC. A credencial precisa chegar lá.
//
// Barreiras: guarda de origem (como todas as rotas) MAIS o token do processo,
// que não está em disco e é sorteado a cada abertura do app. É POST para a
// credencial nunca aparecer em URL, histórico ou log de acesso.
app.post('/api/desktop/credencial', async (req, res) => {
  const corpo = req.body || {};
  if (!tokenValido(corpo.token)) return fail(res, 403, 'Token inválido.');
  const host = store.get().hosts.find((h) => h.id === corpo.hostId) || quickhosts.get(corpo.hostId);
  if (!host) return fail(res, 404, 'Host não encontrado.');
  if (host.protocol !== 'rdp' && host.protocol !== 'vnc') {
    return fail(res, 400, 'Este host não é de área de trabalho remota.');
  }
  const padrao = proto.portaPadrao(host.protocol);
  res.set('Cache-Control', 'no-store');
  // RDP e VNC rodam no RENDERER (IronRDP em WebAssembly, noVNC), então a senha
  // precisa chegar até lá — é assim desde antes do cofre e não muda com ele. O
  // que muda é a origem: com cofre, ela é buscada agora e nunca existiu em
  // disco. Prometer "a senha nunca sai do servidor" seria mentira nestes dois
  // protocolos, e o descritivo (docs/cofres-de-credenciais.md) diz isso.
  let cred;
  try {
    cred = await credenciais.resolver(host);
  } catch (e) {
    return fail(res, 502, `Cofre de credenciais: ${e.message}`);
  }
  try {
    res.json({
      protocolo: host.protocol,
      username: host.username || cred.usuario || '',
      password: cred.password || '',
      domain: host.rdpDomain || '',
      destino: `${host.host}:${host.port || padrao}`,
    });
  } finally {
    // A credencial some do cadastro de redação assim que a resposta sai: daqui
    // em diante quem a guarda é o renderer, pelo tempo do handshake.
    cred.dispose();
  }
});

// ---------- histórico de comandos ----------
// Resolve os metadados da máquina (nome/IP/usuário) a partir do host ou do local,
// no servidor — o cliente nunca dita esses dados (evita spoofing e mantém consistência).
function historyMeta(hostId, local) {
  if (local) {
    let user = '';
    try { user = os.userInfo().username; } catch {}
    return {
      machine: String(os.hostname() || '').replace(/\.local$/i, ''),
      ip: history.localIp(),
      username: user,
      port: null,
      local: true,
      hostId: null,
    };
  }
  const h = store.get().hosts.find((x) => x.id === hostId) || quickhosts.get(hostId);
  if (!h) return null;
  return { machine: h.name, ip: h.host, username: h.username, port: h.port || 22, local: false, hostId: h.id };
}

// Conexão rápida: cria um host avulso (não salvo em data.json) e devolve um id
// temporário que o terminal usa para conectar. Some quando o app fecha.
app.post('/api/quick-connect', (req, res) => {
  const b = req.body || {};
  const host = String(b.host || '').trim();
  const username = String(b.username || '').trim();
  // FTP fica de fora de propósito: transferência de arquivo não abre sessão.
  const protocol = proto.PROTOCOLOS_SESSAO.includes(b.protocol) ? b.protocol : 'ssh';
  if (!host) return fail(res, 400, 'Informe o host ou IP.');
  // RDP e VNC podem ir sem usuário e sem senha: nesse caso a própria máquina
  // remota mostra a tela de login dela, que é o comportamento normal do xrdp e
  // do Windows quando o cliente não manda credencial.
  if (!username && protocol === 'ssh') return fail(res, 400, 'Informe o usuário.');
  // Numa página web o campo "host" carrega a URL inteira: quem define endereço e
  // porta é ela, e a validação é a mesma do cadastro salvo (só http e https).
  let url = '';
  let porta = Number(b.port) || proto.portaPadrao(protocol);
  let endereco = host;
  if (protocol === 'web') {
    const partes = weburl.partesDaUrl(host);
    if (!partes) return fail(res, 400, 'URL inválida. Use um endereço http:// ou https://.');
    url = partes.url; endereco = partes.host; porta = partes.port;
  }
  const port = Math.min(65535, Math.max(1, porta));
  const a = b.auth || {};
  const type = TIPOS_DE_AUTH.includes(a.type) ? a.type : 'agent';
  const auth = { type };
  if (type === 'key') {
    auth.keyPath = String(a.keyPath || '').trim();
    if (a.passphrase) auth.passphrase = String(a.passphrase);
  } else if (type === 'password') {
    auth.password = String(a.password || '');
  }
  const name = String(b.name || '').trim() || (username ? `${username}@${endereco}` : endereco);
  // Página web não tem login do lado do app — guardar credencial aqui seria
  // segredo parado sem nada que o consuma.
  const credencial = protocol === 'web' ? { type: 'agent' } : auth;
  // Referência a segredo de cofre também na conexão rápida: o host é efêmero, a
  // referência não guarda segredo nenhum, e sem isto o `type: 'cofre'` aceito
  // acima ficaria sem o que buscar — pior que não aceitar.
  let segredoRapido = null;
  if (credencial.type === 'cofre') {
    const b2 = b.segredo || {};
    const apelido = String(b2.cofre || '').trim();
    const idSegredo = String(b2.id || '').trim().slice(0, 200);
    if (!apelido || !idSegredo) return fail(res, 400, 'Escolha o cofre e o segredo.');
    segredoRapido = { cofre: apelido, id: idSegredo,
      cliente: String(b2.cliente || '').trim().slice(0, 200),
      rotulo: String(b2.rotulo || '').slice(0, 200) };
  }
  const id = quickhosts.add({ name, host: endereco, port, username: protocol === 'web' ? '' : username, protocol, url, auth: credencial, segredo: segredoRapido });
  res.json({ hostId: id, name, protocol, url });
});

app.get('/api/history', (req, res) => {
  const { source, hostId, q, limit, de, ate } = req.query || {};
  res.json({ entries: history.list({ source, hostId, q, limit, de, ate }) });
});

app.post('/api/history', (req, res) => {
  const b = req.body || {};
  const meta = historyMeta(b.hostId, b.local === true);
  if (!meta) return fail(res, 400, 'Host não encontrado.');
  const entry = history.add({ command: b.command, source: b.source, origin: b.origin, ...meta });
  if (!entry) return fail(res, 400, 'Comando vazio.');
  res.json({ entry });
});

app.delete('/api/history/:id', (req, res) => {
  history.remove(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/history', (req, res) => {
  history.clear();
  res.json({ ok: true });
});

function cleanVars(obj, res) {
  if (obj == null) return {};
  if (typeof obj !== 'object' || Array.isArray(obj)) return fail(res, 400, 'Formato de variáveis inválido.');
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!VAR_NAME_RE.test(key)) return fail(res, 400, `Nome de variável inválido: "${key}"`);
    out[key] = String(value);
  }
  return out;
}

// Nunca devolver senha/passphrase para o navegador
function publicHost(h) {
  const auth = h.auth || {};
  return {
    id: h.id,
    name: h.name,
    host: h.host,
    port: h.port,
    username: h.username,
    protocol: proto.normalizarProtocolo(h.protocol),
    ftps: h.ftps || 'auto',
    rdpDomain: h.rdpDomain || '',
    url: h.url || '',
    rdpLegadoOk: !!h.rdpLegadoOk,
    group: h.group || '',
    icon: h.icon || '',
    color: h.color || '',
    agenda: h.agenda || null,
    // Referência, não segredo: sem ela a tela não consegue mostrar de qual cofre
    // o host depende nem avisar quando esse cofre não está configurado.
    segredo: h.segredo || null,
    // O horário de atendimento do cliente, resolvido AQUI (o navegador não tem a
    // chave da API). Vale como agenda quando o host não tem uma própria: o cofre
    // recusa a credencial fora do horário, então manter aberto fora dele só
    // produziria um laço de conexões negadas.
    janelaDoCofre: janelasDeCofre.janelaDoHost(h),
    vars: h.vars || {},
    fingerprint: h.fingerprint || null,
    webCert: h.webCert || null,
    auth: {
      type: auth.type || 'agent',
      keyPath: auth.keyPath || null,
      hasPassword: !!auth.password,
      hasPassphrase: !!auth.passphrase,
    },
  };
}

function parseHostBody(body, res) {
  if (!body || typeof body !== 'object') return fail(res, 400, 'Corpo da requisição inválido.');
  const name = String(body.name || '').trim();
  if (!name) return fail(res, 400, 'Informe um nome para o host.');
  let hostAddr = String(body.host || '').trim();
  const protocol = proto.normalizarProtocolo(body.protocol);
  // Host de página web é definido pela URL: o endereço e a porta saem dela, para
  // o resto do app (grupo, busca, ícone) continuar tratando como host qualquer.
  let url = '';
  let port = Number(body.port || proto.portaPadrao(protocol));
  if (protocol === 'web') {
    const partes = weburl.partesDaUrl(body.url || body.host);
    if (!partes) return fail(res, 400, 'URL inválida. Use um endereço http:// ou https://.');
    url = partes.url;
    port = partes.port;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fail(res, 400, 'Porta inválida.');
  if (protocol === 'web') hostAddr = new URL(url).hostname;
  if (!hostAddr) return fail(res, 400, 'Informe o endereço do host.');
  const username = String(body.username || '').trim();
  // no Telnet o login é feito no próprio terminal do equipamento
  if (!username && protocol === 'ssh') return fail(res, 400, 'Informe o usuário SSH.');
  // 'confia' estava no <select> do formulário E implementado em lib/files.js
  // (confiaCertificado), mas fora desta lista: escolher "confiando no
  // certificado" gravava 'auto' em silêncio, e o usuário ficava sem a opção
  // que a tela oferecia.
  const ftps = proto.FTPS_MODOS.includes(body.ftps) ? body.ftps : 'auto';

  const a = body.auth || {};
  // Página web não autentica pelo app: quem pede usuário e senha é a página.
  const type = protocol === 'web' ? 'agent'
    : (TIPOS_DE_AUTH.includes(a.type) ? a.type : 'agent');
  const auth = { type };
  if (type === 'key') {
    auth.keyPath = String(a.keyPath || '').trim();
    if (!auth.keyPath) return fail(res, 400, 'Informe o caminho da chave privada.');
    if (a.passphrase) auth.passphrase = String(a.passphrase);
  }
  if (type === 'password' && a.password) auth.password = String(a.password);

  const vars = cleanVars(body.vars, res);
  if (vars === null) return null;
  const group = String(body.group || '').trim().slice(0, 60);
  const icon = slug(body.icon);
  const color = slug(body.color);
  const rdpDomain = String(body.rdpDomain || '').trim().slice(0, 80);
  // A agenda é validada pelo MESMO módulo que o navegador usa (public/agenda.js).
  // Duas validações separadas viravam duas regras: a tela aceitava 8:00 e o
  // servidor recusava, ou pior, o contrário.
  let agenda;
  try { agenda = agendaLib.normalizarAgenda(body.agenda); } catch (e) { return fail(res, 400, e.message); }
  // Referência ao segredo num cofre externo. NÃO é segredo: é apelido do cofre
  // + id do item, e sem ela um host de `type: cofre` não sabe o que buscar.
  let segredo = null;
  if (type === 'cofre') {
    const b2 = body.segredo || {};
    const apelido = String(b2.cofre || '').trim();
    const idSegredo = String(b2.id || '').trim().slice(0, 200);
    if (!apelido) return fail(res, 400, 'Escolha o cofre de credenciais deste host.');
    if (!idSegredo) return fail(res, 400, 'Escolha (ou informe) o segredo dentro do cofre.');
    // `cliente` é o id do cliente dentro do cofre. A API de segredos NÃO diz a
    // qual cliente cada segredo pertence (só a de sistemas diz), então é no
    // momento da escolha — quando a tela sabe por qual cliente filtrou — que
    // essa ligação se guarda. Sem ela não há como saber o horário de
    // atendimento deste host.
    const cliente = String(b2.cliente || '').trim().slice(0, 200);
    segredo = { cofre: apelido, id: idSegredo, cliente,
      rotulo: String(b2.rotulo || '').trim().slice(0, 200) };
  }
  return { name, host: hostAddr, port, username, protocol, ftps, rdpDomain, url, group, icon, color, agenda, segredo, auth, vars };
}

// slug curto para ícone/cor do avatar (defensivo): só [a-z0-9-], até 24 chars
function slug(v) {
  const s = String(v || '').trim().toLowerCase();
  return /^[a-z0-9-]{1,24}$/.test(s) ? s : '';
}

// ---------- exportar configuração (.xml) ----------
// POST de propósito (e não GET): numa navegação GET o navegador não envia
// Origin, então um site externo conseguiria disparar o download do arquivo COM
// SEGREDOS na pasta de downloads do usuário. Com POST o Origin vem sempre, e a
// guarda de origem barra. O front-end já baixa via fetch + Blob.
app.post('/api/export.xml', (req, res) => {
  const includeSecrets = req.query.secrets === '1' || req.query.secrets === 'true';
  const xml = buildXml(store.get(), { exportedAt: new Date().toISOString(), includeSecrets });
  const fname = includeSecrets ? 'ssh-commander-config-com-segredos.xml' : 'ssh-commander-config.xml';
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  // Caractere de controle não cabe em XML 1.0 e é removido na geração. Avisar é
  // o único conserto possível — sem isto o valor volta da restauração com
  // aparência normal e conteúdo diferente.
  if (buildXml.ultimosRemovidos) res.setHeader('X-Vincii-Removidos', String(buildXml.ultimosRemovidos));
  res.send(xml);
});

// ---------- importar configuração ----------
function asArray(v) {
  return Array.isArray(v) ? v : [];
}
// Atributo ausente no arquivo significa "não sei", não "apague". O export omite
// atributo vazio, então um backup feito num host sem grupo/ícone/cor chega aqui
// sem essas chaves — e aplicá-las como string vazia zerava o host existente,
// contra a promessa de que importar nunca apaga nada.
function opcional(v, transformar) {
  return v === undefined || v === null ? undefined : transformar(v);
}
function soDefinidos(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

// `descartadas` recebe os nomes recusados, para o chamador poder contar ao
// usuário. Sem isso, a importação dizia "0 ignorados" e a variável simplesmente
// não existia do outro lado — enquanto o ramo das variáveis GLOBAIS, poucas
// linhas abaixo, já reportava. Era inconsistência, não decisão.
function cleanVarsLenient(obj, descartadas) {
  const out = {};
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      if (VAR_NAME_RE.test(k)) out[k] = String(v);
      else if (Array.isArray(descartadas)) descartadas.push(k);
    }
  }
  return out;
}

// Recebe a configuração já parseada (o navegador faz o parse do XML) e faz
// upsert por nome — nada é apagado.
app.post('/api/import', (req, res) => {
  const body = req.body || {};
  // Trabalha sobre uma CÓPIA. A rota muta cinco coleções em sequência; se algo
  // estourasse no meio, as mutações já feitas continuavam vivas na memória e a
  // PRÓXIMA gravação de qualquer outra rota despejava a importação pela metade
  // no disco — com o usuário achando que nada tinha entrado, porque a tela
  // mostrou erro. Assim, ou entra tudo, ou não entra nada.
  const vivo = store.get();
  const d = structuredClone(vivo);
  // Um data.json de outra versão (ou editado à mão) pode trazer coleção com
  // tipo errado. Normaliza aqui em vez de estourar no meio do laço.
  for (const k of ['hosts', 'playbooks', 'profiles', 'favorites']) {
    if (!Array.isArray(d[k])) d[k] = [];
  }
  if (!d.globals || typeof d.globals !== 'object' || Array.isArray(d.globals)) d.globals = {};
  if (!d.settings || typeof d.settings !== 'object' || Array.isArray(d.settings)) d.settings = {};
  const summary = {
    globals: 0,
    profiles: { added: 0, updated: 0 },
    hosts: { added: 0, updated: 0 },
    playbooks: { added: 0, updated: 0 },
    settings: false,
    skipped: [],
    favorites: { added: 0, updated: 0 },
    prefs: false,
  };

  try {
    // Variáveis globais (merge de chaves)
    if (body.globals && typeof body.globals === 'object' && !Array.isArray(body.globals)) {
      for (const [k, v] of Object.entries(body.globals)) {
        if (VAR_NAME_RE.test(k)) { d.globals[k] = String(v); summary.globals++; }
        else summary.skipped.push('variável global inválida: ' + k);
      }
    }

    // Perfis
    for (const p of asArray(body.profiles)) {
      const name = String((p && p.name) || '').trim();
      if (!name) continue;
      const varsRuins = [];
    const vars = cleanVarsLenient(p.vars, varsRuins);
    for (const nome of varsRuins) summary.skipped.push(`perfil "${name}": variável ignorada por nome inválido: ${nome}`);
      const ex = d.profiles.find((x) => x.name === name);
      if (ex) { ex.vars = { ...(ex.vars || {}), ...vars }; summary.profiles.updated++; }
      else { d.profiles.push({ id: crypto.randomUUID(), name, vars }); summary.profiles.added++; }
    }

    // Hosts
    for (const h of asArray(body.hosts)) {
      const name = String((h && h.name) || '').trim();
      const hostAddr = String((h && h.host) || '').trim();
      const username = String((h && h.username) || '').trim();
      const protocolo = proto.normalizarProtocolo(h && h.protocol);
      // Telnet e FTP podem legitimamente não ter usuário (login no equipamento):
      // exigir usuário aqui fazia esses hosts sumirem na restauração.
      if (!name || !hostAddr || (!username && protocolo === 'ssh')) { summary.skipped.push('host incompleto: ' + (name || '?')); continue; }
    if (protocolo === 'web' && !weburl.normalizarUrl(h.url)) { summary.skipped.push(`"${name}": URL inválida ou ausente`); continue; }
      let port = Number(h.port) || proto.portaPadrao(protocolo);
      if (!Number.isInteger(port) || port < 1 || port > 65535) port = proto.portaPadrao(protocolo);
      const a = h.auth || {};
      const type = TIPOS_DE_AUTH.includes(a.type) ? a.type : 'agent';
      const auth = { type };
      if (type === 'key') {
        auth.keyPath = String(a.keyPath || '');
        if (a.passphrase) auth.passphrase = String(a.passphrase);
      }
      if (type === 'password' && a.password) auth.password = String(a.password);
      const varsRuins = [];
    const vars = cleanVarsLenient(h.vars, varsRuins);
    for (const nome of varsRuins) summary.skipped.push(`"${name}": variável ignorada por nome inválido: ${nome}`);
      const protocol = protocolo;
      const ftps = proto.FTPS_MODOS.includes(h.ftps) ? h.ftps : 'auto';
      const group = opcional(h.group, (v) => String(v).trim().slice(0, 60));
      const rdpDomain = opcional(h.rdpDomain, (v) => String(v).trim().slice(0, 80));
    // A URL passa pela MESMA validação do cadastro manual: o arquivo importado
    // é entrada não confiável e a URL vira `src` de um <webview> dentro do app.
    const url = opcional(h.url, (v) => weburl.normalizarUrl(v) || '');
      const icon = opcional(h.icon, slug);
      const color = opcional(h.color, slug);
      // Referência a segredo de cofre. Vem do arquivo, mas NÃO é segredo: é
      // apelido + id. Sem ela um host de `type: cofre` restaura sem saber o que
      // buscar — completo na tela, quebrado na conexão.
      const segredo = opcional(h.segredo, (v) => {
        const cofre = String((v && v.cofre) || '').trim().slice(0, 40);
        const idSeg = String((v && v.id) || '').trim().slice(0, 200);
        if (!cofre || !idSeg) return null;
        return { cofre, id: idSeg,
          cliente: String((v && v.cliente) || '').trim().slice(0, 200),
          rotulo: String((v && v.rotulo) || '').trim().slice(0, 200) };
      });
      // Agenda mal formada no arquivo não pode derrubar a importação inteira: o
      // XML é entrada de terceiro e as outras 800 entradas não têm culpa. Cai
      // fora com aviso, igual ao que já se faz com variável de nome inválido.
      // Três situações diferentes, e só uma delas pode mexer no que está aqui:
      //   - o arquivo NÃO traz agenda  -> undefined: "não sei", não "apague"
      //   - traz e é válida            -> aplica
      //   - traz e é ILEGÍVEL          -> não aplica, e AVISA
      // Sem a terceira, uma tag quebrada virava `null` e APAGAVA a agenda do
      // host — o oposto da promessa de que importar nunca remove nada, e em
      // silêncio, porque normalizarAgenda devolve null sem lançar quando os
      // dois horários chegam vazios.
      let agenda;
      if (h.agenda === undefined || h.agenda === null) {
        agenda = undefined;
      } else {
        try {
          agenda = agendaLib.normalizarAgenda(h.agenda);
          if (agenda === null) {
            agenda = undefined;
            summary.skipped.push(`"${name}": agenda do arquivo veio vazia — a agenda atual foi mantida`);
          }
        } catch (e) {
          agenda = undefined;
          summary.skipped.push(`"${name}": agenda ignorada, a atual foi mantida — ${e.message}`);
        }
      }
      // O fingerprint NUNCA vem do arquivo: ele é a prova de identidade do
      // servidor, aprendida na primeira conexão real (TOFU). Aceitá-lo de um XML
      // deixaria um arquivo de terceiro apontar o host para outro servidor já
      // "aprovado", e a senha salva seria entregue a ele sem nenhum alerta.
      // Casa por NOME + ENDEREÇO. Só por nome, dois hosts homônimos (comuns em
      // parques com "Firewall" por filial) colapsavam num só na restauração — e a
      // guarda anti-reapontamento ainda apagava a senha do sobrevivente.
      // Num host WEB o destino real é a URL — endereço e porta são derivados
      // dela. Casar só por name+host+port+username deixava um arquivo casar
      // exatamente com um host web seu e trocar SÓ a url: o certificado fixado
      // era descartado, o destino virava outro, e a única notícia era uma linha
      // num painel intitulado "N item(ns) não importado(s)" — rotulando como
      // não-importado justamente o que foi. Com a url no casamento, um destino
      // diferente entra como host NOVO e o seu fica intacto.
      const mesmoDestino = (x) => x.name === name && x.host === hostAddr
        && (x.port || 22) === port && x.username === username
        && (protocolo !== 'web' || (x.url || '') === (url || ''));
      // Só correspondência EXATA atualiza. Qualquer outra coisa entra como host
      // novo: importar nunca deve destruir um registro existente, e sem o endereço
      // não há como saber se "Firewall" do arquivo é o mesmo "Firewall" daqui.
      const ex = d.hosts.find(mesmoDestino);
      if (!ex && d.hosts.some((x) => x.name === name)) {
        summary.skipped.push(`"${name}": já existe um host com este nome em outro endereço — o do arquivo foi adicionado à parte, nada foi sobrescrito`);
      }
      if (ex) {
        // Aqui o destino é NECESSARIAMENTE o mesmo: `mesmoDestino` já exigiu nome,
        // endereço, porta e usuário iguais. O bloco que existia para o caso
        // "mudou de endereço" era inalcançável (medido: 810 entradas casando,
        // zero com endereço diferente) e alimentava um aviso que o cliente
        // exibia como se algo tivesse sido reapontado.
        // Preserva o segredo existente quando o arquivo não traz um.
        if (type === 'password' && !auth.password && ex.auth && ex.auth.type === 'password' && ex.auth.password) auth.password = ex.auth.password;
        if (type === 'key' && !auth.passphrase && ex.auth && ex.auth.passphrase) auth.passphrase = ex.auth.passphrase;
        // Num host web o destino REAL é a url — e ela não entra em `mesmoDestino`.
        // Sem isto, um XML reapontava a página de um host existente para outro
        // lugar mantendo o certificado já fixado, sem aviso nenhum.
        if (protocolo === 'web' && url && ex.url && url !== ex.url) {
          delete ex.webCert;
          summary.skipped.push(`"${name}": o arquivo mudou a URL de ${ex.url} para ${url}`
            + ' — o certificado fixado foi descartado e será aprendido de novo');
        }
        // Variáveis mesclam chave a chave, igual ao que já se faz com as globais:
        // um arquivo sem a variável X não é motivo para apagar o X daqui.
        Object.assign(ex, soDefinidos({ name, host: hostAddr, port, username, protocol, ftps, rdpDomain, url, group, icon, color, agenda, segredo, auth }),
          { vars: { ...(ex.vars || {}), ...vars } });
        summary.hosts.updated++;
      } else {
        // rdpLegadoOk fica de fora de propósito, pela mesma razão do fingerprint:
        // é consentimento de segurança dado pelo usuário nesta máquina, não
        // configuração. Restaurando, o app pergunta de novo — um clique.
        // webCert fica de fora pela mesma razão do fingerprint: é prova de
        // identidade aprendida NESTA máquina, não configuração.
        d.hosts.push({ id: crypto.randomUUID(), fingerprint: null, name, host: hostAddr, port, username, protocol, ftps,
          rdpDomain: rdpDomain || '', url: url || '', group: group || '', icon: icon || '', color: color || '',
          agenda: agenda || null, segredo: segredo || null, auth, vars });
        summary.hosts.added++;
      }
    }

    // Cofres de credenciais: endereço e tipo. A CHAVE nunca vem do arquivo —
    // ela mora fora do data.json e o export não a alcança. Restaurar noutra
    // máquina devolve o cofre configurado faltando só a chave, que é
    // exatamente o que se quer: sem digitar endereço de novo, sem o arquivo
    // carregar o que abre todas as senhas.
    if (!Array.isArray(d.cofres)) d.cofres = [];
    for (const c of asArray(body.cofres)) {
      const apelido = String((c && c.apelido) || '').trim().toLowerCase();
      const tipo = String((c && c.tipo) || '').trim();
      if (!apelido || !cofres.pegar(tipo)) {
        if (apelido) summary.skipped.push(`cofre "${apelido}": tipo desconhecido "${tipo}"`);
        continue;
      }
      const config = {};
      for (const [k, v] of Object.entries((c && c.config) || {})) {
        config[String(k).slice(0, 40)] = String(v).slice(0, 500);
      }
      const ex = d.cofres.find((x) => x.apelido === apelido);
      if (ex) Object.assign(ex, { tipo, nome: String(c.nome || ex.nome || tipo).slice(0, 80), config });
      else d.cofres.push({ apelido, tipo, nome: String(c.nome || tipo).slice(0, 80), config });
      summary.cofres = (summary.cofres || 0) + 1;
    }

    // Playbooks
    for (const pb of asArray(body.playbooks)) {
      const name = String((pb && pb.name) || '').trim();
      if (!name) continue;
      const commands = asArray(pb.commands).map((c) => String(c).replace(/\r/g, ''));
      if (!parseCommands(commands).length) { summary.skipped.push('playbook sem comandos: ' + name); continue; }
      const description = String(pb.description || '').trim();
      const ex = d.playbooks.find((x) => x.name === name);
      if (ex) { ex.description = description; ex.commands = commands; summary.playbooks.updated++; }
      else { d.playbooks.push({ id: crypto.randomUUID(), name, description, commands }); summary.playbooks.added++; }
    }

    // Configurações da IA
    const s = body.settings;
    if (s && typeof s === 'object') {
      d.settings = d.settings || {};
      if (typeof s.model === 'string' && ai.KNOWN_MODELS.includes(s.model)) { d.settings.model = s.model; summary.settings = true; }
      if (typeof s.apiKey === 'string' && s.apiKey.trim()) { d.settings.apiKey = s.apiKey.trim(); summary.settings = true; }
      if (typeof s.termFont === 'string' && s.termFont.length <= 200 && /^[A-Za-z0-9 ,"'\-]+$/.test(s.termFont)) { d.settings.termFont = s.termFont; summary.settings = true; }
      if (Number.isFinite(Number(s.termFontSize))) { d.settings.termFontSize = Math.min(28, Math.max(8, Math.round(Number(s.termFontSize)))); summary.settings = true; }
    }

    // Favoritos: o arquivo referencia o host pelo NOME (ids mudam entre
    // instalações); resolvemos para o id local aqui. Upsert por comando+escopo,
    // para reimportar o mesmo arquivo não duplicar.
    d.favorites = Array.isArray(d.favorites) ? d.favorites : [];
    for (const f of asArray(body.favorites)) {
      const command = String((f && f.command) || '').trim();
      if (!command || command.length > 4000) { summary.skipped.push('favorito inválido'); continue; }
      const label = String((f && f.label) || '').trim().slice(0, 80);
      let hostId = null;
      if (f && f.hostName) {
        const nome = String(f.hostName);
        // Mesmo critério do casamento de hosts: nome + endereço + porta + usuário.
        // Arquivos antigos não trazem o endereço; nesses, cai para o nome — mas
        // se houver mais de um homônimo não há como escolher, então avisa em vez
        // de chutar o primeiro.
        const exatos = f.hostAddr
          ? d.hosts.filter((h) => h.name === nome && h.host === String(f.hostAddr)
              && (h.port || 22) === (Number(f.hostPort) || 22)
              && (h.username || '') === String(f.hostUser || ''))
          : d.hosts.filter((h) => h.name === nome);
        if (!exatos.length) { summary.skipped.push(`favorito de host inexistente: ${nome}`); continue; }
        if (exatos.length > 1) { summary.skipped.push(`favorito "${label || command}": há ${exatos.length} hosts chamados "${nome}" e o arquivo não diz qual`); continue; }
        hostId = exatos[0].id;
      }
      const ex = d.favorites.find((x) => x.command === command && (x.hostId || null) === hostId);
      if (ex) { ex.label = label; summary.favorites.updated++; }
      else { d.favorites.push({ id: crypto.randomUUID(), command, label, hostId }); summary.favorites.added++; }
    }

    // Preferências da interface
    if (body.prefs && typeof body.prefs === 'object') {
      if (!d.settings.ui || typeof d.settings.ui !== 'object' || Array.isArray(d.settings.ui)) d.settings.ui = {};
      const ui = d.settings.ui;
      if (body.prefs.theme === 'light' || body.prefs.theme === 'dark') ui.theme = body.prefs.theme;
      for (const k of ['greetHidden', 'aiCollapsed', 'sidebarCollapsed']) {
        if (typeof body.prefs[k] === 'boolean') ui[k] = body.prefs[k];
      }
      summary.prefs = true;
    }
  } catch (e) {
    // A cópia é descartada: nada do que foi montado chega ao disco.
    return fail(res, 500, 'Falha ao importar o arquivo: ' + (e && e.message ? e.message : e));
  }

  // Só agora o estado real muda.
  Object.assign(vivo, d);
  store.save();
  res.json(summary);
});

// ---------- estado geral ----------
app.get('/api/state', (req, res) => {
  const d = store.get();
  // Dispara a releitura do que venceu e SEGUE — o carregamento da tela não pode
  // ficar preso esperando o ERP responder.
  janelasDeCofre.renovarSeVencido();
  res.json({
    hosts: d.hosts.map(publicHost),
    playbooks: d.playbooks,
    profiles: d.profiles,
    favorites: d.favorites || [],
    globals: d.globals,
  });
});

// ---------- hosts ----------
app.post('/api/hosts', (req, res) => {
  const v = parseHostBody(req.body, res);
  if (!v) return;
  const host = { id: crypto.randomUUID(), fingerprint: null, ...v };
  store.get().hosts.push(host);
  store.save();
  res.json(publicHost(host));
});

app.put('/api/hosts/:id', (req, res) => {
  const host = store.get().hosts.find((h) => h.id === req.params.id);
  if (!host) return fail(res, 404, 'Host não encontrado.');
  const v = parseHostBody(req.body, res);
  if (!v) return;
  // campo em branco = manter a credencial atual
  if (v.auth.type === 'password' && !v.auth.password && host.auth && host.auth.type === 'password') {
    v.auth.password = host.auth.password;
  }
  if (v.auth.type === 'key' && !v.auth.passphrase && host.auth && host.auth.type === 'key' && host.auth.passphrase) {
    v.auth.passphrase = host.auth.passphrase;
  }
  // endereço mudou → o fingerprint antigo deixa de valer
  if (v.host !== host.host || v.port !== host.port || v.url !== host.url) {
    host.fingerprint = null;
    // O pino do certificado pertence ao ENDEREÇO. Sem isto, editar a URL
    // mantinha o pino do equipamento antigo valendo para o novo: o equipamento
    // certo era recusado com a acusação de "alguém está no meio do caminho".
    delete host.webCert;
  }
  Object.assign(host, v);
  store.save();
  res.json(publicHost(host));
});

// Apagar um host de página web deixava para trás a partição do <webview> —
// <userData>/Partitions/web-<id>/ — com o cookie de sessão e o localStorage do
// equipamento em texto claro, para sempre. O gesto que o usuário entende como
// "remover este equipamento" não revogava a sessão dele.
function limparParticaoWeb(hostId) {
  try {
    // Só existe rodando dentro do Electron; em `npm start` não há sessão de
    // webview nenhuma para limpar.
    const { session } = require('electron');
    if (!session) return;
    const ses = session.fromPartition('persist:web-' + hostId);
    ses.clearStorageData().catch(() => {});
    if (ses.clearCache) ses.clearCache().catch(() => {});
  } catch {}
}

app.delete('/api/hosts/:id', (req, res) => {
  const d = store.get();
  const idx = d.hosts.findIndex((h) => h.id === req.params.id);
  if (idx < 0) return fail(res, 404, 'Host não encontrado.');
  const [removido] = d.hosts.splice(idx, 1);
  store.save();
  if (removido && removido.protocol === 'web') limparParticaoWeb(removido.id);
  res.json({ ok: true });
});

// Página web: esquece o certificado fixado, para o próximo acesso aprender o
// novo. É a saída legítima de quem TROCOU o equipamento — sem ela, a mensagem
// de "certificado mudou" seria um beco sem saída.
// A senha de um host, para o usuário COLAR na própria sessão.
//
// O menu "{ } Variáveis" lista os campos do cadastro prontos para colar, e a
// senha faltava ali justamente porque `publicHost` a redige — o navegador nunca
// a recebe. Sem esta rota, colar a senha num prompt de `sudo` significava abrir
// o cadastro e copiar à mão.
//
// Três cuidados, e nenhum é opcional:
//   - exige o TOKEN do processo, como a rota de credencial de RDP/VNC. A guarda
//     de origem sozinha não basta: esta rota devolve segredo;
//   - `no-store`, para não sobrar em cache nenhum;
//   - passa por `credenciais.resolver`, que é o ÚNICO ponto de resolução — logo
//     funciona igual para senha salva e para senha vinda de cofre externo, e
//     registra o valor na redação enquanto ele existe.
app.post('/api/hosts/:id/segredo', async (req, res) => {
  const corpo = req.body || {};
  if (!tokenValido(corpo.token)) return fail(res, 403, 'Token inválido.');
  const host = store.get().hosts.find((h) => h.id === req.params.id) || quickhosts.get(req.params.id);
  if (!host) return fail(res, 404, 'Host não encontrado.');
  const campo = corpo.campo === 'passphrase' ? 'passphrase' : 'senha';

  let cred;
  try {
    cred = await credenciais.resolver(host);
  } catch (e) {
    return fail(res, 502, `Cofre de credenciais: ${e.message}`);
  }
  try {
    const valor = campo === 'passphrase' ? (cred.passphrase || '') : (cred.password || '');
    if (!valor) return fail(res, 404, 'Este host não tem esse segredo guardado.');
    res.set('Cache-Control', 'no-store');
    res.json({ valor });
  } finally {
    cred.dispose();
  }
});

app.post('/api/hosts/:id/forget-cert', (req, res) => {
  const host = store.get().hosts.find((h) => h.id === req.params.id);
  if (!host) return fail(res, 404, 'Host não encontrado.');
  delete host.webCert;
  store.save();
  res.json({ ok: true });
});

app.post('/api/hosts/:id/forget-fingerprint', (req, res) => {
  const host = store.get().hosts.find((h) => h.id === req.params.id);
  if (!host) return fail(res, 404, 'Host não encontrado.');
  host.fingerprint = null;
  store.save();
  res.json({ ok: true });
});

app.post('/api/hosts/:id/test', async (req, res) => {
  const host = store.get().hosts.find((h) => h.id === req.params.id);
  if (!host) return fail(res, 404, 'Host não encontrado.');
  const result = await runner.testHost(host, { saveData: () => store.save() });
  res.json(result);
});

// ---------- playbooks ----------
function parsePlaybookBody(body, res) {
  const name = String((body && body.name) || '').trim();
  if (!name) return fail(res, 400, 'Informe um nome para o playbook.');
  const commands = (Array.isArray(body.commands) ? body.commands : []).map((c) => String(c).replace(/\r$/, ''));
  if (!parseCommands(commands).length) return fail(res, 400, 'Adicione ao menos um comando.');
  return { name, description: String(body.description || '').trim(), commands };
}

app.post('/api/playbooks', (req, res) => {
  const v = parsePlaybookBody(req.body, res);
  if (!v) return;
  const pb = { id: crypto.randomUUID(), ...v };
  store.get().playbooks.push(pb);
  store.save();
  res.json(pb);
});

app.put('/api/playbooks/:id', (req, res) => {
  const pb = store.get().playbooks.find((p) => p.id === req.params.id);
  if (!pb) return fail(res, 404, 'Playbook não encontrado.');
  const v = parsePlaybookBody(req.body, res);
  if (!v) return;
  Object.assign(pb, v);
  store.save();
  res.json(pb);
});

app.delete('/api/playbooks/:id', (req, res) => {
  const d = store.get();
  const idx = d.playbooks.findIndex((p) => p.id === req.params.id);
  if (idx < 0) return fail(res, 404, 'Playbook não encontrado.');
  d.playbooks.splice(idx, 1);
  store.save();
  res.json({ ok: true });
});

// ---------- comandos favoritos (globais ou por host) ----------
function parseFavoriteBody(body, res) {
  const command = String((body && body.command) || '').trim();
  if (!command) return fail(res, 400, 'Informe o comando.');
  if (command.length > 4000) return fail(res, 400, 'Comando longo demais.');
  const label = String((body && body.label) || '').trim();
  let hostId = (body && body.hostId) || null;
  if (hostId) {
    if (!store.get().hosts.find((h) => h.id === hostId)) return fail(res, 400, 'Host não encontrado.');
  } else {
    hostId = null; // favorito global
  }
  return { command, label, hostId };
}

app.post('/api/favorites', (req, res) => {
  const v = parseFavoriteBody(req.body, res);
  if (!v) return;
  const d = store.get();
  if (!Array.isArray(d.favorites)) d.favorites = [];
  // evita duplicado exato (mesmo comando no mesmo escopo)
  const dup = d.favorites.find((f) => f.command === v.command && (f.hostId || null) === v.hostId);
  if (dup) return fail(res, 400, 'Este comando já está nos favoritos desse escopo.');
  const fav = { id: crypto.randomUUID(), ...v };
  d.favorites.push(fav);
  store.save();
  res.json(fav);
});

app.put('/api/favorites/:id', (req, res) => {
  const d = store.get();
  const fav = (d.favorites || []).find((f) => f.id === req.params.id);
  if (!fav) return fail(res, 404, 'Favorito não encontrado.');
  const v = parseFavoriteBody(req.body, res);
  if (!v) return;
  Object.assign(fav, v);
  store.save();
  res.json(fav);
});

app.delete('/api/favorites/:id', (req, res) => {
  const d = store.get();
  const idx = (d.favorites || []).findIndex((f) => f.id === req.params.id);
  if (idx < 0) return fail(res, 404, 'Favorito não encontrado.');
  d.favorites.splice(idx, 1);
  store.save();
  res.json({ ok: true });
});

// ---------- perfis (segmentos) ----------
function parseProfileBody(body, res) {
  const name = String((body && body.name) || '').trim();
  if (!name) return fail(res, 400, 'Informe um nome para o perfil.');
  const vars = cleanVars(body.vars, res);
  if (vars === null) return null;
  return { name, vars };
}

app.post('/api/profiles', (req, res) => {
  const v = parseProfileBody(req.body, res);
  if (!v) return;
  const profile = { id: crypto.randomUUID(), ...v };
  store.get().profiles.push(profile);
  store.save();
  res.json(profile);
});

app.put('/api/profiles/:id', (req, res) => {
  const profile = store.get().profiles.find((p) => p.id === req.params.id);
  if (!profile) return fail(res, 404, 'Perfil não encontrado.');
  const v = parseProfileBody(req.body, res);
  if (!v) return;
  Object.assign(profile, v);
  store.save();
  res.json(profile);
});

app.delete('/api/profiles/:id', (req, res) => {
  const d = store.get();
  const idx = d.profiles.findIndex((p) => p.id === req.params.id);
  if (idx < 0) return fail(res, 404, 'Perfil não encontrado.');
  d.profiles.splice(idx, 1);
  store.save();
  res.json({ ok: true });
});

// ---------- variáveis globais ----------
app.put('/api/globals', (req, res) => {
  const vars = cleanVars(req.body && req.body.vars, res);
  if (vars === null) return;
  store.get().globals = vars;
  store.save();
  res.json({ ok: true });
});

// ---------- resolução e execução ----------
function resolveRequest(body, res) {
  const d = store.get();
  let rawCommands;
  let playbookName = null;
  if (body.playbookId) {
    const pb = d.playbooks.find((p) => p.id === body.playbookId);
    if (!pb) return fail(res, 400, 'Playbook não encontrado.');
    rawCommands = pb.commands;
    playbookName = pb.name;
  } else if (Array.isArray(body.commands)) {
    rawCommands = body.commands;
  } else {
    return fail(res, 400, 'Informe um playbook ou comandos avulsos.');
  }
  const commands = parseCommands(rawCommands);
  if (!commands.length) return fail(res, 400, 'Nenhum comando para executar.');

  const ids = [...new Set(Array.isArray(body.hostIds) ? body.hostIds : [])];
  if (!ids.length) return fail(res, 400, 'Selecione ao menos um host.');
  const hosts = [];
  for (const id of ids) {
    const h = d.hosts.find((x) => x.id === id);
    if (!h) return fail(res, 400, 'Host não encontrado: ' + id);
    if (h.protocol && h.protocol !== 'ssh') return fail(res, 400, `"${h.name}" é ${h.protocol.toUpperCase()} — execução em lote exige SSH.`);
    hosts.push(h);
  }

  let profile = null;
  if (body.profileId) {
    profile = d.profiles.find((p) => p.id === body.profileId);
    if (!profile) return fail(res, 400, 'Perfil não encontrado.');
  }

  const overrides = cleanVars(body.overrides, res);
  if (overrides === null) return null;

  const perHost = [];
  for (const host of hosts) {
    const merged = mergeVars(d.globals, profile, host, overrides);
    let items;
    try {
      items = expandAndResolve(commands, merged);
    } catch (err) {
      return fail(res, 400, err.message);
    }
    const missing = [...new Set(items.flatMap((i) => i.missing))];
    perHost.push({ host, items, missing });
  }

  return { perHost, playbookName };
}

app.post('/api/preview', (req, res) => {
  const r = resolveRequest(req.body || {}, res);
  if (!r) return;
  res.json({
    playbookName: r.playbookName,
    hosts: r.perHost.map((p) => ({
      hostId: p.host.id,
      name: p.host.name,
      address: `${p.host.username}@${p.host.host}:${p.host.port || 22}`,
      commands: p.items,
      missing: p.missing,
    })),
  });
});

app.post('/api/run', (req, res) => {
  const body = req.body || {};
  const r = resolveRequest(body, res);
  if (!r) return;
  const allMissing = [...new Set(r.perHost.flatMap((p) => p.missing))];
  if (allMissing.length) {
    return fail(res, 400, `Variáveis não definidas: ${allMissing.join(', ')}. Defina em globais, perfil, host ou sobrescritas.`);
  }
  const options = {
    stopOnError: body.stopOnError !== false,
    sequential: !!body.sequential,
    timeoutSec: Math.max(0, Number(body.timeoutSec) || 0),
  };
  // registra no histórico os comandos (já resolvidos) que vão rodar em cada host
  for (const p of r.perHost) {
    for (const it of p.items) {
      const c = String(it.resolved || '').trim();
      if (!c || c.startsWith('#')) continue;
      history.add({
        command: c, source: 'human', origin: 'batch',
        machine: p.host.name, ip: p.host.host, username: p.host.username,
        port: p.host.port || 22, local: false, hostId: p.host.id,
      });
    }
  }
  const run = runner.startRun({
    perHost: r.perHost,
    playbookName: r.playbookName,
    options,
    saveData: () => store.save(),
  });
  res.json({ runId: run.id });
});

app.get('/api/runs/:id/stream', (req, res) => {
  const run = runner.getRun(req.params.id);
  if (!run) return fail(res, 404, 'Execução não encontrada.');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': ok\n\n');
  runner.subscribe(run, res);
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 20000);
  req.on('close', () => {
    clearInterval(ping);
    runner.unsubscribe(run, res);
  });
});

app.post('/api/runs/:id/cancel', (req, res) => {
  const run = runner.getRun(req.params.id);
  if (!run) return fail(res, 404, 'Execução não encontrada.');
  runner.cancel(run);
  res.json({ ok: true });
});

// ---------- configurações da IA ----------
app.get('/api/settings', (req, res) => {
  res.json(ai.publicSettings());
});

app.put('/api/settings', (req, res) => {
  const body = req.body || {};
  const s = store.get().settings || (store.get().settings = {});
  if (body.clearApiKey) {
    delete s.apiKey;
  } else if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
    s.apiKey = body.apiKey.trim();
  }
  if (typeof body.model === 'string') {
    if (!ai.KNOWN_MODELS.includes(body.model)) return fail(res, 400, 'Modelo inválido.');
    s.model = body.model;
  }
  if (typeof body.termFont === 'string') {
    const f = body.termFont.trim();
    if (!f || f.length > 200 || !/^[A-Za-z0-9 ,"'\-]+$/.test(f)) return fail(res, 400, 'Fonte inválida.');
    s.termFont = f;
  }
  if (body.termFontSize !== undefined) {
    const n = Number(body.termFontSize);
    if (!Number.isFinite(n)) return fail(res, 400, 'Tamanho de fonte inválido.');
    s.termFontSize = Math.min(28, Math.max(8, Math.round(n)));
  }
  store.save();
  res.json(ai.publicSettings());
});

// ---------- chat com a IA (streaming SSE) ----------
app.post('/api/ai/chat', async (req, res) => {
  const body = req.body || {};
  const host = body.hostId ? store.get().hosts.find((h) => h.id === body.hostId) : null;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (obj) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
  };
  let aborted = false;
  // res 'close' = cliente desconectou (req 'close' dispara ao fim do corpo no Node atual)
  res.on('close', () => { aborted = true; });
  try {
    await ai.streamChat({
      messages: body.messages,
      host,
      terminalContext: body.terminalContext,
      modo: ['desktop', 'web'].includes(body.modo) ? body.modo : 'terminal',
      protocolo: body.protocolo,
      onDelta: (t) => { if (!aborted) send({ type: 'delta', text: t }); },
    });
    if (!aborted) send({ type: 'done' });
  } catch (err) {
    if (!aborted) send({ type: 'error', error: err && err.message ? err.message : String(err) });
  }
  res.end();
});

// ---------- geração de playbook com IA ----------
app.post('/api/ai/playbook', async (req, res) => {
  const description = String((req.body || {}).description || '').trim();
  if (!description) return fail(res, 400, 'Descreva o que o playbook deve fazer.');
  if (description.length > 4000) return fail(res, 400, 'Descrição longa demais.');
  const d = store.get();
  const knownVars = new Set();
  Object.keys(d.globals || {}).forEach((k) => knownVars.add(k));
  (d.profiles || []).forEach((p) => Object.keys(p.vars || {}).forEach((k) => knownVars.add(k)));
  (d.hosts || []).forEach((h) => Object.keys(h.vars || {}).forEach((k) => knownVars.add(k)));
  try {
    const pb = await ai.generatePlaybook({ description, knownVars: [...knownVars] });
    if (!pb.commands.length) return fail(res, 400, 'A IA não gerou nenhum comando. Tente detalhar melhor a tarefa.');
    res.json(pb);
  } catch (err) {
    fail(res, 400, err && err.message ? err.message : String(err));
  }
});

// ---------- agente autônomo (IA age sozinha, analista acompanha) ----------
app.post('/api/agent/start', (req, res) => {
  const body = req.body || {};
  let host;
  if (body.local === true) {
    // agente na própria máquina: comandos rodam via shell local, sem SSH
    let user = '';
    try { user = os.userInfo().username; } catch {}
    host = {
      local: true,
      name: 'Meu computador',
      username: user,
      host: String(os.hostname() || '').replace(/\.local$/i, ''),
      platform: process.platform,
    };
  } else {
    host = store.get().hosts.find((h) => h.id === body.hostId) || quickhosts.get(body.hostId);
    if (!host) return fail(res, 400, 'Host não encontrado.');
    if (host.protocol && host.protocol !== 'ssh') return fail(res, 400, 'O agente autônomo precisa de SSH — não funciona em hosts Telnet, FTP, VNC, RDP ou de página web.');
  }
  const goal = String(body.goal || '').trim();
  if (!goal) return fail(res, 400, 'Descreva a tarefa para o agente.');
  if (goal.length > 4000) return fail(res, 400, 'Tarefa longa demais.');
  // 'escrita' é o padrão: roda sozinho o que for leitura reconhecida e pergunta
  // no resto. 'perigosos' é o comportamento antigo (só a lista de padrões) e
  // 'nunca' não pergunta nada — os dois só entram se pedidos explicitamente.
  const MODOS = ['tudo', 'escrita', 'perigosos', 'nunca'];
  let aprovacao = MODOS.includes(body.aprovacao) ? body.aprovacao : 'escrita';
  if (body.aprovacao === undefined && body.confirmDangerous === false) aprovacao = 'nunca';
  const options = {
    aprovacao,
    timeoutSec: Math.min(600, Math.max(5, Number(body.timeoutSec) || 120)),
  };
  const run = agent.start({ host, goal, options, saveData: () => store.save() });
  res.json({ runId: run.id });
});

app.get('/api/agent/:id/stream', (req, res) => {
  const run = agent.getRun(req.params.id);
  if (!run) return fail(res, 404, 'Execução do agente não encontrada.');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': ok\n\n');
  agent.subscribe(run, res);
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 20000);
  req.on('close', () => {
    clearInterval(ping);
    agent.unsubscribe(run, res);
  });
});

app.post('/api/agent/:id/approve', (req, res) => {
  const run = agent.getRun(req.params.id);
  if (!run) return fail(res, 404, 'Execução do agente não encontrada.');
  // Devolve o que de fato aconteceu: approve() responde false quando não há
  // aprovação pendente (run já terminado, clique duplicado). Responder sempre
  // {ok:true} fazia a tela escrever "→ aprovado" embaixo de um comando negado.
  const efetivou = agent.approve(run, (req.body || {}).approve === true);
  if (!efetivou) return fail(res, 409, 'Não havia aprovação pendente nesta execução.');
  res.json({ ok: true });
});

app.post('/api/agent/:id/stop', (req, res) => {
  const run = agent.getRun(req.params.id);
  if (!run) return fail(res, 404, 'Execução do agente não encontrada.');
  const efetivou = agent.stop(run);
  if (!efetivou) return fail(res, 409, 'Esta execução já havia terminado.');
  res.json({ ok: true });
});

// Sobe o servidor HTTP; port 0 = porta aleatória livre (usado pelo app desktop)
function start(port = PORT, host = HOST) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      // só agora sabemos a porta real (o desktop usa porta 0 = automática)
      setAllowedOrigins(server.address().port);
      resolve(server);
    });
    // Roteia o upgrade de WebSocket por caminho para o WSS certo (um único
    // handler; vários WSS com `path` no mesmo servidor conflitam no handshake).
    server.on('upgrade', (req, socket, head) => {
      // WebSocket não passa pela política de mesma origem: sem esta checagem,
      // qualquer página aberta no navegador abriria um terminal nesta máquina.
      if (!requestAllowed(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      let pathname, params;
      try {
        const u = new URL(req.url, 'http://127.0.0.1');
        pathname = u.pathname;
        params = u.searchParams;
      } catch { socket.destroy(); return; }
      // segunda barreira: sem o token do processo, não abre terminal nenhum
      if (!tokenValido(params.get('token'))) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (pathname === '/api/vnc') desktop.vncWss.handleUpgrade(req, socket, head, (ws) => desktop.vncWss.emit('connection', ws, req));
      else if (pathname === '/api/rdp') rdp.rdpWss.handleUpgrade(req, socket, head, (ws) => rdp.rdpWss.emit('connection', ws, req));
      else if (pathname === '/api/terminal') termWss.handleUpgrade(req, socket, head, (ws) => termWss.emit('connection', ws, req));
      else if (pathname === '/api/localterminal') localWss.handleUpgrade(req, socket, head, (ws) => localWss.emit('connection', ws, req));
      else socket.destroy();
    });
    server.on('error', reject);
  });
}

module.exports = { start };

if (require.main === module) {
  start()
    .then((server) => {
      console.log(`Vincii Canvas disponível em http://${HOST}:${server.address().port} (acessível só nesta máquina)`);
    })
    .catch((err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`A porta ${PORT} já está em uso. Rode com outra porta, ex.: PORT=3555 npm start`);
      } else {
        console.error(err);
      }
      process.exit(1);
    });
}
