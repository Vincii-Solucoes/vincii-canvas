'use strict';

// Quem está mostrando qual host, em qual janela.
//
// Existe por causa da agenda: quando um host entra na faixa de horário dele, a
// janela principal abre a conexão sozinha. Só que ela enxerga apenas as próprias
// abas — e uma aba SOLTA numa janela separada é invisível para ela. Sem este
// registro, soltar um host agendado numa janela própria faz a janela principal
// concluir "ninguém está com ele" e abrir uma SEGUNDA conexão ao mesmo servidor,
// a cada tique do relógio.
//
// Para terminal isto seria dispensável: lib/termsessions.js já sabe quem está
// ligado em quê. RDP, VNC e página web não têm nada no servidor — vivem inteiros
// dentro do renderer — e é para eles que este módulo é indispensável.
//
// Liveness por batida de coração com prazo de validade, e não por aviso de
// saída: uma janela que morre de crash, ou um app fechado no tapa, nunca chega a
// avisar. Com prazo, o registro se corrige sozinho em segundos. O aviso de saída
// existe também (`sair`), mas só para o caso normal ficar instantâneo.

// Uma janela que não bate o ponto neste prazo é considerada morta. Precisa ser
// confortavelmente maior que o intervalo de batida do cliente (5 s), senão uma
// janela viva mas ocupada seria dada como morta e o host abriria duplicado.
const TTL_MS = Number(process.env.VC_PRESENCA_TTL_MS || 20 * 1000);

// Teto de janelas registradas. O id vem do cliente; sem teto, um laço de
// requisições encheria o mapa. 40 janelas é muito acima de qualquer uso real.
const MAX_JANELAS = 40;

const TIPOS = ['term', 'desk', 'web'];

const janelas = new Map();

function agoraMs() { return Date.now(); }

function limparVencidas(agora = agoraMs()) {
  for (const [id, j] of janelas) {
    if (agora - j.visto > TTL_MS) janelas.delete(id);
  }
}

// A janela diz "existo e estou mostrando isto". Chamada a cada poucos segundos.
function anunciar(janelaId, itens, agora = agoraMs()) {
  const id = String(janelaId || '').trim().slice(0, 64);
  if (!id) return false;
  limparVencidas(agora);

  const lista = (Array.isArray(itens) ? itens : [])
    .map((it) => ({
      hostId: String((it && it.hostId) || '').trim().slice(0, 64),
      kind: TIPOS.includes(it && it.kind) ? it.kind : 'term',
    }))
    .filter((it) => it.hostId)
    .slice(0, 60); // uma janela com mais de 60 abas do mesmo host não é caso real

  if (!janelas.has(id) && janelas.size >= MAX_JANELAS) {
    // Despeja a mais antiga em vez de recusar a nova: recusar deixaria a janela
    // recém-aberta invisível para sempre, que é o defeito que este módulo
    // existe para evitar.
    let maisVelha = null;
    for (const [k, j] of janelas) if (!maisVelha || j.visto < maisVelha[1].visto) maisVelha = [k, j];
    if (maisVelha) janelas.delete(maisVelha[0]);
  }
  janelas.set(id, { visto: agora, itens: lista });
  return true;
}

// A janela avisa que está fechando. Só acelera o que o prazo já faria.
function sair(janelaId) {
  return janelas.delete(String(janelaId || '').trim().slice(0, 64));
}

// Tudo que está sendo mostrado agora, já sem as janelas vencidas.
function listar(agora = agoraMs()) {
  limparVencidas(agora);
  const out = [];
  for (const [id, j] of janelas) {
    for (const it of j.itens) out.push({ janela: id, hostId: it.hostId, kind: it.kind });
  }
  return out;
}

function limpar() { janelas.clear(); }

// O módulo devolve a LISTA e nada mais.
//
// Houve aqui um `mostrandoPorOutra(hostId, exceto)` que respondia direto se
// alguém além de quem pergunta estava com o host. Ele foi removido porque
// ninguém o chamava: a decisão acontece toda no navegador, em
// public/agenda.js (`decidirAcao`), que precisa cruzar a presença com as
// próprias abas e com as sessões do servidor. A função só existia para os
// testes — treze verificações sobre código que o app nunca executava, o pior
// tipo de cobertura, porque parece proteção e não protege nada.
module.exports = { anunciar, sair, listar, limpar, TTL_MS, MAX_JANELAS };
