'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let state = { hosts: [], playbooks: [], profiles: [], favorites: [], globals: {} };
let currentRun = null;

// ---------- preferências da interface ----------
// Ficam no data.json (via /api/prefs) porque o app desktop sobe o servidor numa
// porta diferente a cada abertura — e como o localStorage é por origem, tudo que
// dependesse só dele se perdia ao reiniciar. O servidor injeta os valores no
// HTML (window.VC_PREFS), então já chegam prontos, sem esperar requisição.
// O localStorage segue como espelho (modo web e reaproveitamento imediato).
const prefs = Object.assign({
  theme: '', recentHosts: null, greetHidden: null,
  aiCollapsed: null, sidebarCollapsed: null, updateDismissed: '',
}, (typeof window !== 'undefined' && window.VC_PREFS) || {});

const PREF_LS = {
  theme: 'vc-theme', greetHidden: 'vc-greet-hidden', aiCollapsed: 'vc-ai-collapsed',
  sidebarCollapsed: 'vc-sidebar-collapsed', updateDismissed: 'vc-update-dismissed',
  recentHosts: 'vc-recent-hosts',
};

function lsGet(key) {
  try { return localStorage.getItem(PREF_LS[key]); } catch { return null; }
}
function lsSet(key, valor) {
  try { localStorage.setItem(PREF_LS[key], valor); } catch {}
}

// valor efetivo: servidor tem prioridade; localStorage cobre o modo web
function prefBool(key) {
  if (typeof prefs[key] === 'boolean') return prefs[key];
  return lsGet(key) === '1';
}
function prefStr(key, dflt) {
  if (prefs[key]) return prefs[key];
  return lsGet(key) || dflt;
}
function prefList(key) {
  if (Array.isArray(prefs[key])) return prefs[key];
  try { const v = JSON.parse(lsGet(key) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

let prefsTimer = null;
let prefsFila = {};
// grava no servidor com um pequeno atraso (agrupa mudanças seguidas)
function prefSet(key, valor) {
  prefs[key] = valor;
  if (Array.isArray(valor)) lsSet(key, JSON.stringify(valor));
  else if (typeof valor === 'boolean') lsSet(key, valor ? '1' : '0');
  else lsSet(key, String(valor));
  prefsFila[key] = valor;
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    const corpo = prefsFila;
    prefsFila = {};
    api('/api/prefs', { method: 'PUT', body: corpo }).catch(() => {});
  }, 250);
}

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
    if (btn.dataset.tab === 'history') loadHistory();
    if (btn.dataset.tab === 'files') onFilesTabShown();
  }));
  document.body.classList.toggle('term-full', !!$('#tab-terminal.active') || $('#tab-terminal').classList.contains('active'));
}

// ---------- estado ----------
async function loadState() {
  state = await api('/api/state');
  renderHosts();
  renderPlaybooks();
  renderFavoritesTab();
  renderFileHostSelect();
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
  el(info, 'div', 'haddr', hostAddrLabel(h));
  const meta = el(info, 'div', 'meta');
  if (h.protocol === 'telnet') el(meta, 'span', 'tag tag-warn', 'TELNET — sem criptografia');
  else el(meta, 'span', 'tag', authLabel(h.auth));
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
      <label>Protocolo
        <select id="f_protocol">
          <option value="ssh">SSH / SFTP (recomendado)</option>
          <option value="ftp">FTP / FTPS (transferência de arquivos)</option>
          <option value="vnc">VNC (área de trabalho remota)</option>
          <option value="rdp">RDP (área de trabalho do Windows)</option>
          <option value="telnet">Telnet (equipamentos legados)</option>
        </select>
      </label>
      <label id="f_rdpDomainWrap" hidden>Domínio (opcional)
        <input id="f_rdpDomain" placeholder="ex.: EMPRESA">
      </label>
      <label id="f_rdpLegadoWrap" class="inline" hidden>
        <input type="checkbox" id="f_rdpLegado">
        <span>Permitir RDP legado (servidor sem TLS)</span>
      </label>
      <p id="f_rdpLegadoNota" class="hint" hidden>
        Alguns servidores Linux com xrdp recusam TLS. Marcando isto, o app conecta
        assim mesmo — mas <strong>a identidade do servidor não é verificada</strong> e a
        criptografia é a antiga do RDP (RC4). Use só em rede em que você confia.
      </p>
      <label id="f_ftpsWrap" hidden>Criptografia (FTPS)
        <select id="f_ftps">
          <option value="auto">Automática — usa TLS se o servidor aceitar</option>
          <option value="yes">Obrigatória — recusa conectar sem TLS</option>
          <option value="confia">Obrigatória, confiando no certificado (autoassinado)</option>
          <option value="no">Nenhuma — texto claro</option>
        </select>
      </label>
      <label>Usuário <input id="f_user" placeholder="root"></label>
      <label>Host / IP <input id="f_host" required placeholder="10.0.0.5 ou srv.exemplo.com"></label>
      <label>Porta <input id="f_port" type="number" min="1" max="65535" value="22"></label>
    </div>
    <p id="f_telnetNote" class="hint warn-hint" hidden>⚠️ Telnet não é criptografado — usuário e senha trafegam em texto claro na rede. Use só em rede de gerência confiável. Preencha usuário e senha para o app fazer login sozinho; deixe a senha em branco para digitar no terminal. Execução em lote e agente de IA exigem SSH.</p>
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
    <fieldset id="authFieldset">
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
        <label><span id="f_passwordLabel">Senha</span> <input id="f_password" type="password" autocomplete="new-password"></label>
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
  $('#f_protocol').value = (existing && existing.protocol) || 'ssh';
  $('#f_ftps').value = (existing && existing.ftps) || 'auto';
  $('#f_rdpDomain').value = (existing && existing.rdpDomain) || '';
  $('#f_rdpLegado').checked = !!(existing && existing.rdpLegado);
  // Telnet: porta padrão 23, autenticação some (login é no equipamento)
  const syncProtocol = () => {
    const proto = $('#f_protocol').value;
    const isTelnet = proto === 'telnet';
    const isFtp = proto === 'ftp';
    const isVnc = proto === 'vnc';
    const isRdp = proto === 'rdp';
    $('#f_telnetNote').hidden = !isTelnet;
    $('#f_ftpsWrap').hidden = !isFtp;
    $('#f_rdpDomainWrap').hidden = !isRdp;
    $('#f_rdpLegadoWrap').hidden = !isRdp;
    $('#f_rdpLegadoNota').hidden = !isRdp;
    // Telnet e FTP autenticam por usuário e senha; chave/agente SSH não se aplicam.
    // No Telnet a senha é opcional: se preenchida, o app responde sozinho aos
    // prompts do equipamento; se vazia, você digita no terminal como antes.
    const soSenha = isFtp || isTelnet || isVnc || isRdp;
    $$('input[name="authType"]').forEach((r) => {
      const linha = r.closest('label');
      if (linha) linha.hidden = soSenha && r.value !== 'password';
    });
    const lblSenha = $('#f_passwordLabel');
    if (lblSenha) lblSenha.textContent = isTelnet ? 'Senha (opcional — login automático)'
      : isVnc ? 'Senha do VNC' : 'Senha';
    if (soSenha) {
      const senha = $$('input[name="authType"]').find((r) => r.value === 'password');
      if (senha && !senha.checked) { senha.checked = true; syncAuthFields(); }
    }
    const port = $('#f_port');
    const padroes = { telnet: 23, ftp: 21, vnc: 5900, rdp: 3389, ssh: 22 };
    if (!existing && ['21', '22', '23', '3389', '5900', ''].includes(String(port.value))) port.value = padroes[proto];
  };
  $('#f_protocol').addEventListener('change', syncProtocol);
  syncProtocol();
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
      protocol: $('#f_protocol').value,
      ftps: $('#f_ftps').value,
      rdpDomain: $('#f_rdpDomain').value,
      rdpLegado: $('#f_rdpLegado').checked,
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
  openModal(isEdit ? 'Editar playbook' : existing ? 'Revisar playbook' : 'Novo playbook', `
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

// ---------- histórico de comandos ----------
const histState = { source: '', hostId: '', q: '', selected: new Set() };
let histEntries = [];
let histSearchTimer = null;

function fmtHistDate(ts) {
  try {
    return new Date(ts).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return ''; }
}

const ORIGIN_LABEL = { terminal: 'terminal', assistant: 'assistente', agent: 'agente', batch: 'lote', favorite: 'favorito' };

// preenche o seletor de máquinas com base nos hosts + local
function fillHistHostFilter() {
  const sel = $('#histHostFilter');
  if (!sel) return;
  const cur = histState.hostId;
  sel.innerHTML = '<option value="">Todas as máquinas</option><option value="local">Meu computador</option>';
  for (const h of state.hosts) {
    const o = document.createElement('option');
    o.value = h.id;
    o.textContent = `${h.name} (${h.host})`;
    sel.appendChild(o);
  }
  sel.value = cur;
}

async function loadHistory() {
  const params = new URLSearchParams();
  if (histState.source) params.set('source', histState.source);
  if (histState.hostId) params.set('hostId', histState.hostId);
  if (histState.q) params.set('q', histState.q);
  try {
    const r = await api('/api/history?' + params.toString());
    histEntries = r.entries || [];
  } catch (e) {
    histEntries = [];
  }
  // remove da seleção o que não está mais visível
  const ids = new Set(histEntries.map((e) => e.id));
  for (const id of [...histState.selected]) if (!ids.has(id)) histState.selected.delete(id);
  renderHistory();
}

function renderHistory() {
  const wrap = $('#historyList');
  if (!wrap) return;
  fillHistHostFilter();
  wrap.innerHTML = '';
  if (!histEntries.length) {
    el(wrap, 'p', 'empty', 'Nenhum comando no histórico ainda. Use o terminal ou a IA e eles aparecem aqui.');
    updateHistSelUI();
    return;
  }
  for (const e of histEntries) {
    const row = el(wrap, 'div', 'hist-row' + (histState.selected.has(e.id) ? ' selected' : ''));
    const cb = el(row, 'input', 'hist-cb');
    cb.type = 'checkbox';
    cb.checked = histState.selected.has(e.id);
    cb.addEventListener('change', () => {
      if (cb.checked) histState.selected.add(e.id); else histState.selected.delete(e.id);
      row.classList.toggle('selected', cb.checked);
      updateHistSelUI();
    });
    const main = el(row, 'div', 'hist-main');
    const top = el(main, 'div', 'hist-top');
    const badge = el(top, 'span', 'badge ' + (e.source === 'ai' ? 'badge-ai' : 'badge-human'));
    badge.textContent = e.source === 'ai' ? '✨ IA' : '👤 Humano';
    const cmd = el(top, 'code', 'hist-cmd');
    cmd.textContent = e.command;
    const meta = el(main, 'div', 'hist-meta');
    const machine = e.local ? 'Meu computador' : (e.machine || 'host');
    const ipUser = [e.username ? e.username + '@' : '', e.ip || ''].join('');
    meta.textContent = `${fmtHistDate(e.ts)} · ${machine}${ipUser ? ' · ' + ipUser : ''} · ${ORIGIN_LABEL[e.origin] || e.origin}`;
    const fav = el(row, 'button', 'hist-fav', '☆');
    fav.title = 'Adicionar aos favoritos';
    fav.addEventListener('click', () => {
      // escopo por host só quando o host da entrada ainda existe no cadastro
      const hostId = e.hostId && favHostName(e.hostId) ? e.hostId : null;
      openFavoriteModal({ command: e.command, hostId, preferHost: !!hostId });
    });
    const del = el(row, 'button', 'hist-del', '×');
    del.title = 'Remover esta entrada';
    del.addEventListener('click', async () => {
      try { await api('/api/history/' + e.id, { method: 'DELETE' }); histState.selected.delete(e.id); await loadHistory(); }
      catch (err) { toast(err.message, 'erro'); }
    });
  }
  updateHistSelUI();
}

function updateHistSelUI() {
  const n = histState.selected.size;
  const cnt = $('#histSelCount'); if (cnt) cnt.textContent = String(n);
  const btn = $('#btnHistPlaybook'); if (btn) btn.disabled = n === 0;
  const all = $('#histSelectAll');
  if (all) all.checked = histEntries.length > 0 && histEntries.every((e) => histState.selected.has(e.id));
}

// Cria um playbook a partir dos comandos selecionados (mais antigos primeiro,
// pois a lista é exibida do mais recente para o mais antigo).
function historyToPlaybook() {
  const chosen = histEntries.filter((e) => histState.selected.has(e.id));
  if (!chosen.length) { toast('Marque ao menos um comando.', 'erro'); return; }
  const commands = chosen.slice().reverse().map((e) => e.command);
  // remove duplicados consecutivos para um playbook mais limpo
  const dedup = commands.filter((c, i) => i === 0 || c !== commands[i - 1]);
  openPlaybookModal({ name: '', description: '', commands: dedup });
}

function initHistoryControls() {
  $$('#histSourceSeg button').forEach((b) => b.addEventListener('click', () => {
    $$('#histSourceSeg button').forEach((x) => x.classList.toggle('active', x === b));
    histState.source = b.dataset.src || '';
    loadHistory();
  }));
  $('#histHostFilter').addEventListener('change', (e) => { histState.hostId = e.target.value; loadHistory(); });
  $('#histSearch').addEventListener('input', (e) => {
    histState.q = e.target.value.trim();
    clearTimeout(histSearchTimer);
    histSearchTimer = setTimeout(loadHistory, 250);
  });
  $('#histSelectAll').addEventListener('change', (e) => {
    if (e.target.checked) histEntries.forEach((x) => histState.selected.add(x.id));
    else histState.selected.clear();
    renderHistory();
  });
  $('#btnHistPlaybook').addEventListener('click', historyToPlaybook);
  $('#btnHistClear').addEventListener('click', async () => {
    if (!histEntries.length) { toast('O histórico já está vazio.'); return; }
    if (!confirm('Apagar TODO o histórico de comandos? Esta ação não pode ser desfeita.')) return;
    try {
      await api('/api/history', { method: 'DELETE' });
      histState.selected.clear();
      toast('Histórico apagado.');
      await loadHistory();
    } catch (e) { toast(e.message, 'erro'); }
  });
}

// ---------- gerenciador de arquivos (dois painéis: local ↔ remoto) ----------
// O conteúdo dos arquivos NUNCA passa pelo navegador: arrastar de um painel
// para o outro chama /api/files/transfer e o servidor copia direto entre as
// pontas. Assim um arquivo de 2 GB não vira memória nesta aba.
const fileState = {
  sessionId: null,
  protocol: null,
  secure: false,
  paths: { local: '', remote: '' },
  lists: { local: null, remote: null },
  sel: { local: null, remote: null },
};

function fmtTamanho(n) {
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)) + ' ' + u[i];
}
function fmtData(ms) {
  if (!ms) return '—';
  try { return new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return '—'; }
}
function iconeArquivo(item) {
  if (item.type === 'dir') return '📁';
  if (item.type === 'link') return '🔗';
  const ext = (item.name.split('.').pop() || '').toLowerCase();
  if (['txt', 'log', 'conf', 'cfg', 'ini', 'yml', 'yaml', 'json', 'xml', 'md', 'sh', 'py', 'js'].includes(ext)) return '📄';
  if (['tar', 'gz', 'zip', 'bz2', 'xz', 'rar', '7z'].includes(ext)) return '🗜️';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'].includes(ext)) return '🖼️';
  return '📃';
}
const EDITAVEIS = ['txt', 'log', 'conf', 'cfg', 'ini', 'yml', 'yaml', 'json', 'xml', 'md', 'sh', 'py', 'js', 'env', 'service', 'rules', 'list'];
function ehTexto(nome) {
  if (!nome.includes('.')) return true; // arquivos sem extensão costumam ser config
  return EDITAVEIS.includes(nome.split('.').pop().toLowerCase());
}

function filesApi(rota, body) {
  return api('/api/files/' + rota, { method: 'POST', body });
}

// corpo padrão com o lado e a sessão
function ladoBody(lado, extra) {
  return Object.assign({ side: lado, sessionId: fileState.sessionId, path: fileState.paths[lado] }, extra || {});
}

async function fileList(lado, caminho) {
  if (lado === 'remote' && !fileState.sessionId) return;
  const st = $('#fileStatus');
  try {
    const r = await filesApi('list', { side: lado, sessionId: fileState.sessionId, path: caminho != null ? caminho : fileState.paths[lado] });
    fileState.paths[lado] = r.path;
    fileState.lists[lado] = r;
    fileState.sel[lado] = null;
    const inp = document.querySelector(`.file-path[data-side="${lado}"]`);
    if (inp) inp.value = r.path;
    renderFileList(lado);
    if (r.truncated && st) st.textContent = 'Pasta muito grande — mostrando os primeiros itens.';
  } catch (e) {
    toast(e.message, 'erro');
  }
}

function renderFileList(lado) {
  const box = document.querySelector(`.file-list[data-side="${lado}"]`);
  if (!box) return;
  box.innerHTML = '';
  const r = fileState.lists[lado];
  if (!r) {
    el(box, 'p', 'empty', lado === 'remote' ? 'Conecte-se a um servidor acima.' : 'Carregando…');
    return;
  }
  const itens = r.items.slice().sort((a, b) => {
    if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'pt-BR');
  });
  if (r.parent) {
    const up = el(box, 'div', 'file-row file-up');
    el(up, 'span', 'file-ico', '↩');
    el(up, 'span', 'file-name', '..');
    up.addEventListener('dblclick', () => fileList(lado, r.parent));
    up.addEventListener('click', () => fileList(lado, r.parent));
  }
  for (const it of itens) {
    const row = el(box, 'div', 'file-row' + (it.type === 'dir' ? ' is-dir' : ''));
    row.draggable = true;
    row.dataset.name = it.name;
    row.dataset.type = it.type;
    el(row, 'span', 'file-ico', iconeArquivo(it));
    el(row, 'span', 'file-name', it.name);
    el(row, 'span', 'file-size', it.type === 'dir' ? '' : fmtTamanho(it.size));
    el(row, 'span', 'file-date', fmtData(it.mtime));
    if (it.mode) el(row, 'span', 'file-mode mono', it.mode.toString(8).padStart(3, '0'));

    row.addEventListener('click', () => {
      box.querySelectorAll('.file-row.sel').forEach((x) => x.classList.remove('sel'));
      row.classList.add('sel');
      fileState.sel[lado] = it;
    });
    row.addEventListener('dblclick', () => {
      if (it.type === 'dir') fileList(lado, joinCaminho(lado, it.name));
      else if (ehTexto(it.name)) abrirEditorArquivo(lado, it);
      else toast('Só arquivos de texto podem ser abertos aqui. Arraste para o outro painel para transferir.', 'erro');
    });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); abrirMenuArquivo(e, lado, it); });

    // arrastar para o outro painel = transferir
    row.addEventListener('dragstart', (e) => {
      if (it.type === 'dir') { e.preventDefault(); return; } // pastas ainda não
      e.dataTransfer.setData('text/plain', JSON.stringify({ lado, name: it.name }));
      e.dataTransfer.effectAllowed = 'copy';
    });
  }
  if (!itens.length && !r.parent) el(box, 'p', 'empty', 'Pasta vazia.');
}

function joinCaminho(lado, nome) {
  const base = fileState.paths[lado] || '/';
  if (lado === 'local') {
    const sep = base.endsWith('/') ? '' : '/';
    return base + sep + nome;
  }
  return (base === '/' ? '' : base.replace(/\/+$/, '')) + '/' + nome;
}

async function transferirArquivo(deLado, nome) {
  const paraLado = deLado === 'local' ? 'remote' : 'local';
  if (!fileState.sessionId) { toast('Conecte-se a um servidor primeiro.', 'erro'); return; }
  const st = $('#fileStatus');
  if (st) st.textContent = `Transferindo ${nome}…`;
  try {
    await filesApi('transfer', {
      sessionId: fileState.sessionId,
      fromSide: deLado, fromPath: fileState.paths[deLado],
      toSide: paraLado, toPath: fileState.paths[paraLado],
      name: nome,
    });
    if (st) st.textContent = `${nome} transferido.`;
    toast(`${nome} → ${paraLado === 'local' ? 'seu computador' : 'servidor'}`);
    await fileList(paraLado);
  } catch (e) {
    if (st) st.textContent = '';
    toast(e.message, 'erro');
  }
}

// menu de contexto (renomear, permissões, excluir, transferir)
function abrirMenuArquivo(ev, lado, item) {
  const menu = $('#fileMenu');
  menu.innerHTML = '';
  const add = (rotulo, fn, perigo) => {
    const b = el(menu, 'button', 'ctx-item' + (perigo ? ' danger' : ''), rotulo);
    b.addEventListener('click', () => { menu.hidden = true; fn(); });
  };
  if (item.type !== 'dir') {
    add(lado === 'local' ? '⬆ Enviar ao servidor' : '⬇ Baixar para o computador', () => transferirArquivo(lado, item.name));
    if (ehTexto(item.name)) add('✎ Abrir/editar', () => abrirEditorArquivo(lado, item));
  }
  add('Renomear', async () => {
    const novo = prompt('Novo nome:', item.name);
    if (!novo || novo === item.name) return;
    try { await filesApi('rename', ladoBody(lado, { name: item.name, newName: novo })); await fileList(lado); }
    catch (e) { toast(e.message, 'erro'); }
  });
  if (fileState.protocol !== 'ftp' || lado === 'local') {
    add('Permissões (chmod)', async () => {
      const m = prompt('Permissões em octal (ex.: 644, 755):', item.mode ? item.mode.toString(8).padStart(3, '0') : '644');
      if (!m) return;
      if (!/^[0-7]{3,4}$/.test(m)) { toast('Use 3 ou 4 dígitos octais, ex.: 644.', 'erro'); return; }
      try { await filesApi('chmod', ladoBody(lado, { name: item.name, mode: m })); await fileList(lado); }
      catch (e) { toast(e.message, 'erro'); }
    });
  }
  add('Excluir', async () => {
    if (!confirm(`Excluir "${item.name}"${item.type === 'dir' ? ' e todo o conteúdo' : ''}?\n\nEsta ação não pode ser desfeita.`)) return;
    try { await filesApi('delete', ladoBody(lado, { name: item.name })); await fileList(lado); }
    catch (e) { toast(e.message, 'erro'); }
  }, true);

  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(ev.clientX, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(ev.clientY, window.innerHeight - r.height - 8) + 'px';
}

async function abrirEditorArquivo(lado, item) {
  const caminho = joinCaminho(lado, item.name);
  let conteudo;
  try {
    const r = await filesApi('read', { side: lado, sessionId: fileState.sessionId, file: caminho });
    conteudo = r.content;
  } catch (e) { toast(e.message, 'erro'); return; }
  openModal('Editar — ' + item.name, `
    <p class="hint mono small">${lado === 'local' ? 'no seu computador' : 'no servidor'}</p>
    <textarea id="fed_txt" rows="18" class="mono"></textarea>
  `);
  $('#fed_txt').value = conteudo;
  $('#modalForm button[type=submit]').textContent = 'Salvar';
  $('#modalForm').onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      await filesApi('write', { side: lado, sessionId: fileState.sessionId, file: caminho, content: $('#fed_txt').value });
      closeModal();
      toast('Arquivo salvo.');
      await fileList(lado);
    } catch (e) { toast(e.message, 'erro'); }
  };
}

function fileHostsDisponiveis() {
  return state.hosts.filter((h) => h.protocol !== 'telnet');
}

function renderFileHostSelect() {
  const sel = $('#fileHostSelect');
  if (!sel) return;
  const atual = sel.value;
  sel.innerHTML = '';
  const hosts = fileHostsDisponiveis();
  if (!hosts.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'Nenhum host compatível — cadastre em Hosts';
    sel.appendChild(o);
    return;
  }
  for (const h of hosts) {
    const o = document.createElement('option');
    o.value = h.id;
    o.textContent = `${h.name} — ${h.protocol === 'ftp' ? 'FTP' : 'SFTP'} (${h.host})`;
    sel.appendChild(o);
  }
  if (atual) sel.value = atual;
}

async function conectarArquivos() {
  const id = $('#fileHostSelect').value;
  if (!id) { toast('Cadastre um host SSH ou FTP primeiro.', 'erro'); return; }
  const btn = $('#fileConnect');
  btn.disabled = true;
  $('#fileStatus').textContent = 'Conectando…';
  try {
    const r = await filesApi('open', { hostId: id });
    fileState.sessionId = r.sessionId;
    fileState.protocol = r.protocol;
    fileState.secure = r.secure;
    fileState.paths.remote = r.path;
    $('#fileRemoteTitle').textContent = '☁️ ' + r.hostName;
    const badge = $('#fileProtoBadge');
    badge.hidden = false;
    badge.textContent = r.protocol === 'ftp' ? (r.secure ? 'FTPS' : 'FTP') : 'SFTP';
    const aviso = $('#fileInsecure');
    if (!r.secure) { aviso.hidden = false; aviso.textContent = '⚠️ sem criptografia'; }
    else if (r.protocol === 'ftp' && r.certVerificado === false) {
      // TLS sem identidade verificada não é o mesmo que conexão confiável
      aviso.hidden = false; aviso.textContent = '⚠️ certificado não verificado';
    } else aviso.hidden = true;
    $('#fileConnect').hidden = true;
    $('#fileDisconnect').hidden = false;
    $('#fileStatus').textContent = '';
    await fileList('remote', r.path);
  } catch (e) {
    toast(e.message, 'erro');
    $('#fileStatus').textContent = '';
  } finally { btn.disabled = false; }
}

async function desconectarArquivos() {
  if (fileState.sessionId) { try { await filesApi('close', { sessionId: fileState.sessionId }); } catch {} }
  fileState.sessionId = null;
  fileState.lists.remote = null;
  fileState.protocol = null;
  $('#fileProtoBadge').hidden = true;
  $('#fileInsecure').hidden = true;
  $('#fileConnect').hidden = false;
  $('#fileDisconnect').hidden = true;
  $('#fileRemoteTitle').textContent = '☁️ Servidor';
  renderFileList('remote');
}

function initFiles() {
  $('#fileConnect').addEventListener('click', conectarArquivos);
  $('#fileDisconnect').addEventListener('click', desconectarArquivos);

  $$('.file-pane').forEach((pane) => {
    const lado = pane.dataset.side;
    pane.querySelectorAll('.file-actions button').forEach((b) => {
      b.addEventListener('click', async () => {
        const r = fileState.lists[lado];
        if (b.dataset.act === 'up' && r && r.parent) return fileList(lado, r.parent);
        if (b.dataset.act === 'home') return fileList(lado, lado === 'local' ? '' : (fileState.protocol === 'ftp' ? '/' : ''));
        if (b.dataset.act === 'refresh') return fileList(lado);
        if (b.dataset.act === 'mkdir') {
          const nome = prompt('Nome da nova pasta:');
          if (!nome) return;
          try { await filesApi('mkdir', ladoBody(lado, { name: nome })); await fileList(lado); }
          catch (e) { toast(e.message, 'erro'); }
        }
      });
    });
    // caminho editável: Enter navega
    const inp = pane.querySelector('.file-path');
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') fileList(lado, inp.value.trim()); });

    // soltar aqui = transferir do outro painel
    const lista = pane.querySelector('.file-list');
    lista.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; lista.classList.add('drop-alvo'); });
    lista.addEventListener('dragleave', () => lista.classList.remove('drop-alvo'));
    lista.addEventListener('drop', (e) => {
      e.preventDefault();
      lista.classList.remove('drop-alvo');
      let d;
      try { d = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
      if (!d || d.lado === lado) return; // soltou no mesmo painel
      transferirArquivo(d.lado, d.name);
    });
  });

  document.addEventListener('click', () => { const m = $('#fileMenu'); if (m && !m.hidden) m.hidden = true; });
}

function onFilesTabShown() {
  renderFileHostSelect();
  if (!fileState.lists.local) fileList('local', '');
}

// ---------- área de trabalho remota (VNC / RDP) ----------
// As sessões vivem como abas do Terminal (ver createDeskSession). Nada de
// estado global aqui: VNC e RDP abrem sem depender de serviço externo.

// ---------- saudação nerd (barra no topo do terminal) ----------
// Frases de ficção científica/cultura nerd, em pt-BR, para dar as boas-vindas.
const NERD_QUOTES = [
  { icon: '🚀', text: 'Não entre em pânico. E leve sempre uma toalha.', src: 'O Guia do Mochileiro das Galáxias' },
  { icon: '🐬', text: 'Até mais, e obrigado pelos peixes!', src: 'O Guia do Mochileiro das Galáxias' },
  { icon: '🔢', text: 'A resposta para a vida, o universo e tudo mais é 42. A pergunta, ninguém sabe.', src: 'O Guia do Mochileiro das Galáxias' },
  { icon: '🤖', text: '"Aqui estou eu, com um cérebro do tamanho de um planeta, e me pedem para reiniciar um serviço."', src: 'Marvin, o Andróide Paranoide' },
  { icon: '⚔️', text: 'Que a Força esteja com você — e com seus backups.', src: 'Star Wars' },
  { icon: '🌌', text: 'Faça ou não faça. Tentativa não há.', src: 'Mestre Yoda' },
  { icon: '🛸', text: 'Eu tenho um mau pressentimento sobre isso.', src: 'Star Wars' },
  { icon: '🖖', text: 'Vida longa e próspera.', src: 'Star Trek' },
  { icon: '🚨', text: 'As necessidades de muitos superam as necessidades de poucos.', src: 'Spock, Star Trek' },
  { icon: '🕶️', text: 'Não tente entortar a colher. Isso é impossível. Em vez disso, tente perceber a verdade: não há colher.', src: 'Matrix' },
  { icon: '💊', text: 'Infelizmente, ninguém pode ser informado sobre o que é a Matrix. Você tem que ver com seus próprios olhos.', src: 'Matrix' },
  { icon: '🦖', text: 'A vida encontra um caminho. O uptime, às vezes, não.', src: 'Jurassic Park' },
  { icon: '💍', text: 'Um servidor para a todos governar.', src: 'O Senhor dos Anéis' },
  { icon: '🧙', text: 'Você não vai passar! (disse o firewall)', src: 'Gandalf' },
  { icon: '⏳', text: 'Tudo o que temos de decidir é o que fazer com o tempo que nos é dado.', src: 'Gandalf' },
  { icon: '🔭', text: 'O espaço é grande. Muito grande. Você simplesmente não vai acreditar em quão vasto ele é.', src: 'O Guia do Mochileiro das Galáxias' },
  { icon: '🤠', text: 'Ao infinito e além!', src: 'Toy Story' },
  { icon: '🎬', text: 'Estrada? Para onde vamos, não precisamos de estradas.', src: 'De Volta para o Futuro' },
  { icon: '⚡', text: '1.21 gigawatts?! Grande Escoto!', src: 'De Volta para o Futuro' },
  { icon: '🐉', text: 'Um mago nunca se atrasa. Chega precisamente quando pretende.', src: 'O Senhor dos Anéis' },
  { icon: '🎩', text: 'É perigoso sair sozinho! Leve isto.', src: 'The Legend of Zelda' },
  { icon: '👾', text: 'A princesa está em outro castelo.', src: 'Super Mario Bros.' },
  { icon: '🧬', text: 'Resistir é fútil. (mas fazer rollback, não)', src: 'Borg, Star Trek' },
  { icon: '🛰️', text: 'Houston, tivemos um problema. (mas os logs vão dizer qual)', src: 'Apollo 13' },
  { icon: '🤖', text: 'Eu voltarei. — provavelmente no próximo deploy.', src: 'O Exterminador do Futuro' },
  { icon: '🌀', text: 'Resposta 42, pergunta desconhecida. Assim como aquele bug em produção.', src: 'O Guia do Mochileiro das Galáxias' },
  { icon: '🔧', text: 'Já tentou desligar e ligar de novo?', src: 'The IT Crowd' },
  { icon: '📞', text: 'Alô, TI? Está pegando fogo, cara!', src: 'The IT Crowd' },
  { icon: '🧠', text: 'A lógica é o começo da sabedoria, não o fim.', src: 'Spock, Star Trek' },
  { icon: '🎲', text: 'Nunca me diga as probabilidades!', src: 'Han Solo, Star Wars' },
  { icon: '🌟', text: 'Eu sou o seu pai... do processo init.', src: 'Star Wars' },
  { icon: '🛡️', text: 'Este é o caminho.', src: 'The Mandalorian' },
  { icon: '🔮', text: 'Difícil de ver. Sempre em movimento está o futuro — e o cronograma.', src: 'Mestre Yoda' },
  { icon: '💾', text: 'Tenha calma e faça backup.', src: 'Sabedoria ancestral de sysadmin' },
  { icon: '🦸', text: 'Com grandes poderes de root vêm grandes responsabilidades.', src: 'Homem-Aranha (adaptado)' },

  // ----- Star Wars -----
  { icon: '🌠', text: 'Estas não são as VMs que você procura.', src: 'Star Wars (adaptado)' },
  { icon: '🛠️', text: 'Ajude-me, sysadmin. Você é minha única esperança.', src: 'Princesa Leia (adaptado)' },
  { icon: '🌑', text: 'Eu acho sua falta de backup perturbadora.', src: 'Darth Vader (adaptado)' },
  { icon: '⭐', text: 'Um único ticket mal descrito pode destruir uma Estrela da Morte inteira.', src: 'Star Wars (adaptado)' },
  { icon: '🤖', text: 'Não somos os containers que vocês procuram. Podem seguir.', src: 'Star Wars (adaptado)' },
  { icon: '🗡️', text: 'A raiva leva ao ódio. O ódio leva a fazer deploy na sexta-feira.', src: 'Mestre Yoda (adaptado)' },
  { icon: '🧘', text: 'Paciência você deve ter, meu jovem padawan do terminal.', src: 'Mestre Yoda' },
  { icon: '🏜️', text: 'Se existe um centro luminoso do universo, este servidor fica no data center mais distante dele.', src: 'Luke Skywalker (adaptado)' },
  { icon: '🎯', text: 'Confie nos seus logs, Luke.', src: 'Star Wars (adaptado)' },
  { icon: '🚀', text: 'Nunca subestime um Millennium Falcon com uptime de 20 anos.', src: 'Star Wars (adaptado)' },

  // ----- Star Trek -----
  { icon: '🖖', text: 'Espaço: a fronteira final. Assim como aquele disco em 99 por cento.', src: 'Star Trek (adaptado)' },
  { icon: '⚡', text: 'Energizar! (ou apenas reiniciar o serviço, o que for mais rápido)', src: 'Star Trek (adaptado)' },
  { icon: '🔧', text: 'Capitão, os motores não aguentam mais essa carga!', src: 'Scotty, Star Trek' },
  { icon: '🩺', text: 'Sou administrador de sistemas, não mágico!', src: 'Dr. McCoy (adaptado)' },
  { icon: '🌍', text: 'Diretriz Primeira: não mexer em produção sem avisar ninguém.', src: 'Star Trek (adaptado)' },
  { icon: '🧠', text: 'Fascinante. Este comportamento desafia toda a documentação.', src: 'Spock (adaptado)' },
  { icon: '🛰️', text: 'Faça acontecer.', src: 'Capitão Picard, Star Trek' },
  { icon: '🔴', text: 'Alerta vermelho: alguém abriu o firewall inteiro.', src: 'Star Trek (adaptado)' },
  { icon: '🧬', text: 'Você será assimilado ao novo padrão de deploy.', src: 'Borg (adaptado)' },
  { icon: '☕', text: 'Chá. Earl Grey. Quente. E um café para o plantão.', src: 'Capitão Picard' },

  // ----- Guia do Mochileiro -----
  { icon: '📗', text: 'O Guia diz que este servidor é praticamente inofensivo.', src: 'O Guia do Mochileiro das Galáxias' },
  { icon: '🐭', text: 'Camundongos pediram um relatório. Ninguém sabe por quê.', src: 'O Guia do Mochileiro das Galáxias (adaptado)' },
  { icon: '🛁', text: 'Uma toalha é o item mais útil que um sysadmin pode carregar.', src: 'O Guia do Mochileiro das Galáxias' },
  { icon: '🌐', text: 'Este servidor foi demolido para dar lugar a uma via expressa hiperespacial. Culpe o time de rede.', src: 'O Guia do Mochileiro das Galáxias (adaptado)' },
  { icon: '🥴', text: 'A probabilidade de isso funcionar de primeira é de 1 em 2.867.', src: 'Improbabilidade Infinita (adaptado)' },
  { icon: '🤷', text: 'Compartilhe e aproveite. (a garantia venceu ontem)', src: 'Corporação Sirius Cybernetics' },
  { icon: '🕰️', text: 'Prazos fazem um belo som ao passarem voando.', src: 'Douglas Adams (adaptado)' },
  { icon: '🌌', text: 'Existem duas coisas infinitas: o universo e a fila de tickets.', src: 'Sabedoria intergaláctica' },

  // ----- Senhor dos Anéis -----
  { icon: '👁️', text: 'O olho do monitoramento tudo vê. Inclusive aquele deploy silencioso.', src: 'O Senhor dos Anéis (adaptado)' },
  { icon: '⛏️', text: 'Cavaram fundo demais no legado, e acordaram algo antigo.', src: 'O Senhor dos Anéis (adaptado)' },
  { icon: '🧝', text: 'Mesmo o menor commit pode mudar o curso do futuro.', src: 'Galadriel (adaptado)' },
  { icon: '🥔', text: 'Backups. Faça em disco, na nuvem e em fita.', src: 'Samwise (adaptado)' },
  { icon: '💍', text: 'Meu precioso... o token de produção.', src: 'Gollum (adaptado)' },
  { icon: '🏔️', text: 'Não se caminha simplesmente até o ambiente de produção.', src: 'Boromir (adaptado)' },
  { icon: '🗺️', text: 'É perigoso sair pela porta. Você pisa no deploy e não sabe aonde vai parar.', src: 'Bilbo (adaptado)' },
  { icon: '🔥', text: 'Fuja, seu tolo! O rollback já está rodando.', src: 'Gandalf (adaptado)' },

  // ----- Matrix / cyberpunk -----
  { icon: '🐇', text: 'Siga o coelho branco até a causa raiz.', src: 'Matrix (adaptado)' },
  { icon: '🕶️', text: 'Eu conheço kung fu. E também conheço grep.', src: 'Matrix (adaptado)' },
  { icon: '🔋', text: 'Bem-vindo ao deserto do real: o ambiente de homologação.', src: 'Matrix (adaptado)' },
  { icon: '🐈‍⬛', text: 'Déjà vu costuma significar que mudaram alguma coisa na Matrix. Ou no DNS.', src: 'Matrix (adaptado)' },
  { icon: '💊', text: 'Pílula azul: reinicia e esquece. Pílula vermelha: lê o log inteiro.', src: 'Matrix (adaptado)' },
  { icon: '🌆', text: 'O céu acima da porta era da cor de uma tela sem sinal.', src: 'Neuromancer, William Gibson (adaptado)' },
  { icon: '🧊', text: 'O futuro já chegou. Só ainda não foi distribuído por igual.', src: 'William Gibson' },
  { icon: '🏙️', text: 'Acorde, samurai. Temos um incidente para resolver.', src: 'Cyberpunk 2077 (adaptado)' },

  // ----- Filmes de ficção -----
  { icon: '🦕', text: 'Seus engenheiros ficaram tão ocupados vendo se podiam que não pararam para pensar se deviam.', src: 'Jurassic Park (adaptado)' },
  { icon: '🖥️', text: 'Ah, ah, ah! Você não disse a palavra mágica.', src: 'Jurassic Park' },
  { icon: '⚙️', text: 'Segure meu café: vou mexer no /etc/fstab.', src: 'Sabedoria arriscada de sysadmin' },
  { icon: '🤖', text: 'Venha comigo se quiser fazer backup.', src: 'O Exterminador do Futuro (adaptado)' },
  { icon: '⏰', text: 'O futuro não está escrito. Exceto no cron.', src: 'O Exterminador do Futuro (adaptado)' },
  { icon: '👽', text: 'No servidor, ninguém pode ouvir você gritar.', src: 'Alien (adaptado)' },
  { icon: '🚨', text: 'Sinto muito, mas essa política de firewall precisa ficar.', src: 'Ripley (adaptado)' },
  { icon: '🐈', text: 'Nunca abandone o gato. Nem o processo órfão.', src: 'Alien (adaptado)' },
  { icon: '🌧️', text: 'Todos esses logs se perderão no tempo, como lágrimas na chuva.', src: 'Blade Runner (adaptado)' },
  { icon: '🦄', text: 'É uma pena que ele não vá viver. Mas quem vai? (falando do certificado SSL)', src: 'Blade Runner (adaptado)' },
  { icon: '🕰️', text: 'Timey-wimey. Assim é o fuso horário deste servidor.', src: 'Doctor Who (adaptado)' },
  { icon: '📞', text: 'É maior por dentro. Como aquele arquivo de log.', src: 'Doctor Who (adaptado)' },
  { icon: '🏃', text: 'Corra! O deploy começou.', src: 'Doctor Who (adaptado)' },
  { icon: '🌀', text: 'Tudo isso já aconteceu antes, e tudo isso vai acontecer de novo. Principalmente esse bug.', src: 'Battlestar Galactica (adaptado)' },
  { icon: '🏜️', text: 'O medo mata a mente. E também a produtividade em dia de incidente.', src: 'Duna (adaptado)' },
  { icon: '🪱', text: 'Quem controla o backup controla o universo.', src: 'Duna (adaptado)' },
  { icon: '🚢', text: 'Não posso mudar o universo, mas posso reiniciar o serviço.', src: 'The Expanse (adaptado)' },
  { icon: '🛸', text: 'Estou levando este servidor para o céu, capitão.', src: 'Firefly (adaptado)' },
  { icon: '🎩', text: 'Inconcebível!', src: 'A Princesa Prometida' },
  { icon: '⚔️', text: 'Olá. Meu nome é Sysadmin. Você derrubou meu servidor. Prepare-se para o rollback.', src: 'A Princesa Prometida (adaptado)' },
  { icon: '🥥', text: 'É apenas um arranhão! (disse o serviço com 500 erros por minuto)', src: 'Monty Python (adaptado)' },
  { icon: '🦜', text: 'Este processo não está dormindo. Ele deixou de existir.', src: 'Monty Python (adaptado)' },
  { icon: '🌉', text: 'Qual é a sua busca? Qual é a sua senha? Qual é a velocidade média de um pacote sem carga?', src: 'Monty Python (adaptado)' },
  { icon: '👻', text: 'Quem você vai chamar? O plantão.', src: 'Os Caça-Fantasmas (adaptado)' },
  { icon: '🚫', text: 'Nunca cruze os cabos. Nem os ambientes.', src: 'Os Caça-Fantasmas (adaptado)' },
  { icon: '🕴️', text: 'Um flash de memória e ninguém lembra do downtime.', src: 'MIB (adaptado)' },
  { icon: '💾', text: 'Sou o usuário. Luto pelos processos.', src: 'Tron (adaptado)' },
  { icon: '🏍️', text: 'Fim de linha, programa.', src: 'Tron' },
  { icon: '♟️', text: 'Estranho jogo. O único movimento vencedor é não fazer deploy na sexta.', src: 'WarGames (adaptado)' },
  { icon: '🎮', text: 'Que tal uma boa partida de xadrez? Depois do incidente.', src: 'WarGames (adaptado)' },
  { icon: '💻', text: 'Hackeie o planeta! (mas antes abra um ticket)', src: 'Hackers (adaptado)' },
  { icon: '🎭', text: 'Olá, amigo. Você já reparou como o log conta uma história?', src: 'Mr. Robot (adaptado)' },
  { icon: '🕵️', text: 'A vulnerabilidade não estava no código. Estava nas pessoas.', src: 'Mr. Robot (adaptado)' },
  { icon: '📈', text: 'Escalabilidade média a ótima. Assim como o café da copa.', src: 'Silicon Valley (adaptado)' },
  { icon: '🧮', text: 'Compressão sem perdas, diferente das minhas horas de sono.', src: 'Silicon Valley (adaptado)' },
  { icon: '🚪', text: 'Bazinga! O servidor voltou sozinho.', src: 'The Big Bang Theory (adaptado)' },
  { icon: '🪐', text: 'Não vamos passar do limite de tempo, vamos passar do limite de paciência.', src: 'Interestelar (adaptado)' },
  { icon: '📚', text: 'Murphy, a resposta estava nos dados o tempo todo.', src: 'Interestelar (adaptado)' },
  { icon: '🔴', text: 'Sinto muito, Dave. Receio não poder aprovar esse merge.', src: 'HAL 9000, 2001 (adaptado)' },
  { icon: '🗿', text: 'Meu Deus, está cheio de logs!', src: '2001: Uma Odisseia no Espaço (adaptado)' },
  { icon: '🤖', text: 'Diretiva primária: limpar o disco. Sempre.', src: 'Wall-E (adaptado)' },
  { icon: '💡', text: 'Uma inteligência artificial passou no teste. O CAPTCHA, não.', src: 'Ex Machina (adaptado)' },
  { icon: '🌪️', text: 'Precisamos ir mais fundo. No stack trace.', src: 'A Origem (adaptado)' },
  { icon: '🎬', text: 'Um sonho dentro de um sonho dentro de um container dentro de uma VM.', src: 'A Origem (adaptado)' },
  { icon: '🛡️', text: 'Eu poderia fazer isso o dia todo. (o script de retry, não eu)', src: 'Capitão América (adaptado)' },
  { icon: '💥', text: 'Eu sou inevitável. — o débito técnico', src: 'Thanos (adaptado)' },
  { icon: '🔨', text: 'Quem for digno, que empunhe o acesso root.', src: 'Thor (adaptado)' },
  { icon: '🧲', text: 'Gênio, bilionário, playboy, filantropo. E ainda assim esqueceu de renovar o certificado.', src: 'Homem de Ferro (adaptado)' },
  { icon: '🕸️', text: 'Meu sentido de aranha diz que esse deploy vai dar problema.', src: 'Homem-Aranha (adaptado)' },
  { icon: '🦇', text: 'Não sou eu quem está por baixo. É o servidor.', src: 'Batman (adaptado)' },
  { icon: '🦸‍♂️', text: 'Nem todo herói usa capa. Alguns só fazem backup.', src: 'Sabedoria de plantão' },
  { icon: '🪄', text: 'É Leviosa, não Leviosá. E é sudo, não pseudo.', src: 'Harry Potter (adaptado)' },
  { icon: '🧹', text: 'Você é um sysadmin, Harry.', src: 'Hagrid (adaptado)' },
  { icon: '📜', text: 'Juro solenemente que não vou mexer em produção.', src: 'Harry Potter (adaptado)' },
  { icon: '🕯️', text: 'Nox! (para desligar aquele monitor esquecido ligado)', src: 'Harry Potter (adaptado)' },
  { icon: '🐢', text: 'O universo é carregado nas costas de quatro elefantes sobre uma tartaruga. A infraestrutura, em três scripts sem dono.', src: 'Discworld, Terry Pratchett (adaptado)' },

  // ----- Games -----
  { icon: '🎂', text: 'O bolo é mentira. O relatório de disponibilidade também.', src: 'Portal' },
  { icon: '🧪', text: 'Ainda estamos vivos, e ainda fazendo ciência.', src: 'Portal (adaptado)' },
  { icon: '🌀', text: 'Pense com portais. E com pipes.', src: 'Portal (adaptado)' },
  { icon: '🤖', text: 'Esta é a parte em que ele te mata. — nota: era o OOM killer', src: 'Portal (adaptado)' },
  { icon: '🦺', text: 'Ele está a caminho. Prepare-se para a manutenção.', src: 'Half-Life (adaptado)' },
  { icon: '🔬', text: 'Homem certo no lugar errado pode fazer toda a diferença no mundo.', src: 'Half-Life' },
  { icon: '🗡️', text: 'Pegue esta espada. Você vai precisar dela no legado.', src: 'The Legend of Zelda (adaptado)' },
  { icon: '💚', text: 'Você recuperou um coração! (e um pouco de uptime)', src: 'The Legend of Zelda (adaptado)' },
  { icon: '🔺', text: 'Hey! Listen! Alguém esqueceu de commitar.', src: 'Navi, Zelda (adaptado)' },
  { icon: '🍄', text: 'Você pegou um cogumelo: agora o servidor tem o dobro de RAM.', src: 'Super Mario Bros. (adaptado)' },
  { icon: '🐢', text: 'Mamma mia! O disco encheu de novo.', src: 'Super Mario (adaptado)' },
  { icon: '🏰', text: 'Obrigado, sysadmin! Mas nosso uptime está em outro castelo.', src: 'Super Mario Bros. (adaptado)' },
  { icon: '⚡', text: 'Eu escolho você, script de automação!', src: 'Pokémon (adaptado)' },
  { icon: '🎒', text: 'Não dá para usar isso agora. Tente com privilégios de root.', src: 'Pokémon (adaptado)' },
  { icon: '🥚', text: 'Gotta patch em all.', src: 'Pokémon (adaptado)' },
  { icon: '⛏️', text: 'Nunca cave direto para baixo. Nem faça rm -rf direto na raiz.', src: 'Minecraft (adaptado)' },
  { icon: '💥', text: 'Ssssss... aquele barulho antes do incidente.', src: 'Creeper, Minecraft (adaptado)' },
  { icon: '🌙', text: 'A noite chegou e os monstros apareceram. Assim como os alertas.', src: 'Minecraft (adaptado)' },
  { icon: '😈', text: 'Rasgue e destrua. (só que em ambiente de teste)', src: 'Doom (adaptado)' },
  { icon: '🔫', text: 'Roda até em geladeira. Mas não roda nesse legado.', src: 'Doom (adaptado)' },
  { icon: '🐉', text: 'Eu também costumava fazer deploy sem medo, aí tomei uma flecha no joelho.', src: 'Skyrim (adaptado)' },
  { icon: '🏔️', text: 'Fus Ro Dah! (o comando que derrubou o cluster)', src: 'Skyrim (adaptado)' },
  { icon: '🛡️', text: 'Você parece cansado. Precisa de um bom descanso e de um runbook.', src: 'Skyrim (adaptado)' },
  { icon: '☢️', text: 'A guerra nunca muda. O código legado também não.', src: 'Fallout (adaptado)' },
  { icon: '🧴', text: 'Nuka-Cola e plantão: a dupla que mantém o data center vivo.', src: 'Fallout (adaptado)' },
  { icon: '🎺', text: 'Preparando o Vault... quer dizer, o ambiente de contingência.', src: 'Fallout (adaptado)' },
  { icon: '🚀', text: 'Eu sou o Comandante Shepard, e este é meu runbook favorito da Cidadela.', src: 'Mass Effect (adaptado)' },
  { icon: '📦', text: 'Alerta! Papelão detectado no data center.', src: 'Metal Gear Solid (adaptado)' },
  { icon: '❗', text: 'O som mais assustador do mundo: o alerta às 3 da manhã.', src: 'Metal Gear Solid (adaptado)' },
  { icon: '💨', text: 'Gotta go fast — mas não em produção.', src: 'Sonic (adaptado)' },
  { icon: '🥊', text: 'Hadouken no processo travado.', src: 'Street Fighter (adaptado)' },
  { icon: '🏆', text: 'You win! Perfect. Zero downtime.', src: 'Street Fighter (adaptado)' },
  { icon: '🧱', text: 'A peça que você precisa sempre vem depois. Igual à informação no ticket.', src: 'Tetris (adaptado)' },
  { icon: '📏', text: 'Encaixe tudo direitinho e a linha some. Assim são os logs bem estruturados.', src: 'Tetris (adaptado)' },
  { icon: '🏴‍☠️', text: 'Você luta como um administrador de banco de dados.', src: 'Monkey Island (adaptado)' },
  { icon: '🐒', text: 'Sou Guybrush Threepwood, e quero ser um sysadmin poderoso.', src: 'Monkey Island (adaptado)' },
  { icon: '🕶️', text: 'Vim chutar traseiros e liberar espaço em disco. E o disco já está cheio.', src: 'Duke Nukem (adaptado)' },
  { icon: '👹', text: 'Fique um tempo, e escute os logs.', src: 'Diablo (adaptado)' },
  { icon: '⚔️', text: 'Trabalho concluído! Preciso de mais recursos.', src: 'Warcraft (adaptado)' },
  { icon: '👷', text: 'Precisamos construir mais pylons. E mais réplicas.', src: 'StarCraft (adaptado)' },
  { icon: '🐜', text: 'Rush de zerglings ou pico de tráfego? O gráfico é igual.', src: 'StarCraft (adaptado)' },
  { icon: '🐺', text: 'Mal por mal, prefiro o mal documentado.', src: 'The Witcher (adaptado)' },
  { icon: '🪙', text: 'Joga uma moeda pro seu sysadmin, ó vale da abundância.', src: 'The Witcher (adaptado)' },
  { icon: '💀', text: 'Você morreu. Tente novamente com mais logs.', src: 'Dark Souls (adaptado)' },
  { icon: '🔥', text: 'Fogueira acesa: ponto de restauração criado.', src: 'Dark Souls (adaptado)' },
  { icon: '🙏', text: 'Louvado seja o sol, e o backup que funcionou.', src: 'Dark Souls (adaptado)' },
  { icon: '🚀', text: 'Havia um impostor entre os processos.', src: 'Among Us (adaptado)' },
  { icon: '❤️', text: 'Apesar de tudo, ainda era o mesmo bug.', src: 'Undertale (adaptado)' },
  { icon: '🛰️', text: 'Se falhou, adicione mais foguetes. Se falhou de novo, leia o log.', src: 'Kerbal Space Program (adaptado)' },
  { icon: '🏭', text: 'A fábrica deve crescer. O cluster também.', src: 'Factorio (adaptado)' },
  { icon: '🕳️', text: 'Você está em um labirinto de arquivos de configuração, todos parecidos.', src: 'Zork (adaptado)' },
  { icon: '👾', text: 'Os invasores descem uma linha a cada varredura de porta.', src: 'Space Invaders (adaptado)' },
  { icon: '🟡', text: 'Waka waka: o processo comendo toda a memória.', src: 'Pac-Man (adaptado)' },
  { icon: '🌾', text: 'Cada dia é um novo dia para arrumar o servidor da fazenda.', src: 'Stardew Valley (adaptado)' },

  // ----- Anime / mangá -----
  { icon: '🧠', text: 'A rede é vasta e infinita. O log também.', src: 'Ghost in the Shell (adaptado)' },
  { icon: '🌐', text: 'Se lembrarmos de tudo, talvez o sistema não precise de cache.', src: 'Ghost in the Shell (adaptado)' },
  { icon: '🏍️', text: 'Kaneda! O processo está fora de controle!', src: 'Akira (adaptado)' },
  { icon: '🤖', text: 'Entre no robô, Shinji. Ou pelo menos no terminal.', src: 'Evangelion (adaptado)' },
  { icon: '🎼', text: 'Parabéns. O deploy funcionou.', src: 'Evangelion (adaptado)' },
  { icon: '🎷', text: 'Até mais, cowboy do terminal.', src: 'Cowboy Bebop (adaptado)' },
  { icon: '🍜', text: 'Não trabalhe com fome. Nem faça deploy com sono.', src: 'Cowboy Bebop (adaptado)' },
  { icon: '💥', text: 'O nível de carga está OVER 9000!', src: 'Dragon Ball Z (adaptado)' },
  { icon: '🔵', text: 'Kamehameha no cache!', src: 'Dragon Ball (adaptado)' },
  { icon: '🐉', text: 'Reunir sete servidores para realizar um desejo: uptime de 100 por cento.', src: 'Dragon Ball (adaptado)' },
  { icon: '🍥', text: 'Nunca volto atrás na minha palavra. Esse é o meu jeito de documentar.', src: 'Naruto (adaptado)' },
  { icon: '🌀', text: 'Clones das sombras: assim escalamos horizontalmente.', src: 'Naruto (adaptado)' },
  { icon: '🏴‍☠️', text: 'Eu vou ser o rei dos scripts!', src: 'One Piece (adaptado)' },
  { icon: '🍖', text: 'Um bom time de tripulação vale mais que qualquer ferramenta.', src: 'One Piece (adaptado)' },
  { icon: '⚗️', text: 'Troca equivalente: para ganhar uptime, algo de igual valor deve ser monitorado.', src: 'Fullmetal Alchemist (adaptado)' },
  { icon: '🔩', text: 'Humanos não podem ganhar nada sem antes dar um rollback.', src: 'Fullmetal Alchemist (adaptado)' },
  { icon: '📓', text: 'Tudo que é escrito no runbook acontece em 40 segundos.', src: 'Death Note (adaptado)' },
  { icon: '⏳', text: 'É a escolha de Steins Gate. E também a escolha de reiniciar.', src: 'Steins;Gate (adaptado)' },
  { icon: '📟', text: 'Enviar uma mensagem para o passado: nunca use latin1 no banco.', src: 'Steins;Gate (adaptado)' },
  { icon: '🧱', text: 'Do outro lado da muralha existe apenas um datacenter maior.', src: 'Attack on Titan (adaptado)' },

  // ----- Ficção científica literária -----
  { icon: '🤖', text: 'Primeira Lei: um robô não pode derrubar produção, nem por omissão permitir que ela caia.', src: 'Asimov (adaptado)' },
  { icon: '📖', text: 'A violência é o último refúgio do incompetente. Reiniciar, o penúltimo.', src: 'Isaac Asimov (adaptado)' },
  { icon: '🌌', text: 'A psico-história prevê o comportamento do cluster, não o do estagiário.', src: 'Fundação, Asimov (adaptado)' },
  { icon: '🔮', text: 'Qualquer tecnologia suficientemente avançada é indistinguível de mágica. Ou de um script sem comentários.', src: 'Arthur C. Clarke (adaptado)' },
  { icon: '🛰️', text: 'Duas possibilidades existem: o log explica tudo, ou não existe log. Ambas são aterrorizantes.', src: 'Arthur C. Clarke (adaptado)' },
  { icon: '🏙️', text: 'Ciberespaço: uma alucinação consensual vivida diariamente por bilhões de operadores.', src: 'Neuromancer, William Gibson' },
  { icon: '🛹', text: 'A rede é um lugar melhor quando alguém documenta.', src: 'Snow Crash (adaptado)' },
  { icon: '♟️', text: 'O inimigo está lá embaixo. Assim como a causa raiz.', src: 'O Jogo do Exterminador (adaptado)' },
  { icon: '🔥', text: '451 graus: a temperatura em que a documentação queima.', src: 'Fahrenheit 451 (adaptado)' },

  // ----- Cultura de tecnologia -----
  { icon: '🐧', text: 'No começo era a linha de comando. E ela continua lá, esperando.', src: 'Cultura Unix' },
  { icon: '🧰', text: 'Faça uma coisa e faça bem feito.', src: 'Filosofia Unix' },
  { icon: '🔗', text: 'Tudo é um arquivo. Até o problema.', src: 'Filosofia Unix' },
  { icon: '🚪', text: 'Como sair do vim? Ninguém nunca soube ao certo.', src: 'Folclore de terminal' },
  { icon: '⌨️', text: 'Emacs é um ótimo sistema operacional. Falta só um bom editor.', src: 'Guerra santa dos editores' },
  { icon: '🌳', text: 'Git commit, git push, git ansioso.', src: 'Rotina de desenvolvedor' },
  { icon: '🔀', text: 'Em caso de dúvida, crie uma branch.', src: 'Sabedoria de versionamento' },
  { icon: '🧨', text: 'Force push é como dirigir sem cinto: funciona até não funcionar.', src: 'Sabedoria de versionamento' },
  { icon: '🔍', text: 'Tinha um problema. Resolveu com regex. Agora tem dois problemas.', src: 'Jamie Zawinski (adaptado)' },
  { icon: '🌐', text: 'Sempre é o DNS. Mesmo quando não é, é.', src: 'Lei do plantão' },
  { icon: '📡', text: 'Se estiver lento, culpe a rede. Se estiver rápido, foi mérito seu.', src: 'Diplomacia de infraestrutura' },
  { icon: '📦', text: 'Na minha máquina funciona. Então vamos entregar sua máquina.', src: 'Origem dos containers' },
  { icon: '☸️', text: 'Kubernetes resolve todos os seus problemas. E cria uns dez novos.', src: 'Sabedoria de nuvem' },
  { icon: '🐳', text: 'Container não é máquina virtual. Repita mais dez vezes.', src: 'Sabedoria de nuvem' },
  { icon: '🟨', text: 'Em JavaScript, NaN não é um número, mas é do tipo número.', src: 'Curiosidades da linguagem' },
  { icon: '🐍', text: 'Explícito é melhor que implícito. Simples é melhor que complexo.', src: 'Zen do Python' },
  { icon: '📐', text: 'Deve haver um jeito óbvio de fazer. De preferência, um só.', src: 'Zen do Python' },
  { icon: '🗃️', text: 'DROP TABLE sem WHERE: a lenda que assombra todo estagiário.', src: 'Terror de banco de dados' },
  { icon: '📋', text: 'Copiar do Stack Overflow é fácil. Entender é o serviço completo.', src: 'Rotina de desenvolvedor' },
  { icon: '🦆', text: 'Explique o problema para um patinho de borracha. Ele resolve metade dos casos.', src: 'Método do pato de borracha' },
  { icon: '🐛', text: '99 bugs no código, pega um e conserta, 127 bugs no código.', src: 'Canção do programador' },
  { icon: '🧊', text: 'Só existem duas coisas difíceis: invalidar cache e nomear variáveis.', src: 'Phil Karlton' },
  { icon: '➕', text: 'E o erro de índice off-by-one. São três coisas difíceis.', src: 'Piada clássica de programação' },
  { icon: '📏', text: 'Se depurar é remover bugs, programar é colocá-los.', src: 'Edsger Dijkstra' },
  { icon: '🎓', text: 'Testes provam a presença de bugs, nunca a ausência.', src: 'Edsger Dijkstra' },
  { icon: '⚡', text: 'Otimização prematura é a raiz de todo mal.', src: 'Donald Knuth' },
  { icon: '🧑‍💻', text: 'Programas devem ser escritos para pessoas lerem, e só de passagem para máquinas executarem.', src: 'Abelson e Sussman' },
  { icon: '🔧', text: 'Depurar é duas vezes mais difícil que escrever o código. Então não escreva o código mais esperto que você consegue.', src: 'Brian Kernighan' },
  { icon: '🐧', text: 'Conversa é barata. Me mostre o código.', src: 'Linus Torvalds' },
  { icon: '🤝', text: 'Seja conservador no que você envia, e liberal no que você aceita.', src: 'Lei de Postel' },
  { icon: '🪒', text: 'Entre duas explicações, prefira a mais simples. Geralmente é o cabo solto.', src: 'Navalha de Occam (adaptado)' },
  { icon: '🙃', text: 'Nunca atribua à maldade o que pode ser explicado por um deploy sem revisão.', src: 'Navalha de Hanlon (adaptado)' },
  { icon: '👶', text: 'Nove mulheres não fazem um bebê em um mês. Nem nove devs entregam em um dia.', src: 'Lei de Brooks' },
  { icon: '🏛️', text: 'A arquitetura do sistema espelha a estrutura de comunicação da empresa.', src: 'Lei de Conway' },
  { icon: '📊', text: '80 por cento dos incidentes vêm de 20 por cento dos serviços. Você sabe quais.', src: 'Princípio de Pareto (adaptado)' },
  { icon: '🐈', text: 'O deploy está funcionando e quebrado ao mesmo tempo, até alguém abrir o painel.', src: 'Gato de Schrödinger (adaptado)' },
  { icon: '🌡️', text: 'Quanto mais preciso o monitoramento, menos certeza sobre a causa.', src: 'Princípio da Incerteza (adaptado)' },
  { icon: '🍞', text: 'Se algo pode dar errado, vai dar. E na madrugada de sábado.', src: 'Lei de Murphy' },
  { icon: '🧯', text: 'Todo sistema tem um único ponto de falha. Geralmente é quem está de férias.', src: 'Lei do plantão' },
  { icon: '💽', text: 'Existem dois tipos de pessoas: as que fazem backup e as que ainda vão começar.', src: 'Sabedoria ancestral de sysadmin' },
  { icon: '✅', text: 'Backup que nunca foi restaurado é só um arquivo grande com esperança dentro.', src: 'Sabedoria ancestral de sysadmin' },
  { icon: '📅', text: 'Sexta-feira, 17h: o melhor horário para não fazer absolutamente nada em produção.', src: 'Sabedoria ancestral de sysadmin' },
  { icon: '📝', text: 'Documentação é uma carta de amor para o seu eu do futuro.', src: 'Sabedoria ancestral de sysadmin' },
  { icon: '🔐', text: 'Segurança é como cebola: tem camadas, e faz todo mundo chorar.', src: 'Sabedoria de segurança' },
  { icon: '🧑‍🔬', text: 'Não existe nuvem. É só o computador de outra pessoa.', src: 'Verdade inconveniente' },
  { icon: '🕰️', text: 'Fuso horário e horário de verão já derrubaram mais sistemas que hackers.', src: 'Verdade inconveniente' },
  { icon: '🔤', text: 'Tudo funcionava até chegar um nome com acento e emoji.', src: 'Terror da codificação de caracteres' },
  { icon: '🎰', text: 'Funciona de forma intermitente: o pior tipo de funcionar.', src: 'Terror do plantão' },
  { icon: '🧵', text: 'Programação concorrente: quando o bug só aparece na demonstração.', src: 'Terror do plantão' },
  { icon: '🚦', text: 'Verde no painel não significa saudável. Significa que ninguém criou o alerta certo.', src: 'Observabilidade honesta' },
  { icon: '🎯', text: 'Semver: quebrou a compatibilidade, sobe a primeira. Mas ninguém sobe.', src: 'Versionamento semântico' },
  { icon: '🧙', text: 'Qualquer script suficientemente antigo é indistinguível de magia negra.', src: 'Folclore de infraestrutura' },
  { icon: '📼', text: 'Esse código não tem dono. Ele tem sobreviventes.', src: 'Folclore de infraestrutura' },
  { icon: '🕹️', text: 'O primeiro bug de verdade era uma mariposa presa no relé.', src: 'Grace Hopper' },
  { icon: '⚓', text: 'É mais fácil pedir perdão do que permissão. (não vale para produção)', src: 'Grace Hopper' },
  { icon: '💡', text: 'A máquina analítica tece padrões algébricos como o tear tece flores.', src: 'Ada Lovelace' },
  { icon: '🧮', text: 'Uma máquina pode fazer tudo o que soubermos ordenar que ela faça.', src: 'Ada Lovelace (adaptado)' },
  { icon: '🤖', text: 'Se uma máquina engana você achando que é humana, o problema é o teste ou é você?', src: 'Alan Turing (adaptado)' },
  { icon: '📈', text: 'O número de transistores dobra. O tamanho do log, também.', src: 'Lei de Moore (adaptado)' },
  { icon: '🎃', text: 'Y2K não aconteceu porque muita gente trabalhou muito para que não acontecesse.', src: 'História da computação' },
  { icon: '📨', text: 'Existe um RFC para isso. Provavelmente ninguém leu.', src: 'Cultura da internet' },
  { icon: '🔁', text: 'Já tentou desligar e ligar de novo? Sim. Duas vezes. Funcionou na terceira.', src: 'Suporte técnico universal' },
  { icon: '☕', text: 'Erro entre a cadeira e o teclado. Café resolve os dois lados.', src: 'Suporte técnico universal' },
  { icon: '🛌', text: 'Funciona? Não mexe. Não funciona? Também pensa duas vezes antes de mexer.', src: 'Sabedoria ancestral de sysadmin' },
];

function greetingFor(date) {
  const h = date.getHours();
  if (h < 5) return 'Boa madrugada';
  if (h < 12) return 'Bom dia';
  if (h < 18) return 'Boa tarde';
  return 'Boa noite';
}

let greetHidden = false;
greetHidden = prefBool('greetHidden');

function pickQuote() {
  return NERD_QUOTES[Math.floor(Math.random() * NERD_QUOTES.length)];
}

function renderGreeting(q) {
  const quote = q || pickQuote();
  const name = (localInfo && localInfo.user) ? localInfo.user : '';
  $('#greetIcon').textContent = quote.icon;
  $('#greetHello').textContent = `${greetingFor(new Date())}${name ? ', ' + name : ''}!`;
  $('#greetQuote').textContent = `“${quote.text}” — ${quote.src}`;
}

function updateGreetVisibility() {
  const bar = $('#greetBar');
  if (bar) bar.hidden = greetHidden;
  const btn = $('#toggleGreet');
  if (btn) btn.classList.toggle('active', !greetHidden);
  if ($('#tab-terminal') && $('#tab-terminal').classList.contains('active')) setTimeout(fitActive, 40);
}

function setGreetHidden(v) {
  greetHidden = !!v;
  prefSet('greetHidden', greetHidden);
  updateGreetVisibility();
}

function initGreeting() {
  renderGreeting();
  updateGreetVisibility();
  $('#greetShuffle').addEventListener('click', () => renderGreeting());
  $('#greetHide').addEventListener('click', () => setGreetHidden(true));
  $('#toggleGreet').addEventListener('click', () => setGreetHidden(!greetHidden));
}

// ---------- aba Favoritos (edição completa) ----------
const favTab = { scope: '', q: '' };

function renderFavoritesTab() {
  const wrap = $('#favoritesList');
  if (!wrap) return;
  wrap.innerHTML = '';
  const q = favTab.q.toLowerCase();
  let list = state.favorites.slice();
  if (favTab.scope === 'global') list = list.filter((f) => !f.hostId);
  else if (favTab.scope === 'host') list = list.filter((f) => f.hostId);
  if (q) list = list.filter((f) => (f.command + ' ' + (f.label || '')).toLowerCase().includes(q));

  if (!list.length) {
    el(wrap, 'p', 'empty', state.favorites.length
      ? 'Nenhum favorito encontrado com esse filtro.'
      : 'Nenhum favorito ainda. Crie um aqui, ou favorite um comando pelo ☆ no Histórico.');
    return;
  }
  for (const f of list) {
    const card = el(wrap, 'div', 'card item fav-card');
    const head = el(card, 'div', 'item-head');
    el(head, 'strong', null, f.label || f.command);
    const scope = el(head, 'span', 'tag ' + (f.hostId ? 'tag-host' : 'tag-global'));
    const hn = f.hostId ? favHostName(f.hostId) : null;
    scope.textContent = f.hostId ? (hn ? `★ ${hn}` : '★ host removido') : '🌐 Global';
    const pre = el(card, 'pre', 'console small-console');
    pre.textContent = f.command;
    const actions = el(card, 'div', 'actions');
    const edit = el(actions, 'button', 'btn small', 'Editar');
    edit.addEventListener('click', () => openFavoriteModal({ existing: f, hostId: f.hostId }));
    const dup = el(actions, 'button', 'btn small', 'Duplicar');
    dup.addEventListener('click', () => openFavoriteModal({ command: f.command, label: f.label ? f.label + ' (cópia)' : '', hostId: f.hostId }));
    const del = el(actions, 'button', 'btn small danger', 'Excluir');
    del.addEventListener('click', async () => {
      if (!confirm(`Excluir o favorito "${f.label || f.command}"?`)) return;
      try { await api('/api/favorites/' + f.id, { method: 'DELETE' }); toast('Favorito excluído.'); await loadState(); }
      catch (e) { toast(e.message, 'erro'); }
    });
  }
}

function initFavoritesTab() {
  $$('#favScopeSeg button').forEach((b) => b.addEventListener('click', () => {
    $$('#favScopeSeg button').forEach((x) => x.classList.toggle('active', x === b));
    favTab.scope = b.dataset.scope || '';
    renderFavoritesTab();
  }));
  $('#favSearch').addEventListener('input', (e) => { favTab.q = e.target.value.trim(); renderFavoritesTab(); });
  $('#btnNewFavorite').addEventListener('click', () => {
    const s = activeSession();
    const hostId = s && !s.isLocal && favHostName(s.hostId) ? s.hostId : null;
    openFavoriteModal({ hostId });
  });
}

// ---------- comandos favoritos (globais ou por host) ----------
function favHostName(hostId) {
  const h = state.hosts.find((x) => x.id === hostId);
  return h ? h.name : null;
}

// favoritos visíveis para a sessão ativa: os do host da aba + os globais
function favsForActiveSession() {
  const s = activeSession();
  const hostId = s && !s.isLocal && favHostName(s.hostId) ? s.hostId : null;
  const ofHost = hostId ? state.favorites.filter((f) => f.hostId === hostId) : [];
  const globals = state.favorites.filter((f) => !f.hostId);
  return { ofHost, globals, hostId };
}

function renderFavMenu() {
  const menu = $('#favMenu');
  if (!menu) return;
  menu.innerHTML = '';
  const { ofHost, globals, hostId } = favsForActiveSession();

  const addRow = (f) => {
    const row = el(menu, 'div', 'fav-item');
    const body = el(row, 'div', 'fav-body');
    // O favorito apenas ESCREVE o comando no terminal — quem dá Enter é você.
    // Assim dá para revisar ou editar (trocar um caminho, um nome de serviço)
    // antes de executar; nada roda sozinho.
    body.title = 'Escrever no terminal (você revisa e dá Enter)';
    el(body, 'div', 'fav-label', f.label || f.command);
    if (f.label) el(body, 'code', 'fav-cmd', f.command);
    body.addEventListener('click', () => { insertCommand(f.command, false); closeFavMenu(); });
    const del = el(row, 'button', 'fav-del', '×');
    del.title = 'Remover dos favoritos';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Remover este favorito?')) return;
      try { await api('/api/favorites/' + f.id, { method: 'DELETE' }); await loadState(); renderFavMenu(); }
      catch (err) { toast(err.message, 'erro'); }
    });
  };

  if (hostId && ofHost.length) {
    el(menu, 'div', 'fav-group', `★ Deste host (${favHostName(hostId)})`);
    ofHost.forEach(addRow);
  }
  el(menu, 'div', 'fav-group', '🌐 Globais');
  if (globals.length) globals.forEach(addRow);
  else el(menu, 'p', 'fav-empty', 'Nenhum favorito global ainda.');

  const add = el(menu, 'button', 'fav-add', '+ Novo favorito');
  add.addEventListener('click', () => { closeFavMenu(); openFavoriteModal({ hostId }); });
}

function closeFavMenu() { const m = $('#favMenu'); if (m) m.hidden = true; }

function toggleFavMenu() {
  const m = $('#favMenu');
  if (!m) return;
  if (m.hidden) { renderFavMenu(); m.hidden = false; }
  else m.hidden = true;
}

// Modal para criar/editar favorito. ctx: { command?, label?, hostId?, existing? }
function openFavoriteModal(ctx = {}) {
  openModal(ctx.existing ? 'Editar favorito' : 'Adicionar aos favoritos', `
    <label>Comando
      <textarea id="fav_cmd" rows="3" class="mono" required placeholder="ex.: df -h"></textarea>
    </label>
    <label>Rótulo (opcional) <input id="fav_label" placeholder="ex.: Ver uso de disco"></label>
    <label>Escopo
      <select id="fav_scope"></select>
    </label>
    <p class="hint">Global aparece em todos os hosts. De host, só na aba daquele host.</p>
  `);
  // opções montadas via DOM (nome de host é texto do usuário — nada de HTML)
  const sel = $('#fav_scope');
  const optGlobal = document.createElement('option');
  optGlobal.value = '';
  optGlobal.textContent = '🌐 Global — em todos os hosts';
  sel.appendChild(optGlobal);
  for (const h of state.hosts) {
    const o = document.createElement('option');
    o.value = h.id;
    o.textContent = `★ Só para ${h.name}`;
    sel.appendChild(o);
  }
  $('#fav_cmd').value = ctx.command || (ctx.existing && ctx.existing.command) || '';
  $('#fav_label').value = ctx.label || (ctx.existing && ctx.existing.label) || '';
  const wantHost = (ctx.existing && ctx.existing.hostId) || ctx.hostId || '';
  if (wantHost && favHostName(wantHost)) sel.value = wantHost;
  setTimeout(() => { try { ($('#fav_cmd').value ? $('#fav_label') : $('#fav_cmd')).focus(); } catch {} }, 30);

  $('#modalForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const body = {
      command: $('#fav_cmd').value.trim(),
      label: $('#fav_label').value.trim(),
      hostId: $('#fav_scope').value || null,
    };
    if (!body.command) { toast('Informe o comando.', 'erro'); return; }
    try {
      if (ctx.existing) await api('/api/favorites/' + ctx.existing.id, { method: 'PUT', body });
      else await api('/api/favorites', { method: 'POST', body });
      closeModal();
      toast('Favorito salvo.');
      await loadState();
    } catch (e) { toast(e.message, 'erro'); }
  };
}

function initFavorites() {
  $('#favBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleFavMenu(); });
  // fecha o menu ao clicar fora dele
  document.addEventListener('click', (e) => {
    const m = $('#favMenu');
    if (m && !m.hidden && !m.contains(e.target) && e.target !== $('#favBtn')) closeFavMenu();
  });
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
    const res = await fetch('/api/export.xml' + (secrets ? '?secrets=1' : ''), { method: 'POST' });
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
          port: Number(h.getAttribute('port')) || ({ telnet: 23, ftp: 21 }[h.getAttribute('protocol')] || 22),
          username: h.getAttribute('username'),
          group: h.getAttribute('group') || '',
          icon: h.getAttribute('icon') || '',
          color: h.getAttribute('color') || '',
          protocol: ['telnet', 'ftp'].includes(h.getAttribute('protocol')) ? h.getAttribute('protocol') : 'ssh',
          ftps: h.getAttribute('ftps') || 'auto',
          // fingerprint NÃO vem do arquivo: é a prova de identidade do servidor,
          // aprendida na primeira conexão. Aceitá-la daqui permitiria desviar
          // uma conexão para outro servidor sem alarme.
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
      favorites: [...root.querySelectorAll(':scope > favorites > favorite')].map((f) => ({
        label: f.getAttribute('label') || '',
        hostName: f.getAttribute('host') || '',
        command: f.textContent,
      })),
      settings: (() => {
        const s = root.querySelector(':scope > settings');
        if (!s) return {};
        const out = {};
        if (s.getAttribute('model')) out.model = s.getAttribute('model');
        if (s.getAttribute('apiKey')) out.apiKey = s.getAttribute('apiKey');
        if (s.getAttribute('termFont')) out.termFont = s.getAttribute('termFont');
        if (s.getAttribute('termFontSize')) out.termFontSize = Number(s.getAttribute('termFontSize'));
        return out;
      })(),
      prefs: (() => {
        const p = root.querySelector(':scope > prefs');
        if (!p) return null;
        const out = {};
        if (p.getAttribute('theme')) out.theme = p.getAttribute('theme');
        for (const k of ['greetHidden', 'aiCollapsed', 'sidebarCollapsed']) {
          const v = p.getAttribute(k);
          if (v === 'true' || v === 'false') out[k] = v === 'true';
        }
        return Object.keys(out).length ? out : null;
      })(),
    },
  };
}

async function importFromText(text) {
  let parsed;
  try { parsed = xmlToConfig(text); } catch (e) { toast(e.message, 'erro'); return; }
  const c = parsed.config;
  const counts = `${c.hosts.length} host(s), ${c.playbooks.length} playbook(s), ${c.profiles.length} perfil(is), ${(c.favorites || []).length} favorito(s), ${Object.keys(c.globals).length} variável(is) global(is)`;
  const secretsNote = parsed.includesSecrets ? '\n\nO arquivo contém senhas/chave da API — serão importadas.' : '';

  // Avisa quando o arquivo aponta um host JÁ EXISTENTE para outro endereço:
  // é assim que um arquivo de terceiro tentaria desviar uma conexão sua.
  const porNome = new Map(state.hosts.map((h) => [h.name, h]));
  const reaponta = [];
  for (const h of c.hosts || []) {
    const ex = porNome.get(String(h.name || '').trim());
    if (!ex) continue;
    const novoPorto = Number(h.port) || 22;
    if (ex.host !== h.host || (ex.port || 22) !== novoPorto || ex.username !== h.username) {
      reaponta.push(`• ${ex.name}: ${ex.username}@${ex.host}:${ex.port || 22}  →  ${h.username}@${h.host}:${novoPorto}`);
    }
  }
  if (reaponta.length && !confirm(
    `ATENÇÃO: este arquivo muda o ENDEREÇO de ${reaponta.length} host(s) que você já tem:\n\n${reaponta.join('\n')}\n\n` +
    'Se você não esperava isso, cancele — um arquivo de origem duvidosa pode estar tentando desviar sua conexão para outro servidor.\n' +
    'As senhas salvas NÃO serão levadas para o novo endereço, e a identidade do servidor será verificada de novo.\n\nContinuar mesmo assim?'
  )) return;

  if (!confirm(`Importar deste arquivo: ${counts}.\nItens com o mesmo nome serão atualizados; nada é apagado.${secretsNote}\n\nContinuar?`)) return;
  try {
    const r = await api('/api/import', { method: 'POST', body: c });
    await loadState();
    const p = (o) => `${o.added} novo(s), ${o.updated} atualizado(s)`;
    toast(`Importado — hosts: ${p(r.hosts)}; playbooks: ${p(r.playbooks)}; perfis: ${p(r.profiles)}${r.favorites ? '; favoritos: ' + p(r.favorites) : ''}.`);
    if (r.rebound && r.rebound.length) {
      toast(`${r.rebound.length} host(s) tiveram o endereço alterado — a senha salva foi descartada por segurança: ${r.rebound.join(' | ')}`, 'erro');
    }
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
  const checked = new Set(getSelectedHostIds()); // preserva seleção entre re-renderizações
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
      cb.checked = checked.has(h.id); // por padrão, nada marcado — o usuário escolhe
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
  try { localInfo = await api('/api/local-info'); renderHostSidebar(); renderGreeting(); } catch {}
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

// ----- hosts recentes (guardados no data.json via /api/prefs) -----
function getRecents() {
  const ids = prefList('recentHosts');
  const exist = new Set(state.hosts.map((h) => h.id));
  return ids.filter((id) => exist.has(id)); // remove os que já não existem
}
function saveRecents(ids) {
  prefSet('recentHosts', ids.slice(0, 30));
}
function addRecent(id) {
  const ids = getRecents().filter((x) => x !== id);
  ids.unshift(id);
  saveRecents(ids);
}
function removeRecent(id) {
  saveRecents(getRecents().filter((x) => x !== id));
}

// endereço legível do host (Telnet não tem usuário no login)
function hostAddrLabel(h) {
  if (h.protocol === 'telnet') return `telnet://${h.host}:${h.port}`;
  if (h.protocol === 'ftp') return `ftp://${h.username || 'anonymous'}@${h.host}:${h.port}`;
  if (h.protocol === 'vnc') return `vnc://${h.host}:${h.port}`;
  if (h.protocol === 'rdp') return `rdp://${h.username ? h.username + '@' : ''}${h.host}:${h.port}`;
  return `${h.username}@${h.host}:${h.port}`;
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
    const nameRow = el(info, 'div', 'hname');
    el(nameRow, 'span', null, h.name);
    if (h.protocol === 'telnet') el(nameRow, 'span', 'proto-badge', 'TELNET');
    else if (h.protocol === 'ftp') el(nameRow, 'span', 'proto-badge', 'FTP');
    else if (h.protocol === 'vnc') el(nameRow, 'span', 'proto-badge', 'VNC');
    else if (h.protocol === 'rdp') el(nameRow, 'span', 'proto-badge', 'RDP');
    el(info, 'div', 'haddr', hostAddrLabel(h));
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
      : 'Nenhum host cadastrado. Use a Conexão rápida (⚡) acima para conectar a um servidor avulso, ou cadastre na aba Hosts.');
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
  if (s && s.kind !== 'desk') { try { s.fitAddon.fit(); } catch {} }
}

function focusActive() {
  const sa = activeSession();
  if (sa && sa.kind === 'desk') return;
  // enquanto o usuário renomeia uma aba, o terminal não pode roubar o foco
  // (o campo de edição perderia o foco e a renomeação seria cancelada)
  if (renamingId !== null) return;
  const s = activeSession();
  if (s) setTimeout(() => { if (renamingId !== null) return; try { s.term.focus(); } catch {} }, 30);
}

// Re-mede a sessão e envia o tamanho atual ao servidor (corrige uma conexão que
// nasceu estreita por o xterm ainda não ter sido pintado quando conectou).
function sendResize(session) {
  if (!session || session.kind === 'desk') return;
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
  if (host.protocol === 'vnc' || host.protocol === 'rdp') {
    // RDP não depende mais do guacd: o IronRDP roda em WebAssembly no próprio
    // navegador, então abre igual ao VNC, sem nada instalado.
    createDeskSession({ hostId, hostName: host.name, protocol: host.protocol });
    return;
  }
  createSession({ hostId, hostName: host.name });
}

// Abre um terminal LOCAL (shell da própria máquina)
function openLocalSession() {
  if (!xtermReady()) return;
  localDismissed = false;
  createSession({ hostId: null, hostName: 'Meu computador', isLocal: true });
}

// Abre uma sessão para um host AVULSO (conexão rápida, não salvo). Não entra em
// "recentes" (o id é temporário); some quando o app fecha.
function openAdHocSession(hostId, name) {
  if (!xtermReady()) return;
  createSession({ hostId, hostName: name || 'Conexão rápida' });
}

// Modal de conexão rápida: conecta a um servidor avulso sem cadastrá-lo.
function openQuickConnectModal() {
  openModal('Conexão rápida', `
    <p class="hint">Conecte-se a um servidor avulso sem cadastrá-lo. A conexão é temporária (não fica salva), mas os comandos entram normalmente no <strong>Histórico</strong>.</p>
    <div class="grid2">
      <label>Protocolo
        <select id="qc_protocol">
          <option value="ssh">SSH (recomendado)</option>
          <option value="telnet">Telnet (equipamentos legados)</option>
        </select>
      </label>
      <label>Host / IP <input id="qc_host" required placeholder="10.0.0.5 ou srv.exemplo.com"></label>
      <label>Porta <input id="qc_port" type="number" min="1" max="65535" value="22"></label>
      <label>Usuário <input id="qc_user" placeholder="root"></label>
      <label>Rótulo da aba (opcional) <input id="qc_name" placeholder="ex.: switch-core"></label>
    </div>
    <p id="qc_telnetNote" class="hint warn-hint" hidden>⚠️ Telnet não é criptografado — a senha trafega em texto claro. O login é feito no próprio terminal do equipamento.</p>
    <fieldset id="qcAuthFs">
      <legend>Autenticação</legend>
      <div class="radios">
        <label><input type="radio" name="qcAuth" value="agent"> Agente SSH</label>
        <label><input type="radio" name="qcAuth" value="key"> Chave privada</label>
        <label><input type="radio" name="qcAuth" value="password"> Senha</label>
      </div>
      <div id="qcKeyFields" class="auth-fields" hidden>
        <label>Caminho da chave <input id="qc_keyPath" placeholder="~/.ssh/id_ed25519"></label>
        <label>Passphrase (opcional) <input id="qc_passphrase" type="password" autocomplete="new-password"></label>
      </div>
      <div id="qcPassFields" class="auth-fields" hidden>
        <label>Senha <input id="qc_password" type="password" autocomplete="new-password"></label>
      </div>
    </fieldset>
    <label class="check-inline"><input type="checkbox" id="qc_save"> Salvar este host para reusar depois</label>
  `);
  const submit = $('#modalForm button[type=submit]');
  submit.textContent = 'Conectar';
  const syncQc = () => {
    const t = (($$('input[name="qcAuth"]').find((r) => r.checked)) || {}).value || 'agent';
    $('#qcKeyFields').hidden = t !== 'key';
    $('#qcPassFields').hidden = t !== 'password';
  };
  $$('input[name="qcAuth"]').forEach((r) => { r.checked = r.value === 'agent'; r.addEventListener('change', syncQc); });
  syncQc();
  const syncQcProto = () => {
    const isTelnet = $('#qc_protocol').value === 'telnet';
    $('#qc_telnetNote').hidden = !isTelnet;
    $('#qcAuthFs').hidden = isTelnet;
    const p = $('#qc_port');
    if (p.value === '22' || p.value === '23' || !p.value) p.value = isTelnet ? 23 : 22;
  };
  $('#qc_protocol').addEventListener('change', syncQcProto);
  syncQcProto();
  setTimeout(() => { try { $('#qc_host').focus(); } catch {} }, 30);

  $('#modalForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const host = $('#qc_host').value.trim();
    const username = $('#qc_user').value.trim();
    const protocol = $('#qc_protocol').value;
    if (!host) { toast('Informe host/IP.', 'erro'); return; }
    if (!username && protocol === 'ssh') { toast('Informe o usuário.', 'erro'); return; }
    const type = (($$('input[name="qcAuth"]').find((r) => r.checked)) || {}).value || 'agent';
    const auth = { type };
    if (type === 'key') {
      auth.keyPath = $('#qc_keyPath').value.trim();
      if ($('#qc_passphrase').value) auth.passphrase = $('#qc_passphrase').value;
    } else if (type === 'password' && $('#qc_password').value) {
      auth.password = $('#qc_password').value;
    }
    const name = $('#qc_name').value.trim();
    const port = Number($('#qc_port').value) || (protocol === 'telnet' ? 23 : 22);
    const fallbackName = username ? `${username}@${host}` : host;
    submit.disabled = true;
    try {
      if ($('#qc_save').checked) {
        // salva como host permanente e abre uma sessão normal
        const created = await api('/api/hosts', { method: 'POST', body: { name: name || fallbackName, host, port, username, protocol, auth, vars: {} } });
        closeModal();
        await loadState();
        if (created && created.id) openSession(created.id);
        else toast('Host salvo. Selecione-o na lista para conectar.');
      } else {
        const r = await api('/api/quick-connect', { method: 'POST', body: { host, port, username, protocol, auth, name } });
        closeModal();
        openAdHocSession(r.hostId, r.name);
      }
    } catch (e) { toast(e.message, 'erro'); submit.disabled = false; }
  };
}

// Abre uma sessão de ÁREA DE TRABALHO (VNC/RDP) como mais uma aba do Terminal:
// mesma barra de abas, mesma lista de hosts. O conteúdo é um canvas em vez do
// xterm, então tudo que é específico de terminal é pulado (fit, favoritos,
// captura de histórico, painel de IA).
function createDeskSession({ hostId, hostName, protocol }) {
  const id = ++sessionSeq;
  const container = el($('#termContainers'), 'div', 'term-instance desk-instance');
  const session = { id, hostId, hostName, isLocal: false, kind: 'desk', protocol, container, status: 'conectando', desk: null };
  sessions.push(session);
  setActiveSession(id);
  const abrir = () => {
    if (!window.vcDesktop) { toast('Cliente de área de trabalho ainda carregando…', 'erro'); return; }
    const onEstado = ({ estado, erro }) => {
      if (estado === 'conectado') session.status = 'conectado';
      else session.status = 'encerrado';
      renderTermTabs();
      renderHostSidebar();
      if (erro) toast(`${hostName}: ${erro}`, 'erro');
    };
    try {
      session.desk = protocol === 'vnc'
        ? window.vcDesktop.conectarVnc({ hostId, senha: '', container, onEstado })
        : window.vcDesktop.conectarRdp({ hostId, container, onEstado });
    } catch (e) {
      session.status = 'encerrado';
      renderTermTabs();
      toast(e.message, 'erro');
    }
  };
  // espera o container ter tamanho real (o RDP pede a resolução na conexão)
  if (container.clientWidth > 20) abrir(); else setTimeout(abrir, 120);
  return session;
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
  const session = { id, hostId, hostName, isLocal: !!isLocal, kind: 'term', term, fitAddon, ws: null, container, status: 'conectando' };
  // estado de IA POR SESSÃO: cada aba tem seu assistente e agente independentes
  session.ai = { history: [], aiBusy: false, mode: 'assist', goal: '', agent: null, messagesEl: buildAiMessages(), feedEl: buildAgentFeed() };
  term.onData((d) => {
    if (session.ws && session.ws.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify({ t: 'i', d }));
    captureTyped(session, d);
  });
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
  // token do processo: o servidor exige no upgrade (ver server.js) para que uma
  // página de outra origem não consiga abrir um terminal nesta máquina
  const tk = encodeURIComponent((typeof window !== 'undefined' && window.VC_TOKEN) || '');
  const url = session.isLocal
    ? `${proto}://${location.host}/api/localterminal?cols=${cols}&rows=${rows}&token=${tk}`
    : `${proto}://${location.host}/api/terminal?hostId=${encodeURIComponent(session.hostId)}&cols=${cols}&rows=${rows}&token=${tk}`;
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
  // o teclado do RDP é capturado no document: só a aba ativa pode ouvir
  for (const outra of sessions) {
    if (outra.desk) { try { outra.desk.pausarTeclado(outra.id !== id); } catch {} }
  }
  if (s && s.kind !== 'desk') {
    termSelectedHost = s.hostId;
    setTimeout(() => { sendResize(s); focusActive(); }, 20);
  } else if (s) {
    termSelectedHost = s.hostId;
    setTimeout(() => { try { s.desk && s.desk.ajustar(); } catch {} }, 40);
  }
  renderTermTabs();
  renderHostSidebar();
  mountAiForActive(); // painel da direita reflete a IA (assistente + agente) da aba ativa
  updateTermLayout(); // favoritos e IA só valem para terminal: some ao entrar numa aba de área de trabalho
}

function closeSession(id) {
  const idx = sessions.findIndex((s) => s.id === id);
  if (idx < 0) return;
  const s = sessions[idx];
  if (s.desk) { try { s.desk.desconectar(); } catch {} s.desk = null; }
  // fechar a aba precisa PARAR o agente daquela sessão: sem isto ele seguia
  // rodando no servidor e o EventSource ficava aberto para sempre
  if (s.ai && s.ai.agent) {
    if (s.ai.agent.id) api(`/api/agent/${s.ai.agent.id}/stop`, { method: 'POST' }).catch(() => {});
    if (s.ai.agent.es) { try { s.ai.agent.es.close(); } catch {} }
    s.ai.agent = null;
  }
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

// Rótulo da aba: nome personalizado do usuário, senão o nome do host —
// com número quando há mais de uma aba do mesmo host (evita "Meu computador"
// repetido várias vezes sem distinção).
function tabLabel(s) {
  if (s.customName) return s.customName;
  const mesmos = sessions.filter((x) => !x.customName && x.hostName === s.hostName);
  if (mesmos.length < 2) return s.hostName;
  return `${s.hostName} ${mesmos.indexOf(s) + 1}`;
}

// Descrição completa para o tooltip da aba (ajuda a saber "quem é quem")
function tabTitle(s) {
  const parts = [tabLabel(s)];
  if (s.isLocal) parts.push('terminal local desta máquina');
  else {
    const h = state.hosts.find((x) => x.id === s.hostId);
    if (h) parts.push(hostAddrLabel(h));
    else parts.push('conexão rápida');
  }
  parts.push(`status: ${s.status}`);
  return parts.join(' · ') + '\nDuplo clique para renomear';
}

let renamingId = null;              // sessão com o nome em edição
let lastTabClick = { id: null, t: 0 }; // detecção própria de duplo clique

function renderTermTabs() {
  const bar = $('#termTabs');
  if (!bar) return;
  // não recria as abas enquanto o usuário digita o novo nome (perderia o foco)
  if (renamingId !== null && bar.querySelector('.tab-rename') === document.activeElement) return;
  bar.innerHTML = '';
  for (const s of sessions) {
    const tab = el(bar, 'div', 'term-tab' + (s.id === activeSessionId ? ' active' : ''));
    el(tab, 'span', 'tab-dot ' + s.status);

    if (s.id === renamingId) {
      buildRenameInput(tab, s);
    } else {
      tab.title = tabTitle(s);
      el(tab, 'span', 'tab-name', tabLabel(s));
      if (s.ai && s.ai.agent && s.ai.agent.status === 'running') {
        const ind = el(tab, 'span', 'tab-agent' + (s.ai.agent.needsApproval ? ' warn' : ''));
        ind.title = s.ai.agent.needsApproval ? 'Agente aguardando sua aprovação' : 'Agente de IA em execução';
      }
      const pen = el(tab, 'span', 'tab-edit', '✎');
      pen.title = 'Renomear esta aba';
      pen.addEventListener('click', (e) => { e.stopPropagation(); startTabRename(s.id); });
      const x = el(tab, 'span', 'tab-close', '×');
      x.title = 'Fechar conexão';
      x.addEventListener('click', (e) => { e.stopPropagation(); closeSession(s.id); });
      // Duplo clique detectado na mão: o 1º clique troca de aba e re-renderiza a
      // barra, destruindo o elemento — então o evento dblclick nativo nunca
      // dispararia. Comparando id + tempo, funciona mesmo com o re-render.
      tab.addEventListener('click', (e) => {
        if (e.target === x || e.target === pen) return;
        const agora = Date.now();
        if (lastTabClick.id === s.id && agora - lastTabClick.t < 450) {
          lastTabClick = { id: null, t: 0 };
          startTabRename(s.id);
          return;
        }
        lastTabClick = { id: s.id, t: agora };
        setActiveSession(s.id);
      });
    }
  }
  updateTabsArrows();
  scrollActiveTabIntoView();
}

function startTabRename(id) {
  renamingId = id;
  renderTermTabs();
  const inp = $('#termTabs .tab-rename');
  if (inp) { inp.focus(); inp.select(); }
}

// Campo de edição do nome da aba: Enter salva, Esc cancela, vazio volta ao host.
function buildRenameInput(tab, session) {
  const input = document.createElement('input');
  input.className = 'tab-rename';
  input.type = 'text';
  input.value = tabLabel(session);
  input.maxLength = 40;
  tab.appendChild(input);
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save) {
      const v = input.value.trim();
      session.customName = v && v !== session.hostName ? v : '';
    }
    renamingId = null;
    renderTermTabs();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  // blur logo após a criação (foco ainda se acomodando) não cancela a edição
  const criadoEm = Date.now();
  input.addEventListener('blur', () => {
    if (Date.now() - criadoEm < 300 && renamingId === session.id) {
      try { input.focus(); } catch {}
      return;
    }
    finish(true);
  });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('mousedown', (e) => e.stopPropagation());
}

// setas de rolagem: aparecem só quando as abas não cabem na barra
function updateTabsArrows() {
  const bar = $('#termTabs');
  const l = $('#tabsLeft');
  const r = $('#tabsRight');
  if (!bar || !l || !r) return;
  const overflow = bar.scrollWidth > bar.clientWidth + 2;
  l.hidden = !overflow;
  r.hidden = !overflow;
  if (overflow) {
    l.disabled = bar.scrollLeft <= 1;
    r.disabled = bar.scrollLeft + bar.clientWidth >= bar.scrollWidth - 1;
  }
}

// Mantém a aba ativa visível. Ajusta scrollLeft na mão (a suavização vem do
// scroll-behavior no CSS — scrollBy com behavior "smooth" nem sempre é aplicado).
function scrollActiveTabIntoView() {
  const bar = $('#termTabs');
  if (!bar) return;
  const active = bar.querySelector('.term-tab.active');
  if (!active || bar.scrollWidth <= bar.clientWidth) return;
  const left = active.offsetLeft;
  const right = left + active.offsetWidth;
  const margem = 12;
  if (left < bar.scrollLeft + margem) bar.scrollLeft = Math.max(0, left - margem);
  else if (right > bar.scrollLeft + bar.clientWidth - margem) bar.scrollLeft = right - bar.clientWidth + margem;
}

// Rola as abas para uma posição. Atribuição direta de scrollLeft de propósito:
// scrollBy/scroll-behavior "smooth" e animações por requestAnimationFrame não
// são aplicados de forma confiável em todo ambiente (com a aba em segundo plano
// o rAF nem dispara, e a rolagem simplesmente não aconteceria). Aqui o destino
// é sempre atingido.
function scrollTabsTo(target) {
  const bar = $('#termTabs');
  if (!bar) return;
  const max = Math.max(0, bar.scrollWidth - bar.clientWidth);
  bar.scrollLeft = Math.max(0, Math.min(max, Math.round(target)));
  updateTabsArrows();
}

function initTermTabsScroll() {
  const bar = $('#termTabs');
  const l = $('#tabsLeft');
  const r = $('#tabsRight');
  if (!bar || !l || !r) return;
  const step = () => Math.max(160, Math.round(bar.clientWidth * 0.7));
  l.addEventListener('click', () => scrollTabsTo(bar.scrollLeft - step()));
  r.addEventListener('click', () => scrollTabsTo(bar.scrollLeft + step()));
  bar.addEventListener('scroll', updateTabsArrows);
  // roda do mouse sobre as abas rola na horizontal
  bar.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    bar.scrollLeft += e.deltaY;
  }, { passive: false });
  window.addEventListener('resize', updateTabsArrows);
}

function termSnapshot() {
  const s = activeSession();
  if (!s || s.kind === 'desk') return '';
  const buf = s.term.buffer.active;
  const lines = [];
  const start = Math.max(0, buf.length - 45);
  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function insertCommand(cmd, run, opts = {}) {
  const s = activeSession();
  if (!s || !s.ws || s.ws.readyState !== WebSocket.OPEN) {
    toast('Abra uma conexão antes de inserir o comando.', 'erro');
    return;
  }
  s.ws.send(JSON.stringify({ t: 'i', d: cmd + (run ? '\n' : '') }));
  // rodou direto → registra; inserido sem rodar, a captura do Enter registra depois
  if (run) logHistory(s, cmd, opts.source || 'ai', opts.origin || 'assistant');
  focusActive();
}

// ---------- captura do que é DIGITADO no terminal (selo Humano) ----------
// Ao teclar Enter, lê a LINHA JÁ RENDERIZADA do xterm (reflete auto-complete e
// histórico do shell) e remove o prompt. Como senhas não são ecoadas na tela,
// elas não aparecem aqui — a captura é por segurança baseada na tela, não nas teclas.
function captureTyped(session, d) {
  for (let i = 0; i < d.length; i++) {
    const ch = d[i];
    if (ch === '\r' || ch === '\n') finalizeTyped(session);
  }
}

function finalizeTyped(session) {
  if (!session || session.status !== 'conectado') return;
  let cmd = '';
  try { cmd = readCommandLine(session.term); } catch {}
  cmd = (cmd || '').trim();
  if (!cmd) return;
  logHistory(session, cmd, 'human', 'terminal');
}

const PROMPT_TERMS = ['❯ ', '➜ ', '$ ', '# ', '% '];

// Lê o comando na posição do cursor: sobe até a linha do prompt (juntando as
// continuações com wrap) e remove o prompt. Não depende de isWrapped — procura o
// terminador do prompt nas últimas linhas, o que é mais robusto na prática.
function readCommandLine(term) {
  const buf = term.buffer.active;
  const cursorRow = buf.baseY + buf.cursorY;
  const parts = [];
  for (let r = cursorRow; r >= 0 && r >= cursorRow - 5; r--) {
    const ln = buf.getLine(r);
    if (!ln) break;
    const text = ln.translateToString(false);
    parts.unshift(text);
    if (PROMPT_TERMS.some((t) => text.includes(t))) {
      return stripPrompt(parts.join('').replace(/\s+$/, ''));
    }
  }
  return ''; // sem prompt reconhecível → não registra (evita capturar dentro de vim/top)
}

// Remove o prompt do shell, pegando o que vem após o último terminador comum.
function stripPrompt(line) {
  let cut = -1;
  for (const t of PROMPT_TERMS) {
    const i = line.lastIndexOf(t);
    if (i >= 0 && i + t.length > cut) cut = i + t.length;
  }
  return cut >= 0 ? line.slice(cut).trim() : '';
}

// Envia uma entrada ao histórico; o servidor resolve máquina/IP/usuário.
function logHistory(session, command, source, origin) {
  if (!session || !command) return;
  const body = { command, source, origin };
  if (session.isLocal) body.local = true;
  else if (session.hostId) body.hostId = session.hostId;
  else return; // sem contexto de host, não registra
  api('/api/history', { method: 'POST', body }).catch(() => {});
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
// (o agente roda em host remoto via SSH ou na própria máquina, na aba local)
// numa aba de área de trabalho não há terminal para a IA assistir
function ehDesk(s) { return !!(s && s.kind === 'desk'); }

function updateAgentControls(s) {
  const start = $('#agentStart'), auto = $('#agentAuto'), stop = $('#agentStop'), note = $('#agentLocalNote');
  const agent = s && s.ai && s.ai.agent;
  const running = !!(agent && agent.status === 'running');
  const isLocal = !!(s && s.isLocal);
  const canAgent = !!(s && !ehDesk(s) && (isLocal || s.hostId));
  if (start) { start.hidden = running; start.disabled = !canAgent; }
  if (auto) { auto.hidden = running; auto.disabled = !canAgent; }
  if (stop) stop.hidden = !running;
  // na aba local a nota vira um aviso: os comandos rodam NESTA máquina
  if (note) note.hidden = !isLocal;
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
// Abaixo desta largura os painéis viram gavetas sobrepostas (ver style.css).
// Declarado ANTES de quem usa: como `const`, seria erro de zona morta lá em
// cima — e o try/catch engoliria o erro sem ninguém perceber.
const LARGURA_ESTREITA = 1000;
function ehEstreito() { return window.innerWidth <= LARGURA_ESTREITA; }

let aiCollapsed = false;      // usuário recolheu o painel de IA (lembrado)
let sidebarCollapsed = false; // usuário recolheu a barra de hosts (lembrado)
try {
  aiCollapsed = prefBool('aiCollapsed');
  sidebarCollapsed = prefBool('sidebarCollapsed');
  // Em janela estreita os painéis viram gavetas sobrepostas: começam fechados
  // para o terminal nascer com a tela toda. Não grava a preferência — ao voltar
  // para uma janela grande, a escolha do usuário continua valendo.
  if (ehEstreito()) { aiCollapsed = true; sidebarCollapsed = true; }
} catch {}

// aplica sidebar/painel de IA recolhidos ou não — devolve espaço ao terminal

// Ao ENCOLHER a janela, painéis que já estavam abertos viravam duas gavetas
// sobre o terminal, deixando só uma fresta no meio. Ao cruzar para o modo
// estreito, fecha as gavetas; e nesse modo nunca deixa as duas abertas.
let estavaEstreito = null;
// As gavetas começam exatamente onde o terminal começa — assim nunca cobrem a
// saudação nem a barra de botões (incluindo os que as abrem e fecham). Medido
// do topo da grade até o topo do terminal, então vale com a saudação visível
// ou oculta, sem número fixo.
function medirTopoDoTerminal() {
  const grade = document.querySelector('.term-grid');
  const painel = document.querySelector('.term-pane');
  if (!grade || !painel) return;
  const desloc = Math.round(painel.getBoundingClientRect().top - grade.getBoundingClientRect().top);
  document.documentElement.style.setProperty('--altura-topbar', Math.max(0, desloc) + 'px');
}

function ajustaModoEstreito() {
  medirTopoDoTerminal();
  const agora = ehEstreito();
  if (agora && estavaEstreito === false) {
    sidebarCollapsed = true;
    aiCollapsed = true;
    updateTermLayout();
  } else if (agora && !sidebarCollapsed && !aiCollapsed) {
    aiCollapsed = true; // as duas abertas não cabem
    updateTermLayout();
  }
  estavaEstreito = agora;
}

function updateTermLayout() {
  // o botão de favoritos insere comando no terminal: some na área de trabalho
  const fav = document.querySelector('.fav-wrap');
  if (fav) fav.hidden = ehDesk(activeSession());
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
  const desk = ehDesk(activeSession());
  if (bAi) { bAi.hidden = !aiEnabled || desk; bAi.classList.toggle('active', showAi && !desk); }
  if (desk && pane) pane.hidden = true; // área de trabalho não usa o painel de IA
  const bSb = $('#toggleSidebar');
  if (bSb) bSb.classList.toggle('active', !sidebarCollapsed);
  // o terminal muda de largura — reajusta o xterm
  if ($('#tab-terminal').classList.contains('active')) setTimeout(fitActive, 40);
  setTimeout(medirTopoDoTerminal, 60); // gavetas acompanham o novo topo
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
  if (!s.isLocal && !s.hostId) { toast('Abra um host remoto ou o terminal "Meu computador" para usar o agente.', 'erro'); return; }
  const goal = $('#agentGoal').value.trim();
  if (!goal) { toast('Descreva a tarefa para o agente.', 'erro'); return; }
  const alvo = s.isLocal ? 'nesta máquina (seu computador)' : 'no servidor';
  if (auto && !confirm(
    `Modo AUTOMÁTICO: a IA vai executar sozinha todos os comandos necessários para cumprir a tarefa, sem pedir confirmação — inclusive comandos que alteram ou apagam dados ${alvo}. ` +
    'Você acompanha ao vivo e pode clicar em "Parar" a qualquer momento.\n\nDeseja continuar?'
  )) return;
  const ai = s.ai;
  ai.goal = goal;
  ai.feedEl.replaceChildren();
  ai.agent = { id: null, es: null, cmds: new Map(), text: null, auto: !!auto, status: 'starting', needsApproval: false };
  updateAgentControls(s);
  api('/api/agent/start', {
    method: 'POST',
    body: s.isLocal
      ? { local: true, goal, confirmDangerous: !auto }
      : { hostId: s.hostId, goal, confirmDangerous: !auto },
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
  // nomes legíveis quando o servidor manda a lista descrita; senão, os ids
  const lista = (s.modelList && s.modelList.length)
    ? s.modelList
    : (s.models || []).map((id) => ({ id, label: id }));
  lista.forEach((m) => {
    const o = el(sel, 'option', null, m.hint ? `${m.label} — ${m.hint}` : m.label);
    o.value = m.id;
  });
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
  prefSet('theme', t);
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
  dismissed = prefStr('updateDismissed', '');
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
    prefSet('updateDismissed', d.latest);
  });
  bar.hidden = false;
}

// tela de carregamento: garante um tempo mínimo em tela para a animação ser
// vista, mesmo quando os dados chegam instantaneamente
const SPLASH_MIN_MS = 2600;
const splashStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
let splashDone = false;
function hideSplash() {
  if (splashDone) return;
  splashDone = true;
  const sp = document.getElementById('splash');
  if (!sp) return;
  const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : 0) - splashStart;
  const wait = Math.max(0, SPLASH_MIN_MS - elapsed);
  setTimeout(() => {
    sp.classList.add('hide');
    setTimeout(() => { try { sp.remove(); } catch {} }, 650); // após o fade
  }, wait);
}
// rede de segurança: se algo travar o loadState, não deixa a splash presa
setTimeout(hideSplash, 6000);

function init() {
  initTabs();
  initTheme();
  $('#btnNewHost').addEventListener('click', () => openHostModal(null));
  $('#btnNewPlaybook').addEventListener('click', () => openPlaybookModal(null));
  $('#btnPlaybookAi').addEventListener('click', openPlaybookAiModal);
  initHistoryControls();
  initFavorites();
  initFavoritesTab();
  initGreeting();
  initTermTabsScroll();
  initFiles();
  ajustaModoEstreito();
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
  $('#sidebarQuickConnect').addEventListener('click', openQuickConnectModal);
  $('#toggleSidebar').addEventListener('click', () => {
    // em janela estreita as duas gavetas se sobrepõem: abrir uma fecha a outra
    if (ehEstreito() && sidebarCollapsed) aiCollapsed = true;
    sidebarCollapsed = !sidebarCollapsed;
    prefSet('sidebarCollapsed', sidebarCollapsed);
    updateTermLayout();
  });
  $('#toggleAiPane').addEventListener('click', () => {
    if (ehEstreito() && aiCollapsed) sidebarCollapsed = true;
    aiCollapsed = !aiCollapsed;
    prefSet('aiCollapsed', aiCollapsed);
    updateTermLayout();
  });
  window.addEventListener('resize', () => {
    ajustaModoEstreito();
    if ($('#tab-terminal').classList.contains('active')) fitActive();
  });
  // Observa o painel do terminal: qualquer mudança de tamanho — janela, painéis
  // recolhidos, saudação oculta, troca de aba — reajusta o xterm. Antes isso
  // dependia só do evento de resize da janela, e o terminal ficava com o número
  // de colunas/linhas antigo quando o layout mudava por outro motivo.
  const painelTerm = document.querySelector('.term-pane');
  if (painelTerm && typeof ResizeObserver === 'function') {
    let pendente = null;
    const ro = new ResizeObserver(() => {
      clearTimeout(pendente);
      pendente = setTimeout(() => { if ($('#tab-terminal').classList.contains('active')) fitActive(); }, 80);
    });
    ro.observe(painelTerm);
  }
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
  loadState()
    .catch((e) => toast(e.message, 'erro'))
    .finally(hideSplash); // some a tela de carregamento quando os dados chegam
  refreshAiVisibility(); // esconde recursos de IA se não houver chave configurada
  checkForUpdate(); // avisa (sem instalar) se houver versão nova no GitHub
  loadLocalInfo(); // login/SO da máquina para o botão "Meu computador"
  // se o Terminal for a aba inicial, prepara o xterm já na carga
  if ($('#tab-terminal').classList.contains('active')) onTerminalTabShown();
}

init();
