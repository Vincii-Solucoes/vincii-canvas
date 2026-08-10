'use strict';

// Adaptador do CONTRATO ABERTO (docs/cofres-de-credenciais.md, Parte A).
//
// É o provedor mais simples possível: o produto do outro lado já fala o formato
// canônico, então aqui não há tradução — só transporte, validação do que chegou
// e o mapeamento de erro.
//
// Serve de MODELO para os demais adaptadores. Um adaptador é sempre isto:
//   - um descritor (tipo, nome, campos de configuração, capacidades);
//   - ping / listar / ler, devolvendo o formato canônico;
//   - tradução do erro do produto para os códigos que o núcleo entende.
// Nada mais. Nenhum adaptador guarda estado, decide retentativa ou fala com a
// interface — isso é do núcleo, e é o que impede cada produto novo de trazer
// junto a sua própria versão dessas regras.

const { pedir, ErroDeCofre } = require('./http');

const TIPOS_DE_SEGREDO = ['senha', 'chave-ssh'];

// Traduz o corpo de erro do contrato para um ErroDeCofre. O contrato já usa os
// mesmos códigos do núcleo, então aqui é quase identidade — mas passar por esta
// função de propósito garante que um código desconhecido vire `indisponivel`
// (que o núcleo trata com recuo) em vez de escapar como string solta.
const CODIGOS = new Set([
  'chave_invalida', 'chave_expirada', 'sem_permissao',
  'nao_encontrado', 'limite_de_taxa', 'indisponivel', 'sem_listagem',
]);

function traduzirErro(status, corpo, cabecalhos) {
  const e = (corpo && corpo.erro) || {};
  let codigo = CODIGOS.has(e.codigo) ? e.codigo : null;
  if (!codigo) {
    // O produto respondeu erro fora do contrato. Deduz pelo status, para o
    // núcleo ainda conseguir decidir entre "tenta de novo" e "para tudo".
    if (status === 401) codigo = 'chave_invalida';
    else if (status === 403) codigo = 'sem_permissao';
    else if (status === 404) codigo = 'nao_encontrado';
    else if (status === 429) codigo = 'limite_de_taxa';
    else if (status === 501) codigo = 'sem_listagem';
    else codigo = 'indisponivel';
  }
  const espera = Number(cabecalhos && cabecalhos['retry-after']) || null;
  return new ErroDeCofre(codigo, e.mensagem || `O cofre respondeu ${status}.`, espera);
}

// A referência é montada CAMPO A CAMPO, e não repassada inteira.
//
// Se o produto mandar um campo a mais — inclusive um valor de segredo por
// engano do outro lado — ele para aqui e não entra no app. É a mesma razão de o
// cofre de mentira derivar a listagem por omissão explícita.
function referencia(bruto) {
  const r = bruto || {};
  const id = String(r.id || '').trim();
  if (!id) return null;
  return {
    id,
    nome: String(r.nome || id),
    caminho: r.caminho ? String(r.caminho) : '',
    tipo: TIPOS_DE_SEGREDO.includes(r.tipo) ? r.tipo : 'senha',
    usuario: r.usuario ? String(r.usuario) : '',
    host: r.host ? String(r.host) : '',
    porta: Number.isInteger(r.porta) ? r.porta : null,
  };
}

module.exports = {
  tipo: 'nativo',
  nome: 'Contrato aberto (API de credenciais v1)',
  descricao: 'Qualquer cofre que implemente as três rotas de docs/cofres-de-credenciais.md.',

  config: [
    { chave: 'baseUrl', rotulo: 'Endereço da API', tipo: 'url', obrigatorio: true,
      dica: 'ex.: https://cofre.empresa.com.br/v1' },
    { chave: 'chave', rotulo: 'Chave de API', tipo: 'senha', obrigatorio: true, segredo: true,
      dica: 'vai no cabeçalho Authorization: Bearer' },
  ],

  capacidades: { listar: true, buscar: true, tipos: TIPOS_DE_SEGREDO },

  async ping(cfg) {
    const r = await pedir(cfg, 'GET', '/ping', null, traduzirErro);
    return {
      produto: String(r.produto || 'desconhecido'),
      versao: String(r.versao || '?'),
      rotuloDaChave: String((r.chave && r.chave.rotulo) || ''),
      expiraEm: (r.chave && r.chave.expiraEm) || null,
      permissoes: Array.isArray(r.permissoes) ? r.permissoes.map(String) : [],
      cofres: Array.isArray(r.cofres)
        ? r.cofres.map((c) => ({ id: String(c.id || ''), nome: String(c.nome || c.id || '') }))
        : [],
    };
  },

  async listar(cfg, { busca, cursor, limite } = {}) {
    const q = new URLSearchParams();
    if (busca) q.set('busca', String(busca));
    if (cursor) q.set('cursor', String(cursor));
    q.set('limite', String(Math.min(Number(limite) || 50, 200)));
    const r = await pedir(cfg, 'GET', `/secrets?${q}`, null, traduzirErro);
    return {
      itens: (Array.isArray(r.itens) ? r.itens : []).map(referencia).filter(Boolean),
      proximoCursor: r.proximoCursor || null,
    };
  },

  async ler(cfg, id) {
    const r = await pedir(cfg, 'GET', `/secrets/${encodeURIComponent(id)}`, null, traduzirErro);
    const tipo = TIPOS_DE_SEGREDO.includes(r.tipo) ? r.tipo : 'senha';
    if (tipo === 'chave-ssh') {
      if (!r.chavePrivada) {
        throw new ErroDeCofre('resposta_invalida',
          'O cofre disse que o segredo é uma chave SSH, mas não mandou a chave privada.');
      }
      return {
        tipo, usuario: r.usuario ? String(r.usuario) : '',
        chavePrivada: String(r.chavePrivada),
        passphrase: r.passphrase ? String(r.passphrase) : '',
        expiraEm: r.expiraEm || null,
      };
    }
    if (typeof r.senha !== 'string') {
      throw new ErroDeCofre('resposta_invalida',
        'O cofre não mandou a senha deste segredo.');
    }
    return {
      tipo, usuario: r.usuario ? String(r.usuario) : '',
      senha: r.senha,
      expiraEm: r.expiraEm || null,
    };
  },
};
