'use strict';

// Registro em memória de hosts "avulsos" para conexão rápida no terminal — não
// são persistidos em data.json. Vivem enquanto o app está aberto (com TTL e
// limite de quantidade), o suficiente para durar a sessão de terminal e para o
// log de histórico resolver a máquina/IP/usuário do host avulso.

const crypto = require('crypto');

const TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX = 100;
const hosts = new Map(); // id -> host (com createdAt)

function cleanup() {
  const now = Date.now();
  for (const [id, h] of hosts) {
    if (now - h.createdAt > TTL_MS) hosts.delete(id);
  }
  // remove os mais antigos se passar do limite (Map preserva ordem de inserção)
  while (hosts.size >= MAX) {
    const oldest = hosts.keys().next().value;
    if (oldest === undefined) break;
    hosts.delete(oldest);
  }
}

function add(host) {
  cleanup();
  const id = 'qc_' + crypto.randomUUID();
  hosts.set(id, { ...host, id, ephemeral: true, createdAt: Date.now() });
  return id;
}

function get(id) {
  return hosts.get(id) || undefined;
}

// Procura por endereço+porta. Usado pela fixação de certificado das páginas web:
// o pino pertence ao ENDEREÇO, e um host avulso precisa da mesma regra de um
// salvo — senão toda gerência com certificado autoassinado aberta pela conexão
// rápida seria recusada sem saída para o usuário.
function acharPorEndereco(protocolo, endereco, porta) {
  cleanup();
  for (const h of hosts.values()) {
    if (h.protocol === protocolo && String(h.host) === String(endereco)
      && Number(h.port) === Number(porta)) return h;
  }
  return undefined;
}

module.exports = { add, get, acharPorEndereco };
