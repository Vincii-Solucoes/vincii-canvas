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
const store = require('./store');
const segredosDeCofre = require('./cofresegredos');
const weburl = require('../public/weburl');
const proto = require('../public/protocolos');

// Buscar o ERP precisa da CHAVE do cofre, e decifrá-la abre o Keychain no
// macOS. safeStorage é síncrono: se o aquecimento do cache (no arranque, num
// timer) dispara isso com o Keychain ainda fechado, o app inteiro congela no
// diálogo de senha. Enquanto o cofre não foi destravado nesta sessão (o usuário
// conectar ou abrir um cofre), NADA em segundo plano toca o segredo. Só o
// estado 'ainda-nao-perguntado' pede prompt; os demais ('sistema', 'texto-claro',
// 'desligado-pelo-usuario', 'indisponivel') leem sem abrir diálogo.
function segredoAcessivelSemPrompt() {
  return segredosDeCofre.estadoDaProtecao() !== 'ainda-nao-perguntado';
}

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
// Carência depois de uma falha, CRESCENTE.
//
// Era um minuto fixo, e um minuto é muito para um blip: o ERP devolve 502 por
// dois segundos enquanto reinicia, e a mesa de trabalho do cliente ficava fora
// da lista por sessenta. Como a esmagadora maioria das falhas é assim — curta —
// a primeira retentativa vem rápido, e só quem falha de novo é castigado.
//
// Cresce até um minuto para o caso oposto (ERP fora do ar de verdade), onde
// bater a cada cinco segundos não ajuda ninguém e ainda gasta o limite de taxa.
const ESPERAS_MS = [5 * 1000, 15 * 1000, 60 * 1000];
const ESPERA_APOS_FALHA_MS = ESPERAS_MS[ESPERAS_MS.length - 1];

// apelido do cofre -> { clientes: Map(id -> {id, nome, janela}), buscadoEm, erro, buscando }
const cache = new Map();

function entrada(apelido) {
  let e = cache.get(apelido);
  if (!e) {
    e = { clientes: new Map(), sistemas: [], segredos: [], buscadoEm: 0, tentadoEm: 0, esperarAte: 0,
      falhasSeguidas: 0, erro: null, buscando: null };
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
    for (const c of r.cofres || []) {
      novos.set(c.id, { id: c.id, nome: c.nome, janela: c.janela,
        // O estado de "sem janela" (sem_turnos | encaminhamento_desativado):
        // sem ele, o host do cliente ficava mudo sobre POR QUE não abre sozinho.
        semJanela: c.semJanela || '' });
    }
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

    // E os SEGREDOS (só referências — valor nenhum) vêm na mesma renovação,
    // pela mesma razão. Um segredo que declara protocolo + endereço descreve o
    // acesso inteiro, e vira host espelhado como os sistemas viram: aparece
    // sozinho, agrupado no cliente, e quem manda nele é o ERP. Foi o pedido
    // que nasceu na prática: a pessoa cadastrou a credencial da VM no cofre e
    // esperou a máquina aparecer no Canvas — e ela tinha razão de esperar.
    if (adapt && adapt.capacidades.listar && typeof adapt.listar === 'function') {
      try {
        // SEGUE a paginação: `limite: 200` numa chamada só era um teto mudo —
        // do 201º segredo em diante nada virava host, sem aviso, e QUAIS 200
        // entravam dependia da ordem da listagem do ERP. O teto de 1000 existe
        // para um ERP doente não prender a renovação para sempre — e quando
        // ele corta, fica REGISTRADO, não calado.
        const cfgCompleta = credenciais.configCompleta(cofre);
        const todos = [];
        let cursor;
        do {
          const rl = await adapt.listar(cfgCompleta, { limite: 200, cursor });
          todos.push(...(Array.isArray(rl.itens) ? rl.itens : []));
          cursor = rl.proximoCursor || null;
        } while (cursor && todos.length < 1000);
        e.segredos = todos;
        e.segredosTruncados = !!cursor;
        if (cursor) console.error(`[cofres] segredos de "${cofre.apelido}": mais de 1000 — lista cortada`);
      } catch (err3) {
        console.error(`[cofres] segredos de "${cofre.apelido}": ${err3.message}`);
      }
    }

    e.buscadoEm = Date.now();
    e.erro = null;
    e.falhasSeguidas = 0;
    // Confiança de destino que não existe mais em nenhum espelho sai do disco
    // — DEPOIS de marcar esta busca como boa, para a própria checagem valer.
    limparConfiancaOrfa();
  } catch (err) {
    // Guarda o erro para a tela poder explicar por que a janela está velha, mas
    // MANTÉM os clientes já conhecidos.
    e.erro = { codigo: err.codigo || 'indisponivel', mensagem: err.message };
    // 429 vem com Retry-After, e aqui ele PRECISA ser obedecido: o limite é de
    // 120 requisições por minuto POR IP, do ERP inteiro — dividido com o
    // navegador do próprio analista atrás do mesmo NAT. Voltar a bater antes da
    // hora é ajudar a estourar o balde que já estourou.
    const degrau = ESPERAS_MS[Math.min(e.falhasSeguidas, ESPERAS_MS.length - 1)];
    e.falhasSeguidas += 1;
    e.esperarAte = Date.now() + Math.max(
      Number(err.esperaSegundos) > 0 ? Number(err.esperaSegundos) * 1000 : 0,
      degrau);
  } finally {
    e.tentadoEm = Date.now();
  }
}

// Dispara o que estiver vencido, sem esperar. Chamada nas rotas de leitura.
function renovarSeVencido() {
  // Em segundo plano nunca forçamos o prompt do Keychain: sem isso, o
  // aquecimento na partida (server.js, dentro do listen) congelava o app.
  if (!segredoAcessivelSemPrompt()) return;
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
//
// Vai TAMBÉM quando a janela está ausente mas o estado é conhecido
// (`semJanela`): "o cliente não tem turnos" e "o encaminhamento está
// desligado" são coisas que a tela precisa dizer — a trava do cofre vale nos
// dois casos, e sem isto a recusa fora do horário chegava sem explicação.
// `janela: null` já era um estado que a tela trata (não abre sozinho, não
// trava aba); o campo novo só dá nome à ausência.
function janelaDoHost(host) {
  const ref = (host && host.segredo) || {};
  if (!ref.cofre || !ref.cliente) return null;
  const e = cache.get(ref.cofre);
  if (!e) return null;
  const c = e.clientes.get(ref.cliente);
  if (!c || (!c.janela && !c.semJanela)) return null;
  return { cliente: c.nome || ref.cliente, cofre: ref.cofre,
    janela: c.janela || null, semJanela: c.semJanela || '' };
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

// Um segredo que declara protocolo + endereço vira host espelhado. O `seg:` no
// id separa o espaço de nomes dos sistemas — os dois são UUIDs do ERP e nada
// impediria uma colisão de azar.
function hostDoSegredo(apelido, s) {
  if (!s || !s.id || !s.host) return null;
  // Sem protocolo não há como saber O QUE abrir; "web" o ERP nem aceita em
  // segredo (manda cadastrar em sistemas), e se vier, o lugar dele é lá.
  if (!proto.ehProtocolo(s.protocolo) || s.protocolo === 'web') return null;
  return {
    id: `${PREFIXO}${apelido}:seg:${s.id}`,
    name: s.nome,
    protocol: s.protocolo,
    host: s.host,
    port: Number.isInteger(s.porta) && s.porta > 0 ? s.porta : proto.portaPadrao(s.protocolo),
    username: s.usuario || '',
    rdpDomain: s.dominio || '',
    url: '',
    group: s.clienteNome || s.cliente || '',
    // A referência ao próprio segredo: conectar busca o valor na hora, pela
    // mesma porta única de resolução de credenciais de sempre.
    segredo: { cofre: apelido, cliente: s.cliente || '', id: s.id, rotulo: s.nome },
    auth: { type: 'cofre' },
    vars: {},
    // O host renasce a cada renovação; a prova de identidade do servidor NÃO
    // pode renascer junto — vem do que esta máquina já aprendeu (TOFU),
    // chaveado pelo DESTINO (a máquina), nunca pelo id.
    fingerprint: fingerprintFixado(mesmoDestino({
      protocol: s.protocolo,
      host: s.host,
      port: Number.isInteger(s.porta) && s.porta > 0 ? s.porta : proto.portaPadrao(s.protocolo),
    })),
    espelho: { cofre: apelido, cliente: s.clienteNome || s.cliente || '', sistema: s.nome },
  };
}

// A chave de DEDUPE inclui o usuário: duas contas na mesma máquina (admin e
// operador) são dois acessos legítimos — sem o usuário na chave, o segundo
// sumia e a ORDEM da listagem do ERP decidia qual sobrevivia, trocando a
// identidade do host em silêncio a cada renovação.
function destinoComUsuario(h) {
  const d = mesmoDestino(h);
  return d ? `${d}|${String(h.username || '').toLowerCase()}` : '';
}

// A chave de dedupe de um host que CONECTA (não-web): mesmo protocolo, mesmo
// endereço, mesma porta = a mesma máquina, seja de onde o host veio.
function mesmoDestino(h) {
  if (!h || !h.host) return '';
  return `${h.protocol || 'ssh'}|${String(h.host).toLowerCase()}:${h.port || ''}`;
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

// Todos os hosts espelhados, de todos os cofres — dos SISTEMAS (viram hosts
// web) e dos SEGREDOS com protocolo + endereço (viram hosts de conexão).
//
// `jaCadastrados` são os hosts que a pessoa criou à mão (a lista inteira): o
// que ela já cadastrou não aparece duas vezes — nem a página do sistema, nem o
// destino do segredo. Quem ganha é o cadastro manual — ela pode ter mudado
// nome, grupo ou ícone, e o espelho passando por cima desfaria isso a cada
// renovação. (Aceita também a forma antiga, só URLs, por compatibilidade.)
function hostsEspelhados(jaCadastrados = []) {
  const paginas = new Set();
  const destinos = new Set();
  // Host manual SEM usuário é "esta máquina, seja qual for o login": esconde
  // qualquer espelho do destino. COM usuário, só esconde o do mesmo usuário —
  // admin e operador na mesma máquina são dois acessos legítimos.
  const destinosSemUsuario = new Set();
  const segredosJaApontados = new Set();
  for (const j of jaCadastrados) {
    if (typeof j === 'string') { const p = mesmaPagina(j); if (p) paginas.add(p); continue; }
    if (j && j.url) { const p = mesmaPagina(j.url); if (p) paginas.add(p); }
    const d = destinoComUsuario(j);
    if (d) destinos.add(d);
    if (j && !j.username) { const b = mesmoDestino(j); if (b) destinosSemUsuario.add(b); }
    // Host manual que APONTA para um segredo do cofre esconde o espelho desse
    // segredo, sempre — mesmo com usuário ou endereço digitados diferentes: a
    // pessoa já deu a esse acesso o nome e o grupo que quis.
    if (j && j.segredo && j.segredo.id) segredosJaApontados.add(j.segredo.id);
  }
  const out = [];
  for (const cofre of credenciais.listaDeCofres()) {
    if (!espelhando(cofre)) continue;
    const e = cache.get(cofre.apelido);
    if (!e) continue;
    for (const s of e.sistemas) {
      const h = hostDoSistema(cofre.apelido, s);
      if (!h) continue;
      const chave = mesmaPagina(h.url);
      if (paginas.has(chave)) continue;
      paginas.add(chave); // dois cofres com o mesmo sistema também não duplicam
      out.push(h);
    }
    for (const s of e.segredos || []) {
      if (segredosJaApontados.has(s.id)) continue;
      const h = hostDoSegredo(cofre.apelido, s);
      if (!h) continue;
      if (destinosSemUsuario.has(mesmoDestino(h))) continue;
      const chave = destinoComUsuario(h);
      if (destinos.has(chave)) continue;
      destinos.add(chave); // o MESMO acesso (máquina + usuário) não duplica
      out.push(h);
    }
  }
  return out;
}

const ehEspelhado = (id) => typeof id === 'string' && id.startsWith(PREFIXO);

// ---------- a confiança aprendida (TOFU) dos espelhados ----------
//
// O objeto de um host espelhado é RECONSTRUÍDO a cada renovação: gravar o
// fingerprint nele morre no minuto seguinte, e o TOFU vira papel — cada
// reconexão "aprenderia" o servidor de novo, inclusive um servidor trocado no
// caminho. A prova de identidade é estado DESTA MÁQUINA (como o webCert), não
// cadastro do ERP — então ela mora no data.json.
//
// A CHAVE é o destino (protocolo|endereço:porta), NÃO o id do espelho. A
// revisão provou por que, três vezes: o id embute o apelido do cofre (renomear
// o cofre órfãva todos os pins e reabria a janela de MITM numa edição banal);
// o admin trocando o endereço do segredo no ERP mantinha o id — e o pin da
// máquina ANTIGA valia para a nova; e dois segredos da mesma máquina trocavam
// de vencedor no dedupe zerando o pin. O destino é a máquina — que é
// exatamente do que o fingerprint é prova.
function chaveDeConfianca(host) {
  return host && host.host ? mesmoDestino(host) : '';
}

function fingerprintFixado(chave) {
  const mapa = store.get().espelhoConfianca;
  if (!chave || !mapa || typeof mapa !== 'object' || Array.isArray(mapa)) return null;
  return Object.prototype.hasOwnProperty.call(mapa, chave) ? String(mapa[chave]) : null;
}

// Devolve true quando o host é um espelhado (e o pin foi tratado aqui) —
// false manda o chamador seguir o caminho normal de host cadastrado.
// NUNCA sobrescreve: pin diferente do gravado só sai com o esquecimento
// explícito — sobrescrever calado é aceitar o servidor trocado que o TOFU
// existe para barrar (e era o que uma corrida de duas conexões fazia).
function fixarFingerprint(id, fp, host) {
  if (!ehEspelhado(id) || !fp) return false;
  const alvo = host && host.host ? host : pegarHost(id);
  const chave = chaveDeConfianca(alvo);
  if (!chave) return true; // espelhado sem destino: nada a gravar, nada a salvar no store
  const d = store.get();
  if (!d.espelhoConfianca || typeof d.espelhoConfianca !== 'object' || Array.isArray(d.espelhoConfianca)) {
    d.espelhoConfianca = {};
  }
  if (Object.prototype.hasOwnProperty.call(d.espelhoConfianca, chave)) return true;
  d.espelhoConfianca[chave] = String(fp);
  store.save();
  return true;
}

// O caminho de saída: servidor legitimamente trocado (reinstalação) precisa de
// um "esquecer" — sem ele, o espelhado ficava inconectável até editar o
// data.json à mão.
function esquecerFingerprint(id) {
  if (!ehEspelhado(id)) return false;
  const alvo = pegarHost(id);
  const chave = chaveDeConfianca(alvo);
  const d = store.get();
  if (!chave || !d.espelhoConfianca || !Object.prototype.hasOwnProperty.call(d.espelhoConfianca, chave)) {
    return true; // não havia pin: esquecer é idempotente
  }
  delete d.espelhoConfianca[chave];
  store.save();
  return true;
}

// Pins de destinos que não existem mais em NENHUM espelho saem do data.json —
// senão o mapa só cresce, guardando confiança de máquinas que já foram
// removidas do ERP.
function limparConfiancaOrfa() {
  const d = store.get();
  const mapa = d.espelhoConfianca;
  if (!mapa || typeof mapa !== 'object' || Array.isArray(mapa)) return;
  // Só limpa quando TODOS os cofres com clientes já responderam bem e a lista
  // veio inteira: no arranque, limpar com metade dos caches vazios apagaria
  // pins válidos — e pin apagado é TOFU zerado, exatamente o que uma limpeza
  // não pode causar. Na dúvida, o pin fica.
  for (const cofre of credenciais.listaDeCofres()) {
    if (!temClientes(cofre) || !espelhando(cofre)) continue;
    const e = cache.get(cofre.apelido);
    if (!e || !e.buscadoEm || e.erro || e.segredosTruncados) return;
  }
  const vivos = new Set();
  for (const e of cache.values()) {
    for (const s of e.segredos || []) {
      const h = hostDoSegredo('x', s); // o apelido não entra na chave de destino
      if (h) vivos.add(chaveDeConfianca(h));
    }
  }
  let mudou = false;
  for (const chave of Object.keys(mapa)) {
    if (!vivos.has(chave)) { delete mapa[chave]; mudou = true; }
  }
  if (mudou) store.save();
}

// Busca por id, para o servidor resolver um host espelhado igual resolve um
// cadastrado. Mesmo papel do `quickhosts.get` na cadeia de procura.
function pegarHost(id) {
  if (!ehEspelhado(id)) return null;
  return hostsEspelhados().find((h) => h.id === id) || null;
}

// A mesma busca, com paciência de arranque: o espelho só existe depois da
// primeira conversa com o ERP, e um clique rápido (Recentes, aba reatada)
// chegava antes dela — "Host não encontrado" para um host que ia existir dois
// segundos depois. No cache frio, renova UMA vez e tenta de novo.
async function pegarHostRenovando(id) {
  const direto = pegarHost(id);
  if (direto || !ehEspelhado(id)) return direto;
  const m = new RegExp(`^${PREFIXO}([^:]+):`).exec(id);
  if (m) { try { await renovarAgora(m[1]); } catch { /* a falha aparece no aviso do cofre */ } }
  return pegarHost(id);
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
      falhasSeguidas: e.falhasSeguidas,
      erro: e.erro,
    };
  }
  return out;
}

// O que a TELA precisa saber para não deixar a falha invisível.
//
// Sem isto, um blip do ERP na hora errada tirava os sistemas do cliente da lista
// sem uma palavra em lugar nenhum — e a pessoa via "às vezes aparece, às vezes
// não". Só aponta o dedo quando dói: houve erro E não há nada em cache para
// mostrar no lugar.
function avisos() {
  const out = [];
  for (const cofre of credenciais.listaDeCofres()) {
    if (!temClientes(cofre) || !espelhando(cofre)) continue;
    const e = cache.get(cofre.apelido);
    if (!e || !e.erro) continue;
    if (e.sistemas.length || e.clientes.size) continue; // tem dado velho: a lista não fica vazia
    out.push({
      cofre: cofre.apelido,
      codigo: e.erro.codigo,
      mensagem: e.erro.mensagem,
      // INSTANTE ABSOLUTO, e não uma contagem regressiva.
      //
      // Era `emSegundos`, calculado na hora — então o corpo de /api/state mudava
      // a CADA leitura, a assinatura nunca se repetia, e a tela redesenhava a
      // lista de hosts inteira a cada tique. Enquanto o cofre está falhando, o
      // tique é de 1 segundo: o card que a pessoa ia clicar era destruído e
      // recriado debaixo do dedo, e o clique não chegava a lugar nenhum.
      //
      // Ou seja: a mensagem que existe para explicar a intermitência estava
      // CAUSANDO intermitência. Quem conta os segundos agora é o navegador, a
      // partir deste instante fixo.
      tentarEm: e.esperarAte || 0,
    });
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
  hostsEspelhados, pegarHost, pegarHostRenovando, ehEspelhado, avisos, PREFIXO,
  fixarFingerprint, esquecerFingerprint,
  VALIDADE_MS, ESPERA_APOS_FALHA_MS, ESPERAS_MS };
