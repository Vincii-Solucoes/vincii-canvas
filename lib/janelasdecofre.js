'use strict';

// Onde ficam as janelas de atendimento vindas dos cofres.
//
// A janela de um cliente mora no ERP e chega pelo `ping` do cofre. O navegador
// precisa dela a cada dez segundos (é o tique que decide se a aba fica travada),
// mas NÃO pode pedi-la ao ERP: a chave da API não sai daqui, e 120 requisições
// por minuto acabariam num piscar de olhos com o app aberto o dia inteiro.
//
// Então: o servidor busca de vez em quando, guarda o resultado EM MEMÓRIA, e o
// navegador lê a cópia. Três decisões deste arquivo, e o motivo de cada uma:
//
//   1. NUNCA BLOQUEIA. A rota de estado é o carregamento da tela; esperar o ERP
//      ali faz o app abrir devagar quando o ERP está lento, e não abrir quando
//      ele está fora. Quem pergunta recebe o que há em memória, e a busca corre
//      por fora.
//
//   2. FALHA NÃO APAGA. Se o ERP cai às 14h, a janela conhecida às 13h continua
//      valendo. Apagar faria toda aba travada destravar junto — e o horário de
//      atendimento do cliente não mudou só porque a API caiu.
//
//   3. NADA VAI PARA O DISCO. Janela não é segredo, mas é dado do ERP, e a
//      decisão de "nunca gravar" vale para tudo que vem de lá: reiniciar o app
//      busca de novo, que custa uma requisição.

const credenciais = require('./credenciais');
const cofres = require('./cofres');

// Cinco minutos: o horário de atendimento de um cliente muda em escala de dias,
// não de minutos. Com um punhado de cofres configurados isso dá algumas
// requisições por hora — folgado dentro das 120/min.
const VALIDADE_MS = 5 * 60 * 1000;
// Depois de uma falha, esperar antes de tentar de novo. Sem isto, um ERP fora do
// ar viraria uma tentativa a cada leitura de estado.
const ESPERA_APOS_FALHA_MS = 60 * 1000;

// apelido do cofre -> { clientes: Map(id -> {id, nome, janela}), buscadoEm, erro, buscando }
const cache = new Map();

function entrada(apelido) {
  let e = cache.get(apelido);
  if (!e) {
    e = { clientes: new Map(), buscadoEm: 0, tentadoEm: 0, esperarAte: 0,
      erro: null, buscando: null };
    cache.set(apelido, e);
  }
  return e;
}

// Só faz sentido perguntar a cofre que declara conhecer clientes. O contrato
// aberto não tem esse conceito, e chamar `ping` nele por causa de janela seria
// gastar requisição para receber um campo que não existe.
function temClientes(cofre) {
  const a = cofres.pegar(cofre.tipo);
  return !!(a && a.capacidades && a.capacidades.clientes);
}

// Devolve a busca EM VOO quando já existe uma, em vez de desistir.
//
// Desistindo, `renovarAgora` (usada pelo botão "Testar") voltava antes de a
// resposta chegar, e a tela mostrava "nenhum cliente" logo depois de um teste
// bem-sucedido. Uma requisição por vez continua valendo — o que muda é que quem
// chegou depois espera a mesma, em vez de receber um resultado vazio.
function buscar(cofre) {
  const e = entrada(cofre.apelido);
  if (e.buscando) return e.buscando;
  e.buscando = buscarDeVerdade(cofre, e).finally(() => { e.buscando = null; });
  return e.buscando;
}

async function buscarDeVerdade(cofre, e) {
  try {
    const r = await credenciais.ping(cofre);
    const novos = new Map();
    for (const c of r.cofres || []) novos.set(c.id, { id: c.id, nome: c.nome, janela: c.janela });
    e.clientes = novos;
    e.buscadoEm = Date.now();
    e.erro = null;
  } catch (err) {
    // Guarda o erro para a tela poder explicar por que a janela está velha, mas
    // MANTÉM os clientes já conhecidos.
    e.erro = { codigo: err.codigo || 'indisponivel', mensagem: err.message };
    // 429 vem com Retry-After, e aqui ele PRECISA ser obedecido: o limite é de
    // 120 requisições por minuto POR IP, do ERP inteiro — dividido com o
    // navegador do próprio analista atrás do mesmo NAT. Voltar a bater antes da
    // hora é ajudar a estourar o balde que já estourou.
    e.esperarAte = Date.now() + Math.max(
      Number(err.esperaSegundos) > 0 ? Number(err.esperaSegundos) * 1000 : 0,
      ESPERA_APOS_FALHA_MS);
  } finally {
    e.tentadoEm = Date.now();
  }
}

// Dispara o que estiver vencido, sem esperar. Chamada nas rotas de leitura.
function renovarSeVencido() {
  const agora = Date.now();
  for (const cofre of credenciais.listaDeCofres()) {
    if (!temClientes(cofre)) continue;
    const e = entrada(cofre.apelido);
    if (e.buscando) continue;
    const vencido = agora - e.buscadoEm >= VALIDADE_MS;
    // A carência depois de uma falha é a maior entre o mínimo e o Retry-After
    // que o cofre pediu.
    const podeTentar = agora >= (e.esperarAte || 0);
    // Relógio remexido para trás deixa as contas negativas; aí renova, que é o
    // lado seguro (uma requisição a mais, e não uma janela congelada para sempre).
    if ((vencido || agora < e.buscadoEm) && (podeTentar || agora < e.tentadoEm)) {
      buscar(cofre).catch(() => {});
    }
  }
}

// A janela de um host, ou null. É o que vai junto do host para o navegador.
function janelaDoHost(host) {
  const ref = (host && host.segredo) || {};
  if (!ref.cofre || !ref.cliente) return null;
  const e = cache.get(ref.cofre);
  if (!e) return null;
  const c = e.clientes.get(ref.cliente);
  if (!c || !c.janela) return null;
  return { cliente: c.nome || ref.cliente, cofre: ref.cofre, janela: c.janela };
}

// Para a tela de configuração: o que se sabe de cada cofre agora.
function estado() {
  const out = {};
  for (const [apelido, e] of cache) {
    out[apelido] = {
      clientes: [...e.clientes.values()].map((c) => ({ id: c.id, nome: c.nome, janela: c.janela })),
      buscadoEm: e.buscadoEm || null,
      // "ainda não perguntei" e "perguntei e a resposta foi zero cliente" são
      // coisas diferentes, e a resposta do ERP não as distingue sozinha: um
      // analista desligado recebe 200 com a lista vazia, igualzinho a quem
      // acabou de abrir o app. Sem esta marca, a tela diz "a lista ainda não
      // chegou" para quem perdeu o acesso — e a pessoa fica esperando.
      jaBuscou: !!e.buscadoEm,
      erro: e.erro,
    };
  }
  return out;
}

// Força a releitura de um cofre — usada logo depois de salvar ou testar, para a
// tela não esperar cinco minutos pela primeira janela.
async function renovarAgora(apelido) {
  const cofre = credenciais.cofrePorApelido(apelido);
  if (!cofre || !temClientes(cofre)) return null;
  entrada(apelido).esperarAte = 0;
  await buscar(cofre);
  return estado()[apelido] || null;
}

function esquecer(apelido) {
  cache.delete(apelido);
}

module.exports = { renovarSeVencido, renovarAgora, janelaDoHost, estado, esquecer,
  VALIDADE_MS, ESPERA_APOS_FALHA_MS };
