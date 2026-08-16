'use strict';

// Adaptador do Homem Vitruviano (ERP da Vincii) como cofre de credenciais.
//
// O ERP entrega, por API: os CLIENTES que o analista atende (aqui chamados
// "cofres"), os SISTEMAS de cada cliente (a mesa de trabalho) e as CREDENCIAIS
// para entrar neles. Quatro rotas, todas GET, sob /v1.
//
// Quatro coisas separam este produto do contrato aberto, e todas mudam código:
//
//   1. DOIS ENVELOPES DE ERRO. O contrato do cofre responde
//      `{erro:{codigo,mensagem}}` em português; o que falha ANTES dele
//      (validação de parâmetro, rota errada, falha inesperada) responde
//      `{error:{code,message}}` em inglês, do ERP. Ler só um deixa metade dos
//      erros virando "indisponivel" — e aí o app insiste contra uma parede.
//
//   2. `indisponivel` (503) NÃO É TRANSITÓRIO. Aqui ele quer dizer "o cofre
//      está sem chave de cifra" ou "o segredo não decifra". A documentação é
//      explícita: retry não resolve, avise quem administra o ERP.
//
//   3. `/v1/sistemas` não existe no contrato aberto. É a mesa de trabalho: os
//      sistemas do cliente, com URL, para o Canvas abrir.
//
//   4. A JANELA DE ATENDIMENTO vem no ping, por cliente. É o horário em que o
//      Canvas deve manter aquilo aberto — e o cofre RECUSA a credencial fora
//      dele, então ignorar a janela produz um laço de conexões negadas.

const { pedir, ErroDeCofre } = require('./http');
const janelaLib = require('../../public/janela');

// Os tipos do contrato (14/ago). O que importa NÃO é a lista: é que são só
// DUAS FORMAS — valor único no campo `senha` (senha, token, banco, nota) e PEM
// no campo `chavePrivada` (chave-ssh, certificado). Tipo futuro chega numa das
// duas, então a forma é decidida pelo CAMPO que veio, e o nome do tipo serve
// só de rótulo — um tipo desconhecido não pode virar erro nem virar "senha".
const TIPOS_DE_SEGREDO = ['senha', 'chave-ssh', 'token', 'banco', 'nota', 'certificado'];
const TIPOS_PEM = ['chave-ssh', 'certificado'];
const tipoLimpo = (t) => String(t || 'senha').trim().slice(0, 24) || 'senha';
const proto = require('../../public/protocolos');
// `protocolo` só entra se for um dos seis do app — valor estranho vindo da API
// não pode escorrer para a tela nem para um cadastro de host. `ehProtocolo`
// (e não um acesso direto a PROTOCOLOS[p]) porque "constructor" e "toString"
// são propriedades herdadas e passariam no acesso direto — a armadilha que o
// próprio protocolos.js documenta.
const protocoloLimpo = (p) => (proto.ehProtocolo(p) ? String(p) : '');

// Códigos do contrato v1 (envelope `erro`), com a decisão de insistir ou não.
// `transitorio: false` é o que impede o núcleo de gastar o limite de requisições
// contra um erro que não passa sozinho.
const CODIGOS = {
  chave_invalida: { transitorio: false },
  chave_expirada: { transitorio: false },
  sem_permissao: { transitorio: false },
  cliente_inativo: { transitorio: false },
  nao_encontrado: { transitorio: false },
  limite_de_taxa: { transitorio: true },
  // 503 aqui é "cofre sem chave de cifra" ou "segredo que não decifra".
  indisponivel: { transitorio: false },
};

// Códigos do envelope genérico do ERP (`error`), que nascem ANTES do cofre.
//
// Detalhe que engana: só `validation_error` e `http_error` saem em INGLÊS.
// `internal_error` e `conflict` saem em português, no mesmo envelope. Ou seja,
// o idioma não serve para decidir nada — quem decide é sempre o código.
const CODIGOS_ERP = {
  validation_error: { codigo: 'requisicao_invalida', transitorio: false },
  http_error: { codigo: 'requisicao_invalida', transitorio: false },
  internal_error: { codigo: 'indisponivel', transitorio: false },
  conflict: { codigo: 'conflito', transitorio: false },
};

// O 422 NÃO tem `message` — só `details`.
//
// Lendo só `message`, a mensagem na tela virava "erro 422", sem dizer QUAL
// parâmetro estava fora da faixa. E como o Canvas é quem monta a chamada, essa
// é justamente a informação que conserta o problema.
function textoDoErp(corpo) {
  const e = (corpo && corpo.error) || {};
  if (e.message) return String(e.message);
  const d = e.details;
  if (Array.isArray(d) && d.length) {
    return d.map((x) => {
      if (typeof x === 'string') return x;
      if (!x || typeof x !== 'object') return '';
      // Formato de validador: { loc: [...], msg: "..." } ou { campo, mensagem }.
      const onde = Array.isArray(x.loc) ? x.loc.filter((p) => p !== 'query').join('.')
        : (x.campo || x.field || x.param || '');
      const oque = x.msg || x.mensagem || x.message || '';
      return [onde, oque].filter(Boolean).join(': ');
    }).filter(Boolean).join('; ');
  }
  if (typeof d === 'string') return d;
  return '';
}

function traduzirErro(status, corpo, cabecalhos) {
  const c = corpo || {};
  // Os DOIS lugares. Ler só `erro` faz todo erro de validação virar
  // "indisponivel" e o app insistir num parâmetro que ele mesmo mandou errado.
  const doContrato = c.erro || {};
  const doErp = c.error || {};
  const espera = Number(cabecalhos && cabecalhos['retry-after']) || null;

  if (doContrato.codigo && CODIGOS[doContrato.codigo]) {
    const d = CODIGOS[doContrato.codigo];
    return new ErroDeCofre(doContrato.codigo, doContrato.mensagem || `O cofre respondeu ${status}.`,
      espera, d.transitorio);
  }
  if (doErp.code && CODIGOS_ERP[doErp.code]) {
    const d = CODIGOS_ERP[doErp.code];
    const prefixo = doErp.code === 'validation_error'
      ? 'O Canvas mandou um parâmetro fora da faixa aceita pelo cofre: '
      : doErp.code === 'http_error'
        ? 'O Canvas chamou uma rota ou método que o cofre não tem: '
        : doErp.code === 'conflict'
          ? 'O cofre recusou por conflito de estado: '
          : '';
    return new ErroDeCofre(d.codigo, prefixo + (textoDoErp(corpo) || `erro ${status}`),
      espera, d.transitorio);
  }
  // Código desconhecido (dos dois lados): deduz pelo status, sem inventar que
  // vale insistir.
  let codigo = 'indisponivel';
  if (status === 401) codigo = 'chave_invalida';
  else if (status === 403) codigo = 'sem_permissao';
  else if (status === 404) codigo = 'nao_encontrado';
  else if (status === 429) codigo = 'limite_de_taxa';
  else if (status === 422) codigo = 'requisicao_invalida';
  else if (status === 409) codigo = 'conflito';

  // FALHA DE INFRAESTRUTURA NÃO É O `indisponivel` DO CONTRATO.
  //
  // O `indisponivel` de vocês (503 COM o envelope) quer dizer "cofre sem chave
  // de cifra" — ação humana no ERP, e insistir não resolve. Um 502 ou 504 SEM
  // envelope é outra coisa: é o proxy dizendo que o app atrás dele reiniciou,
  // está sobrecarregado ou demorou. Isso passa sozinho, quase sempre em
  // segundos.
  //
  // Tratar os dois igual foi o que produziu a intermitência que o usuário viu:
  // um blip de 502 do gateway derrubava a busca, sem retentativa nenhuma, e os
  // sistemas do cliente simplesmente não apareciam na lista até a carência
  // seguinte. A distinção é o ENVELOPE: se o cofre falou, é do cofre; se veio
  // um 5xx cru, é da estrada.
  const daEstrada = !doContrato.codigo && !doErp.code
    && (status === 502 || status === 504 || status === 408 || status === 0);
  const msg = doContrato.mensagem || textoDoErp(corpo)
    || (daEstrada
      ? `O servidor do cofre não respondeu (${status}). Isso costuma passar sozinho.`
      : `O cofre respondeu ${status}.`);
  return new ErroDeCofre(codigo, msg, espera, codigo === 'limite_de_taxa' || daEstrada);
}

// Referência montada CAMPO A CAMPO: um campo a mais vindo da API (inclusive um
// valor de segredo mandado por engano) para aqui e não entra no app.
function referencia(bruto) {
  const r = bruto || {};
  const id = String(r.id || '').trim();
  if (!id) return null;
  return {
    id,
    nome: String(r.nome || id),
    // O CLIENTE dono do segredo. Passou a vir na listagem (era o pedido de maior
    // efeito da nossa lista), e é o que liga o segredo ao horário de atendimento
    // sem depender de o analista ter filtrado por cliente antes de escolher.
    // `cofre` nunca é null; `cofreNome` pode ser.
    cliente: r.cofre ? String(r.cofre) : '',
    clienteNome: r.cofreNome ? String(r.cofreNome) : '',
    // `caminho` PODE VIR NULL — a especificação avisa. Tratar como string sem
    // isto produziria "null" impresso na tela.
    caminho: r.caminho ? String(r.caminho) : '',
    // O tipo vai CRU (aparado): coagir desconhecido para "senha" mentiria o
    // rótulo na tela — um "nota" apareceria como senha de conexão.
    tipo: tipoLimpo(r.tipo),
    usuario: r.usuario ? String(r.usuario) : '',
    host: r.host ? String(r.host) : '',
    porta: Number.isInteger(r.porta) ? r.porta : null,
    // Novos de 14/ago, resposta às observações do docs/tipos-de-conexao.md:
    // com protocolo + host + porta o segredo descreve o acesso inteiro, e
    // `dominio` cobre o RDP com Active Directory de ponta a ponta.
    protocolo: protocoloLimpo(r.protocolo),
    dominio: r.dominio ? String(r.dominio).slice(0, 80) : '',
    atualizadoEm: r.atualizadoEm ? String(r.atualizadoEm) : null,
  };
}

// Os limites da API são RECUSA, não ajuste: mandar `limite=500` devolve 422 em
// vez de cortar em 200. Então quem corta é o cliente, antes de perguntar.
const LIMITE_MAX = 200;
const BUSCA_MAX = 128;
const COFRE_MAX = 64;

// UM lugar só para o corte. Estava em dois — no `listar` e aqui — e o daqui era
// código morto: quem chamava já mandava o valor cortado. Duas cópias de uma
// regra é uma cópia que um dia deixa de ser corrigida junto.
const limiteValido = (n) => Math.max(1, Math.min(Number(n) || 50, LIMITE_MAX));

function parametros({ busca, cursor, limite, cofre } = {}) {
  const q = new URLSearchParams();
  if (cofre) q.set('cofre', String(cofre).slice(0, COFRE_MAX));
  if (busca) q.set('busca', String(busca).slice(0, BUSCA_MAX));
  if (cursor) q.set('cursor', String(cursor));
  if (limite !== undefined) q.set('limite', String(limiteValido(limite)));
  return q;
}

module.exports = {
  tipo: 'vitruviano',
  nome: 'Homem Vitruviano (ERP Vincii)',
  // O que este produto responde em `produto` no /v1/ping.
  //
  // Serve para a tela flagrar a configuração errada mais provável: apontar o
  // endereço deste ERP e escolher o tipo "Contrato aberto". O ping responde, a
  // chave é aceita, os segredos aparecem — e cliente, horário de atendimento e
  // mesa de trabalho não, porque não existem naquele contrato. Um sucesso que
  // esconde uma perda, e sem isto nada na tela aponta para o campo "Tipo".
  produtoEsperado: 'Homem Vitruviano',
  descricao: 'Os clientes que você atende, os sistemas de cada um e as credenciais para entrar.',

  config: [
    { chave: 'baseUrl', rotulo: 'Endereço da API', tipo: 'url', obrigatorio: true,
      padrao: 'https://homemvitruviano.vincii.com.br/api/cofre/v1',
      dica: 'normalmente não precisa mexer' },
    { chave: 'chave', rotulo: 'Meu token do Canvas', tipo: 'senha', obrigatorio: true, segredo: true,
      dica: 'gere o seu no ERP em Configurações → Meu token do Canvas (começa com hvk_)' },
  ],

  // `clientes` e `sistemas` são capacidades deste produto que o contrato aberto
  // não tem: a interface pergunta antes de oferecer o botão.
  capacidades: { listar: true, buscar: true, tipos: TIPOS_DE_SEGREDO, clientes: true, sistemas: true },

  async ping(cfg) {
    const r = await pedir(cfg, 'GET', '/ping', null, traduzirErro);
    return {
      produto: String(r.produto || 'Homem Vitruviano'),
      versao: String(r.versao || '?'),
      rotuloDaChave: String((r.chave && r.chave.rotulo) || ''),
      // `expiraEm` só vem quando o token tem validade; ausente é o normal.
      expiraEm: (r.chave && r.chave.expiraEm) || null,
      permissoes: Array.isArray(r.permissoes) ? r.permissoes.map(String) : [],
      // "cofres" aqui são os CLIENTES que este analista atende. A janela de
      // atendimento vem junto, por cliente, e é opcional.
      cofres: (Array.isArray(r.cofres) ? r.cofres : []).map((c) => ({
        id: String((c && c.id) || ''),
        nome: String((c && c.nome) || (c && c.id) || ''),
        janela: janelaLib.normalizarJanela(c && c.janela),
      })).filter((c) => c.id),
    };
  },

  // Segue a paginação até o fim: `proximoCursor` vem SEMPRE, com null na última
  // página. Parar na primeira deixaria segredos invisíveis sem nenhum sinal.
  async listar(cfg, opcoes = {}) {
    const itens = [];
    // CURSOR INVÁLIDO NÃO DÁ ERRO: o cofre degrada para a primeira página com
    // 200. Num laço de paginação isso é traiçoeiro — a página 1 volta no meio da
    // varredura e os mesmos segredos entram de novo na lista, sem nada indicando
    // que houve problema. Duas defesas, e as duas são baratas:
    //   - id já visto não entra duas vezes;
    //   - cursor repetido encerra a varredura (é o sinal de que o cofre voltou
    //     ao começo, ou de que ele não está avançando).
    const vistos = new Set();
    const cursoresUsados = new Set();
    let cursor = opcoes.cursor || null;
    const teto = limiteValido(opcoes.limite);
    // Trava de segurança: um `proximoCursor` que nunca vira null viraria laço
    // infinito contra o limite de 120 requisições por minuto — que é do ERP
    // INTEIRO e por IP, dividido com o navegador do próprio analista.
    for (let volta = 0; volta < 20; volta += 1) {
      if (cursor) {
        if (cursoresUsados.has(cursor)) break;
        cursoresUsados.add(cursor);
      }
      const q = parametros({ ...opcoes, cursor, limite: teto });
      const r = await pedir(cfg, 'GET', `/secrets?${q}`, null, traduzirErro);
      let novos = 0;
      for (const b of Array.isArray(r.itens) ? r.itens : []) {
        const ref = referencia(b);
        if (!ref || vistos.has(ref.id)) continue;
        vistos.add(ref.id);
        itens.push(ref);
        novos += 1;
      }
      cursor = r.proximoCursor || null;
      // Página inteira repetida com cursor novo: o cofre está andando em falso.
      // Continuar só gastaria requisição.
      if (!cursor || !novos || itens.length >= teto) break;
    }
    return { itens, proximoCursor: cursor };
  },

  async ler(cfg, id) {
    const r = await pedir(cfg, 'GET', `/secrets/${encodeURIComponent(id)}`, null, traduzirErro);
    const tipo = tipoLimpo(r.tipo);
    const comum = {
      tipo,
      usuario: r.usuario ? String(r.usuario) : '',
      // O domínio do Active Directory, quando o segredo é de RDP. E o
      // protocolo, quando o admin o preencheu — a tela usa os dois.
      dominio: r.dominio ? String(r.dominio).slice(0, 80) : '',
      protocolo: protocoloLimpo(r.protocolo),
      // `expiraEm` é PURAMENTE INFORMATIVO: o cofre não para de entregar o
      // segredo depois dessa data — não há checagem nenhuma no ERP. A leitura
      // certa é "esta senha deve ser trocada até tal dia", nunca "depois disso
      // você vai precisar pedir de novo". Nada na interface pode prometer que
      // a sessão cai, porque não cai.
      expiraEm: r.expiraEm || null,
      // A janela pode vir junto do segredo, quando o cliente tem horário fixo.
      janela: janelaLib.normalizarJanela(r.janela),
    };
    // A FORMA é decidida pelo campo que veio, não pelo nome do tipo. Antes era
    // pelo nome, e um tipo novo em forma PEM ("certificado") caía no ramo da
    // senha e estourava com "o cofre não mandou a senha" — o cofre tinha
    // mandado tudo, o app é que olhava o campo errado.
    if (typeof r.chavePrivada === 'string' && r.chavePrivada) {
      return { ...comum, chavePrivada: String(r.chavePrivada),
        passphrase: r.passphrase ? String(r.passphrase) : '' };
    }
    if (TIPOS_PEM.includes(tipo)) {
      throw new ErroDeCofre('resposta_invalida',
        `O cofre disse que o segredo é "${tipo}" (forma PEM), mas não mandou a chave privada.`,
        null, false);
    }
    if (typeof r.senha !== 'string') {
      throw new ErroDeCofre('resposta_invalida', 'O cofre não mandou o valor deste segredo.',
        null, false);
    }
    return { ...comum, senha: r.senha };
  },

  // A mesa de trabalho: os sistemas que o cliente usa, com URL para abrir.
  //
  // Não é paginado e não tem id estável por sistema — a especificação manda usar
  // `cofre + nome` como chave, e é o que se faz aqui.
  async sistemas(cfg, opcoes = {}) {
    const q = parametros({ cofre: opcoes.cofre, busca: opcoes.busca });
    const r = await pedir(cfg, 'GET', `/sistemas${q.toString() ? '?' + q : ''}`, null, traduzirErro);
    return {
      itens: (Array.isArray(r.itens) ? r.itens : []).map((s) => {
        const nome = String((s && s.nome) || '').trim();
        if (!nome) return null;
        const url = String((s && s.url) || '').trim();
        return {
          // `id` é a chave ESTÁVEL: sobrevive a renomear o sistema. O fallback
          // `cliente + nome` existe só para sistema antigo que ainda não passou
          // por um save no ERP — e é frágil de propósito reconhecido: nada
          // impede dois sistemas com o mesmo nome no mesmo cliente.
          id: String((s && s.id) || '') || `${(s && s.cofre) || ''}::${nome}`,
          idEstavel: !!(s && s.id),
          cliente: String((s && s.cofre) || ''),
          clienteNome: String((s && s.cofreNome) || ''),
          nome,
          // Só http/https entram: a URL vira `src` de um <webview> dentro do
          // app. A API promete revalidar na saída; conferir de novo aqui custa
          // uma linha e fecha a porta se a promessa falhar um dia.
          url: /^https?:\/\//i.test(url) ? url : '',
          // `campos` é texto livre preenchido pelo admin. A política do ERP diz
          // que senha não deveria vir aqui, mas nada IMPEDE — então o app trata
          // como potencialmente sensível: não registra em log e não guarda.
          campos: (Array.isArray(s && s.campos) ? s.campos : []).map((c) => ({
            nome: String((c && c.nome) || ''),
            valor: String((c && c.valor) || ''),
          })).filter((c) => c.nome),
        };
      }).filter(Boolean),
    };
  },

  // exportado para teste: os dois envelopes precisam ser conferidos lado a lado
  _traduzirErro: traduzirErro,
};
