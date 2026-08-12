'use strict';

// Onde fica o que o COFRE sabe e o Canvas precisa mostrar: os clientes (com o
// horário de atendimento de cada um) e os SISTEMAS de cada cliente.
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
//   3. NADA VAI PARA O DISCO. Janela e sistema não são segredo, mas são dado do
//      ERP, e a decisão de "nunca gravar" vale para tudo que vem de lá:
//      reiniciar o app busca de novo, que custa uma requisição.
//
// Os sistemas viram HOSTS ESPELHADOS: aparecem na lista junto dos hosts
// cadastrados, mas nunca entram no data.json. Isso não é economia de disco, é o
// que faz o espelho ser espelho:
//
//   - o ERP manda. Renomeou lá, muda aqui; removeu lá, some aqui. Se estivessem
//     gravados, a cópia local sobreviveria à remoção e viraria um host fantasma
//     apontando para um sistema que não é mais daquele cliente;
//   - não vão para o backup. Restaurar noutra máquina traz o que o ERP disser
//     PARA AQUELE analista, e não a mesa de trabalho de quem exportou;
//   - não dá para editar. Um campo editado à mão seria apagado na renovação
//     seguinte, em silêncio — pior do que não deixar editar.

const credenciais = require('./credenciais');
const cofres = require('./cofres');
const weburl = require('../public/weburl');

// Dois minutos.
//
// Era cinco, escolhido pensando só no custo: o horário de atendimento muda em
// escala de dias. Mas os SISTEMAS entram na mesma renovação, e esses mudam
// quando o admin mexe no cadastro do cliente — e aí cinco minutos olhando para
// uma lista que não muda é lento de um jeito que a pessoa sente.
//
// O custo continua desprezível: 2 requisições por cofre a cada 2 minutos, ou
// seja 1 por minuto. O limite do Homem Vitruviano é 120/min POR IP, dividido
// com o navegador do analista — mesmo com dez pessoas atrás do mesmo NAT são 10
// de 120.
const VALIDADE_MS = 2 * 60 * 1000;
// Depois de uma falha, esperar antes de tentar de novo. Sem isto, um ERP fora do
// ar viraria uma tentativa a cada leitura de estado.
const ESPERA_APOS_FALHA_MS = 60 * 1000;

// apelido do cofre -> { clientes: Map(id -> {id, nome, janela}), buscadoEm, erro, buscando }
const cache = new Map();

function entrada(apelido) {
  let e = cache.get(apelido);
  if (!e) {
    e = { clientes: new Map(), sistemas: [], buscadoEm: 0, tentadoEm: 0, esperarAte: 0,
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

    // Os sistemas vêm na MESMA renovação, não numa própria.
    //
    // São duas requisições por cofre a cada VALIDADE_MS, e não duas contagens de
    // tempo independentes que se cruzam. O limite do Homem Vitruviano é por IP e
    // do ERP inteiro; dois relógios separados dobrariam o gasto sem dobrar
    // utilidade nenhuma, porque os dois dados mudam na mesma escala (dias).
    const adapt = cofres.pegar(cofre.tipo);
    if (adapt && adapt.capacidades.sistemas && typeof adapt.sistemas === 'function') {
      try {
        const rs = await adapt.sistemas(credenciais.configCompleta(cofre), {});
        e.sistemas = Array.isArray(rs.itens) ? rs.itens : [];
      } catch (err2) {
        // Falhar aqui NÃO invalida os clientes que acabaram de chegar: a lista de
        // sistemas velha continua valendo, pela mesma razão de sempre.
        console.error(`[cofres] sistemas de "${cofre.apelido}": ${err2.message}`);
      }
    }

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

// ---------- os sistemas viram hosts ----------

// Prefixo próprio, para ninguém confundir com id de host cadastrado.
//
// O id precisa ser ESTÁVEL entre renovações: é ele que amarra a aba aberta ao
// host. Um id que mudasse a cada busca faria a aba perder o dono a cada cinco
// minutos — a agenda abriria uma segunda, a trava soltaria, e a barra lateral
// mostraria o mesmo sistema duas vezes.
//
// `s.id` é o id estável do ERP; quando falta (sistema antigo, ainda sem save
// lá), o adaptador já devolve `cliente::nome` como reserva.
const PREFIXO = 'erp:';
const idEspelhado = (apelido, sistema) => `${PREFIXO}${apelido}:${sistema.id}`;

// O espelho é OPT-OUT por cofre: nasce ligado, e quem não quiser desliga.
function espelhando(cofre) {
  return cofre.espelharSistemas !== false;
}

function hostDoSistema(apelido, s) {
  // Sem URL não há host web: o adaptador já recusa esquema que não seja
  // http/https, e sistema sem endereço não tem o que abrir. Ele continua
  // aparecendo na lista de sistemas, marcado — só não vira host.
  const url = weburl.normalizarUrl(s.url);
  if (!url) return null;
  return {
    id: idEspelhado(apelido, s),
    name: s.nome,
    // O host é WEB: o Canvas abre a página do sistema numa aba. Nenhuma
    // credencial passa por aqui — a senha, quando existir, vem do cofre no
    // momento de entrar, como em qualquer outro host.
    protocol: 'web',
    url,
    host: (() => { try { return new URL(url).hostname; } catch { return ''; } })(),
    port: 443,
    username: '',
    group: s.clienteNome || s.cliente || '',
    // A LIGAÇÃO COM O CLIENTE é o que faz o horário de atendimento valer aqui
    // também: `janelaDoHost` lê daqui. Um sistema do cliente abre sozinho e
    // trava a aba durante o expediente dele, sem ninguém digitar horário.
    segredo: { cofre: apelido, cliente: s.cliente || '', id: '', rotulo: s.nome },
    auth: { type: 'agent' },
    vars: {},
    // A marca que a tela usa para não oferecer editar nem remover, e para dizer
    // de onde o host veio.
    espelho: { cofre: apelido, cliente: s.clienteNome || s.cliente || '', sistema: s.nome },
  };
}

// Duas URLs que abrem a MESMA página.
//
// `normalizarUrl` já resolve maiúscula, porta padrão e esquema, mas mantém a
// barra final e o fragmento — e para comparar cadastro com espelho isso não
// serve: quem digitou ".../atendente" e o ERP que devolveu ".../atendente/"
// estão falando do mesmo sistema, e o host apareceria duplicado na lista.
//
// A query string NÃO é ignorada, de propósito: `?empresa=2` costuma ser um
// sistema diferente, não a mesma página com enfeite.
function mesmaPagina(bruta) {
  const u = weburl.normalizarUrl(bruta);
  if (!u) return '';
  try {
    const x = new URL(u);
    x.hash = '';
    if (x.pathname.length > 1 && x.pathname.endsWith('/')) x.pathname = x.pathname.slice(0, -1);
    return x.toString();
  } catch { return u; }
}

// Todos os hosts espelhados, de todos os cofres.
//
// `jaCadastrados` são as URLs dos hosts que a pessoa criou à mão: um sistema que
// ela já cadastrou não aparece duas vezes. Quem ganha é o cadastro manual —
// ela pode ter mudado nome, grupo ou ícone, e o espelho passando por cima
// desfaria isso a cada renovação.
function hostsEspelhados(jaCadastrados = []) {
  const usadas = new Set(jaCadastrados.map(mesmaPagina).filter(Boolean));
  const out = [];
  for (const cofre of credenciais.listaDeCofres()) {
    if (!espelhando(cofre)) continue;
    const e = cache.get(cofre.apelido);
    if (!e) continue;
    for (const s of e.sistemas) {
      const h = hostDoSistema(cofre.apelido, s);
      if (!h) continue;
      const chave = mesmaPagina(h.url);
      if (usadas.has(chave)) continue;
      usadas.add(chave); // dois cofres com o mesmo sistema também não duplicam
      out.push(h);
    }
  }
  return out;
}

const ehEspelhado = (id) => typeof id === 'string' && id.startsWith(PREFIXO);

// Busca por id, para o servidor resolver um host espelhado igual resolve um
// cadastrado. Mesmo papel do `quickhosts.get` na cadeia de procura.
function pegarHost(id) {
  if (!ehEspelhado(id)) return null;
  return hostsEspelhados().find((h) => h.id === id) || null;
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
      sistemas: e.sistemas.length,
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
  hostsEspelhados, pegarHost, ehEspelhado, PREFIXO,
  VALIDADE_MS, ESPERA_APOS_FALHA_MS };
