'use strict';

// Testes do registro de presença entre janelas.
//
// O defeito que ele evita: com um host agendado solto numa janela própria, a
// janela principal não vê aquela aba, conclui "ninguém está com este host" e
// abre uma SEGUNDA conexão ao mesmo servidor — de novo a cada tique do relógio,
// enquanto durar a faixa de horário.
//
// As duas propriedades que precisam valer sempre:
//   - quem pergunta não pode enxergar o próprio reflexo (senão nada abre nunca);
//   - janela que morreu de crash precisa sumir sozinha (senão nada reabre nunca).

const assert = require('assert');
const p = require('../lib/presenca');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const naoOk = (c, m) => { assert.ok(!c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

const T0 = 1_000_000;

// ---------- o caso que motiva o módulo ----------

{
  p.limpar();
  // A janela solta anuncia o host RDP que está exibindo.
  p.anunciar('janela-solta', [{ hostId: 'h-rdp', kind: 'desk' }], T0);

  ok(p.mostrandoPorOutra('h-rdp', 'janela-principal', T0),
    'a principal precisa VER o host que está na janela solta — é isso que a impede '
    + 'de abrir uma segunda conexão ao mesmo servidor');
  naoOk(p.mostrandoPorOutra('h-outro', 'janela-principal', T0),
    'um host que ninguém mostra continua livre para abrir');
}

{
  p.limpar();
  // A armadilha: a própria janela anuncia o que está mostrando. Se ela se
  // enxergasse na consulta, concluiria que "já tem alguém" e nunca abriria nada.
  p.anunciar('eu', [{ hostId: 'h1', kind: 'term' }], T0);
  naoOk(p.mostrandoPorOutra('h1', 'eu', T0), 'quem pergunta não conta a si mesmo');
  ok(p.mostrandoPorOutra('h1', 'outra', T0), 'mas conta para as demais');
}

// ---------- janela que morre sem avisar ----------

{
  p.limpar();
  p.anunciar('vai-morrer', [{ hostId: 'h1', kind: 'web' }], T0);
  ok(p.mostrandoPorOutra('h1', 'x', T0), 'viva, aparece');

  // Nenhuma batida desde então: um crash, um kill -9, a tampa do notebook.
  ok(p.mostrandoPorOutra('h1', 'x', T0 + p.TTL_MS), 'no limite do prazo ainda vale');
  naoOk(p.mostrandoPorOutra('h1', 'x', T0 + p.TTL_MS + 1),
    'passado o prazo some sozinha — sem isto o host agendado nunca mais reabriria');
  igual(p.listar(T0 + p.TTL_MS + 1), [], 'e sai do registro de vez');
}

{
  p.limpar();
  // Bater o ponto renova o prazo.
  p.anunciar('viva', [{ hostId: 'h1', kind: 'term' }], T0);
  p.anunciar('viva', [{ hostId: 'h1', kind: 'term' }], T0 + p.TTL_MS - 1);
  ok(p.mostrandoPorOutra('h1', 'x', T0 + p.TTL_MS + 1),
    'quem continua batendo o ponto continua viva');
}

{
  p.limpar();
  p.anunciar('sai-direito', [{ hostId: 'h1', kind: 'term' }], T0);
  ok(p.sair('sai-direito'), 'o aviso de saída remove na hora');
  naoOk(p.mostrandoPorOutra('h1', 'x', T0), 'sem esperar o prazo vencer');
  naoOk(p.sair('nunca-existiu'), 'sair de quem não existe não quebra');
}

// ---------- a janela troca o que está mostrando ----------

{
  p.limpar();
  p.anunciar('j', [{ hostId: 'h1', kind: 'term' }, { hostId: 'h2', kind: 'term' }], T0);
  ok(p.mostrandoPorOutra('h2', 'x', T0), 'as duas abas contam');
  // Usuário fechou a aba do h2: a batida seguinte não a inclui.
  p.anunciar('j', [{ hostId: 'h1', kind: 'term' }], T0 + 1000);
  naoOk(p.mostrandoPorOutra('h2', 'x', T0 + 1000),
    'a batida SUBSTITUI a lista — senão uma aba fechada ficaria marcada para sempre '
    + 'e o host agendado nunca reabriria');
  ok(p.mostrandoPorOutra('h1', 'x', T0 + 1000), 'a que ficou continua valendo');
}

// ---------- entrada suja e limites ----------

{
  p.limpar();
  naoOk(p.anunciar('', [{ hostId: 'h1' }], T0), 'janela sem id é recusada');
  naoOk(p.anunciar(null, [{ hostId: 'h1' }], T0), 'nem null');
  igual(p.listar(T0), [], 'e nada entra no registro');

  ok(p.anunciar('j', 'não é lista', T0), 'itens de tipo errado não derrubam a rota');
  igual(p.listar(T0), [], 'só não registram nada');

  p.anunciar('j2', [{ hostId: '', kind: 'term' }, { hostId: 'h1' }, null], T0);
  igual(p.listar(T0), [{ janela: 'j2', hostId: 'h1', kind: 'term' }],
    'item sem hostId e item nulo são descartados; kind ausente vira term');

  p.limpar();
  p.anunciar('j3', [{ hostId: 'h1', kind: 'inventado' }], T0);
  igual(p.listar(T0)[0].kind, 'term', 'tipo desconhecido cai no padrão em vez de passar adiante');
}

{
  p.limpar();
  // O id vem do cliente: um laço de requisições não pode encher a memória.
  for (let i = 0; i < p.MAX_JANELAS + 5; i++) p.anunciar('j' + i, [{ hostId: 'h' + i }], T0 + i);
  ok(p.listar(T0 + 100).length <= p.MAX_JANELAS, `no máximo ${p.MAX_JANELAS} janelas`);
  // A mais NOVA precisa sobreviver: ela é a que acabou de abrir e cuja invisibilidade
  // causaria justamente a conexão duplicada.
  ok(p.mostrandoPorOutra('h' + (p.MAX_JANELAS + 4), 'x', T0 + 100),
    'ao lotar, despeja a mais antiga e mantém a recém-chegada');
}

{
  p.limpar();
  const muitos = Array.from({ length: 200 }, (_, i) => ({ hostId: 'h' + i, kind: 'term' }));
  p.anunciar('j', muitos, T0);
  ok(p.listar(T0).length <= 60, 'a lista de uma janela tem teto');
}

console.log(`\n${n} verificações passaram`);
