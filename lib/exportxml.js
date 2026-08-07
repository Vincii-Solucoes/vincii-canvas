'use strict';

// Serializa toda a configuração do app em XML. Por padrão, segredos (senhas,
// passphrases, chave da API) NÃO são incluídos — apenas marcados com
// hasPassword/hasApiKey. Com opts.includeSecrets = true, os segredos vão em
// texto claro (para backup completo pelo próprio usuário) — arquivo sensível.

// Quantos caracteres foram removidos na geração atual. O usuário precisa saber:
// um valor com byte de controle sai do arquivo com aparência normal e conteúdo
// diferente, e restaurar na MESMA máquina sobrescreve o valor bom pelo mutilado.
// Remover está certo (XML 1.0 não carrega esses bytes nem como referência
// numérica, e um só inutilizaria o arquivo inteiro); o que faltava era avisar.
let removidos = 0;

function cleanChars(s) {
  // Remove o que não é caractere XML 1.0 válido (§2.2). Além dos controles,
  // U+FFFE e U+FFFF: um único desses em qualquer campo não corrompe só o
  // campo — torna o ARQUIVO INTEIRO irrecuperável, porque nenhum parser aceita
  // o documento. Verificado com o expat: "not well-formed (invalid token)".
  const texto = String(s);
  const limpo = texto.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, '');
  if (limpo.length !== texto.length) removidos += texto.length - limpo.length;
  return limpo;
}

function escText(s) {
  return cleanChars(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s) {
  // TAB, LF e CR precisam de referência numérica DENTRO de atributo: a
  // normalização de valor de atributo (XML 1.0 §3.3.3) troca os três por espaço
  // na leitura, em qualquer parser. Uma senha colada de planilha, com TAB,
  // voltava mutilada da restauração — e, pior, sobrescrevia a senha boa,
  // porque a preservação de segredo só age quando o arquivo não traz nenhum.
  return escText(s)
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;');
}

function attrs(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => ` ${k}="${escAttr(v)}"`)
    .join('');
}

function varsXml(vars, indent) {
  const pad = ' '.repeat(indent);
  return Object.entries(vars || {})
    .map(([name, value]) => `${pad}<var name="${escAttr(name)}">${escText(value)}</var>`)
    .join('\n');
}

function buildXml(data, opts = {}) {
  removidos = 0;
  const d = data || {};
  const secrets = !!opts.includeSecrets;
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    secrets
      ? '<!-- Vincii Canvas — backup de configuração. ATENÇÃO: contém SENHAS, passphrases e a CHAVE DA API em TEXTO CLARO. Guarde este arquivo com segurança. -->'
      : '<!-- Vincii Canvas — backup de configuração. Senhas, passphrases e chave da API NÃO são exportadas. Atenção: variáveis, comandos de playbook e favoritos vão em texto claro — revise antes de compartilhar. -->'
  );
  lines.push(`<sshCommander version="1"${opts.exportedAt ? ` exportedAt="${escAttr(opts.exportedAt)}"` : ''} includesSecrets="${secrets ? 'true' : 'false'}">`);

  // Variáveis globais
  lines.push('  <globals>');
  const gx = varsXml(d.globals, 4);
  if (gx) lines.push(gx);
  lines.push('  </globals>');

  // Perfis (segmentos)
  lines.push('  <profiles>');
  for (const p of d.profiles || []) {
    lines.push(`    <profile${attrs({ name: p.name })}>`);
    const px = varsXml(p.vars, 6);
    if (px) lines.push(px);
    lines.push('    </profile>');
  }
  lines.push('  </profiles>');

  // Hosts (sem segredos)
  lines.push('  <hosts>');
  for (const h of d.hosts || []) {
    const auth = h.auth || {};
    // protocol e ftps precisam ir no arquivo: sem eles, um host Telnet ou FTP
    // volta como SSH na restauração (a porta certa, o protocolo errado).
    // rdpDomain é digitado pelo usuário e o CredSSP depende dele: sem ele no
    // arquivo, restaurar num ambiente com Active Directory produz um cadastro
    // que PARECE completo e não autentica. Só faz sentido no RDP.
    lines.push(`    <host${attrs({ name: h.name, host: h.host, port: h.port, username: h.username, protocol: h.protocol || 'ssh', ftps: h.protocol === 'ftp' ? (h.ftps || 'auto') : undefined, rdpDomain: h.protocol === 'rdp' ? h.rdpDomain : undefined,
      url: h.protocol === 'web' ? h.url : undefined, group: h.group, icon: h.icon, color: h.color })}>`);
    const authAttrs = { type: auth.type || 'agent', keyPath: auth.keyPath };
    if (secrets) {
      authAttrs.password = auth.password;
      authAttrs.passphrase = auth.passphrase;
    } else {
      authAttrs.hasPassword = auth.password ? 'true' : undefined;
      authAttrs.hasPassphrase = auth.passphrase ? 'true' : undefined;
    }
    lines.push(`      <auth${attrs(authAttrs)}/>`);
    const hx = varsXml(h.vars, 8);
    if (Object.keys(h.vars || {}).length) {
      lines.push('      <vars>');
      lines.push(hx);
      lines.push('      </vars>');
    }
    lines.push('    </host>');
  }
  lines.push('  </hosts>');

  // Playbooks
  lines.push('  <playbooks>');
  for (const pb of d.playbooks || []) {
    lines.push(`    <playbook${attrs({ name: pb.name, description: pb.description })}>`);
    for (const cmd of pb.commands || []) {
      lines.push(`      <command>${escText(cmd)}</command>`);
    }
    lines.push('    </playbook>');
  }
  lines.push('  </playbooks>');

  // Comandos favoritos (globais ou presos a um host). O host é referenciado
  // pelo NOME, não pelo id — ids mudam ao importar em outra instalação.
  // Só o nome não basta: o próprio import assume que hosts homônimos são
  // normais (um "Firewall" por filial) e chega a criar um segundo com o mesmo
  // nome. Com a referência completa, o favorito da filial B não reaparece na A.
  const porId = new Map((d.hosts || []).map((h) => [h.id, h]));
  lines.push('  <favorites>');
  for (const f of d.favorites || []) {
    const alvo = f.hostId ? porId.get(f.hostId) : undefined;
    if (f.hostId && !alvo) continue; // favorito órfão: host já não existe
    lines.push(`    <favorite${attrs({ label: f.label, host: alvo && alvo.name,
      hostAddr: alvo && alvo.host, hostPort: alvo && alvo.port, hostUser: alvo && alvo.username })}>${escText(f.command)}</favorite>`);
  }
  lines.push('  </favorites>');

  // Configurações (IA + terminal)
  const s = d.settings || {};
  const settingsAttrs = { model: s.model, termFont: s.termFont, termFontSize: s.termFontSize };
  if (secrets) settingsAttrs.apiKey = s.apiKey;
  else settingsAttrs.hasApiKey = s.apiKey ? 'true' : undefined;
  lines.push(`  <settings${attrs(settingsAttrs)}/>`);

  // Preferências da interface (tema, painéis, saudação). Hosts recentes ficam
  // de fora de propósito: são ids desta instalação e não valem em outra.
  const ui = (s.ui && typeof s.ui === 'object') ? s.ui : {};
  const uiAttrs = {
    theme: ui.theme,
    greetHidden: ui.greetHidden === true ? 'true' : (ui.greetHidden === false ? 'false' : undefined),
    aiCollapsed: ui.aiCollapsed === true ? 'true' : (ui.aiCollapsed === false ? 'false' : undefined),
    sidebarCollapsed: ui.sidebarCollapsed === true ? 'true' : (ui.sidebarCollapsed === false ? 'false' : undefined),
  };
  if (Object.values(uiAttrs).some((v) => v !== undefined)) lines.push(`  <prefs${attrs(uiAttrs)}/>`);

  lines.push('</sshCommander>');
  const xml = lines.join('\n') + '\n';
  // Quem chama decide o que fazer com o número; a rota o devolve num cabeçalho.
  buildXml.ultimosRemovidos = removidos;
  return xml;
}

module.exports = { buildXml };
