'use strict';

// Trava o beco em que o cofre real caiu: endereço certo, chave certa, tipo
// errado.
//
// Um cofre foi cadastrado como "Contrato aberto" apontando para o Homem
// Vitruviano — o adaptador certo ainda não existia quando ele foi criado. O ping
// respondia, a chave era aceita, os segredos apareciam. E cliente, horário de
// atendimento e mesa de trabalho não apareciam, porque não existem naquele
// contrato. Sucesso na tela, recurso faltando, e nada apontando para a causa.
//
// Duas coisas impedem a repetição, e as duas são conferidas aqui:
//   1. o adaptador DECLARA que produto ele atende, e a tela compara com o que o
//      ping respondeu — igualdade, não palpite por pedaço de nome;
//   2. o tipo pode ser TROCADO num cofre já existente. Enquanto não podia, a
//      única saída era remover o cofre e orfanar todos os hosts dele.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cofres = require('../lib/cofres');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

const raiz = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(raiz, 'public', 'app.js'), 'utf8');

// ---------- 1. o produto declarado ----------

{
  const v = cofres.pegar('vitruviano');
  igual(v.produtoEsperado, 'Homem Vitruviano',
    'o adaptador diz o que o /v1/ping do produto dele responde em `produto`');

  const cat = cofres.catalogo();
  igual(cat.find((a) => a.tipo === 'vitruviano').produtoEsperado, 'Homem Vitruviano',
    'e o campo chega ao catálogo — sem isso a tela não teria com o que comparar');
  igual(cat.find((a) => a.tipo === 'nativo').produtoEsperado, '',
    'o contrato aberto não declara produto: ele atende qualquer um que siga o contrato, '
    + 'e apontar o dedo para um produto específico seria mentira');

  // Nenhum outro adaptador pode reivindicar o mesmo produto: dois donos do
  // mesmo nome fariam o aviso mandar trocar para o tipo errado.
  const donos = cat.filter((a) => a.produtoEsperado === 'Homem Vitruviano');
  igual(donos.length, 1, 'um produto tem UM adaptador dono');
}

// ---------- 2. a tela compara por igualdade ----------

{
  ok(/a\.produtoEsperado === i\.produto/.test(app),
    'a comparação é por IGUALDADE. A primeira versão casava pedaço de nome '
    + '("Homem" dentro de "Homem Vitruviano (ERP Vincii)") e sugeriria trocar '
    + 'para qualquer adaptador cujo nome tivesse a mesma primeira palavra');
  ok(/a\.tipo !== c\.tipo/.test(app),
    'e só sugere trocar quando o tipo é OUTRO — senão o aviso apareceria em cima '
    + 'da configuração já correta');
  ok(/Troque para/.test(app) && /Editar/.test(app),
    'o aviso diz o que fazer e onde, em vez de só constatar a divergência');
}

// ---------- 3. o tipo pode ser trocado ----------

{
  const i = app.indexOf("const sel = $('#cf_tipo')");
  ok(i > 0, 'achei o seletor de tipo no formulário de cofre');
  const trecho = app.slice(i, i + 1200);
  ok(/sel\.disabled = false/.test(trecho),
    'o seletor de tipo NÃO é desabilitado ao editar — enquanto era, a única saída '
    + 'para um tipo errado era remover o cofre e orfanar todos os hosts dele');
  ok(!/sel\.disabled = !!existente/.test(app),
    'e a trava antiga não voltou');
}

// ---------- 4. o servidor aceita a troca ----------

{
  const srv = fs.readFileSync(path.join(raiz, 'server.js'), 'utf8');
  const i = srv.indexOf('const alvo = editando');
  ok(i > 0, 'achei o caminho de edição de cofre no servidor');
  ok(/Object\.assign\(alvo, \{ apelido, tipo: adapt\.tipo/.test(srv.slice(i, i + 400)),
    'o servidor grava o tipo novo na edição — a trava era só da tela, mas se ele '
    + 'ignorasse o campo a troca seria silenciosamente descartada');
}

// ---------- 5. o que muda de verdade entre os dois tipos ----------

{
  const nativo = cofres.pegar('nativo').capacidades;
  const vitr = cofres.pegar('vitruviano').capacidades;
  ok(!nativo.clientes && !nativo.sistemas,
    'o contrato aberto não tem clientes nem mesa de trabalho — é exatamente o que '
    + '"a chave está lá, mas não compartilha nada" quer dizer');
  ok(vitr.clientes && vitr.sistemas,
    'e o adaptador do produto tem os dois: é a diferença que o usuário sente');
}

console.log(`\n${n} verificações passaram`);
