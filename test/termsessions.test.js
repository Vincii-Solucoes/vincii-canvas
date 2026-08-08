'use strict';

// Testes do registro de sessões de terminal.
//
// Até a v1.23.3 a conexão nascia e morria com o WebSocket: fechar a aba matava
// o shell. Isso impedia soltar uma aba numa janela própria sem perder o
// diretório atual, as variáveis de ambiente e o que estivesse rodando.
//
// A propriedade que estes testes protegem é justamente essa: o socket é só a
// tela do momento; quem é dono da conexão é a sessão. E as duas guardas que
// impedem "órfã viva" de virar vazamento — buffer com teto e TTL.

const assert = require('assert');
const { EventEmitter } = require('events');
const ts = require('../lib/termsessions');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// Socket falso com a mesma superfície que o registro usa.
function socketFalso() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.recebidas = [];
  ws.send = (m) => ws.recebidas.push(JSON.parse(m));
  ws.close = () => { ws.readyState = 3; ws.emit('close'); };
  return ws;
}
function comCanal(sessao) {
  const escrito = [];
  let encerrou = false;
  sessao.definirCanal({
    escrever: (d) => escrito.push(d),
    redimensionar: (c, r) => escrito.push(`resize:${c}x${r}`),
    encerrar: () => { encerrou = true; },
  });
  return { escrito, encerrouCanal: () => encerrou };
}

// ---------- o shell sobrevive ao socket ----------

{
  const s = ts.criar({ rotulo: 'web-01', hostId: 'h1' });
  const canal = comCanal(s);
  const ws1 = socketFalso();
  s.atacar(ws1);
  s.enviar({ t: 'ready' });
  s.enviar({ t: 'o', d: '/var/log$ ' });

  // A janela some (usuário soltou a aba, ou fechou a janela).
  ws1.close();
  ok(!s.encerrada, 'fechar o socket NÃO pode matar a sessão');
  ok(s.orfaDesde, 'a sessão precisa ficar marcada como órfã');
  ok(!canal.encerrouCanal(), 'a conexão não pode ser derrubada ao soltar a aba');

  // Enquanto órfã, a saída continua sendo acumulada.
  s.enviar({ t: 'o', d: 'linha que chegou sem janela\n' });

  // Outra janela reata.
  const ws2 = socketFalso();
  ok(s.atacar(ws2), 'reatar precisa dar certo');
  const tipos = ws2.recebidas.map((m) => m.t);
  igual(tipos, ['sessao', 'o', 'ready'], 'ao reatar: id, tela reexibida e o pronto');
  const tela = ws2.recebidas.find((m) => m.t === 'o').d;
  ok(tela.includes('/var/log$'), 'a tela de antes precisa voltar');
  ok(tela.includes('linha que chegou sem janela'),
    'o que chegou enquanto não havia janela também precisa aparecer');
  ok(!s.orfaDesde, 'depois de reatar não é mais órfã');

  // E a digitação da janela nova chega ao MESMO shell.
  ws2.emit('message', JSON.stringify({ t: 'i', d: 'pwd\n' }));
  igual(canal.escrito, ['pwd\n'], 'a tecla da janela nova vai para a conexão original');
  ws2.emit('message', JSON.stringify({ t: 'r', cols: 120, rows: 40 }));
  ok(canal.escrito.includes('resize:120x40'), 'redimensionar também');

  s.encerrar('fim do teste');
}

// ---------- fechar a aba de propósito encerra ----------

{
  const s = ts.criar({ rotulo: 'x' });
  const canal = comCanal(s);
  const ws = socketFalso();
  s.atacar(ws);
  // A janela avisa que o fechamento é intencional.
  ws.emit('message', JSON.stringify({ t: 'fim' }));
  ok(s.encerrada, '{t:fim} precisa encerrar a sessão');
  ok(canal.encerrouCanal(), 'e derrubar a conexão de verdade');
  igual(ts.pegar(s.id), undefined, 'e tirar do registro');
}

// ---------- uma janela por vez ----------

{
  const s = ts.criar({ rotulo: 'x' });
  comCanal(s);
  const ws1 = socketFalso();
  const ws2 = socketFalso();
  s.atacar(ws1);
  s.atacar(ws2);
  ok(ws1.readyState === 3, 'a janela anterior é desligada ao outra reatar');
  ok(ws1.recebidas.some((m) => m.t === 'e' && /outra janela/.test(m.d)),
    'e recebe um aviso dizendo por quê — senão a tela morre sem explicação');
  ok(s.ws === ws2, 'a sessão passa a pertencer à janela nova');
  s.encerrar('fim');
}

// ---------- as guardas contra órfã virar vazamento ----------

{
  // Buffer em anel: o começo é descartado, o fim (a tela atual) sobrevive.
  const s = ts.criar({ rotulo: 'x' });
  comCanal(s);
  s.enviar({ t: 'o', d: 'A'.repeat(ts.MAX_BUFFER) });
  s.enviar({ t: 'o', d: 'FIM-VISIVEL' });
  ok(s.buffer.length <= ts.MAX_BUFFER, 'o buffer não pode passar do teto');
  ok(s.buffer.endsWith('FIM-VISIVEL'), 'o mais recente é o que precisa sobreviver');
  s.encerrar('fim');
}

{
  // Sessão encerrada não aceita mais nada nem fica no registro.
  const s = ts.criar({ rotulo: 'x' });
  comCanal(s);
  const ws = socketFalso();
  s.atacar(ws);
  s.encerrar('teste');
  igual(ts.pegar(s.id), undefined, 'sai do registro ao encerrar');
  ok(!s.atacar(socketFalso()), 'não dá para reatar a uma sessão encerrada');
  const antes = s.buffer.length;
  s.enviar({ t: 'o', d: 'depois do fim' });
  igual(s.buffer.length, antes, 'nem acumula saída depois de encerrada');
  ok(ws.recebidas.some((m) => m.t === 'x'), 'a janela é avisada do fim');
}

{
  // Teto de sessões: a órfã mais antiga sai para a nova entrar.
  const criadas = [];
  for (let i = 0; i < ts.MAX_SESSOES + 2; i++) {
    const s = ts.criar({ rotulo: 'lote-' + i });
    comCanal(s);
    s.desatacar();          // nasce e vira órfã na hora
    criadas.push(s);
  }
  ok(ts.listar().length <= ts.MAX_SESSOES,
    `o registro não pode passar de ${ts.MAX_SESSOES} sessões`);
  ok(criadas[0].encerrada, 'a órfã mais antiga é a despejada');
  ok(!criadas[criadas.length - 1].encerrada, 'a mais nova continua viva');
  criadas.forEach((s) => s.encerrar('limpeza'));
}

{
  // O teto precisa valer TAMBÉM quando não há órfã para despejar.
  //
  // Antes, o despejo era um `if` que derrubava UMA órfã por chamada: criar mais
  // rápido do que o despejo fazia o registro passar do teto e continuar
  // crescendo. E com todas as sessões LIGADAS a alguma janela não havia órfã
  // nenhuma — nada era despejado, nada impedia a criação, e o "teto" não era
  // teto nenhum. Derrubar um terminal em uso para caber mais um seria pior, então
  // o certo é RECUSAR, com erro, para quem pediu saber que não abriu.
  const vivas = [];
  for (let i = 0; i < ts.MAX_SESSOES; i++) {
    const s = ts.criar({ rotulo: 'ligada-' + i });
    comCanal(s);
    s.atacar(socketFalso());   // ligada: não é candidata a despejo
    vivas.push(s);
  }
  igual(ts.listar().length, ts.MAX_SESSOES, 'o registro está cheio, todas ligadas');
  assert.throws(() => ts.criar({ rotulo: 'a mais' }), /[Ll]imite/,
    'sem órfã para despejar, criar RECUSA em vez de estourar o teto em silêncio');
  n += 1;
  igual(ts.listar().length, ts.MAX_SESSOES, 'e o registro continua no teto, não acima');
  ok(vivas.every((s) => !s.encerrada), 'nenhum terminal em uso foi derrubado para abrir espaço');
  vivas.forEach((s) => s.encerrar('limpeza'));
}

// ---------- id não é adivinhável ----------

{
  const ids = new Set();
  for (let i = 0; i < 50; i++) {
    const s = ts.criar({ rotulo: 'x' });
    ids.add(s.id);
    ok(/^ts_[0-9a-f-]{36}$/.test(s.id), `id fora do formato esperado: ${s.id}`);
    s.encerrar('fim');
  }
  igual(ids.size, 50, 'nenhum id pode se repetir — quem tem o id assume a sessão');
}

console.log(`\n${n} verificações passaram`);
