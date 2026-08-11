'use strict';

// Janela de atendimento de um cliente, como o Homem Vitruviano a descreve.
//
// É o horário em que o Canvas deve manter os sistemas daquele cliente abertos.
// Três detalhes desta especificação são armadilhas, e cada um deles quebra em
// silêncio — o sistema abre no dia errado e ninguém percebe até alguém reclamar:
//
//   1. O DIA NÃO É O DO JAVASCRIPT. Aqui `0 = segunda` e `6 = domingo`; em
//      `Date#getDay()` é `0 = domingo`. Usar um no lugar do outro desloca a
//      semana inteira em um dia, e o erro passa despercebido porque continua
//      "abrindo em algum dia".
//
//   2. O FUSO É FIXO, não o da máquina. A especificação manda `-03:00`
//      (Brasília). Calcular com o relógio local faz um analista em outro fuso —
//      ou um notebook com o fuso errado — abrir fora da hora. E o cofre RECUSA
//      a credencial fora do horário, então o erro vira um laço de tentativas.
//
//   3. UM TURNO PODE ATRAVESSAR O DIA E A SEMANA. `diaInicio 6, 22:00 →
//      diaFim 0, 06:00` é o plantão de domingo à noite que termina na segunda.
//      A comparação ingênua `inicio <= agora < fim` é sempre falsa aí.
//
// E há a regra que o documento faz questão de repetir: esta janela é
// INFORMATIVA. Quem trava de verdade é o cofre, que recusa a credencial fora do
// horário com `sem_permissao`. Por isso, na dúvida, este módulo fecha — manter
// aberto quando o cofre vai recusar produz um laço de falhas; fechar quando o
// cofre aceitaria só faz o analista clicar.

const RE_HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;
const RE_FUSO = /^([+-])(\d{2}):(\d{2})$/;
const RE_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;

const MIN_POR_DIA = 24 * 60;
const MIN_POR_SEMANA = 7 * MIN_POR_DIA;

const DIAS = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'];
const DIAS_CURTOS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

function emMinutos(hhmm) {
  const m = RE_HORA.exec(String(hhmm || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function deslocamentoEmMinutos(fuso) {
  const m = RE_FUSO.exec(String(fuso || '').trim());
  if (!m) return null;
  const sinal = m[1] === '-' ? -1 : 1;
  return sinal * (Number(m[2]) * 60 + Number(m[3]));
}

// O "relógio de parede" do fuso da janela: dia da semana no formato do Homem
// Vitruviano (0 = segunda), minutos do dia, e a data em texto para casar com as
// exceções.
//
// O deslocamento é somado ao instante e o resultado é lido pelos getters UTC.
// É o único jeito de obter a hora de OUTRO fuso sem depender do fuso da máquina.
function relogioNoFuso(agora, fuso) {
  const desloc = deslocamentoEmMinutos(fuso);
  if (desloc === null) return null;
  const t = new Date(agora.getTime() + desloc * 60000);
  // getUTCDay: 0 = domingo. Aqui 0 = segunda.
  const dia = (t.getUTCDay() + 6) % 7;
  const minutosDoDia = t.getUTCHours() * 60 + t.getUTCMinutes();
  const data = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`
    + `-${String(t.getUTCDate()).padStart(2, '0')}`;
  return { dia, minutosDoDia, data, minutosDaSemana: dia * MIN_POR_DIA + minutosDoDia };
}

const diaValido = (d) => Number.isInteger(d) && d >= 0 && d <= 6;

// Normaliza o que veio da API. Entrada de rede não é confiável: um turno com
// hora ilegível precisa ser DESCARTADO, e não virar "sempre aberto".
function normalizarJanela(bruta) {
  if (!bruta || typeof bruta !== 'object') return null;
  const fuso = RE_FUSO.test(String(bruta.fuso || '')) ? String(bruta.fuso) : '-03:00';

  const turnos = (Array.isArray(bruta.turnos) ? bruta.turnos : []).map((t) => {
    if (!t || typeof t !== 'object') return null;
    const ini = emMinutos(t.inicio);
    const fim = emMinutos(t.fim);
    if (ini === null || fim === null) return null;
    if (!diaValido(t.diaInicio) || !diaValido(t.diaFim)) return null;
    // String() em tudo, e não só na validação.
    //
    // `emMinutos` valida com String(x) — então um objeto com toString() certo
    // PASSA e era guardado cru. O estrago aparecia longe daqui: este objeto vai
    // por JSON para o navegador, vira `{}` no caminho, e lá o turno é
    // descartado. O servidor entendia "24 h" e o navegador entendia "sem
    // janela" — as duas pontas discordando, sem erro em lugar nenhum. E a
    // comparação estrita de `descreverJanela` (`inicio === '00:00'`) falhava
    // pelo mesmo motivo.
    return {
      diaInicio: t.diaInicio, inicio: String(t.inicio), diaFim: t.diaFim, fim: String(t.fim),
      rotulo: t.rotulo ? String(t.rotulo) : '',
    };
  }).filter(Boolean);

  const excecoes = (Array.isArray(bruta.excecoes) ? bruta.excecoes : []).map((e) => {
    if (!e || typeof e !== 'object' || !RE_DATA.test(String(e.data || ''))) return null;
    const fechado = e.fechado !== false;
    if (fechado) return { data: String(e.data), fechado: true, rotulo: e.rotulo ? String(e.rotulo) : '' };
    const ini = emMinutos(e.inicio);
    const fim = emMinutos(e.fim);
    // Exceção de expediente reduzido SEM horário legível não descreve nada.
    // Tratar como "aberto o dia todo" seria inventar; como fechado, é a escolha
    // conservadora que o resto do módulo segue.
    if (ini === null || fim === null) {
      return { data: String(e.data), fechado: true, rotulo: e.rotulo ? String(e.rotulo) : '' };
    }
    return { data: String(e.data), fechado: false, inicio: String(e.inicio), fim: String(e.fim),
      rotulo: e.rotulo ? String(e.rotulo) : '' };
  }).filter(Boolean);

  // Sem turno e sem exceção não há janela: é o caso "abre só quando o analista
  // clicar", e ele precisa ser distinguível de "janela que nunca abre".
  if (!turnos.length && !excecoes.length) return null;
  return { fuso, turnos, excecoes };
}

// Um turno vira uma faixa em minutos desde segunda 00:00. Quando o fim é menor
// ou igual ao início, a faixa DÁ A VOLTA na semana.
function faixaDoTurno(t) {
  const ini = t.diaInicio * MIN_POR_DIA + emMinutos(t.inicio);
  const fim = t.diaFim * MIN_POR_DIA + emMinutos(t.fim);
  return { ini, fim, davolta: fim <= ini };
}

function dentroDoTurno(t, minutosDaSemana) {
  const { ini, fim, davolta } = faixaDoTurno(t);
  if (davolta) return minutosDaSemana >= ini || minutosDaSemana < fim;
  return minutosDaSemana >= ini && minutosDaSemana < fim;
}

// A pergunta que o app faz: o cliente está em atendimento agora?
function estaEmAtendimento(janela, agora) {
  const j = normalizarJanela(janela);
  if (!j) return false;
  const r = relogioNoFuso(agora, j.fuso);
  if (!r) return false;

  // A exceção manda no DIA dela, e sobrepõe qualquer turno — inclusive um que
  // tenha começado na véspera e atravessado a meia-noite.
  //
  // Isto é uma escolha, e ela é conservadora de propósito: o documento diz que a
  // trava real é do cofre, que recusa fora do horário. Estender um plantão para
  // dentro de um feriado produziria um laço de conexões recusadas; encurtá-lo
  // faz, no pior caso, o analista clicar para abrir.
  const exc = j.excecoes.find((e) => e.data === r.data);
  if (exc) {
    if (exc.fechado) return false;
    const ini = emMinutos(exc.inicio);
    const fim = emMinutos(exc.fim);
    if (fim > ini) return r.minutosDoDia >= ini && r.minutosDoDia < fim;
    // Expediente reduzido que atravessa a meia-noite: vale até o fim do dia.
    return r.minutosDoDia >= ini;
  }

  return j.turnos.some((t) => dentroDoTurno(t, r.minutosDaSemana));
}

// Quando o atendimento em curso termina — só para a tela dizer "aberto até tal
// hora". Devolve `null` fora do atendimento.
//
// É RÓTULO, não garantia: quem decide se pode fechar é `estaEmAtendimento`,
// recalculado a cada tique. Este cálculo encadeia turnos coladinhos (um termina
// 18:00, o seguinte começa 18:00 → um período só, que é o que a pessoa vê) e
// ignora exceção de dia futuro. Um feriado amanhã pode encurtar o que está
// escrito aqui; o relógio corrige sozinho quando chegar lá.
function fimDoAtendimento(janela, agora) {
  const j = normalizarJanela(janela);
  if (!j || !estaEmAtendimento(j, agora)) return null;
  const r = relogioNoFuso(agora, j.fuso);
  if (!r) return null;

  // Aritmética só em MINUTOS À FRENTE, somados ao instante original. Reconstruir
  // uma data no fuso da janela seria a quarta chance de errar o fuso no mesmo
  // arquivo.
  const daquiA = (minutos) => new Date(agora.getTime() + minutos * 60000);

  const exc = j.excecoes.find((e) => e.data === r.data);
  if (exc) {
    const ini = emMinutos(exc.inicio);
    const fim = emMinutos(exc.fim);
    // Expediente reduzido que atravessa a meia-noite vale até o fim do dia.
    const ate = fim > ini ? fim : MIN_POR_DIA;
    return daquiA(ate - r.minutosDoDia);
  }

  let fim = null;
  for (const t of j.turnos) {
    if (!dentroDoTurno(t, r.minutosDaSemana)) continue;
    const f = faixaDoTurno(t);
    // Distância à frente, dando a volta na semana quando preciso.
    const adiante = ((f.fim - r.minutosDaSemana) % MIN_POR_SEMANA + MIN_POR_SEMANA) % MIN_POR_SEMANA
      || MIN_POR_SEMANA;
    if (fim === null || adiante > fim) fim = adiante;
  }
  if (fim === null) return null;

  // Turnos encostados viram um período só. Sem isto, "seg 08:00–12:00" +
  // "seg 12:00–18:00" mostraria "aberto até 12:00" numa quarta de manhã.
  for (let i = 0; i < j.turnos.length; i += 1) {
    const emenda = j.turnos.find((t) => {
      const f = faixaDoTurno(t);
      const inicioAdiante = ((f.ini - r.minutosDaSemana) % MIN_POR_SEMANA + MIN_POR_SEMANA)
        % MIN_POR_SEMANA;
      return inicioAdiante === fim;
    });
    if (!emenda) break;
    const f = faixaDoTurno(emenda);
    const novo = ((f.fim - r.minutosDaSemana) % MIN_POR_SEMANA + MIN_POR_SEMANA) % MIN_POR_SEMANA
      || MIN_POR_SEMANA;
    if (novo <= fim) break; // turno degenerado: não deixa o laço andar de lado
    fim = novo;
  }
  return daquiA(fim);
}

// Texto curto para a tela. Sem isto, o usuário vê o sistema abrir sozinho e não
// tem onde ler por quê.
function descreverJanela(janela) {
  const j = normalizarJanela(janela);
  if (!j) return '';
  if (!j.turnos.length) return `Só nas datas de exceção (${j.excecoes.length})`;
  const vinteQuatroSete = j.turnos.length === 1 && j.turnos[0].diaInicio === 0
    && j.turnos[0].inicio === '00:00' && j.turnos[0].diaFim === 6 && j.turnos[0].fim === '23:59';
  if (vinteQuatroSete) return '24 h, todos os dias';
  const partes = j.turnos.map((t) => {
    const mesmoDia = t.diaInicio === t.diaFim;
    const quando = mesmoDia
      ? DIAS_CURTOS[t.diaInicio]
      : `${DIAS_CURTOS[t.diaInicio]} a ${DIAS_CURTOS[t.diaFim]}`;
    return `${quando} ${t.inicio}–${t.fim}${t.rotulo ? ` (${t.rotulo})` : ''}`;
  });
  const feriados = j.excecoes.length ? ` · ${j.excecoes.length} exceção(ões)` : '';
  return `${partes.join('; ')}${feriados}`;
}

// Uso duplo, como public/agenda.js: o servidor normaliza o que vem do ERP e o
// navegador AVALIA a cada tique do relógio. Duas implementações da mesma regra
// de horário divergiriam — e a divergência aqui é a tela travada num horário em
// que o cofre já recusa a credencial.
if (typeof window !== 'undefined') {
  window.normalizarJanela = normalizarJanela;
  window.estaEmAtendimento = estaEmAtendimento;
  window.descreverJanela = descreverJanela;
  window.fimDoAtendimento = fimDoAtendimento;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizarJanela, estaEmAtendimento, descreverJanela, fimDoAtendimento,
    relogioNoFuso, dentroDoTurno, faixaDoTurno,
    DIAS, DIAS_CURTOS, MIN_POR_DIA, MIN_POR_SEMANA,
  };
}
