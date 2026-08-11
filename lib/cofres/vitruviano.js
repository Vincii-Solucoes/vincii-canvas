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

const TIPOS_DE_SEGREDO = ['senha', 'chave-ssh'];

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
const CODIGOS_ERP = {
  validation_error: { codigo: 'requisicao_invalida', transitorio: false },
  http_error: { codigo: 'requisicao_invalida', transitorio: false },
  internal_error: { codigo: 'indisponivel', transitorio: false },
};

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
        : '';
    return new ErroDeCofre(d.codigo, prefixo + (doErp.message || `erro ${status}`),
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
  const msg = doContrato.mensagem || doErp.message || `O cofre respondeu ${status}.`;
  return new ErroDeCofre(codigo, msg, espera, codigo === 'limite_de_taxa');
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
    // `caminho` PODE VIR NULL — a especificação avisa. Tratar como string sem
    // isto produziria "null" impresso na tela.
    caminho: r.caminho ? String(r.caminho) : '',
    tipo: TIPOS_DE_SEGREDO.includes(r.tipo) ? r.tipo : 'senha',
    usuario: r.usuario ? String(r.usuario) : '',
    host: r.host ? String(r.host) : '',
    porta: Number.isInteger(r.porta) ? r.porta : null,
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
    let cursor = opcoes.cursor || null;
    const teto = limiteValido(opcoes.limite);
    // Trava de segurança: um `proximoCursor` que nunca vira null viraria laço
    // infinito contra o limite de 120 requisições por minuto.
    for (let volta = 0; volta < 20; volta += 1) {
      const q = parametros({ ...opcoes, cursor, limite: teto });
      const r = await pedir(cfg, 'GET', `/secrets?${q}`, null, traduzirErro);
      for (const b of Array.isArray(r.itens) ? r.itens : []) {
        const ref = referencia(b);
        if (ref) itens.push(ref);
      }
      cursor = r.proximoCursor || null;
      if (!cursor || itens.length >= teto) break;
    }
    return { itens, proximoCursor: cursor };
  },

  async ler(cfg, id) {
    const r = await pedir(cfg, 'GET', `/secrets/${encodeURIComponent(id)}`, null, traduzirErro);
    const tipo = TIPOS_DE_SEGREDO.includes(r.tipo) ? r.tipo : 'senha';
    const comum = {
      tipo,
      usuario: r.usuario ? String(r.usuario) : '',
      expiraEm: r.expiraEm || null,
      // A janela pode vir junto do segredo, quando o cliente tem horário fixo.
      janela: janelaLib.normalizarJanela(r.janela),
    };
    if (tipo === 'chave-ssh') {
      if (!r.chavePrivada) {
        throw new ErroDeCofre('resposta_invalida',
          'O cofre disse que o segredo é uma chave SSH, mas não mandou a chave privada.',
          null, false);
      }
      return { ...comum, chavePrivada: String(r.chavePrivada),
        passphrase: r.passphrase ? String(r.passphrase) : '' };
    }
    if (typeof r.senha !== 'string') {
      throw new ErroDeCofre('resposta_invalida', 'O cofre não mandou a senha deste segredo.',
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
