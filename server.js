'use strict';

const path = require('path');
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
const { mergeVars, parseCommands, expandAndResolve, VAR_NAME_RE } = require('./lib/vars');
const { buildXml } = require('./lib/exportxml');
const pkg = require('./package.json');

const HOST = '127.0.0.1'; // apenas esta máquina — o app guarda credenciais e executa comandos
const PORT = Number(process.env.PORT || 3033);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Assets do terminal (xterm.js) servidos direto do pacote instalado
function pkgDir(id) {
  return path.dirname(require.resolve(id + '/package.json'));
}
app.use('/vendor/xterm', express.static(pkgDir('@xterm/xterm')));
app.use('/vendor/addon-fit', express.static(pkgDir('@xterm/addon-fit')));

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
  const h = store.get().hosts.find((x) => x.id === hostId);
  if (!h) return null;
  return { machine: h.name, ip: h.host, username: h.username, port: h.port || 22, local: false, hostId: h.id };
}

app.get('/api/history', (req, res) => {
  const { source, hostId, q, limit } = req.query || {};
  res.json({ entries: history.list({ source, hostId, q, limit }) });
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
    group: h.group || '',
    icon: h.icon || '',
    color: h.color || '',
    vars: h.vars || {},
    fingerprint: h.fingerprint || null,
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
  const hostAddr = String(body.host || '').trim();
  if (!hostAddr) return fail(res, 400, 'Informe o endereço do host.');
  const port = Number(body.port || 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fail(res, 400, 'Porta inválida.');
  const username = String(body.username || '').trim();
  if (!username) return fail(res, 400, 'Informe o usuário SSH.');

  const a = body.auth || {};
  const type = ['agent', 'key', 'password'].includes(a.type) ? a.type : 'agent';
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
  return { name, host: hostAddr, port, username, group, icon, color, auth, vars };
}

// slug curto para ícone/cor do avatar (defensivo): só [a-z0-9-], até 24 chars
function slug(v) {
  const s = String(v || '').trim().toLowerCase();
  return /^[a-z0-9-]{1,24}$/.test(s) ? s : '';
}

// ---------- exportar configuração (.xml) ----------
app.get('/api/export.xml', (req, res) => {
  const includeSecrets = req.query.secrets === '1' || req.query.secrets === 'true';
  const xml = buildXml(store.get(), { exportedAt: new Date().toISOString(), includeSecrets });
  const fname = includeSecrets ? 'ssh-commander-config-com-segredos.xml' : 'ssh-commander-config.xml';
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(xml);
});

// ---------- importar configuração ----------
function asArray(v) {
  return Array.isArray(v) ? v : [];
}
function cleanVarsLenient(obj) {
  const out = {};
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      if (VAR_NAME_RE.test(k)) out[k] = String(v);
    }
  }
  return out;
}

// Recebe a configuração já parseada (o navegador faz o parse do XML) e faz
// upsert por nome — nada é apagado.
app.post('/api/import', (req, res) => {
  const body = req.body || {};
  const d = store.get();
  const summary = {
    globals: 0,
    profiles: { added: 0, updated: 0 },
    hosts: { added: 0, updated: 0 },
    playbooks: { added: 0, updated: 0 },
    settings: false,
    skipped: [],
  };

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
    const vars = cleanVarsLenient(p.vars);
    const ex = d.profiles.find((x) => x.name === name);
    if (ex) { ex.vars = vars; summary.profiles.updated++; }
    else { d.profiles.push({ id: crypto.randomUUID(), name, vars }); summary.profiles.added++; }
  }

  // Hosts
  for (const h of asArray(body.hosts)) {
    const name = String((h && h.name) || '').trim();
    const hostAddr = String((h && h.host) || '').trim();
    const username = String((h && h.username) || '').trim();
    if (!name || !hostAddr || !username) { summary.skipped.push('host incompleto: ' + (name || '?')); continue; }
    let port = Number(h.port) || 22;
    if (!Number.isInteger(port) || port < 1 || port > 65535) port = 22;
    const a = h.auth || {};
    const type = ['agent', 'key', 'password'].includes(a.type) ? a.type : 'agent';
    const auth = { type };
    if (type === 'key') {
      auth.keyPath = String(a.keyPath || '');
      if (a.passphrase) auth.passphrase = String(a.passphrase);
    }
    if (type === 'password' && a.password) auth.password = String(a.password);
    const vars = cleanVarsLenient(h.vars);
    const group = String(h.group || '').trim().slice(0, 60);
    const icon = slug(h.icon);
    const color = slug(h.color);
    const fingerprint = h.fingerprint ? String(h.fingerprint) : null;
    const ex = d.hosts.find((x) => x.name === name);
    if (ex) {
      // preserva segredo existente quando o arquivo não traz um
      if (type === 'password' && !auth.password && ex.auth && ex.auth.type === 'password' && ex.auth.password) auth.password = ex.auth.password;
      if (type === 'key' && !auth.passphrase && ex.auth && ex.auth.passphrase) auth.passphrase = ex.auth.passphrase;
      Object.assign(ex, { name, host: hostAddr, port, username, group, icon, color, auth, vars, fingerprint: fingerprint || ex.fingerprint || null });
      summary.hosts.updated++;
    } else {
      d.hosts.push({ id: crypto.randomUUID(), fingerprint, name, host: hostAddr, port, username, group, icon, color, auth, vars });
      summary.hosts.added++;
    }
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
  }

  store.save();
  res.json(summary);
});

// ---------- estado geral ----------
app.get('/api/state', (req, res) => {
  const d = store.get();
  res.json({
    hosts: d.hosts.map(publicHost),
    playbooks: d.playbooks,
    profiles: d.profiles,
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
  if (v.host !== host.host || v.port !== host.port) host.fingerprint = null;
  Object.assign(host, v);
  store.save();
  res.json(publicHost(host));
});

app.delete('/api/hosts/:id', (req, res) => {
  const d = store.get();
  const idx = d.hosts.findIndex((h) => h.id === req.params.id);
  if (idx < 0) return fail(res, 404, 'Host não encontrado.');
  d.hosts.splice(idx, 1);
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
    host = store.get().hosts.find((h) => h.id === body.hostId);
    if (!host) return fail(res, 400, 'Host não encontrado.');
  }
  const goal = String(body.goal || '').trim();
  if (!goal) return fail(res, 400, 'Descreva a tarefa para o agente.');
  if (goal.length > 4000) return fail(res, 400, 'Tarefa longa demais.');
  const options = {
    confirmDangerous: body.confirmDangerous !== false,
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
  agent.approve(run, (req.body || {}).approve === true);
  res.json({ ok: true });
});

app.post('/api/agent/:id/stop', (req, res) => {
  const run = agent.getRun(req.params.id);
  if (!run) return fail(res, 404, 'Execução do agente não encontrada.');
  agent.stop(run);
  res.json({ ok: true });
});

// Sobe o servidor HTTP; port 0 = porta aleatória livre (usado pelo app desktop)
function start(port = PORT, host = HOST) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    // Roteia o upgrade de WebSocket por caminho para o WSS certo (um único
    // handler; vários WSS com `path` no mesmo servidor conflitam no handshake).
    server.on('upgrade', (req, socket, head) => {
      let pathname;
      try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; } catch { socket.destroy(); return; }
      if (pathname === '/api/terminal') termWss.handleUpgrade(req, socket, head, (ws) => termWss.emit('connection', ws, req));
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
