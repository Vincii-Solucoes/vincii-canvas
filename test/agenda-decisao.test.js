'use strict';

// Testes da decisão do vigia da agenda: "este host está na faixa de horário —
// abro, trago de volta, ou não faço nada?"
//
// Esta função é onde moram os erros caros da funcionalidade, e todos eles são
// SILENCIOSOS — nenhum estoura, nenhum aparece em log:
//
//   - abrir o que já está aberto => duas conexões ao mesmo servidor, e mais uma
//     a cada dez segundos enquanto durar a faixa;
//   - não reconhecer a sessão órfã => a aba solta que o usuário fechou não volta
//     para o Terminal e morre no TTL de cinco minutos;
//   - reconhecer a órfã CEDO DEMAIS => a janela principal rouba a sessão da
//     janela solta que ainda está carregando;
//   - ignorar o intervalo entre tentativas => host fora do ar vira laço de
//     reconexão pelas oito horas da janela de manutenção.
//
// A ORDEM das regras é parte do contrato: cada uma desarma a seguinte num caso
// específico. Os testes abaixo montam justamente os casos em que duas regras
// disputam a mesma situação.

const assert = require('assert');
const {
  decidirAcao, ESPERA_ENTREGA_MS, ESPERA_ENTRE_TENTATIVAS_MS,
} = require('../public/agenda');

let n = 0;
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };
const ok = (c, m) => { assert.ok(c, m); n += 1; };

const T = 10_000_000;
const EU = 'janela-principal';
// Base sem nada acontecendo: o host não está em lugar nenhum.
const base = (extra = {}) => decidirAcao({
  hostId: 'h1', janelaId: EU, agora: T, minhas: [], presenca: [], sessoes: [],
  entregueEm: 0, ultimaTentativa: 0, ...extra,
});

// ---------- o caso comum ----------

{
  const d = base();
  igual(d.acao, 'abrir', 'host agendado que não está aberto em lugar nenhum é aberto');
  igual(d.primeira, true, 'a primeira tentativa desta entrada na faixa avisa na tela');
}

{
  igual(base({ minhas: [{ hostId: 'h1', status: 'conectado' }] }).acao, 'nada',
    'já aberto aqui: não abrir de novo');
  igual(base({ minhas: [{ hostId: 'h1', status: 'conectando' }] }).acao, 'nada',
    'AINDA CONECTANDO também conta — senão dois tiques durante uma conexão lenta '
    + 'abrem duas conexões ao mesmo servidor');
  igual(base({ minhas: [{ hostId: 'h1', status: 'encerrado' }] }).acao, 'abrir',
    'aba cuja conexão morreu NÃO conta: a promessa é manter aberto, então reabre');
  igual(base({ minhas: [{ hostId: 'outro', status: 'conectado' }] }).acao, 'abrir',
    'aba de outro host não impede nada');
}

// ---------- outra janela é a dona ----------

{
  igual(base({ presenca: [{ janela: 'solta', hostId: 'h1' }] }).acao, 'nada',
    'aberto numa janela solta: a principal não pode abrir uma segunda');
  igual(base({ presenca: [{ janela: EU, hostId: 'h1' }] }).acao, 'abrir',
    'a própria janela no registro de presença NÃO conta — quem pergunta veria o '
    + 'próprio reflexo e nunca abriria nada');
  igual(base({ presenca: [{ janela: 'solta', hostId: 'outro' }] }).acao, 'abrir',
    'outra janela com OUTRO host não bloqueia');
}

// ---------- a sessão viva sem janela volta para cá ----------

{
  const d = base({ sessoes: [{ id: 'ts_1', hostId: 'h1', orfa: true }] });
  igual(d.acao, 'reatar', 'sessão viva sem janela VOLTA para uma aba, em vez de morrer');
  igual(d.sessaoId, 'ts_1', 'e volta pelo id certo — é ele que preserva o shell');

  igual(base({ sessoes: [{ id: 'ts_1', hostId: 'h1', orfa: false }] }).acao, 'abrir',
    'sessão LIGADA a alguma janela não é órfã; se ninguém a declarou na presença, '
    + 'ela não é candidata a voltar');
  igual(base({ sessoes: [{ id: 'ts_1', hostId: 'outro', orfa: true }] }).acao, 'abrir',
    'órfã de outro host não serve');
}

// ---------- a carência de entrega, que é a regra mais sutil ----------

{
  // O instante exato depois de soltar a aba: a aba já saiu daqui, a janela nova
  // ainda não carregou, e a sessão está órfã no servidor. Sem a carência, a
  // regra da órfã dispara e as duas janelas brigam pela mesma sessão.
  const emEntrega = {
    sessoes: [{ id: 'ts_1', hostId: 'h1', orfa: true }],
    entregueEm: T - 1000,
  };
  igual(base(emEntrega).acao, 'nada',
    'órfã recém-entregue a outra janela NÃO pode ser puxada de volta — a janela '
    + 'nova ainda está abrindo');
  ok(base({ ...emEntrega, entregueEm: T - ESPERA_ENTREGA_MS + 1 }).acao === 'nada',
    'dentro da carência, continua esperando');
  igual(base({ ...emEntrega, entregueEm: T - ESPERA_ENTREGA_MS }).acao, 'reatar',
    'passada a carência sem ninguém assumir, a sessão volta — é o caso de a janela '
    + 'nova ter falhado ao abrir');
}

{
  // A carência não pode segurar para sempre: se a janela nova ASSUMIU, quem
  // bloqueia é a presença, e ela não tem prazo.
  const d = base({ presenca: [{ janela: 'solta', hostId: 'h1' }], entregueEm: T - 999_999 });
  igual(d.acao, 'nada', 'assumida por outra janela, continua sendo dela');
}

{
  // `assumida` é o sinal que encurta a espera do usuário. Sem ele, fechar a
  // janela solta dois segundos depois de soltá-la deixava a aba sumida da tela
  // pelos 18 segundos restantes da carência, sem nada acontecendo — parecia que
  // a sessão tinha se perdido.
  const d = base({ presenca: [{ janela: 'solta', hostId: 'h1' }], entregueEm: T - 2000 });
  igual(d.assumida, true, 'ver a outra janela declarada é PROVA de que a entrega deu certo');
  ok(!base({ entregueEm: T - 2000 }).assumida,
    'sem ninguém declarado, não há prova nenhuma — a carência tem de valer inteira');
  ok(!base().assumida, 'e nada a descartar quando não houve entrega');
}

// ---------- o intervalo entre tentativas ----------

{
  igual(base({ ultimaTentativa: T - 1000 }).acao, 'nada',
    'host que acabou de falhar não é tentado de novo no tique seguinte');
  igual(base({ ultimaTentativa: T - ESPERA_ENTRE_TENTATIVAS_MS + 1 }).acao, 'nada',
    'dentro do intervalo, espera');
  const d = base({ ultimaTentativa: T - ESPERA_ENTRE_TENTATIVAS_MS });
  igual(d.acao, 'abrir', 'passado o intervalo, tenta de novo — a promessa é manter aberto');
  igual(d.primeira, false,
    'mas NÃO avisa de novo na tela: numa faixa de 8 horas com o servidor fora do ar '
    + 'seriam centenas de avisos idênticos');
}

{
  // O intervalo NÃO pode atrasar a volta de uma sessão viva: ela não é uma
  // tentativa de conexão, é uma aba mudando de janela.
  const d = base({
    sessoes: [{ id: 'ts_1', hostId: 'h1', orfa: true }],
    ultimaTentativa: T - 1000,
  });
  igual(d.acao, 'reatar',
    'trazer de volta uma sessão que já está conectada não é "tentar conectar" — '
    + 'segurá-la por um minuto deixaria a aba sumida da tela sem motivo');
}

// ---------- precedência entre regras ----------

{
  // Aberto aqui vence tudo: mesmo com órfã no servidor e nada mais.
  igual(base({
    minhas: [{ hostId: 'h1', status: 'conectado' }],
    sessoes: [{ id: 'ts_1', hostId: 'h1', orfa: true }],
  }).acao, 'nada', 'uma órfã pendurada não faz abrir uma segunda aba do que já está aqui');

  // Outra janela vence a órfã.
  igual(base({
    presenca: [{ janela: 'solta', hostId: 'h1' }],
    sessoes: [{ id: 'ts_1', hostId: 'h1', orfa: true }],
  }).acao, 'nada', 'com outra janela declarada, a órfã é de outra sessão — não puxar');
}

// ---------- socket vivo no servidor vence a presença ----------

// A presença depende de a outra janela conseguir bater o ponto a cada 5 s, e o
// Chromium estrangula temporizador de janela em segundo plano. Bastava a máquina
// suspender, ou um diálogo bloqueante numa janela solta, para o prazo de 20 s
// vencer com a janela VIVA — e a principal abria uma segunda conexão ao mesmo
// servidor, já travada pela agenda e impossível de fechar.
//
// `ligada` vem do WebSocket do próprio servidor: existe independentemente de o
// renderer da outra janela estar acordado.

{
  const d = base({ sessoes: [{ hostId: 'h1', orfa: false, ligada: true }] });
  igual(d.acao, 'nada',
    'sessão com socket vivo no servidor é de ALGUÉM — não abrir uma segunda');
  igual(d.assumida, true, 'e isso também é prova de entrega concluída');
  // A conta não depende de id nenhum: o servidor deixou de publicar o id de
  // sessão VIVA, porque quem tem o id reata e rouba o shell (expulsa a janela
  // atual e recebe os últimos 256 KB de saída). Contar responde a mesma pergunta
  // sem entregar a chave.
  ok(!('id' in d), 'a decisão não precisa de id de sessão viva');
}

{
  // Sem presença nenhuma declarada: é exatamente o cenário da janela suspensa.
  const d = base({
    presenca: [],
    sessoes: [{ id: 'ts_1', hostId: 'h1', orfa: false, ligada: true }],
  });
  igual(d.acao, 'nada', 'a presença ter vencido não autoriza duplicar a conexão');
}

{
  // A MINHA própria sessão não pode me bloquear.
  const d = base({
    minhas: [{ hostId: 'h1', kind: 'term', status: 'conectado' }],
    sessoes: [{ hostId: 'h1', orfa: false, ligada: true }],
  });
  igual(d.acao, 'nada', 'com uma ligada no servidor e uma minha, a conta bate: é a minha');
  igual(d.motivo, 'já está aberto nesta janela', 'e quem responde é a regra 1');
}

{
  // Duas ligadas no servidor e só uma minha: a segunda é de outra janela.
  const d = base({
    minhas: [{ hostId: 'h1', kind: 'term', status: 'conectado' }],
    sessoes: [{ hostId: 'h1', ligada: true }, { hostId: 'h1', ligada: true }],
  });
  igual(d.acao, 'nada', 'sobra uma ligada que não é minha');

  // Aba MORTA minha não entra na conta: senão uma sessão fantasma no servidor
  // faria a agenda desistir de reabrir para sempre.
  const d2 = base({
    minhas: [{ hostId: 'h1', kind: 'term', status: 'encerrado' }],
    sessoes: [],
  });
  igual(d2.acao, 'abrir', 'aba morta não conta de nenhum lado');

  // Aba de RDP/VNC/web não tem sessão no servidor: contá-la mascararia uma
  // sessão de terminal alheia.
  const d3 = base({
    minhas: [{ hostId: 'h1', kind: 'desk', status: 'conectado' }],
    sessoes: [{ hostId: 'h1', ligada: true }],
  });
  igual(d3.acao, 'nada', 'a de terminal ligada no servidor não é a minha aba de RDP');
  igual(d3.motivo, 'já está aberto nesta janela',
    'aqui a regra 1 já basta — mas a contagem não pode CREDITAR a aba de RDP');
}

{
  igual(base({ sessoes: [{ hostId: 'h1', orfa: false, ligada: false }] }).acao,
    'abrir', 'sessão sem socket e sem marca de órfã não prova nada');
}

// ---------- relógio remexido ----------

// Os prazos são medidos com Date.now(), que é relógio de parede. Um acerto do
// sistema para trás (NTP, ou o usuário mudando a hora justamente para TESTAR a
// agenda) torna `agora - marca` negativo. Com um `< PRAZO` simples, toda
// carência passava a valer pelo tamanho inteiro do salto — a agenda ficava
// parada por horas, e `entregandoParaOutraJanela` guardava um carimbo no futuro.

{
  igual(base({ entregueEm: T + 3600_000 }).acao, 'abrir',
    'carência de entrega com carimbo no futuro não pode segurar a agenda');
  igual(base({ ultimaTentativa: T + 3600_000 }).acao, 'abrir',
    'nem o intervalo entre tentativas');
  const d = base({
    entregueEm: T + 3600_000,
    sessoes: [{ id: 'ts_1', hostId: 'h1', orfa: true }],
  });
  igual(d.acao, 'reatar', 'e a sessão órfã volta em vez de ficar esperando o relógio');
}

// ---------- entrada degenerada ----------

{
  igual(decidirAcao({ hostId: 'h1', janelaId: EU, agora: T }).acao, 'abrir',
    'listas ausentes não podem derrubar o ciclo do relógio');
  igual(base({ minhas: [{ status: 'conectado' }] }).acao, 'abrir',
    'sessão sem hostId (terminal local) nunca casa com um host agendado');
  igual(base({ hostId: '' }).acao, 'nada',
    'host sem id não pode disparar abertura — não há o que abrir');
}

console.log(`\n${n} verificações passaram`);
