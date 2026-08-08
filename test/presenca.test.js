'use strict';

// Testes do registro de presença entre janelas.
//
// O defeito que ele evita: com um host agendado solto numa janela própria, a
// janela principal não vê aquela aba, conclui "ninguém está com este host" e
// abre uma SEGUNDA conexão ao mesmo servidor — de novo a cada tique do relógio,
// enquanto durar a faixa de horário.
//
// Este arquivo cobre só o que o SERVIDOR faz: guardar quem anunciou o quê e
// esquecer quem parou de anunciar. A decisão ("abro ou não abro?") é do
// navegador e está em test/agenda-decisao.test.js — inclusive a regra de que
// quem pergunta não pode contar a si mesmo.
//
// As asserções abaixo são todas sobre `listar()`, que é exatamente o que a rota
// GET /api/janelas devolve. Uma versão anterior testava um `mostrandoPorOutra`
// que nenhuma linha do app chamava: treze verificações verdes sobre código
// morto.

const assert = require('assert');
const p = require('../lib/presenca');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const naoOk = (c, m) => { assert.ok(!c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

const T = 1_000_000;
const tem = (hostId, agora) => p.listar(agora).some((x) => x.hostId === hostId);

// ---------- o caso que motiva o módulo ----------

{
  p.limpar();
  // A janela solta anuncia o host RDP que está exibindo.
  p.anunciar('janela-solta', [{ hostId: 'h-rdp', kind: 'desk' }], T);
  igual(p.listar(T), [{ janela: 'janela-solta', hostId: 'h-rdp', kind: 'desk' }],
    'a janela principal precisa CONSEGUIR VER o host que está na janela solta — '
    + 'é este dado que a impede de abrir uma segunda conexão ao mesmo servidor');
  naoOk(tem('h-outro', T), 'um host que ninguém mostra não aparece');
}

// ---------- janela que morre sem avisar ----------

{
  p.limpar();
  p.anunciar('vai-morrer', [{ hostId: 'h1', kind: 'web' }], T);
  ok(tem('h1', T), 'viva, aparece');

  // Nenhuma batida desde então: um crash, um kill -9, a tampa do notebook.
  ok(tem('h1', T + p.TTL_MS), 'no limite do prazo ainda vale');
  naoOk(tem('h1', T + p.TTL_MS + 1),
    'passado o prazo some sozinha — sem isto o host agendado nunca mais reabriria');
  igual(p.listar(T + p.TTL_MS + 1), [], 'e sai do registro de vez');
}

{
  p.limpar();
  // Bater o ponto renova o prazo.
  p.anunciar('viva', [{ hostId: 'h1', kind: 'term' }], T);
  p.anunciar('viva', [{ hostId: 'h1', kind: 'term' }], T + p.TTL_MS - 1);
  ok(tem('h1', T + p.TTL_MS + 1), 'quem continua batendo o ponto continua viva');
}

{
  p.limpar();
  p.anunciar('sai-direito', [{ hostId: 'h1', kind: 'term' }], T);
  ok(p.sair('sai-direito'), 'o aviso de saída remove na hora');
  naoOk(tem('h1', T), 'sem esperar o prazo vencer — é o que faz a sessão voltar rápido '
    + 'para a janela principal quando a solta fecha');
  naoOk(p.sair('nunca-existiu'), 'sair de quem não existe não quebra');
}

// ---------- a janela troca o que está mostrando ----------

{
  p.limpar();
  p.anunciar('j', [{ hostId: 'h1', kind: 'term' }, { hostId: 'h2', kind: 'term' }], T);
  ok(tem('h2', T), 'as duas abas contam');
  // Usuário fechou a aba do h2: a batida seguinte não a inclui.
  p.anunciar('j', [{ hostId: 'h1', kind: 'term' }], T + 1000);
  naoOk(tem('h2', T + 1000),
    'a batida SUBSTITUI a lista — senão uma aba fechada ficaria marcada para sempre '
    + 'e o host agendado nunca reabriria');
  ok(tem('h1', T + 1000), 'a que ficou continua valendo');
}

{
  p.limpar();
  // Duas janelas com o MESMO host aparecem as duas: quem cruza os dados é o
  // navegador, e ele precisa saber de qual janela cada linha veio.
  p.anunciar('j1', [{ hostId: 'h1', kind: 'term' }], T);
  p.anunciar('j2', [{ hostId: 'h1', kind: 'term' }], T);
  igual(p.listar(T).map((x) => x.janela).sort(), ['j1', 'j2'],
    'a janela de origem vai junto em cada linha — sem ela quem pergunta não '
    + 'consegue descontar o próprio reflexo');
}

// ---------- entrada suja e limites ----------

{
  p.limpar();
  naoOk(p.anunciar('', [{ hostId: 'h1' }], T), 'janela sem id é recusada');
  naoOk(p.anunciar(null, [{ hostId: 'h1' }], T), 'nem null');
  igual(p.listar(T), [], 'e nada entra no registro');

  ok(p.anunciar('j', 'não é lista', T), 'itens de tipo errado não derrubam a rota');
  igual(p.listar(T), [], 'só não registram nada');

  p.anunciar('j2', [{ hostId: '', kind: 'term' }, { hostId: 'h1' }, null], T);
  igual(p.listar(T), [{ janela: 'j2', hostId: 'h1', kind: 'term' }],
    'item sem hostId e item nulo são descartados; kind ausente vira term');

  p.limpar();
  p.anunciar('j3', [{ hostId: 'h1', kind: 'inventado' }], T);
  igual(p.listar(T)[0].kind, 'term', 'tipo desconhecido cai no padrão em vez de passar adiante');
}

{
  p.limpar();
  // O id vem do cliente: um laço de requisições não pode encher a memória.
  for (let i = 0; i < p.MAX_JANELAS + 5; i++) p.anunciar('j' + i, [{ hostId: 'h' + i }], T + i);
  ok(p.listar(T + 100).length <= p.MAX_JANELAS, `no máximo ${p.MAX_JANELAS} janelas`);
  // A mais NOVA precisa sobreviver: ela é a que acabou de abrir e cuja
  // invisibilidade causaria justamente a conexão duplicada.
  ok(tem('h' + (p.MAX_JANELAS + 4), T + 100), 'a recém-chegada fica');
  // E a mais ANTIGA é a que sai. A versão anterior deste teste AFIRMAVA isso na
  // mensagem e só verificava a sobrevivente — recusar a nova em vez de despejar
  // a velha passaria verde, e é exatamente o comportamento errado.
  naoOk(tem('h0', T + 100), 'a mais antiga é a despejada');
  ok(tem('h' + (p.MAX_JANELAS + 3), T + 100), 'e a penúltima também fica');
}

{
  p.limpar();
  const muitos = Array.from({ length: 200 }, (_, i) => ({ hostId: 'h' + i, kind: 'term' }));
  p.anunciar('j', muitos, T);
  ok(p.listar(T).length <= 60, 'a lista de uma janela tem teto');
}

console.log(`\n${n} verificações passaram`);
