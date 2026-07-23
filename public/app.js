'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let state = { hosts: [], playbooks: [], profiles: [], globals: {} };
let currentRun = null;

// ---------- utilidades ----------
async function api(url, options = {}) {
  const opts = { headers: {}, ...options };
  if (opts.body !== undefined && typeof opts.body !== 'string') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, opts);
  let payload = null;
  try { payload = await res.json(); } catch {}
  if (!res.ok) throw new Error((payload && payload.error) || `Erro ${res.status}`);
  return payload;
}

function toast(message, kind = 'ok') {
  const box = document.createElement('div');
  box.className = `toast ${kind}`;
  box.textContent = message;
  $('#toasts').appendChild(box);
  setTimeout(() => box.remove(), kind === 'erro' ? 7000 : 4000);
}

function el(parent, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  parent.appendChild(node);
  return node;
}

function varsToText(vars) {
  return Object.entries(vars || {}).map(([k, v]) => `${k}=${v}`).join('\n');
}

function textToVars(text) {
  const out = {};
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) throw new Error(`Linha de variável inválida: "${line}" (use CHAVE=valor)`);
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) throw new Error(`Nome de variável inválido: "${key}"`);
    out[key] = line.slice(eq + 1);
  }
  return out;
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, '\n');
}

function fmtMs(ms) {
  return ms >= 1000 ? (ms / 1000).toFixed(1).replace('.', ',') + ' s' : ms + ' ms';
}

function authLabel(auth) {
  return auth.type === 'key' ? 'Chave' : auth.type === 'password' ? 'Senha' : 'Agente';
}

// avatar do host: inicial + cor derivada do nome (estilo Termius)
function hostInitial(name) {
  const t = String(name || '').trim();
  return (t[0] || '?').toUpperCase();
}
function hostHue(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
// matiz do avatar: cor escolhida (paleta) ou derivada do nome
function avatarHue(host) {
  const c = host && host.color;
  if (c && typeof HOST_COLORS !== 'undefined' && HOST_COLORS[c] != null) return HOST_COLORS[c];
  return hostHue(host && host.name);
}
// avatar: recebe o host inteiro; mostra o ícone escolhido ou a inicial do nome
function makeAvatar(parent, host, extraClass) {
  if (typeof host === 'string') host = { name: host }; // compat: aceitava só o nome
  const av = el(parent, 'div', 'host-avatar' + (extraClass ? ' ' + extraClass : ''));
  const hue = avatarHue(host);
  av.style.background = `linear-gradient(135deg, hsl(${hue} 58% 48%), hsl(${(hue + 30) % 360} 58% 40%))`;
  const key = host && host.icon;
  if (key && typeof HOST_ICONS !== 'undefined' && HOST_ICONS[key]) {
    av.classList.add('has-icon');
    av.innerHTML = HOST_ICONS[key].svg;
  } else {
    av.textContent = hostInitial(host && host.name);
  }
  return av;
}
// agrupa hosts por grupo; "Sem grupo" por último
function groupedHosts() {
  const groups = new Map();
  for (const h of state.hosts) {
    const g = (h.group || '').trim() || 'Sem grupo';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(h);
  }
  return [...groups.entries()].sort((a, b) => {
    if (a[0] === 'Sem grupo') return 1;
    if (b[0] === 'Sem grupo') return -1;
    return a[0].localeCompare(b[0], 'pt-BR');
  });
}
function existingGroups() {
  return [...new Set(state.hosts.map((h) => (h.group || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

// ---------- abas ----------
function initTabs() {
  $$('.tabs button').forEach((btn) => btn.addEventListener('click', () => {
    $$('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab));
    // aba Terminal usa a janela inteira (sem o teto de 1200px das outras abas)
    document.body.classList.toggle('term-full', btn.dataset.tab === 'terminal');
    if (btn.dataset.tab === 'terminal') onTerminalTabShown();
    if (btn.dataset.tab === 'config') loadConfigTab();
  }));
  document.body.classList.toggle('term-full', !!$('#tab-terminal.active') || $('#tab-terminal').classList.contains('active'));
}

// ---------- estado ----------
async function loadState() {
  state = await api('/api/state');
  renderHosts();
  renderPlaybooks();
  renderProfiles();
  renderGlobals();
  renderExecControls();
  renderHostSidebar();
  renderTermTabs();
}

// ---------- modal ----------
function openModal(title, bodyHtml) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml; // template estático; valores entram via .value
  const submit = $('#modalForm button[type=submit]');
  submit.textContent = 'Salvar';
  submit.disabled = false;
  $('#modalRoot').classList.add('open');
}

function closeModal() {
  $('#modalRoot').classList.remove('open');
  $('#modalForm').onsubmit = null;
}

// ---------- hosts ----------
function renderHosts() {
  const wrap = $('#hostsList');
  wrap.innerHTML = '';
  if (!state.hosts.length) {
    el(wrap, 'p', 'empty', 'Nenhum host cadastrado. Clique em "Novo host".');
    return;
  }
  for (const [groupName, hosts] of groupedHosts()) {
    const grp = el(wrap, 'div', 'host-group');
    const head = el(grp, 'div', 'host-group-header');
    el(head, 'span', 'gname', groupName);
    el(head, 'span', 'count', `${hosts.length} host(s)`);
    const cards = el(grp, 'div', 'host-cards');
    for (const h of hosts) cards.appendChild(hostCard(h));
  }
}

function hostCard(h) {
  const card = document.createElement('div');
  card.className = 'host-card';
  makeAvatar(card, h, 'avatar-lg');
  const info = el(card, 'div', 'info');
  el(info, 'div', 'hname', h.name);
  el(info, 'div', 'haddr', `${h.username}@${h.host}:${h.port}`);
  const meta = el(info, 'div', 'meta');
  el(meta, 'span', 'tag', authLabel(h.auth));
  const nv = Object.keys(h.vars || {}).length;
  if (nv) el(meta, 'span', 'tag', `${nv} var(s)`);
  if (h.fingerprint) el(meta, 'span', 'tag', 'fingerprint fixado');
  const actions = el(info, 'div', 'actions');
  const btnConn = el(actions, 'button', 'btn small primary', 'Conectar');
  btnConn.addEventListener('click', () => connectFromHosts(h.id));
  const btnTest = el(actions, 'button', 'btn small', 'Testar');
  btnTest.addEventListener('click', () => testHost(h, btnTest));
  const btnEdit = el(actions, 'button', 'btn small', 'Editar');
  btnEdit.addEventListener('click', () => openHostModal(h));
  const btnDel = el(actions, 'button', 'btn small danger', 'Excluir');
  btnDel.addEventListener('click', async () => {
    if (!confirm(`Excluir o host "${h.name}"?`)) return;
    try {
      await api(`/api/hosts/${h.id}`, { method: 'DELETE' });
      toast('Host excluído.');
      await loadState();
    } catch (e) { toast(e.message, 'erro'); }
  });
  return card;
}

// da aba Hosts: vai para o Terminal e conecta
function connectFromHosts(id) {
  document.querySelector('.tabs button[data-tab="terminal"]').click();
  setTimeout(() => openSession(id), 60);
}

async function testHost(h, btn) {
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = 'Testando…';
  try {
    const r = await api(`/api/hosts/${h.id}/test`, { method: 'POST' });
    if (r.ok) toast(`Conexão OK com ${h.name}.`);
    else toast(`Falha em ${h.name}: ${r.error}`, 'erro');
    await loadState();
  } catch (e) {
    toast(e.message, 'erro');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

function syncAuthFields() {
  const checked = $$('input[name="authType"]').find((r) => r.checked);
  const type = checked ? checked.value : 'agent';
  $('#authKeyFields').hidden = type !== 'key';
  $('#authPassFields').hidden = type !== 'password';
}

function openHostModal(existing) {
  openModal(existing ? 'Editar host' : 'Novo host', `
    <div class="grid2">
      <label>Nome <input id="f_name" required placeholder="ex.: web-01 Cliente A"></label>
      <label>Grupo (opcional) <input id="f_group" list="groupList" placeholder="ex.: Produção"><datalist id="groupList"></datalist></label>
      <label>Usuário <input id="f_user" required placeholder="root"></label>
      <label>Host / IP <input id="f_host" required placeholder="10.0.0.5 ou srv.exemplo.com"></label>
      <label>Porta <input id="f_port" type="number" min="1" max="65535" value="22"></label>
    </div>
    <fieldset class="appearance-fs">
      <legend>Aparência (ícone e cor)</legend>
      <div class="appearance">
        <div id="f_avatarPreview" class="appearance-preview" title="Prévia do avatar"></div>
        <div class="appearance-body">
          <div class="pick-row"><span class="pick-label">Ícone</span><button type="button" id="f_iconClear" class="btn small">Usar inicial do nome</button></div>
          <div id="f_iconGrid" class="icon-grid"></div>
          <div class="pick-row"><span class="pick-label">Cor</span></div>
          <div id="f_colorRow" class="color-row"></div>
        </div>
      </div>
    </fieldset>
    <fieldset>
      <legend>Autenticação</legend>
      <div class="radios">
        <label><input type="radio" name="authType" value="agent"> Agente SSH</label>
        <label><input type="radio" name="authType" value="key"> Chave privada</label>
        <label><input type="radio" name="authType" value="password"> Senha</label>
      </div>
      <div id="authKeyFields" class="auth-fields" hidden>
        <label>Caminho da chave <input id="f_keyPath" placeholder="~/.ssh/id_ed25519"></label>
        <label>Passphrase (opcional) <input id="f_passphrase" type="password" autocomplete="new-password"></label>
      </div>
      <div id="authPassFields" class="auth-fields" hidden>
        <label>Senha <input id="f_password" type="password" autocomplete="new-password"></label>
        <p class="hint">A senha fica salva em data.json (permissão 600) nesta máquina. Prefira agente ou chave.</p>
      </div>
    </fieldset>
    <label>Variáveis do host
      <textarea id="f_vars" rows="4" class="mono" placeholder="CHAVE=valor&#10;DATA_DIR=/srv/app"></textarea>
    </label>
    <div id="fpRow" class="hint" hidden></div>
  `);

  $('#f_name').value = existing ? existing.name : '';
  $('#f_group').value = (existing && existing.group) || '';
  $('#groupList').innerHTML = existingGroups().map((g) => `<option value="${g.replace(/"/g, '&quot;')}"></option>`).join('');
  $('#f_user').value = existing ? existing.username : '';
  $('#f_host').value = existing ? existing.host : '';
  $('#f_port').value = existing ? existing.port : 22;
  $('#f_keyPath').value = (existing && existing.auth.keyPath) || '';
  $('#f_vars').value = varsToText(existing && existing.vars);
  const type = (existing && existing.auth.type) || 'agent';
  $$('input[name="authType"]').forEach((r) => {
    r.checked = r.value === type;
    r.addEventListener('change', syncAuthFields);
  });
  if (existing && existing.auth.hasPassword) $('#f_password').placeholder = '•••••• (em branco = manter atual)';
  if (existing && existing.auth.hasPassphrase) $('#f_passphrase').placeholder = '•••••• (em branco = manter atual)';
  if (existing && existing.fingerprint) {
    const row = $('#fpRow');
    row.hidden = false;
    el(row, 'span', 'mono', `Fingerprint: ${existing.fingerprint.slice(0, 24)}… `);
    const forget = el(row, 'button', 'btn small', 'Esquecer fingerprint');
    forget.type = 'button';
    forget.addEventListener('click', async () => {
      try {
        await api(`/api/hosts/${existing.id}/forget-fingerprint`, { method: 'POST' });
        toast('Fingerprint removido — será fixado de novo na próxima conexão.');
        row.hidden = true;
        await loadState();
      } catch (e) { toast(e.message, 'erro'); }
    });
  }
  syncAuthFields();

  // ----- seletor de ícone e cor do avatar -----
  let selIcon = (existing && existing.icon) || '';
  let selColor = (existing && existing.color) || '';
  const refreshAvatarPreview = () => {
    const box = $('#f_avatarPreview');
    box.innerHTML = '';
    makeAvatar(box, { name: $('#f_name').value, icon: selIcon, color: selColor }, 'avatar-lg');
  };
  const iconGrid = $('#f_iconGrid');
  for (const [key, def] of Object.entries(HOST_ICONS)) {
    const b = el(iconGrid, 'button', 'icon-opt' + (selIcon === key ? ' sel' : ''));
    b.type = 'button';
    b.title = def.label;
    b.innerHTML = def.svg;
    b.addEventListener('click', () => {
      selIcon = selIcon === key ? '' : key;
      iconGrid.querySelectorAll('.icon-opt').forEach((x) => x.classList.remove('sel'));
      if (selIcon) b.classList.add('sel');
      refreshAvatarPreview();
    });
  }
  $('#f_iconClear').addEventListener('click', () => {
    selIcon = '';
    iconGrid.querySelectorAll('.icon-opt').forEach((x) => x.classList.remove('sel'));
    refreshAvatarPreview();
  });
  const colorRow = $('#f_colorRow');
  const markColor = () => colorRow.querySelectorAll('.color-opt').forEach((x) => x.classList.toggle('sel', (x.dataset.color || '') === selColor));
  const autoSw = el(colorRow, 'button', 'color-opt auto', 'A');
  autoSw.type = 'button';
  autoSw.dataset.color = '';
  autoSw.title = 'Automática (pela inicial do nome)';
  autoSw.addEventListener('click', () => { selColor = ''; markColor(); refreshAvatarPreview(); });
  for (const [key, hue] of Object.entries(HOST_COLORS)) {
    const b = el(colorRow, 'button', 'color-opt');
    b.type = 'button';
    b.dataset.color = key;
    b.title = key;
    b.style.background = `linear-gradient(135deg, hsl(${hue} 58% 48%), hsl(${(hue + 30) % 360} 58% 40%))`;
    b.addEventListener('click', () => { selColor = key; markColor(); refreshAvatarPreview(); });
  }
  markColor();
  $('#f_name').addEventListener('input', refreshAvatarPreview);
  refreshAvatarPreview();

  $('#modalForm').onsubmit = async (ev) => {
    ev.preventDefault();
    let vars;
    try { vars = textToVars($('#f_vars').value); } catch (e) { toast(e.message, 'erro'); return; }
    const checked = $$('input[name="authType"]').find((r) => r.checked);
    const authType = checked ? checked.value : 'agent';
    const body = {
      name: $('#f_name').value.trim(),
      group: $('#f_group').value.trim(),
      icon: selIcon,
      color: selColor,
      host: $('#f_host').value.trim(),
      port: Number($('#f_port').value),
      username: $('#f_user').value.trim(),
      vars,
      auth: { type: authType },
    };
    if (authType === 'key') {
      body.auth.keyPath = $('#f_keyPath').value.trim();
      if ($('#f_passphrase').value) body.auth.passphrase = $('#f_passphrase').value;
    }
    if (authType === 'password' && $('#f_password').value) body.auth.password = $('#f_password').value;
    try {
      if (existing) await api(`/api/hosts/${existing.id}`, { method: 'PUT', body });
      else await api('/api/hosts', { method: 'POST', body });
      closeModal();
      toast('Host salvo.');
      await loadState();
    } catch (e) { toast(e.message, 'erro'); }
  };
}

// ---------- playbooks ----------
function renderPlaybooks() {
  const wrap = $('#playbooksList');
  wrap.innerHTML = '';
  if (!state.playbooks.length) {
    el(wrap, 'p', 'empty', 'Nenhum playbook ainda. Crie um com seus comandos e variáveis {{ASSIM}}.');
    return;
  }
  for (const pb of state.playbooks) {
    const card = el(wrap, 'div', 'card item');
    const head = el(card, 'div', 'item-head');
    el(head, 'strong', null, pb.name);
    const n = pb.commands.filter((c) => c.trim() && !c.trim().startsWith('#')).length;
    el(head, 'span', 'muted small', `${n} comando(s)`);
    if (pb.description) el(card, 'p', 'muted', pb.description);
    const pre = el(card, 'pre', 'console small-console');
    pre.textContent = pb.commands.join('\n');
    const actions = el(card, 'div', 'actions');
    const btnEdit = el(actions, 'button', 'btn small', 'Editar');
    btnEdit.addEventListener('click', () => openPlaybookModal(pb));
    const btnDel = el(actions, 'button', 'btn small danger', 'Excluir');
    btnDel.addEventListener('click', async () => {
      if (!confirm(`Excluir o playbook "${pb.name}"?`)) return;
      try {
        await api(`/api/playbooks/${pb.id}`, { method: 'DELETE' });
        toast('Playbook excluído.');
        await loadState();
      } catch (e) { toast(e.message, 'erro'); }
    });
  }
}

function openPlaybookModal(existing) {
  const isEdit = !!(existing && existing.id); // rascunho gerado pela IA não tem id → é criação
  openModal(isEdit ? 'Editar playbook' : existing ? 'Revisar playbook gerado' : 'Novo playbook', `
    <label>Nome <input id="f_pbName" required placeholder="ex.: Atualizar aplicação"></label>
    <label>Descrição (opcional) <input id="f_pbDesc"></label>
    <label>Comandos — um por linha
      <textarea id="f_pbCommands" rows="10" class="mono" required placeholder="# use {{VARIAVEL}} para segmentar valores&#10;echo &quot;Deploy {{CLIENTE}} em {{AMBIENTE}}&quot;&#10;systemctl restart {{SERVICO}}"></textarea>
    </label>
    <p class="hint">Linhas vazias e iniciadas com # são ignoradas. Embutidas: {{host.name}}, {{host.host}}, {{host.port}}, {{host.user}}.</p>
    <p class="hint">Ranges/listas: <code>@cada VLAN em {{VLANS}}: vlan {{VLAN}}</code> repete o comando para cada item (ex.: VLANS=100-110,150). Também aceita range literal: <code>@cada PORTA em 1-24: …</code></p>
  `);
  $('#f_pbName').value = existing ? existing.name : '';
  $('#f_pbDesc').value = (existing && existing.description) || '';
  $('#f_pbCommands').value = existing ? existing.commands.join('\n') : '';

  $('#modalForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const body = {
      name: $('#f_pbName').value.trim(),
      description: $('#f_pbDesc').value.trim(),
      commands: $('#f_pbCommands').value.split('\n'),
    };
    try {
      if (isEdit) await api(`/api/playbooks/${existing.id}`, { method: 'PUT', body });
      else await api('/api/playbooks', { method: 'POST', body });
      closeModal();
      toast('Playbook salvo.');
      await loadState();
    } catch (e) { toast(e.message, 'erro'); }
  };
}

function openPlaybookAiModal() {
  openModal('Criar playbook com IA', `
    <p class="hint">Descreva em linguagem natural o que o playbook deve fazer. A IA gera os comandos — usando variáveis <code>{{ASSIM}}</code> reutilizáveis quando fizer sentido — e você revisa e edita antes de salvar. Requer chave da API em "Config. IA".</p>
    <label>O que o playbook deve fazer?
      <textarea id="f_pbAi" rows="5" placeholder="ex.: atualizar os pacotes do sistema, reiniciar o serviço {{SERVICO}} e verificar se ele voltou a rodar"></textarea>
    </label>
  `);
  $('#modalForm button[type=submit]').textContent = 'Gerar';
  const ta = $('#f_pbAi');
  setTimeout(() => ta.focus(), 30);

  $('#modalForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const description = ta.value.trim();
    if (!description) { toast('Descreva o que o playbook deve fazer.', 'erro'); return; }
    const btn = $('#modalForm button[type=submit]');
    btn.disabled = true;
    btn.textContent = 'Gerando…';
    try {
      const pb = await api('/api/ai/playbook', { method: 'POST', body: { description } });
      closeModal();
      toast('Playbook gerado — revise e salve.');
      openPlaybookModal({ name: pb.name, description: pb.description, commands: pb.commands });
    } catch (e) {
      toast(e.message, 'erro');
      btn.disabled = false;
      btn.textContent = 'Gerar';
    }
  };
}

// ---------- variáveis ----------
function renderGlobals() {
  $('#globalsText').value = varsToText(state.globals);
}

async function exportXml() {
  const secrets = $('#exportSecrets').checked;
  if (secrets && !confirm(
    'O arquivo vai conter as SENHAS, passphrases e a CHAVE DA API em texto claro. ' +
    'Qualquer pessoa com acesso ao arquivo poderá vê-los. Guarde-o com segurança.\n\nDeseja continuar?'
  )) return;
  const btn = $('#btnExportXml');
  btn.disabled = true;
  try {
    const res = await fetch('/api/export.xml' + (secrets ? '?secrets=1' : ''));
    if (!res.ok) throw new Error(`Erro ${res.status}`);
    const text = await res.text();
    const blob = new Blob([text], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `ssh-commander-config${secrets ? '-com-segredos' : ''}-${stamp}.xml`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(secrets ? 'Configuração exportada (com segredos).' : 'Configuração exportada.');
  } catch (e) {
    toast(e.message, 'erro');
  } finally {
    btn.disabled = false;
  }
}

// Converte o XML exportado em objeto de configuração (parse no navegador)
function xmlToConfig(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Arquivo XML inválido ou corrompido.');
  const root = doc.documentElement;
  if (!root || root.tagName !== 'sshCommander') throw new Error('Este arquivo não é um backup do Vincii Canvas.');

  const varsOf = (el) => {
    const o = {};
    if (el) el.querySelectorAll(':scope > var').forEach((v) => { o[v.getAttribute('name')] = v.textContent; });
    return o;
  };

  return {
    includesSecrets: root.getAttribute('includesSecrets') === 'true',
    config: {
      globals: varsOf(root.querySelector(':scope > globals')),
      profiles: [...root.querySelectorAll(':scope > profiles > profile')].map((p) => ({
        name: p.getAttribute('name'),
        vars: varsOf(p),
      })),
      hosts: [...root.querySelectorAll(':scope > hosts > host')].map((h) => {
        const auth = h.querySelector(':scope > auth');
        return {
          name: h.getAttribute('name'),
          host: h.getAttribute('host'),
          port: Number(h.getAttribute('port')) || 22,
          username: h.getAttribute('username'),
          group: h.getAttribute('group') || '',
          icon: h.getAttribute('icon') || '',
          color: h.getAttribute('color') || '',
          fingerprint: h.getAttribute('fingerprint') || null,
          auth: auth ? {
            type: auth.getAttribute('type') || 'agent',
            keyPath: auth.getAttribute('keyPath') || '',
            password: auth.getAttribute('password') || '',
            passphrase: auth.getAttribute('passphrase') || '',
          } : { type: 'agent' },
          vars: varsOf(h.querySelector(':scope > vars')),
        };
      }),
      playbooks: [...root.querySelectorAll(':scope > playbooks > playbook')].map((pb) => ({
        name: pb.getAttribute('name'),
        description: pb.getAttribute('description') || '',
        commands: [...pb.querySelectorAll(':scope > command')].map((c) => c.textContent),
      })),
      settings: (() => {
        const s = root.querySelector(':scope > settings');
        if (!s) return {};
        const out = {};
        if (s.getAttribute('model')) out.model = s.getAttribute('model');
        if (s.getAttribute('apiKey')) out.apiKey = s.getAttribute('apiKey');
        return out;
      })(),
    },
  };
}

async function importFromText(text) {
  let parsed;
  try { parsed = xmlToConfig(text); } catch (e) { toast(e.message, 'erro'); return; }
  const c = parsed.config;
  const counts = `${c.hosts.length} host(s), ${c.playbooks.length} playbook(s), ${c.profiles.length} perfil(is), ${Object.keys(c.globals).length} variável(is) global(is)`;
  const secretsNote = parsed.includesSecrets ? '\n\nO arquivo contém senhas/chave da API — serão importadas.' : '';
  if (!confirm(`Importar deste arquivo: ${counts}.\nItens com o mesmo nome serão atualizados; nada é apagado.${secretsNote}\n\nContinuar?`)) return;
  try {
    const r = await api('/api/import', { method: 'POST', body: c });
    await loadState();
    const p = (o) => `${o.added} novo(s), ${o.updated} atualizado(s)`;
    toast(`Importado — hosts: ${p(r.hosts)}; playbooks: ${p(r.playbooks)}; perfis: ${p(r.profiles)}.`);
    if (r.skipped && r.skipped.length) toast(`${r.skipped.length} item(ns) ignorado(s): ${r.skipped.slice(0, 3).join('; ')}`, 'erro');
  } catch (e) {
    toast(e.message, 'erro');
  }
}

function onImportFile(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { importFromText(String(reader.result)); ev.target.value = ''; };
  reader.onerror = () => { toast('Não foi possível ler o arquivo.', 'erro'); ev.target.value = ''; };
  reader.readAsText(file);
}

async function saveGlobals() {
  let vars;
  try { vars = textToVars($('#globalsText').value); } catch (e) { toast(e.message, 'erro'); return; }
  try {
    await api('/api/globals', { method: 'PUT', body: { vars } });
    toast('Variáveis globais salvas.');
    await loadState();
  } catch (e) { toast(e.message, 'erro'); }
}

function renderProfiles() {
  const wrap = $('#profilesList');
  wrap.innerHTML = '';
  if (!state.profiles.length) {
    el(wrap, 'p', 'empty', 'Nenhum perfil ainda. Ex.: "Cliente A — Produção" com CLIENTE=a, AMBIENTE=prod.');
    return;
  }
  for (const p of state.profiles) {
    const card = el(wrap, 'div', 'card item');
    const head = el(card, 'div', 'item-head');
    el(head, 'strong', null, p.name);
    el(head, 'span', 'muted small', `${Object.keys(p.vars || {}).length} variável(is)`);
    const pre = el(card, 'pre', 'console small-console');
    pre.textContent = varsToText(p.vars) || '(vazio)';
    const actions = el(card, 'div', 'actions');
    const btnEdit = el(actions, 'button', 'btn small', 'Editar');
    btnEdit.addEventListener('click', () => openProfileModal(p));
    const btnDel = el(actions, 'button', 'btn small danger', 'Excluir');
    btnDel.addEventListener('click', async () => {
      if (!confirm(`Excluir o perfil "${p.name}"?`)) return;
      try {
        await api(`/api/profiles/${p.id}`, { method: 'DELETE' });
        toast('Perfil excluído.');
        await loadState();
      } catch (e) { toast(e.message, 'erro'); }
    });
  }
}

function openProfileModal(existing) {
  openModal(existing ? 'Editar perfil' : 'Novo perfil (segmento)', `
    <label>Nome <input id="f_prName" required placeholder="ex.: Cliente A — Produção"></label>
    <label>Variáveis
      <textarea id="f_prVars" rows="8" class="mono" placeholder="CLIENTE=Cliente A&#10;AMBIENTE=producao"></textarea>
    </label>
  `);
  $('#f_prName').value = existing ? existing.name : '';
  $('#f_prVars').value = varsToText(existing && existing.vars);

  $('#modalForm').onsubmit = async (ev) => {
    ev.preventDefault();
    let vars;
    try { vars = textToVars($('#f_prVars').value); } catch (e) { toast(e.message, 'erro'); return; }
    const body = { name: $('#f_prName').value.trim(), vars };
    try {
      if (existing) await api(`/api/profiles/${existing.id}`, { method: 'PUT', body });
      else await api('/api/profiles', { method: 'POST', body });
      closeModal();
      toast('Perfil salvo.');
      await loadState();
    } catch (e) { toast(e.message, 'erro'); }
  };
}

// ---------- aba executar ----------
function getSelectedHostIds() {
  return $$('#hostChecklist input[type=checkbox]:checked').map((cb) => cb.value);
}

function syncAdhoc() {
  $('#adhocWrap').hidden = $('#playbookSelect').value !== '__adhoc__';
}

function renderExecControls() {
  const sel = $('#playbookSelect');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const pb of state.playbooks) {
    const o = el(sel, 'option', null, pb.name);
    o.value = pb.id;
  }
  const adhoc = el(sel, 'option', null, '✎ Comandos avulsos');
  adhoc.value = '__adhoc__';
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  else sel.selectedIndex = 0;
  syncAdhoc();

  const ps = $('#profileSelect');
  const prevP = ps.value;
  ps.innerHTML = '';
  el(ps, 'option', null, '(nenhum)').value = '';
  for (const p of state.profiles) {
    const o = el(ps, 'option', null, p.name);
    o.value = p.id;
  }
  if ([...ps.options].some((o) => o.value === prevP)) ps.value = prevP;

  const wrap = $('#hostChecklist');
  const checked = new Set(getSelectedHostIds());
  const hadAny = wrap.querySelector('input') !== null;
  wrap.innerHTML = '';
  if (!state.hosts.length) {
    el(wrap, 'p', 'hint', 'Cadastre hosts na aba "Hosts".');
    return;
  }
  for (const [groupName, hosts] of groupedHosts()) {
    el(wrap, 'div', 'check-group-label', groupName);
    for (const h of hosts) {
      const label = el(wrap, 'label', 'check-host');
      label.dataset.search = `${groupName} ${h.name} ${h.username}@${h.host}:${h.port}`.toLowerCase();
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = h.id;
      cb.checked = hadAny ? checked.has(h.id) : true;
      label.appendChild(cb);
      makeAvatar(label, h, 'avatar-sm');
      const info = el(label, 'div', 'info');
      el(info, 'div', 'hname', h.name);
      el(info, 'div', 'haddr', `${h.username}@${h.host}:${h.port}`);
    }
  }
  filterExecHosts(); // reaplica a busca atual após re-renderizar
}

// Filtra a lista de hosts da aba Executar pela busca. Só ESCONDE (CSS) os que
// não casam — as seleções de hosts fora do filtro são preservadas; o "todos"
// passa a valer para os visíveis. A prévia sempre mostra o que vai rodar.
function filterExecHosts() {
  const wrap = $('#hostChecklist');
  if (!wrap) return;
  const q = (($('#execHostSearch') && $('#execHostSearch').value) || '').toLowerCase().trim();
  let groupLabel = null;
  let groupHasVisible = false;
  let anyVisible = false;
  for (const n of [...wrap.children]) {
    if (n.classList.contains('check-group-label')) {
      if (groupLabel) groupLabel.classList.toggle('filtered-out', !groupHasVisible);
      groupLabel = n;
      groupHasVisible = false;
    } else if (n.classList.contains('check-host')) {
      const match = !q || (n.dataset.search || '').includes(q);
      n.classList.toggle('filtered-out', !match);
      if (match) { groupHasVisible = true; anyVisible = true; }
    }
  }
  if (groupLabel) groupLabel.classList.toggle('filtered-out', !groupHasVisible);
  let empty = wrap.querySelector('.search-empty');
  if (q && !anyVisible) {
    if (!empty) empty = el(wrap, 'p', 'hint search-empty', 'Nenhum host encontrado para essa busca.');
    empty.hidden = false;
  } else if (empty) {
    empty.hidden = true;
  }
}

function gatherBody() {
  const hostIds = getSelectedHostIds();
  if (!hostIds.length) throw new Error('Selecione ao menos um host.');
  const overrides = textToVars($('#overridesText').value);
  const body = {
    hostIds,
    overrides,
    stopOnError: $('#optStopOnError').checked,
    sequential: $('#optSequential').checked,
    timeoutSec: Math.max(0, Number($('#optTimeout').value) || 0),
  };
  const profileId = $('#profileSelect').value;
  if (profileId) body.profileId = profileId;
  const src = $('#playbookSelect').value;
  if (src === '__adhoc__') body.commands = $('#adhocCommands').value.split('\n');
  else if (src) body.playbookId = src;
  else throw new Error('Crie um playbook ou use comandos avulsos.');
  return body;
}

async function doPreview() {
  let body;
  try { body = gatherBody(); } catch (e) { toast(e.message, 'erro'); return; }
  try {
    const r = await api('/api/preview', { method: 'POST', body });
    renderPreview(r);
  } catch (e) { toast(e.message, 'erro'); }
}

function renderPreview(r) {
  const ph = $('#execPlaceholder');
  if (ph) ph.hidden = true;
  $('#runPanel').hidden = true;
  const panel = $('#previewPanel');
  panel.hidden = false;
  panel.innerHTML = '';
  el(panel, 'h2', null, 'Pré-visualização (nada foi executado)');
  for (const h of r.hosts) {
    const box = el(panel, 'div', 'preview-host');
    const head = el(box, 'div', 'preview-head');
    el(head, 'strong', null, h.name);
    el(head, 'span', 'mono muted small', h.address);
    if (h.missing.length) {
      el(box, 'p', 'missing', '⚠ Variáveis não definidas: ' + h.missing.join(', '));
    }
    const pre = el(box, 'pre', 'console');
    for (const c of h.commands) {
      el(pre, 'span', c.missing.length ? 'line-err' : 'line-cmd', '$ ' + c.resolved + '\n');
    }
  }
}

async function doRun() {
  let body;
  try { body = gatherBody(); } catch (e) { toast(e.message, 'erro'); return; }
  $('#btnRun').disabled = true;
  try {
    const r = await api('/api/run', { method: 'POST', body });
    attachRun(r.runId);
  } catch (e) {
    toast(e.message, 'erro');
    $('#btnRun').disabled = false;
  }
}

function attachRun(runId) {
  const ph = $('#execPlaceholder');
  if (ph) ph.hidden = true;
  $('#previewPanel').hidden = true;
  $('#runOutput').innerHTML = '';
  $('#runSummary').textContent = 'Iniciando…';
  $('#runPanel').hidden = false;
  $('#btnCancel').hidden = false;
  currentRun = { id: runId, panels: new Map(), done: false, es: new EventSource(`/api/runs/${runId}/stream`) };
  currentRun.es.onmessage = (m) => handleEvent(JSON.parse(m.data));
  currentRun.es.onerror = () => {
    if (currentRun && !currentRun.done) {
      $('#runSummary').textContent += ' (conexão de eventos perdida — recarregue a página)';
    }
  };
}

function panelFor(hostId) {
  return currentRun ? currentRun.panels.get(hostId) : null;
}

function chipSet(chip, status, label) {
  chip.className = 'chip ' + status;
  chip.textContent = label;
}

// Agrupa os scrolls num único frame — com milhares de linhas expandidas (@cada),
// ler scrollHeight a cada evento SSE forçaria um reflow síncrono por chunk.
const pendingScroll = new Set();
let scrollScheduled = false;
function autoscroll(pre) {
  pendingScroll.add(pre);
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    for (const p of pendingScroll) p.scrollTop = p.scrollHeight;
    pendingScroll.clear();
  });
}

function handleEvent(evt) {
  switch (evt.type) {
    case 'run-start': {
      const src = evt.playbookName ? `playbook "${evt.playbookName}"` : 'comandos avulsos';
      $('#runSummary').textContent = `Executando ${src}: ${evt.commandCount} comando(s) no total em ${evt.hostCount} host(s)…`;
      break;
    }
    case 'host-start': {
      const box = el($('#runOutput'), 'section', 'host-box');
      const head = el(box, 'header', 'host-head');
      const chip = el(head, 'span', 'chip conectando', 'conectando');
      el(head, 'strong', null, evt.name);
      el(head, 'span', 'mono muted small', evt.address);
      const pre = el(box, 'pre', 'console');
      currentRun.panels.set(evt.host, { chip, pre });
      break;
    }
    case 'notice': {
      const p = evt.host ? panelFor(evt.host) : null;
      if (p) {
        el(p.pre, 'span', 'line-notice', '· ' + evt.message + '\n');
        autoscroll(p.pre);
      } else {
        $('#runSummary').textContent = evt.message;
      }
      break;
    }
    case 'cmd-start': {
      const p = panelFor(evt.host);
      if (!p) break;
      chipSet(p.chip, 'executando', 'executando');
      el(p.pre, 'span', 'line-cmd', '$ ' + evt.command + '\n');
      autoscroll(p.pre);
      break;
    }
    case 'data': {
      const p = panelFor(evt.host);
      if (!p) break;
      el(p.pre, 'span', evt.kind === 'err' ? 'line-err' : 'line-out', stripAnsi(evt.text));
      autoscroll(p.pre);
      break;
    }
    case 'cmd-end': {
      const p = panelFor(evt.host);
      if (!p) break;
      let msg, cls;
      if (evt.error) { msg = `✗ erro: ${evt.error}`; cls = 'line-meta fail'; }
      else if (evt.timedOut) { msg = `✗ tempo esgotado (${fmtMs(evt.durationMs)})`; cls = 'line-meta fail'; }
      else if (evt.code === 0) { msg = `✓ ok (${fmtMs(evt.durationMs)})`; cls = 'line-meta okc'; }
      else { msg = `✗ código de saída ${evt.code === null ? '?' : evt.code} (${fmtMs(evt.durationMs)})`; cls = 'line-meta fail'; }
      el(p.pre, 'span', cls, msg + '\n');
      autoscroll(p.pre);
      break;
    }
    case 'host-end': {
      const p = panelFor(evt.host);
      if (!p) break;
      const map = { ok: ['ok', 'concluído'], erro: ['erro', 'falhou'], cancelado: ['cancelado', 'cancelado'] };
      const [cls, label] = map[evt.status] || ['erro', evt.status];
      chipSet(p.chip, cls, label);
      if (evt.error) {
        el(p.pre, 'span', 'line-err', '✗ ' + evt.error + '\n');
        autoscroll(p.pre);
      }
      break;
    }
    case 'run-end': {
      currentRun.done = true;
      currentRun.es.close();
      $('#btnCancel').hidden = true;
      $('#btnRun').disabled = false;
      const c = evt.counts || {};
      const statusTxt = { ok: 'Concluído com sucesso', erro: 'Concluído com falhas', cancelado: 'Cancelado' }[evt.status] || evt.status;
      $('#runSummary').textContent = `${statusTxt} em ${fmtMs(evt.durationMs)} — ${c.ok || 0} OK, ${c.erro || 0} com erro, ${c.cancelado || 0} cancelado(s).`;
      break;
    }
  }
}

async function doCancel() {
  if (!currentRun) return;
  try {
    await api(`/api/runs/${currentRun.id}/cancel`, { method: 'POST' });
  } catch (e) { toast(e.message, 'erro'); }
}

// ---------- terminal: múltiplas sessões (abas) ----------
let sessions = [];          // { id, hostId, hostName, isLocal, term, fitAddon, ws, container, status }
let activeSessionId = null;
let sessionSeq = 0;
let termSelectedHost = null; // host da sessão ativa (usado por IA/agente)
let localDismissed = false;  // usuário fechou o terminal local; não reabrir sozinho até reentrar na aba
let localInfo = null;        // { user, host, shell, platform } da própria máquina

async function loadLocalInfo() {
  try { localInfo = await api('/api/local-info'); renderHostSidebar(); } catch {}
}

const DEFAULT_TERM_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const DEFAULT_TERM_FONT_SIZE = 13;
let termFont = DEFAULT_TERM_FONT;
let termFontSize = DEFAULT_TERM_FONT_SIZE;

function activeSession() { return sessions.find((s) => s.id === activeSessionId) || null; }
function activeHostId() { const s = activeSession(); return s ? s.hostId : null; }

function applyTermAppearance() {
  for (const s of sessions) {
    s.term.options.fontFamily = termFont;
    s.term.options.fontSize = termFontSize;
  }
  fitActive();
}

// ----- hosts recentes (persistidos por máquina no localStorage) -----
function getRecents() {
  let ids = [];
  try { ids = JSON.parse(localStorage.getItem('vc-recent-hosts') || '[]'); } catch {}
  if (!Array.isArray(ids)) ids = [];
  const exist = new Set(state.hosts.map((h) => h.id));
  return ids.filter((id) => exist.has(id)); // remove os que já não existem
}
function saveRecents(ids) {
  try { localStorage.setItem('vc-recent-hosts', JSON.stringify(ids.slice(0, 30))); } catch {}
}
function addRecent(id) {
  const ids = getRecents().filter((x) => x !== id);
  ids.unshift(id);
  saveRecents(ids);
}
function removeRecent(id) {
  saveRecents(getRecents().filter((x) => x !== id));
}

function renderHostSidebar() {
  const list = $('#hostSidebarList');
  if (!list) return;
  const q = (($('#hostSearch') && $('#hostSearch').value) || '').toLowerCase().trim();
  list.innerHTML = '';

  // monta um item de host; removable = mostra "×" para tirar dos recentes
  const addHostItem = (h, removable) => {
    const nConn = sessions.filter((s) => s.hostId === h.id && s.status === 'conectado').length;
    let cls = 'host-item';
    if (activeHostId() === h.id) cls += ' active';
    if (nConn) cls += ' connected';
    const item = el(list, 'div', cls);
    makeAvatar(item, h);
    const info = el(item, 'div', 'info');
    el(info, 'div', 'hname', h.name);
    el(info, 'div', 'haddr', `${h.username}@${h.host}:${h.port}`);
    if (nConn > 1) el(item, 'span', 'conn-count', String(nConn));
    el(item, 'span', 'dot');
    item.title = 'Clique para abrir uma nova conexão';
    item.addEventListener('click', () => openSession(h.id));
    if (removable) {
      const x = el(item, 'button', 'host-remove', '×');
      x.type = 'button';
      x.title = 'Remover dos recentes';
      x.addEventListener('click', (e) => { e.stopPropagation(); removeRecent(h.id); renderHostSidebar(); });
    }
  };

  if (q) {
    // BUSCA: mostra todos os hosts que casam, agrupados — para conectar a qualquer um
    let shown = 0;
    for (const [groupName, hosts] of groupedHosts()) {
      const matches = hosts.filter((h) => `${h.name} ${h.username}@${h.host}:${h.port}`.toLowerCase().includes(q));
      if (!matches.length) continue;
      const lbl = el(list, 'div', 'host-group-label');
      el(lbl, 'span', null, groupName);
      el(lbl, 'span', 'count', String(matches.length));
      for (const h of matches) { shown++; addHostItem(h, false); }
    }
    if (!shown) el(list, 'p', 'empty', 'Nenhum host encontrado.');
    return;
  }

  // SEM BUSCA: atalho fixo do terminal local + hosts recentes (com "×")
  const localItem = el(list, 'div', 'host-item local-item');
  const act = activeSession();
  if (act && act.isLocal) localItem.classList.add('active');
  if (sessions.some((s) => s.isLocal && s.status === 'conectado')) localItem.classList.add('connected');
  makeAvatar(localItem, { name: 'Meu computador', icon: localOsIcon(), color: 'teal' });
  const linfo = el(localItem, 'div', 'info');
  el(linfo, 'div', 'hname', 'Meu computador');
  const login = (localInfo && localInfo.user && localInfo.host) ? `${localInfo.user}@${localInfo.host}` : 'terminal local';
  el(linfo, 'div', 'haddr', login + (localInfo && localInfo.shell ? ` · ${localInfo.shell}` : ''));
  el(localItem, 'span', 'dot');
  localItem.title = 'Abrir um terminal na sua própria máquina';
  localItem.addEventListener('click', () => openLocalSession());

  const recents = getRecents();
  const lbl = el(list, 'div', 'host-group-label');
  el(lbl, 'span', null, 'Recentes');
  if (recents.length) el(lbl, 'span', 'count', String(recents.length));
  if (!recents.length) {
    el(list, 'p', 'empty', state.hosts.length
      ? 'Nenhum host recente. Use a busca acima para conectar — o host passa a aparecer aqui.'
      : 'Nenhum host cadastrado. Clique em + acima para adicionar um servidor.');
    return;
  }
  const byId = new Map(state.hosts.map((h) => [h.id, h]));
  for (const id of recents) { const h = byId.get(id); if (h) addHostItem(h, true); }
}

function xtermReady() {
  if (typeof Terminal === 'undefined') {
    toast('Biblioteca do terminal (xterm) não carregou.', 'erro');
    return false;
  }
  return true;
}

function fitActive() {
  const s = activeSession();
  if (s) { try { s.fitAddon.fit(); } catch {} }
}

function focusActive() {
  const s = activeSession();
  if (s) setTimeout(() => { try { s.term.focus(); } catch {} }, 30);
}

// Re-mede a sessão e envia o tamanho atual ao servidor (corrige uma conexão que
// nasceu estreita por o xterm ainda não ter sido pintado quando conectou).
function sendResize(session) {
  if (!session) return;
  try { session.fitAddon.fit(); } catch {}
  if (session.ws && session.ws.readyState === WebSocket.OPEN) {
    session.ws.send(JSON.stringify({ t: 'r', cols: session.term.cols || 80, rows: session.term.rows || 24 }));
  }
}

function onTerminalTabShown() {
  localDismissed = false;
  ensureLocalTerminal(); // sem nada conectado, cai no terminal local da máquina
  setTimeout(() => { fitActive(); focusActive(); }, 40);
}

// Abre uma NOVA conexão (sessão) para o host — permite várias, inclusive ao mesmo host
function openSession(hostId) {
  if (!xtermReady()) return;
  const host = state.hosts.find((h) => h.id === hostId);
  if (!host) { toast('Host não encontrado.', 'erro'); return; }
  addRecent(hostId); // passa a aparecer na lista de recentes da sidebar
  createSession({ hostId, hostName: host.name });
}

// Abre um terminal LOCAL (shell da própria máquina)
function openLocalSession() {
  if (!xtermReady()) return;
  localDismissed = false;
  createSession({ hostId: null, hostName: 'Meu computador', isLocal: true });
}

function createSession({ hostId, hostName, isLocal }) {
  const id = ++sessionSeq;
  const container = el($('#termContainers'), 'div', 'term-instance');
  const term = new Terminal({
    cursorBlink: true,
    fontSize: termFontSize,
    fontFamily: termFont,
    theme: { background: '#0a0d12', foreground: '#e6edf3', cursor: '#00c9b1' },
    scrollback: 5000,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);
  const session = { id, hostId, hostName, isLocal: !!isLocal, term, fitAddon, ws: null, container, status: 'conectando' };
  // estado de IA POR SESSÃO: cada aba tem seu assistente e agente independentes
  session.ai = { history: [], aiBusy: false, mode: 'assist', goal: '', agent: null, messagesEl: buildAiMessages(), feedEl: buildAgentFeed() };
  term.onData((d) => { if (session.ws && session.ws.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify({ t: 'i', d })); });
  term.onResize(({ cols, rows }) => { if (session.ws && session.ws.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify({ t: 'r', cols, rows })); });
  sessions.push(session);
  setActiveSession(id);
  // só conecta quando o xterm já tem tamanho real (senão o pty nasce estreito)
  waitSizedThenConnect(session, 0);
  return session;
}

function terminalTabActive() {
  return !!($('#tab-terminal') && $('#tab-terminal').classList.contains('active'));
}
function hasRemoteSession() { return sessions.some((s) => !s.isLocal); }
// Sem nenhuma sessão remota, garante um terminal local da própria máquina.
function ensureLocalTerminal() {
  if (!xtermReady() || !terminalTabActive() || localDismissed) return;
  if (sessions.length === 0) openLocalSession();
}
function localOsIcon() {
  const p = String((localInfo && localInfo.platform) || navigator.platform || navigator.userAgent || '').toLowerCase();
  if (p.includes('darwin') || p.includes('mac')) return 'apple';
  if (p.includes('win')) return 'windows';
  if (p.includes('linux')) return 'linux';
  return 'desktop';
}

function waitSizedThenConnect(session, tries) {
  try { session.fitAddon.fit(); } catch {}
  if ((session.term.cols || 0) >= 20 || tries >= 25) { connectSession(session); return; }
  setTimeout(() => waitSizedThenConnect(session, tries + 1), 25);
}

function connectSession(session) {
  fitActive();
  const cols = session.term.cols || 80;
  const rows = session.term.rows || 24;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = session.isLocal
    ? `${proto}://${location.host}/api/localterminal?cols=${cols}&rows=${rows}`
    : `${proto}://${location.host}/api/terminal?hostId=${encodeURIComponent(session.hostId)}&cols=${cols}&rows=${rows}`;
  session.status = 'conectando';
  const ws = new WebSocket(url);
  session.ws = ws;
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'o') session.term.write(m.d);
    else if (m.t === 'ready') {
      session.status = 'conectado';
      renderTermTabs();
      renderHostSidebar();
      if (activeSessionId === session.id) { setTimeout(() => { sendResize(session); focusActive(); }, 30); }
    } else if (m.t === 'e') session.term.write(`\r\n\x1b[33m${m.d}\x1b[0m`);
    else if (m.t === 'x') { session.status = 'encerrado'; renderTermTabs(); }
  };
  ws.onclose = () => {
    if (session.status === 'conectando' || session.status === 'conectado') session.status = 'encerrado';
    session.ws = null;
    renderTermTabs();
    renderHostSidebar();
  };
  ws.onerror = () => {};
}

function setActiveSession(id) {
  activeSessionId = id;
  for (const s of sessions) s.container.hidden = s.id !== id;
  const s = activeSession();
  const empty = $('#termEmpty');
  if (empty) empty.hidden = !!s;
  if (s) {
    termSelectedHost = s.hostId;
    setTimeout(() => { sendResize(s); focusActive(); }, 20);
  }
  renderTermTabs();
  renderHostSidebar();
  mountAiForActive(); // painel da direita reflete a IA (assistente + agente) da aba ativa
}

function closeSession(id) {
  const idx = sessions.findIndex((s) => s.id === id);
  if (idx < 0) return;
  const s = sessions[idx];
  if (s.isLocal) localDismissed = true; // fechou o local de propósito: não reabrir sozinho
  try { if (s.ws) s.ws.close(); } catch {}
  try { s.term.dispose(); } catch {}
  try { s.container.remove(); } catch {}
  sessions.splice(idx, 1);
  if (activeSessionId === id) {
    const next = sessions[idx] || sessions[idx - 1] || null;
    setActiveSession(next ? next.id : null);
  } else {
    renderTermTabs();
    renderHostSidebar();
  }
  ensureLocalTerminal(); // fechou a última remota? cai no terminal local
}

function renderTermTabs() {
  const bar = $('#termTabs');
  if (!bar) return;
  bar.innerHTML = '';
  for (const s of sessions) {
    const tab = el(bar, 'div', 'term-tab' + (s.id === activeSessionId ? ' active' : ''));
    el(tab, 'span', 'tab-dot ' + s.status);
    el(tab, 'span', 'tab-name', s.hostName);
    if (s.ai && s.ai.agent && s.ai.agent.status === 'running') {
      const ind = el(tab, 'span', 'tab-agent' + (s.ai.agent.needsApproval ? ' warn' : ''));
      ind.title = s.ai.agent.needsApproval ? 'Agente aguardando sua aprovação' : 'Agente de IA em execução';
    }
    const x = el(tab, 'span', 'tab-close', '×');
    x.title = 'Fechar conexão';
    tab.addEventListener('click', (e) => { if (e.target !== x) setActiveSession(s.id); });
    x.addEventListener('click', (e) => { e.stopPropagation(); closeSession(s.id); });
  }
}

function termSnapshot() {
  const s = activeSession();
  if (!s) return '';
  const buf = s.term.buffer.active;
  const lines = [];
  const start = Math.max(0, buf.length - 45);
  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function insertCommand(cmd, run) {
  const s = activeSession();
  if (!s || !s.ws || s.ws.readyState !== WebSocket.OPEN) {
    toast('Abra uma conexão antes de inserir o comando.', 'erro');
    return;
  }
  s.ws.send(JSON.stringify({ t: 'i', d: cmd + (run ? '\n' : '') }));
  focusActive();
}

// ---------- IA por sessão: builders + montagem no painel ----------
const AI_EMPTY_ASSIST = 'Peça ajuda com comandos em linguagem natural — ex.: <em>"como vejo o uso de disco?"</em>. A IA sugere comandos; você decide inserir e executar. Nada roda sozinho.';
const AI_EMPTY_AGENT = 'A IA vai executar comandos no servidor <strong>sozinha</strong> para cumprir a tarefa, e você acompanha cada passo aqui. Você pode parar a qualquer momento; comandos perigosos pedem sua aprovação.';

function buildAiMessages() {
  const box = document.createElement('div');
  box.className = 'ai-messages';
  el(box, 'p', 'ai-empty').innerHTML = AI_EMPTY_ASSIST;
  return box;
}
function buildAgentFeed() {
  const box = document.createElement('div');
  box.className = 'agent-feed';
  el(box, 'p', 'ai-empty').innerHTML = AI_EMPTY_AGENT;
  return box;
}

// Mostra no painel a IA (assistente + agente) da aba ATIVA. As abas inativas
// mantêm seus próprios elementos (destacados do DOM) e seguem recebendo eventos.
function mountAiForActive() {
  const msgMount = $('#aiMessagesMount');
  const feedMount = $('#agentFeedMount');
  if (!msgMount || !feedMount) return;
  const s = activeSession();
  msgMount.replaceChildren();
  feedMount.replaceChildren();
  if (s && s.ai) {
    msgMount.appendChild(s.ai.messagesEl);
    feedMount.appendChild(s.ai.feedEl);
    setPanelMode(s.ai.mode);
    $('#aiInput').value = s.ai.draft || '';
    $('#agentGoal').value = s.ai.goal || '';
    $('#aiSend').disabled = !!s.ai.aiBusy;
  }
  updateAgentControls(s);
}

function setPanelMode(mode) {
  const agent = mode === 'agent';
  $$('.ai-modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#assistView').hidden = agent;
  $('#agentView').hidden = !agent;
}

// habilita/desabilita os controles do agente conforme a aba ativa
// (o agente autônomo só roda em host remoto; no terminal local, só assistente)
function updateAgentControls(s) {
  const start = $('#agentStart'), auto = $('#agentAuto'), stop = $('#agentStop'), note = $('#agentLocalNote'), goal = $('#agentGoal');
  const agent = s && s.ai && s.ai.agent;
  const running = !!(agent && agent.status === 'running');
  const isLocal = !!(s && s.isLocal);
  const canAgent = !!(s && !isLocal && s.hostId);
  if (start) { start.hidden = running; start.disabled = !canAgent; }
  if (auto) { auto.hidden = running; auto.disabled = !canAgent; }
  if (stop) stop.hidden = !running;
  if (note) note.hidden = !isLocal;
  // a textarea fica SEMPRE habilitada (digitar deve funcionar em qualquer aba);
  // no terminal local só os botões ficam desativados, com a nota explicando.
}

// ---------- assistente de IA (estado por sessão) ----------
function aiReset(ai) {
  ai = ai || (activeSession() && activeSession().ai);
  if (!ai) return;
  ai.history = [];
  ai.messagesEl.replaceChildren();
  el(ai.messagesEl, 'p', 'ai-empty').innerHTML = AI_EMPTY_ASSIST;
}

function aiScroll(ai) {
  if (ai && ai.messagesEl) ai.messagesEl.scrollTop = ai.messagesEl.scrollHeight;
}

function renderAiMessage(ai, role, text, opts = {}) {
  const box = ai.messagesEl;
  const empty = box.querySelector('.ai-empty');
  if (empty) empty.remove();
  const msg = el(box, 'div', 'ai-msg ' + role + (opts.error ? ' error' : ''));
  el(msg, 'div', 'role', role === 'user' ? 'você' : opts.error ? 'erro' : 'IA');
  const body = el(msg, 'div', 'body');
  if (role === 'assistant' && !opts.error) renderAssistantBody(body, text);
  else el(body, 'p', null, text);
  aiScroll(ai);
  return { msg, body };
}

// Renderiza texto com blocos ```bash``` como código + botões de inserir
function renderAssistantBody(container, text) {
  container.innerHTML = '';
  const parts = String(text).split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // bloco de código: primeira linha pode ser a linguagem
      let code = part.replace(/^[a-zA-Z0-9_-]*\n/, '').replace(/\n$/, '');
      if (!code.trim()) { if (part.trim()) el(container, 'p', null, part); return; }
      const wrap = el(container, 'div', 'ai-code');
      el(wrap, 'pre').textContent = code;
      const actions = el(wrap, 'div', 'code-actions');
      const bInsert = el(actions, 'button', 'btn small', 'Inserir');
      bInsert.addEventListener('click', () => insertCommand(code, false));
      const bRun = el(actions, 'button', 'btn small primary', 'Inserir e executar');
      bRun.addEventListener('click', () => insertCommand(code, true));
    } else if (part.trim()) {
      for (const para of part.split(/\n{2,}/)) {
        if (para.trim()) el(container, 'p', null, para.trim());
      }
    }
  });
}

async function aiSend(question) {
  const s = activeSession();
  if (!s || !s.ai) return;
  const ai = s.ai;
  if (ai.aiBusy) return;
  const q = question.trim();
  if (!q) return;
  ai.aiBusy = true;
  ai.draft = '';
  $('#aiSend').disabled = true;
  $('#aiInput').value = '';
  renderAiMessage(ai, 'user', q);
  ai.history.push({ role: 'user', content: q });

  const { body } = renderAiMessage(ai, 'assistant', '…');
  let acc = '';
  try {
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: ai.history, hostId: s.hostId, terminalContext: termSnapshot() }),
    });
    if (!res.ok || !res.body) throw new Error(`Erro ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let errored = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 2);
        if (!line.startsWith('data:')) continue;
        const evt = JSON.parse(line.slice(5).trim());
        if (evt.type === 'delta') {
          acc += evt.text;
          renderAssistantBody(body, acc);
          aiScroll(ai);
        } else if (evt.type === 'error') {
          errored = true;
          body.innerHTML = '';
          el(body, 'p', null, evt.error);
          body.parentElement.classList.add('error');
          body.previousElementSibling.textContent = 'erro';
        }
      }
    }
    if (!errored && acc) {
      ai.history.push({ role: 'assistant', content: acc });
    } else if (!errored && !acc) {
      el(body, 'p', null, '(sem resposta)');
    }
  } catch (e) {
    body.innerHTML = '';
    el(body, 'p', null, e.message);
    body.parentElement.classList.add('error');
  } finally {
    ai.aiBusy = false;
    if (activeSession() === s) $('#aiSend').disabled = false;
    aiScroll(ai);
  }
}

// ---------- visibilidade dos recursos de IA + layout do terminal ----------
let aiEnabled = false;
let aiCollapsed = false;      // usuário recolheu o painel de IA (lembrado)
let sidebarCollapsed = false; // usuário recolheu a barra de hosts (lembrado)
try {
  aiCollapsed = localStorage.getItem('vc-ai-collapsed') === '1';
  sidebarCollapsed = localStorage.getItem('vc-sidebar-collapsed') === '1';
} catch {}

// aplica sidebar/painel de IA recolhidos ou não — devolve espaço ao terminal
function updateTermLayout() {
  const grid = document.querySelector('.term-grid');
  const pane = document.querySelector('.ai-pane');
  const sidebar = document.querySelector('.host-sidebar');
  const showAi = aiEnabled && !aiCollapsed;
  if (pane) pane.hidden = !showAi;
  if (sidebar) sidebar.hidden = sidebarCollapsed;
  if (grid) {
    grid.classList.toggle('no-ai', !showAi);
    grid.classList.toggle('no-sidebar', sidebarCollapsed);
  }
  const bAi = $('#toggleAiPane');
  if (bAi) { bAi.hidden = !aiEnabled; bAi.classList.toggle('active', showAi); }
  const bSb = $('#toggleSidebar');
  if (bSb) bSb.classList.toggle('active', !sidebarCollapsed);
  // o terminal muda de largura — reajusta o xterm
  if ($('#tab-terminal').classList.contains('active')) setTimeout(fitActive, 40);
}

function applyAiVisibility(hasKey) {
  aiEnabled = !!hasKey;
  const pbAi = $('#btnPlaybookAi');
  if (pbAi) pbAi.hidden = !aiEnabled;
  if (aiEnabled) mountAiForActive(); // (re)monta a IA da aba ativa ao exibir o painel
  updateTermLayout();
}

async function refreshAiVisibility() {
  try {
    const s = await api('/api/settings');
    applyAiVisibility(s.hasApiKey);
    if (s.termFont) termFont = s.termFont;
    if (s.termFontSize) termFontSize = s.termFontSize;
    applyTermAppearance();
  } catch {
    applyAiVisibility(false);
  }
}

// ---------- modo assistente vs. agente (lembrado por aba) ----------
function initAiModes() {
  $$('.ai-modes button').forEach((btn) => btn.addEventListener('click', () => {
    const mode = btn.dataset.mode;
    const s = activeSession();
    if (s && s.ai) s.ai.mode = mode;
    setPanelMode(mode);
  }));
}

function currentMode() {
  const s = activeSession();
  return (s && s.ai && s.ai.mode) || 'assist';
}

// ---------- agente autônomo (um por sessão, rodando em paralelo) ----------
function agentResetFeed(ai) {
  ai = ai || (activeSession() && activeSession().ai);
  if (!ai) return;
  ai.feedEl.replaceChildren();
  el(ai.feedEl, 'p', 'ai-empty').innerHTML = AI_EMPTY_AGENT;
}

function agentScroll(ai) { if (ai && ai.feedEl) ai.feedEl.scrollTop = ai.feedEl.scrollHeight; }

function clearThinking(ai) {
  const t = ai.feedEl.querySelector('.agent-thinking');
  if (t) t.remove();
}

function agentStart(auto) {
  const s = activeSession();
  if (!s || !s.ai) return;
  if (s.isLocal || !s.hostId) { toast('O agente autônomo roda em hosts remotos. Conecte-se a um host.', 'erro'); return; }
  const goal = $('#agentGoal').value.trim();
  if (!goal) { toast('Descreva a tarefa para o agente.', 'erro'); return; }
  if (auto && !confirm(
    'Modo AUTOMÁTICO: a IA vai executar sozinha todos os comandos necessários para cumprir a tarefa, sem pedir confirmação — inclusive comandos que alteram ou apagam dados no servidor. ' +
    'Você acompanha ao vivo e pode clicar em "Parar" a qualquer momento.\n\nDeseja continuar?'
  )) return;
  const ai = s.ai;
  ai.goal = goal;
  ai.feedEl.replaceChildren();
  ai.agent = { id: null, es: null, cmds: new Map(), text: null, auto: !!auto, status: 'starting', needsApproval: false };
  updateAgentControls(s);
  api('/api/agent/start', {
    method: 'POST',
    body: { hostId: s.hostId, goal, confirmDangerous: !auto },
  })
    .then((r) => {
      if (!ai.agent) return; // cancelado antes de iniciar
      ai.agent.id = r.runId;
      ai.agent.status = 'running';
      ai.agent.es = new EventSource(`/api/agent/${r.runId}/stream`);
      ai.agent.es.onmessage = (m) => handleAgentEvent(s, JSON.parse(m.data));
      ai.agent.es.onerror = () => {};
      if (activeSession() === s) updateAgentControls(s);
      renderTermTabs();
    })
    .catch((e) => {
      toast(e.message, 'erro');
      ai.agent = null;
      if (activeSession() === s) updateAgentControls(s);
      renderTermTabs();
    });
}

function agentStop() {
  const s = activeSession();
  if (s && s.ai && s.ai.agent && s.ai.agent.id) {
    api(`/api/agent/${s.ai.agent.id}/stop`, { method: 'POST' }).catch(() => {});
  }
}

// encerra o agente de uma sessão específica (pode não ser a ativa)
function agentFinish(session) {
  const ai = session && session.ai;
  if (!ai || !ai.agent) return;
  ai.agent.status = 'done';
  ai.agent.needsApproval = false;
  if (ai.agent.es) { try { ai.agent.es.close(); } catch {} }
  if (activeSession() === session) updateAgentControls(session);
  renderTermTabs();
}

function handleAgentEvent(session, evt) {
  const ai = session && session.ai;
  if (!ai || !ai.agent) return;
  const box = ai.feedEl;
  const agent = ai.agent;
  switch (evt.type) {
    case 'agent-start': {
      box.replaceChildren();
      el(box, 'div', 'agent-goal').textContent = `Objetivo: ${evt.goal}`;
      el(box, 'div', 'muted small', `${evt.host.name} — ${evt.host.address}`);
      el(box, 'div', 'agent-mode ' + (agent.auto ? 'auto' : 'sup'),
        agent.auto ? '⚡ Modo automático — executando sem pedir confirmação' : '🛡 Modo supervisionado — comandos perigosos pedem aprovação');
      break;
    }
    case 'thinking-start': {
      clearThinking(ai);
      agent.text = null;
      el(box, 'div', 'agent-thinking', 'IA analisando…');
      agentScroll(ai);
      break;
    }
    case 'text': {
      clearThinking(ai);
      if (!agent.text) agent.text = el(box, 'div', 'agent-text');
      agent.text.textContent += evt.text;
      agentScroll(ai);
      break;
    }
    case 'command': {
      clearThinking(ai);
      agent.text = null;
      el(box, 'div', 'agent-cmd', '$ ' + evt.command);
      const pre = el(box, 'pre', 'agent-out');
      agent.cmds.set(evt.id, pre);
      agentScroll(ai);
      break;
    }
    case 'command-output': {
      const pre = agent.cmds.get(evt.id);
      if (pre) {
        const span = el(pre, 'span', evt.kind === 'err' ? 'err' : null);
        span.textContent = stripAnsi(evt.text);
        agentScroll(ai);
      }
      break;
    }
    case 'command-end': {
      let cls, txt;
      if (evt.error) { cls = 'fail'; txt = '✗ erro: ' + evt.error; }
      else if (evt.timedOut) { cls = 'fail'; txt = '✗ tempo esgotado'; }
      else if (evt.code === 0) { cls = 'ok'; txt = `✓ concluído (código 0${evt.durationMs ? ', ' + fmtMs(evt.durationMs) : ''})`; }
      else { cls = 'fail'; txt = `✗ código de saída ${evt.code === null ? '?' : evt.code}`; }
      el(box, 'div', 'agent-meta ' + cls, txt);
      agentScroll(ai);
      break;
    }
    case 'need-approval': {
      clearThinking(ai);
      agent.text = null;
      agent.needsApproval = true;
      renderTermTabs();
      const wrap = el(box, 'div', 'agent-approval');
      wrap.dataset.id = evt.id;
      el(wrap, 'div', 'warn', `⚠ Comando perigoso — ${evt.reason}. Aprovar execução?`);
      el(wrap, 'pre').textContent = evt.command;
      const row = el(wrap, 'div', 'btn-row');
      const deny = el(row, 'button', 'btn small', 'Negar');
      const ok = el(row, 'button', 'btn small danger', 'Aprovar e executar');
      const resolve = (approve) => {
        api(`/api/agent/${agent.id}/approve`, { method: 'POST', body: { approve } }).catch(() => {});
        deny.disabled = ok.disabled = true;
        agent.needsApproval = false;
        renderTermTabs();
        el(wrap, 'div', 'muted small', approve ? '→ aprovado' : '→ negado');
      };
      deny.addEventListener('click', () => resolve(false));
      ok.addEventListener('click', () => resolve(true));
      agentScroll(ai);
      break;
    }
    case 'command-denied':
    case 'approved':
      break;
    case 'notice': {
      clearThinking(ai);
      agent.text = null;
      el(box, 'div', 'agent-notice', '· ' + evt.message);
      agentScroll(ai);
      break;
    }
    case 'final': {
      clearThinking(ai);
      agent.text = null;
      el(box, 'div', 'agent-final', evt.text);
      agentScroll(ai);
      break;
    }
    case 'error': {
      clearThinking(ai);
      agent.text = null;
      el(box, 'div', 'agent-error', '✗ ' + evt.error);
      agentScroll(ai);
      break;
    }
    case 'agent-end': {
      const label = { ok: 'Tarefa concluída', erro: 'Encerrado com erro', cancelado: 'Parado pelo analista' }[evt.status] || evt.status;
      el(box, 'div', 'agent-meta ' + (evt.status === 'ok' ? 'ok' : 'fail'), `— ${label} (${fmtMs(evt.durationMs)})`);
      agentScroll(ai);
      agentFinish(session);
      break;
    }
  }
}

// ---------- aba Configurações (IA) ----------
async function loadConfigTab() {
  let s;
  try { s = await api('/api/settings'); } catch (e) { toast(e.message, 'erro'); return; }
  const sel = $('#cfgModel');
  sel.innerHTML = '';
  (s.models || []).forEach((m) => { const o = el(sel, 'option', null, m); o.value = m; });
  sel.value = s.model;
  $('#cfgApiKey').value = '';
  $('#cfgApiKey').placeholder = s.hasApiKey ? '•••••••• (em branco = manter atual)' : 'sk-ant-…';
  $('#cfgApiKey').disabled = s.fromEnv;
  $('#cfgKeyState').textContent = s.fromEnv
    ? 'Chave definida pela variável de ambiente ANTHROPIC_API_KEY (não editável aqui).'
    : s.hasApiKey
      ? 'Uma chave está salva nesta máquina. Os recursos de IA estão ativos.'
      : 'Nenhuma chave configurada — os recursos de IA ficam ocultos até você informar uma.';
  $('#cfgClearKey').hidden = !(s.hasApiKey && !s.fromEnv);
  applyAiVisibility(s.hasApiKey);

  // aparência do terminal
  termFont = s.termFont || DEFAULT_TERM_FONT;
  termFontSize = s.termFontSize || DEFAULT_TERM_FONT_SIZE;
  const fontSel = $('#cfgTermFont');
  if (![...fontSel.options].some((o) => o.value === termFont)) fontSel.selectedIndex = 0;
  else fontSel.value = termFont;
  $('#cfgTermSize').value = termFontSize;
  updateFontPreview();
}

// prévia ao vivo — lê os controles atuais, sem aplicar no terminal nem salvar
function updateFontPreview() {
  const pv = $('#cfgFontPreview');
  if (!pv) return;
  const font = $('#cfgTermFont').value || DEFAULT_TERM_FONT;
  const n = Number($('#cfgTermSize').value);
  const size = Number.isFinite(n) ? Math.min(28, Math.max(8, Math.round(n))) : DEFAULT_TERM_FONT_SIZE;
  pv.style.fontFamily = font;
  pv.style.fontSize = size + 'px';
}

// aplica ao terminal e salva — chamado pelo botão "Salvar"
async function saveTermAppearance() {
  termFont = $('#cfgTermFont').value || DEFAULT_TERM_FONT;
  const n = Number($('#cfgTermSize').value);
  termFontSize = Number.isFinite(n) ? Math.min(28, Math.max(8, Math.round(n))) : DEFAULT_TERM_FONT_SIZE;
  $('#cfgTermSize').value = termFontSize; // reflete o valor já normalizado (8–28)
  updateFontPreview();
  applyTermAppearance();
  const btn = $('#cfgSaveTerm');
  if (btn) btn.disabled = true;
  try {
    await api('/api/settings', { method: 'PUT', body: { termFont, termFontSize } });
    toast('Aparência do terminal salva.');
  } catch (e) {
    toast(e.message, 'erro');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function saveConfigAi() {
  const body = { model: $('#cfgModel').value };
  if ($('#cfgApiKey').value) body.apiKey = $('#cfgApiKey').value;
  try {
    const r = await api('/api/settings', { method: 'PUT', body });
    applyAiVisibility(r.hasApiKey);
    toast('Configurações salvas.');
    loadConfigTab();
  } catch (e) { toast(e.message, 'erro'); }
}

async function clearConfigAi() {
  if (!confirm('Remover a chave da API salva? Os recursos de IA ficarão ocultos.')) return;
  try {
    const r = await api('/api/settings', { method: 'PUT', body: { clearApiKey: true } });
    applyAiVisibility(r.hasApiKey);
    toast('Chave removida — recursos de IA ocultados.');
    loadConfigTab();
  } catch (e) { toast(e.message, 'erro'); }
}

// ---------- init ----------
// ---------- tema claro/escuro ----------
const THEME_ICONS = {
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>',
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M4.8 4.8l1.6 1.6M17.6 17.6l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.8 19.2l1.6-1.6M17.6 6.4l1.6-1.6"/></svg>',
};
function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}
function setTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('vc-theme', t); } catch {}
  // o botão do header mostra o ícone do tema para o qual vai alternar
  const tb = $('#themeToggle');
  if (tb) {
    tb.innerHTML = t === 'dark' ? THEME_ICONS.sun : THEME_ICONS.moon;
    tb.title = t === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro';
  }
  $$('#themeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.themeChoice === t));
  // o terminal permanece escuro; só reajusta o tamanho caso a aba esteja ativa
  if ($('#tab-terminal') && $('#tab-terminal').classList.contains('active')) fitActive();
}
function initTheme() {
  setTheme(currentTheme()); // sincroniza a UI com o que o script inline já aplicou
  $('#themeToggle').addEventListener('click', () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
  $$('#themeSeg button').forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.themeChoice)));
}

// ---------- aviso de atualização (verificar no GitHub, sem instalar sozinho) ----------
async function checkForUpdate() {
  let d;
  try { d = await api('/api/update-check'); } catch { return; }
  if (!d || !d.updateAvailable || !d.latest) return;
  // no app Windows/Linux a atualização é automática (electron-updater); a faixa
  // de aviso fica só para o Mac e para o modo web.
  if (d.desktop && (d.platform === 'win32' || d.platform === 'linux')) return;
  let dismissed = '';
  try { dismissed = localStorage.getItem('vc-update-dismissed') || ''; } catch {}
  if (dismissed === d.latest) return; // usuário já dispensou esta versão
  showUpdateBanner(d);
}

function showUpdateBanner(d) {
  const bar = $('#updateBanner');
  if (!bar) return;
  bar.replaceChildren();
  const txt = el(bar, 'span', 'update-text');
  txt.append('✨ Nova versão ');
  el(txt, 'strong', null, d.latest);
  txt.append(` disponível — você tem a ${d.current}.`);
  const link = el(bar, 'a', 'btn small primary', 'Ver / baixar');
  link.href = d.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  const x = el(bar, 'button', 'update-close', '×');
  x.type = 'button';
  x.title = 'Dispensar';
  x.addEventListener('click', () => {
    bar.hidden = true;
    try { localStorage.setItem('vc-update-dismissed', d.latest); } catch {}
  });
  bar.hidden = false;
}

function init() {
  initTabs();
  initTheme();
  $('#btnNewHost').addEventListener('click', () => openHostModal(null));
  $('#btnNewPlaybook').addEventListener('click', () => openPlaybookModal(null));
  $('#btnPlaybookAi').addEventListener('click', openPlaybookAiModal);
  $('#btnNewProfile').addEventListener('click', () => openProfileModal(null));
  $('#btnSaveGlobals').addEventListener('click', saveGlobals);
  $('#btnExportXml').addEventListener('click', exportXml);
  $('#btnImportXml').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', onImportFile);
  $('#playbookSelect').addEventListener('change', syncAdhoc);
  $('#selectAllHosts').addEventListener('change', (e) => {
    // com busca ativa, "todos" marca/desmarca só os hosts visíveis
    $$('#hostChecklist .check-host:not(.filtered-out) input[type=checkbox]').forEach((cb) => { cb.checked = e.target.checked; });
  });
  $('#execHostSearch').addEventListener('input', filterExecHosts);
  $('#btnPreview').addEventListener('click', doPreview);
  $('#btnRun').addEventListener('click', doRun);
  $('#btnCancel').addEventListener('click', doCancel);
  $('#hostSearch').addEventListener('input', renderHostSidebar);
  $('#sidebarNewHost').addEventListener('click', () => openHostModal(null));
  $('#toggleSidebar').addEventListener('click', () => {
    sidebarCollapsed = !sidebarCollapsed;
    try { localStorage.setItem('vc-sidebar-collapsed', sidebarCollapsed ? '1' : '0'); } catch {}
    updateTermLayout();
  });
  $('#toggleAiPane').addEventListener('click', () => {
    aiCollapsed = !aiCollapsed;
    try { localStorage.setItem('vc-ai-collapsed', aiCollapsed ? '1' : '0'); } catch {}
    updateTermLayout();
  });
  window.addEventListener('resize', () => { if ($('#tab-terminal').classList.contains('active')) fitActive(); });
  $('#cfgSaveAi').addEventListener('click', saveConfigAi);
  $('#cfgClearKey').addEventListener('click', clearConfigAi);
  $('#cfgTermFont').addEventListener('change', updateFontPreview);
  $('#cfgTermSize').addEventListener('input', updateFontPreview);
  $('#cfgSaveTerm').addEventListener('click', saveTermAppearance);
  $('#aiClear').addEventListener('click', () => { if (currentMode() === 'agent') agentResetFeed(); else aiReset(); });
  initAiModes();
  $('#agentStart').addEventListener('click', () => agentStart(false));
  $('#agentAuto').addEventListener('click', () => agentStart(true));
  $('#agentStop').addEventListener('click', agentStop);
  $('#aiForm').addEventListener('submit', (e) => { e.preventDefault(); aiSend($('#aiInput').value); });
  $('#aiInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiSend($('#aiInput').value); }
  });
  // rascunho do assistente e objetivo do agente ficam guardados por aba
  $('#aiInput').addEventListener('input', () => { const s = activeSession(); if (s && s.ai) s.ai.draft = $('#aiInput').value; });
  $('#agentGoal').addEventListener('input', () => { const s = activeSession(); if (s && s.ai) s.ai.goal = $('#agentGoal').value; });
  $('#modalCancel').addEventListener('click', closeModal);
  $('#modalRoot').addEventListener('mousedown', (e) => {
    if (e.target === $('#modalRoot')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
  loadState().catch((e) => toast(e.message, 'erro'));
  refreshAiVisibility(); // esconde recursos de IA se não houver chave configurada
  checkForUpdate(); // avisa (sem instalar) se houver versão nova no GitHub
  loadLocalInfo(); // login/SO da máquina para o botão "Meu computador"
  // se o Terminal for a aba inicial, prepara o xterm já na carga
  if ($('#tab-terminal').classList.contains('active')) onTerminalTabShown();
}

init();
