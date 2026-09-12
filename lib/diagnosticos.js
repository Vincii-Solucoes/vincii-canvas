'use strict';

// As tarefas de diagnóstico por sonda (Ping e MTU) e o registro delas.
//
// Uma tarefa nasce por POST, roda em segundo plano em todas as sondas
// escolhidas e a tela acompanha por GET (o mesmo desenho do TCP ping e do MTR:
// começar/detalhe, sem SSE). Cada sonda tem o próprio estado — "conectando",
// "rodando", "ok", "erro" — para a tela mostrar o roteador respondendo enquanto
// a OLT ainda autentica.

const sondas = require('./sondas');
const pingtool = require('./pingtool');
const mtu = require('./mtu');

const tarefas = new Map();
const MAX_TAREFAS = 30;
const TTL_MS = 30 * 60 * 1000;
const MAX_SONDAS = 12;
const MAX_PACOTES = 100;

let seq = 0;
function novaTarefa(tipo, alvo, listaDeSondas) {
  // as mais antigas saem quando o registro enche ou vencem
  const agora = Date.now();
  for (const [id, t] of tarefas) {
    if (agora - t.criadaEm > TTL_MS || tarefas.size >= MAX_TAREFAS) tarefas.delete(id);
  }
  seq += 1;
  const t = {
    id: `${tipo}-${agora.toString(36)}-${seq}`,
    tipo, alvo, criadaEm: agora, concluida: false,
    sondas: listaDeSondas.map((s) => ({ id: s.id, rotulo: s.rotulo, estado: 'aguardando', plataforma: null, resultado: null, erro: null })),
  };
  tarefas.set(t.id, t);
  return t;
}

function detalhe(id) {
  const t = tarefas.get(String(id || ''));
  if (!t) return null;
  return { id: t.id, tipo: t.tipo, alvo: t.alvo, concluida: t.concluida, criadaEm: t.criadaEm, sondas: t.sondas };
}

// Resolve os ids vindos da tela ('local' ou id de host) para as sondas de fato.
function resolverSondas(ids, acharHost) {
  const out = [];
  for (const id of (Array.isArray(ids) ? ids : []).slice(0, MAX_SONDAS)) {
    if (id === 'local') { out.push({ id: 'local', tipo: 'local', rotulo: 'Esta máquina' }); continue; }
    const host = acharHost(String(id));
    if (!host) continue;
    if (host.protocol && host.protocol !== 'ssh') continue;
    out.push({ id: host.id, tipo: 'host', rotulo: host.name || host.host, host });
  }
  return out;
}

const aplicar = (t, i, mudanca) => { Object.assign(t.sondas[i], mudanca); };

// ---------- Ping ----------

function iniciarPing({ alvo, ids, pacotes, intervaloMs, tamanho }, { acharHost, onSaveFingerprint }) {
  const alvoLimpo = String(alvo || '').trim();
  if (!pingtool.validarAlvo(alvoLimpo)) throw new Error('Informe um IP ou nome de host válido.');
  const lista = resolverSondas(ids, acharHost);
  if (!lista.length) throw new Error('Escolha pelo menos uma sonda (esta máquina ou um host SSH).');
  const opts = {
    pacotes: Math.min(MAX_PACOTES, Math.max(1, Math.round(Number(pacotes)) || 10)),
    intervaloMs: Math.min(5000, Math.max(200, Math.round(Number(intervaloMs)) || 500)),
    tamanho: Math.min(1472, Math.max(8, Math.round(Number(tamanho)) || 56)),
  };
  const t = novaTarefa('ping', alvoLimpo, lista);
  const timeoutSec = Math.ceil((opts.pacotes * (opts.intervaloMs + 2000)) / 1000) + 15;
  sondas.emTodas(lista, async (aberta) => {
    const { saida } = await aberta.exec((plataforma) => pingtool.comandoPing(alvoLimpo, opts, plataforma), { timeoutSec });
    const r = pingtool.parsePing(saida);
    const est = pingtool.estatisticas(r.rtts);
    return { ...r, estatisticas: est, opcoes: opts, saida: saida.slice(0, 20000) };
  }, { aoMudar: (i, m) => aplicar(t, i, m), onSaveFingerprint })
    .then(() => { t.concluida = true; })
    .catch(() => { t.concluida = true; });
  return t;
}

// ---------- MTU ----------

function iniciarMtu({ alvo, ids, ipv6 }, { acharHost, onSaveFingerprint }) {
  const alvoLimpo = String(alvo || '').trim();
  if (!pingtool.validarAlvo(alvoLimpo)) throw new Error('Informe um IP ou nome de host válido.');
  const lista = resolverSondas(ids, acharHost);
  if (!lista.length) throw new Error('Escolha pelo menos uma sonda (esta máquina ou um host SSH).');
  const v6 = ipv6 === true || alvoLimpo.includes(':');
  const t = novaTarefa('mtu', alvoLimpo, lista);
  sondas.emTodas(lista, async (aberta) => {
    if (aberta.plataforma === 'busybox') throw new Error('O ping do BusyBox não tem a opção "não fragmentar" — use outra sonda.');
    // A sonda que a busca binária chama: um ping DF de um tamanho, classificado.
    // O "mtu=1500" que o Linux/macOS às vezes já dizem na recusa é guardado
    // como dica para o relato — a busca em si segue pela classificação.
    const sonda = async (payload) => {
      const { saida, codigo } = await aberta.exec((plataforma) => mtu.comandoSonda(alvoLimpo, payload, plataforma), { timeoutSec: 20 });
      const resultado = mtu.classificarResposta(saida, codigo);
      const mtuSugerido = mtu.extrairMtuSugerido(saida);
      return mtuSugerido ? { resultado, mtuSugerido } : resultado;
    };
    const r = await mtu.buscar(sonda, { ipv6: v6 });
    return { ...r, ipv6: v6, explicacao: mtu.explicar(r) };
  }, { aoMudar: (i, m) => aplicar(t, i, m), onSaveFingerprint })
    .then(() => { t.concluida = true; })
    .catch(() => { t.concluida = true; });
  return t;
}

module.exports = { iniciarPing, iniciarMtu, detalhe, resolverSondas, MAX_SONDAS, MAX_PACOTES };
