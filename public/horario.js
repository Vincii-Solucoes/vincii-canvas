'use strict';

// UMA resposta para "este host precisa estar aberto agora?".
//
// Existem duas fontes de horário, e elas têm formatos diferentes:
//
//   - a AGENDA do host (public/agenda.js): faixa hh:mm–hh:mm, todo dia, relógio
//     LOCAL da máquina. É o que a pessoa preenche no formulário.
//   - a JANELA DE ATENDIMENTO do cliente (public/janela.js): turnos por dia da
//     semana, fuso FIXO -03:00, com feriados. Vem do ERP pelo cofre.
//
// Sem este arquivo, as quatro perguntas do app (trava a aba? qual o motivo? abre
// sozinho? o que escrevo na etiqueta?) precisariam de um `if` cada uma — quatro
// lugares para esquecer a segunda fonte em um deles. E esquecer significa: a aba
// destrava mas o app continua reabrindo, ou o contrário.
//
// QUEM MANDA quando as duas existem: a agenda do host.
//
// A janela é o horário do CLIENTE; a agenda é uma decisão explícita de quem usa
// o app, digitada naquele host. Uma configuração digitada à mão que o sistema
// ignora em silêncio é pior do que não ter a configuração.

// De onde vêm as duas bibliotecas depende de quem está rodando: no navegador
// elas já são globais (carregadas por <script> antes deste arquivo); em Node, no
// teste, vêm por require. Resolvidas na CHAMADA, e não no carregamento, porque
// no navegador a ordem dos <script defer> não é garantia de nada.
function daLib(nome) {
  if (typeof window !== 'undefined' && typeof window[nome] === 'function') return window[nome];
  if (typeof require === 'function') {
    const a = require('./agenda');
    if (typeof a[nome] === 'function') return a[nome];
    const j = require('./janela');
    if (typeof j[nome] === 'function') return j[nome];
  }
  throw new Error(`horario.js: função "${nome}" não encontrada`);
}

// Um host tem horário quando alguma das duas fontes existe.
function fonteDeHorario(h) {
  if (!h) return null;
  if (h.agenda) return { tipo: 'agenda', agenda: h.agenda };
  const jc = h.janelaDoCofre;
  if (jc && jc.janela) return { tipo: 'cofre', janela: jc.janela, cliente: jc.cliente };
  return null;
}

const temHorario = (h) => !!fonteDeHorario(h);

function noHorario(h, agora) {
  const f = fonteDeHorario(h);
  if (!f) return false;
  return f.tipo === 'agenda'
    ? daLib('estaNaJanela')(f.agenda, agora)
    : daLib('estaEmAtendimento')(f.janela, agora);
}

function fimDoHorario(h, agora) {
  const f = fonteDeHorario(h);
  if (!f) return null;
  return f.tipo === 'agenda'
    ? daLib('fimDaJanelaAtual')(f.agenda, agora)
    : daLib('fimDoAtendimento')(f.janela, agora);
}

// Texto da etiqueta do card. Diz de ONDE veio o horário: um host que abre
// sozinho por causa do contrato do cliente e um que abre por causa do que a
// pessoa digitou são coisas diferentes, e a diferença é onde ir mexer.
function descreverHorario(h) {
  const f = fonteDeHorario(h);
  if (!f) return '';
  return f.tipo === 'agenda'
    ? daLib('descreverAgenda')(f.agenda)
    : `${f.cliente || 'cliente'}: ${daLib('descreverJanela')(f.janela)}`;
}

// Frase do cadeado, quando a pessoa tenta fechar a aba.
function motivoDoHorario(h, agora) {
  const f = fonteDeHorario(h);
  if (!f) return '';
  const fim = fimDoHorario(h, agora);
  const ate = fim
    ? ` até ${fim.toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
    : '';
  if (f.tipo === 'agenda') {
    return `Aberto pela agenda deste host (${daLib('descreverAgenda')(f.agenda)})${ate}.`
      + ' Não dá para fechar agora.';
  }
  return `Aberto pelo horário de atendimento de ${f.cliente || 'este cliente'} `
    + `(${daLib('descreverJanela')(f.janela)})${ate}. Não dá para fechar agora.`;
}

if (typeof window !== 'undefined') {
  window.fonteDeHorario = fonteDeHorario;
  window.temHorario = temHorario;
  window.noHorario = noHorario;
  window.fimDoHorario = fimDoHorario;
  window.descreverHorario = descreverHorario;
  window.motivoDoHorario = motivoDoHorario;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { fonteDeHorario, temHorario, noHorario, fimDoHorario,
    descreverHorario, motivoDoHorario };
}
