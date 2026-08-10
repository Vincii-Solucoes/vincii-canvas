'use strict';

// Registro de adaptadores de cofre.
//
// Acrescentar um produto é acrescentar um arquivo aqui e uma linha na lista.
// Nenhum outro ponto do app precisa saber que ele existe: a tela de
// configuração se monta a partir do descritor, e o núcleo
// (lib/credenciais.js) só conhece o formato canônico.
//
// A validação abaixo roda no carregamento, de propósito. Um adaptador
// malformado precisa quebrar agora, com a mensagem dizendo o que falta — e não
// numa madrugada, no meio de uma conexão, com um `undefined is not a function`.

const nativo = require('./nativo');

const ADAPTADORES = [nativo];

const OBRIGATORIOS = ['tipo', 'nome', 'config', 'capacidades', 'ping', 'listar', 'ler'];

const porTipo = new Map();
for (const a of ADAPTADORES) {
  for (const campo of OBRIGATORIOS) {
    if (a[campo] === undefined) {
      throw new Error(`Adaptador de cofre sem "${campo}": ${a.tipo || '(sem tipo)'}`);
    }
  }
  if (porTipo.has(a.tipo)) throw new Error(`Dois adaptadores com o tipo "${a.tipo}".`);
  for (const c of a.config) {
    if (!c.chave || !c.rotulo) throw new Error(`Campo de config incompleto em "${a.tipo}".`);
  }
  porTipo.set(a.tipo, a);
}

const pegar = (tipo) => porTipo.get(String(tipo || '')) || null;

// O que a interface precisa para desenhar a tela de configuração, sem conhecer
// nenhum produto. Os campos marcados `segredo` vão junto: a tela precisa saber
// quais renderizar como senha e quais nunca reexibir.
function catalogo() {
  return ADAPTADORES.map((a) => ({
    tipo: a.tipo,
    nome: a.nome,
    descricao: a.descricao || '',
    config: a.config.map((c) => ({ ...c })),
    capacidades: { ...a.capacidades },
  }));
}

// Quais chaves de config são segredo — usado para separar o que vai para o
// armazenamento protegido do que fica no data.json (e no backup).
function camposSecretos(tipo) {
  const a = pegar(tipo);
  return a ? a.config.filter((c) => c.segredo).map((c) => c.chave) : [];
}

module.exports = { pegar, catalogo, camposSecretos, ADAPTADORES };
