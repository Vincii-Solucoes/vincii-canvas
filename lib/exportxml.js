'use strict';

// Serializa toda a configuração do app em XML. Por padrão, segredos (senhas,
// passphrases, chave da API) NÃO são incluídos — apenas marcados com
// hasPassword/hasApiKey. Com opts.includeSecrets = true, os segredos vão em
// texto claro (para backup completo pelo próprio usuário) — arquivo sensível.

function cleanChars(s) {
  // remove caracteres de controle inválidos em XML 1.0
  return String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function escText(s) {
  return cleanChars(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s) {
  return escText(s).replace(/"/g, '&quot;');
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
  const d = data || {};
  const secrets = !!opts.includeSecrets;
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    secrets
      ? '<!-- Vincii Canvas — backup de configuração. ATENÇÃO: contém SENHAS, passphrases e a CHAVE DA API em TEXTO CLARO. Guarde este arquivo com segurança. -->'
      : '<!-- Vincii Canvas — backup de configuração. Segredos (senhas, passphrases, chave da API) NÃO são exportados. -->'
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
    lines.push(`    <host${attrs({ name: h.name, host: h.host, port: h.port, username: h.username, group: h.group, icon: h.icon, color: h.color, fingerprint: h.fingerprint })}>`);
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

  // Configurações da IA
  const s = d.settings || {};
  const settingsAttrs = { model: s.model };
  if (secrets) settingsAttrs.apiKey = s.apiKey;
  else settingsAttrs.hasApiKey = s.apiKey ? 'true' : undefined;
  lines.push(`  <settings${attrs(settingsAttrs)}/>`);

  lines.push('</sshCommander>');
  return lines.join('\n') + '\n';
}

module.exports = { buildXml };
