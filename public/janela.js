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

// ---------------------------------------------------------------------------
// TUDO daqui para baixo vive DENTRO desta função, e não no escopo global.
//
// No navegador estes arquivos são <script> comuns, e `const` no topo de um
// script comum vai para o escopo léxico GLOBAL — compartilhado com todos os
// outros. `agenda.js` também declara `const RE_HORA`, e duas declarações do
// mesmo nome derrubam o segundo script inteiro com SyntaxError, ANTES de
// qualquer linha rodar.
//
// O estrago não parecia com a causa: `window.estaEmAtendimento` ficava
// indefinida, `horario.js` lançava ao ser chamado, e `hostCard` morria no meio
// do desenho — a aba Hosts mostrava o cabeçalho do grupo e nenhum host dentro.
// Nada disso apontava para um nome de constante repetido.
//
// O que sai daqui é só o que for atribuído a `window` (navegador) ou a
// `module.exports` (Node), no fim do arquivo. Um `const` novo aqui dentro não
// pode mais colidir com nada. test/escopo-global.test.js confere que nenhum
// outro par de arquivos tem o mesmo problema.
// ---------------------------------------------------------------------------

(function () {

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

  // Nome de zona IANA ("America/Sao_Paulo"), além do deslocamento fixo.
  //
  // Hoje o ERP manda `-03:00`. Eles avisaram que, se o horário de verão voltar,
  // passam a mandar a ZONA — porque deslocamento fixo não representa DST. Sem
  // isto, `America/Sao_Paulo` não casava com RE_FUSO e caía no padrão `-03:00`
  // CALADO: durante o horário de verão, uma hora errada todo dia, sem erro em
  // lugar nenhum. Uma hora errada aqui é a tela travada fora do expediente com o
  // cofre recusando a credencial em laço.
  //
  // `Intl` existe nos dois lados (Node e navegador) e calcula o deslocamento PARA
  // O INSTANTE consultado — que é o único jeito certo com DST, já que ele muda ao
  // longo do ano.
  const RE_ZONA = /^[A-Za-z]{2,}(?:\/[A-Za-z0-9_+-]+){1,2}$/;
  const formatadores = new Map();

  function deslocamentoDaZona(zona, instante) {
    if (!formatadores.has(zona)) {
      let f = null;
      try {
        f = new Intl.DateTimeFormat('en-US', {
          timeZone: zona, hourCycle: 'h23',
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
      } catch { f = null; } // zona desconhecida: não inventa deslocamento
      formatadores.set(zona, f);
    }
    const f = formatadores.get(zona);
    if (!f) return null;
    const p = {};
    for (const { type, value } of f.formatToParts(instante)) p[type] = value;
    // O mesmo relógio de parede, lido como se fosse UTC. A diferença para o
    // instante real É o deslocamento da zona naquele momento.
    const comoUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
      Number(p.hour), Number(p.minute), Number(p.second));
    // Os segundos do instante são zerados dos dois lados: formatToParts arredonda
    // para o segundo, e um resto de milissegundos viraria minuto quebrado.
    const semMilis = Math.floor(instante.getTime() / 1000) * 1000;
    return Math.round((comoUtc - semMilis) / 60000);
  }

  function deslocamentoEmMinutos(fuso, instante) {
    const t = String(fuso || '').trim();
    const m = RE_FUSO.exec(t);
    if (m) {
      const sinal = m[1] === '-' ? -1 : 1;
      return sinal * (Number(m[2]) * 60 + Number(m[3]));
    }
    if (RE_ZONA.test(t) && instante instanceof Date) return deslocamentoDaZona(t, instante);
    return null;
  }

  // Um fuso é aceitável se este módulo sabe transformá-lo em deslocamento.
  // Usado pela normalização para NÃO trocar em silêncio um fuso que ela entende
  // mal por `-03:00`.
  const fusoConhecido = (f) => deslocamentoEmMinutos(f, new Date(0)) !== null;

  // O "relógio de parede" do fuso da janela: dia da semana no formato do Homem
  // Vitruviano (0 = segunda), minutos do dia, e a data em texto para casar com as
  // exceções.
  //
  // O deslocamento é somado ao instante e o resultado é lido pelos getters UTC.
  // É o único jeito de obter a hora de OUTRO fuso sem depender do fuso da máquina.
  function relogioNoFuso(agora, fuso) {
    // O instante VAI JUNTO: com zona IANA, o deslocamento depende da data
    // (horário de verão). Calcular uma vez e reusar seria o mesmo erro de uma
    // hora, só que escondido mais fundo.
    const desloc = deslocamentoEmMinutos(fuso, agora);
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
    // Fuso ilegível vira o padrão do contrato; fuso que este módulo ENTENDE é
    // preservado como veio, inclusive nome de zona.
    const fuso = fusoConhecido(bruta.fuso) ? String(bruta.fuso).trim() : '-03:00';

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
    // `fim === ini` é 24 HORAS, e não duração zero.
    //
    // O contrato diz "diaFim/fim MENORES que o início" ao descrever a volta, e
    // eu li isso como "igual não dá a volta" — fechando o turno. Errado, e caro:
    // o Homem Vitruviano codifica 24/7 exatamente assim, e com esse nome:
    //
    //   { diaInicio: 0, inicio: "00:00", diaFim: 0, fim: "00:00", rotulo: "24h" }
    //
    // Com `fim < ini`, esse turno passava a não abrir em NENHUM instante da
    // semana — o cliente 24 h do Ygor ficou sem horário nenhum, calado. Quem
    // define o significado do dado é quem o produz, não a minha leitura da prosa.
    return { ini, fim, davolta: fim <= ini };
  }

  function dentroDoTurno(t, minutosDaSemana) {
    const { ini, fim, davolta } = faixaDoTurno(t);
    // `davolta` cobre os dois casos que dão a volta: o plantão que atravessa
    // (dom 22:00 → seg 06:00) e o 24 h que fecha o círculo (fim === ini). Nos
    // dois, "dentro" é estar depois do início OU antes do fim.
    if (davolta) return minutosDaSemana >= ini || minutosDaSemana < fim;
    return minutosDaSemana >= ini && minutosDaSemana < fim;
  }

  // EXCEÇÃO NÃO É TURNO, e é aqui que a diferença mora.
  //
  // Um turno tem `diaInicio`/`diaFim`, então 22:00→06:00 significa "de hoje às
  // 22:00 até AMANHÃ às 06:00". Uma exceção não tem esses campos, e a mesma
  // escrita significa outra coisa: DENTRO DA MESMA DATA, ou seja 00:00–06:00 E
  // 22:00–24:00 daquele dia.
  //
  // O código lia as duas do mesmo payload e aplicava a semântica do turno nas
  // duas: numa véspera 22:00→06:00, a madrugada inteira (00:00–06:00) ficava de
  // fora. O sistema não abria, ninguém via erro, e a explicação na tela dizia que
  // era expediente reduzido — que é verdade, só que na metade errada do dia.
  function dentroDaExcecao(exc, minutosDoDia) {
    const ini = emMinutos(exc.inicio);
    const fim = emMinutos(exc.fim);
    if (ini === null || fim === null) return false;
    // `fim <= ini`: as duas pontas do MESMO dia, sem atravessar para o seguinte.
    // Igual é o dia inteiro, pela mesma razão do turno — quem produz o dado usa
    // essa forma para dizer "sem interrupção".
    if (fim <= ini) return minutosDoDia >= ini || minutosDoDia < fim;
    return minutosDoDia >= ini && minutosDoDia < fim;
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
      return dentroDaExcecao(exc, r.minutosDoDia);
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
      // A exceção de duas pontas (22:00→06:00) tem DOIS fins possíveis no mesmo
      // dia: quem está na madrugada termina em `fim`; quem está na noite termina
      // à meia-noite, porque a exceção não atravessa para o dia seguinte.
      let ate;
      if (fim > ini) ate = fim;
      else ate = r.minutosDoDia < fim ? fim : MIN_POR_DIA;
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

})();
