'use strict';

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;
const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;

function builtinVars(host) {
  return {
    'host.name': host.name,
    'host.host': host.host,
    'host.port': String(host.port || 22),
    'host.user': host.username,
  };
}

// Precedência (da menor para a maior): globais < perfil < host < sobrescritas < embutidas host.*
function mergeVars(globals, profile, host, overrides) {
  return {
    ...(globals || {}),
    ...((profile && profile.vars) || {}),
    ...(host.vars || {}),
    ...(overrides || {}),
    ...builtinVars(host),
  };
}

function resolveText(text, vars) {
  const missing = new Set();
  const out = String(text).replace(VAR_RE, (raw, name) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
    missing.add(name);
    return raw;
  });
  return { text: out, missing: [...missing] };
}

// Linhas vazias e iniciadas com # não são executadas
function parseCommands(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map((l) => String(l).replace(/\r$/, '').trim())
    .filter((l) => l && !l.startsWith('#'));
}

// ---------- expansão de listas e ranges (@cada) ----------
// Sintaxe: @cada VLAN em {{VLANS}}: comando com {{VLAN}}
//          @cada PORTA em 1-24: comando com {{PORTA}}
// A lista aceita itens separados por vírgula; itens "A-B" numéricos viram um range inclusivo.
// O parse é manual (sem regex sobre a linha inteira) para custo linear em qualquer entrada.
const EACH_PREFIX_RE = /^@(?:cada|each)\s+([A-Za-z_][A-Za-z0-9_.]*)\s+(?:em|in)\s+/i;
const EACH_START_RE = /^@(?:cada|each)\b/i;

const MAX_LIST_ITEMS = 4094; // cobre a faixa completa de VLANs (1-4094)
const MAX_TOTAL_COMMANDS = 6000;

// Separa "spec: comando" no primeiro ':' seguido de espaço — assim itens como "08:00"
// no spec não quebram o parse; sem nenhum ':' com espaço, usa o primeiro ':'.
function parseEachLine(raw) {
  const m = raw.match(EACH_PREFIX_RE);
  if (!m) return null;
  const rest = raw.slice(m[0].length);
  let colon = -1;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === ':' && (rest[i + 1] === ' ' || rest[i + 1] === '\t')) {
      colon = i;
      break;
    }
  }
  if (colon < 0) colon = rest.indexOf(':');
  if (colon < 0) return null;
  const spec = rest.slice(0, colon).trim();
  const command = rest.slice(colon + 1).trim();
  if (!spec || !command) return null;
  return { loopVar: m[1], spec, command };
}

function parseListSpec(spec) {
  const items = [];
  for (const tokRaw of String(spec).split(',')) {
    const tok = tokRaw.trim();
    if (!tok) continue;
    const m = tok.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      // acima de 2^53 a soma em ponto flutuante deixa de avançar e o laço não terminaria
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) {
        throw new RangeError(`números grandes demais no range "${tok}"`);
      }
      if (Math.abs(b - a) + 1 > MAX_LIST_ITEMS) {
        throw new RangeError(`o range ${a}-${b} excede o limite de ${MAX_LIST_ITEMS} itens`);
      }
      const step = a <= b ? 1 : -1;
      for (let v = a; step > 0 ? v <= b : v >= b; v += step) items.push(String(v));
    } else {
      items.push(tok);
    }
    if (items.length > MAX_LIST_ITEMS) {
      throw new RangeError(`a lista excede o limite de ${MAX_LIST_ITEMS} itens`);
    }
  }
  return items;
}

// Expande linhas @cada e resolve {{variáveis}} de todas as linhas.
// Retorna [{ raw, resolved, missing }] — linhas @cada geram um item por valor da lista.
function expandAndResolve(commands, vars) {
  const items = [];
  const pushItem = (item) => {
    items.push(item);
    if (items.length > MAX_TOTAL_COMMANDS) {
      throw new Error(`O playbook gerou mais de ${MAX_TOTAL_COMMANDS} comandos após a expansão — reduza os ranges.`);
    }
  };
  for (const raw of commands) {
    const each = parseEachLine(raw);
    if (!each) {
      if (EACH_START_RE.test(raw)) {
        throw new Error(`Linha "@cada" malformada — use: @cada VAR em LISTA: comando. Linha: ${raw}`);
      }
      const r = resolveText(raw, vars);
      pushItem({ raw, resolved: r.text, missing: r.missing });
      continue;
    }
    const spec = resolveText(each.spec, vars);
    if (spec.missing.length) {
      pushItem({ raw, resolved: raw, missing: spec.missing });
      continue;
    }
    let values;
    try {
      values = parseListSpec(spec.text);
    } catch (err) {
      throw new Error(`Linha "@cada" inválida (${err.message}): ${raw}`);
    }
    for (const value of values) {
      // dentro da linha expandida, a variável do laço vence qualquer outra de mesmo nome
      const r = resolveText(each.command, { ...vars, [each.loopVar]: value });
      pushItem({ raw, resolved: r.text, missing: r.missing });
    }
  }
  return items;
}

module.exports = { mergeVars, resolveText, parseCommands, expandAndResolve, parseListSpec, VAR_NAME_RE };
