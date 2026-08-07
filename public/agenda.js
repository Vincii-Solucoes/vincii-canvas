'use strict';

// Agenda de um host: dias da semana + faixa de horário em que a conexão dele
// precisa ficar aberta.
//
// Durante a faixa o app abre a sessão sozinho e ela não pode ser fechada — o
// "×" da aba some. Fora da faixa nada muda: a aba continua aberta e volta a ser
// fechável. Nada é derrubado automaticamente no fim do período; interromper um
// comando em execução seria pior do que deixar uma aba a mais na tela.
//
// Tudo aqui é horário LOCAL da máquina. O app é local por definição (o servidor
// escuta só em 127.0.0.1), então o relógio de quem usa é o relógio certo — e
// converter para UTC só criaria uma discrepância na virada do horário de verão.
//
// A regra que mais dá errado é a faixa que ATRAVESSA A MEIA-NOITE (22:00–02:00,
// uma janela de manutenção típica). Nela a comparação ingênua
// `minutos >= inicio && minutos < fim` é sempre falsa, e a agenda simplesmente
// nunca abriria. O tratamento está em `estaNaJanela` e é o motivo de este
// módulo existir separado, com teste próprio.

// 0 = domingo, igual a Date#getDay().
const DIAS_CURTOS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const DIAS_LONGOS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

const RE_HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

// "24:00" existe só como FIM, e significa o fim do dia.
//
// Sem ele não havia como pedir 24 horas contínuas: `estaNaJanela` compara
// `min < fim`, então 00:00–23:59 deixa o minuto das 23:59 de fora — um buraco de
// 60 segundos por dia, todo dia. E a mensagem de erro deste módulo chegou a
// RECOMENDAR 00:00–23:59 como "o dia inteiro", o que era falso.
const FIM_DO_DIA = '24:00';

function emMinutos(hhmm, aceitaFimDoDia) {
  const t = String(hhmm || '');
  if (aceitaFimDoDia && t === FIM_DO_DIA) return 24 * 60;
  const m = RE_HORA.exec(t);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Prazo já vencido?
//
// A comparação é sempre `agora - marca`, com `agora` vindo de Date.now() — que é
// relógio de PAREDE. Um acerto do sistema para trás (NTP, o usuário mexendo na
// hora para testar a agenda) torna a diferença negativa, e um `< PRAZO` simples
// passaria a ser verdadeiro pelo tamanho inteiro do salto: a carência ficaria
// presa por horas. Diferença negativa é sinal de relógio remexido, e aí o certo
// é destravar, não travar mais.
function venceu(agora, marca, prazo) {
  if (!marca) return true;
  const decorrido = agora - marca;
  return decorrido < 0 || decorrido >= prazo;
}

// Valida e põe em forma canônica. Devolve `null` quando não há agenda (o caso
// normal: a esmagadora maioria dos hosts não tem) e lança com mensagem em
// português quando há agenda mal preenchida — a mensagem vai direto para a tela.
//
// Usada nos DOIS lados: no servidor, ao salvar e ao importar um backup; e no
// navegador, para não deixar o formulário enviar lixo. Uma validação só, para
// não haver duas regras discordando.
function normalizarAgenda(bruto) {
  if (bruto === null || bruto === undefined || bruto === '') return null;
  if (typeof bruto !== 'object' || Array.isArray(bruto)) {
    throw new Error('Agenda inválida.');
  }
  // Os dias chegam como lista (do formulário) ou como texto separado por vírgula
  // (do XML de backup). Separadores vazios são descartados; QUALQUER outro
  // conteúdo é recusado com erro.
  //
  // Recusar é o ponto. Antes, `Number(String(d).trim())` convertia e um filtro
  // silencioso jogava fora o que não fosse 0..6 — só que `Number('')` é ZERO, um
  // dia perfeitamente válido. Efeito medido: `dias=""` virava `[0]` e o host
  // passava a abrir sozinho aos DOMINGOS, e `dias="1,,3"` virava `[0,1,3]` —
  // domingo de brinde num arquivo que só pedia segunda e quarta. Nada estourava,
  // nada aparecia no resumo da importação, e o cadastro na tela parecia normal.
  const brutos = Array.isArray(bruto.dias) ? bruto.dias
    : (typeof bruto.dias === 'string' ? bruto.dias.split(',') : []);
  const fichas = brutos.map((d) => String(d).trim()).filter((t) => t !== '');
  const inicioBruto = String(bruto.inicio || '').trim();
  const fimBruto = String(bruto.fim || '').trim();
  // Agenda vazia (nenhum dia marcado e sem horário) é o mesmo que não ter
  // agenda: é assim que o formulário desliga o recurso.
  if (!fichas.length && !inicioBruto && !fimBruto) return null;

  const dias = [];
  for (const f of fichas) {
    if (!/^[0-6]$/.test(f)) {
      throw new Error(`Dia da semana inválido na agenda: "${f}". Use 0 (domingo) a 6 (sábado).`);
    }
    if (!dias.includes(Number(f))) dias.push(Number(f));
  }
  dias.sort((a, b) => a - b);
  if (!dias.length) {
    throw new Error('Escolha pelo menos um dia da semana para manter o host aberto.');
  }
  const inicio = emMinutos(inicioBruto);
  const fim = emMinutos(fimBruto, true); // só o fim aceita 24:00
  if (inicio === null || fim === null) {
    throw new Error('Informe a hora de início e a de fim no formato HH:MM '
      + `(o fim também aceita ${FIM_DO_DIA}, para ir até o fim do dia).`);
  }
  // Início igual ao fim não descreve nada: pode ser "zero minuto" ou "o dia
  // inteiro", e escolher por conta própria é chutar. Quem quer o dia todo
  // escreve 00:00–24:00, que é exato — e é contínuo de verdade.
  if (inicio === fim) {
    throw new Error('A hora de fim precisa ser diferente da de início. '
      + `Para o dia inteiro, use 00:00 e ${FIM_DO_DIA}.`);
  }
  return { dias, inicio: inicioBruto, fim: fimBruto };
}

// A pergunta que o app faz o tempo todo: agora está dentro da janela?
function estaNaJanela(agenda, agora) {
  if (!agenda) return false;
  const dias = agenda.dias || [];
  const ini = emMinutos(agenda.inicio);
  const fim = emMinutos(agenda.fim, true);
  if (!dias.length || ini === null || fim === null || ini === fim) return false;

  const d = agora.getDay();
  const min = agora.getHours() * 60 + agora.getMinutes();

  if (ini < fim) return dias.includes(d) && min >= ini && min < fim;

  // Faixa que atravessa a meia-noite. Ela PERTENCE AO DIA EM QUE COMEÇA: uma
  // agenda de sábado 22:00–02:00 cobre sábado à noite e as duas primeiras horas
  // de domingo, e não domingo à noite. Marcar "sábado" e ver a conexão abrir na
  // noite de domingo seria o oposto do combinado.
  const ontem = (d + 6) % 7;
  return (dias.includes(d) && min >= ini) || (dias.includes(ontem) && min < fim);
}

// Texto curto para a tela ("Seg a Sex, 08:00–18:00"). Agrupar dias seguidos
// evita o "seg, ter, qua, qui, sex" que ninguém lê.
function descreverAgenda(agenda) {
  if (!agenda || !(agenda.dias || []).length) return '';
  const dias = [...agenda.dias].sort((a, b) => a - b);
  let texto;
  if (dias.length === 7) texto = 'Todo dia';
  else if (dias.length === 5 && dias.join() === '1,2,3,4,5') texto = 'Seg a Sex';
  else if (dias.length === 2 && dias.join() === '0,6') texto = 'Fim de semana';
  else {
    // Agrupa corridas de 3 dias ou mais: [1,2,3,4,6] vira "Seg a Qui, Sáb".
    const partes = [];
    let i = 0;
    while (i < dias.length) {
      let j = i;
      while (j + 1 < dias.length && dias[j + 1] === dias[j] + 1) j += 1;
      const nome = (k) => DIAS_CURTOS[dias[k]][0].toUpperCase() + DIAS_CURTOS[dias[k]].slice(1);
      partes.push(j - i >= 2 ? `${nome(i)} a ${nome(j)}` : dias.slice(i, j + 1).map((_, k) => nome(i + k)).join(', '));
      i = j + 1;
    }
    texto = partes.join(', ');
  }
  const vira = emMinutos(agenda.inicio) > emMinutos(agenda.fim, true) ? ' (vira o dia)' : '';
  return `${texto}, ${agenda.inicio}–${agenda.fim}${vira}`;
}

// Quando a janela ATUAL termina. Serve para dizer ao usuário, no lugar do "×"
// que sumiu, até quando a aba fica travada. `null` se não está numa janela.
function fimDaJanelaAtual(agenda, agora) {
  if (!estaNaJanela(agenda, agora)) return null;
  // Estando DENTRO da janela, o fim é sempre a próxima ocorrência do horário de
  // fim — hoje se ainda não passou, amanhã se já passou. Isso resolve os dois
  // casos de uma vez: 08:00–18:00 às 10h dá hoje 18:00; 22:00–02:00 às 23h dá
  // amanhã 02:00, e às 01h (já do outro lado da meia-noite) dá hoje 02:00.
  const fim = emMinutos(agenda.fim, true);
  const alvo = new Date(agora.getTime());
  alvo.setSeconds(0, 0);
  alvo.setHours(Math.floor(fim / 60), fim % 60);
  if (alvo.getTime() <= agora.getTime()) alvo.setDate(alvo.getDate() + 1);
  return alvo;
}

// ---------- o que fazer com um host que está na faixa agora ----------

// Quanto tempo a janela principal espera uma janela recém-aberta se anunciar,
// antes de considerar que o host ficou sem dono. Cobre o carregamento da janela
// nova, que é quando a sessão fica órfã no servidor sem que ninguém a tenha
// abandonado.
const ESPERA_ENTREGA_MS = 20 * 1000;
// Intervalo mínimo entre duas aberturas automáticas do MESMO host. É o que
// impede um servidor fora do ar de virar um laço de reconexão.
const ESPERA_ENTRE_TENTATIVAS_MS = 60 * 1000;

// Decisão pura, sem tela e sem rede — é aqui que moram os erros caros, e por
// isso ela sai de dentro do laço da interface para ter teste próprio.
//
// A ORDEM das regras é o que importa: cada uma existe para desarmar a seguinte
// num caso específico, e trocá-las de lugar produz conexão duplicada ou sessão
// perdida sem que nada estoure.
function decidirAcao({
  hostId, minhas = [], presenca = [], sessoes = [], janelaId,
  entregueEm = 0, ultimaTentativa = 0, agora,
}) {
  if (!hostId) return { acao: 'nada', motivo: 'host sem id' };
  // 1. Já está aberto NESTA janela. Vale também para 'conectando': sem isso,
  //    dois tiques durante uma conexão lenta abriam duas.
  if (minhas.some((s) => s.hostId === hostId && s.status !== 'encerrado')) {
    return { acao: 'nada', motivo: 'já está aberto nesta janela' };
  }
  // 2. Alguém tem um SOCKET VIVO nesta sessão de terminal, e não sou eu.
  //
  //    Esta regra existe porque a da presença (2b) depende de a outra janela
  //    conseguir bater o ponto a cada 5 s, e o Chromium estrangula temporizador
  //    de janela em segundo plano. Bastava a máquina suspender, ou um diálogo
  //    bloqueante na janela solta, para o prazo de 20 s vencer com a janela
  //    VIVA — e aí abria-se uma segunda conexão ao mesmo servidor, já travada
  //    pela agenda, que o usuário não conseguia fechar.
  //
  //    "Ligada" vem do próprio WebSocket do servidor: não depende de o renderer
  //    estar acordado para dizer que existe. Só vale para terminal; RDP, VNC e
  //    página web não têm sessão no servidor e continuam dependendo da presença.
  const meus = new Set(minhas.map((s) => s.sessaoId).filter(Boolean));
  if (sessoes.some((s) => s.hostId === hostId && !s.orfa && s.ligada && !meus.has(s.id))) {
    return { acao: 'nada', assumida: true, motivo: 'outra janela está ligada a esta sessão' };
  }
  // 2b. Está numa janela solta, segundo o registro de presença.
  //    `assumida` diz ao chamador que a carência da regra 3 já cumpriu o papel
  //    dela e pode ser descartada: existe prova de que a outra janela assumiu.
  //    Sem isso, fechar a janela solta logo depois de soltá-la deixava a aba
  //    sumida da tela pelo resto dos 20 segundos, sem nada acontecendo.
  if (presenca.some((p) => p.hostId === hostId && p.janela !== janelaId)) {
    return { acao: 'nada', assumida: true, motivo: 'está aberto em outra janela' };
  }
  // 3. Acabou de sair daqui para uma janela que ainda está carregando. Nesse
  //    intervalo a sessão fica órfã no servidor — o mesmo sinal da regra 4 —
  //    e sem esta carência a janela principal a puxaria de volta no meio da
  //    entrega, brigando com a janela nova pela mesma sessão.
  if (!venceu(agora, entregueEm, ESPERA_ENTREGA_MS)) {
    return { acao: 'nada', motivo: 'entregue a outra janela há pouco' };
  }
  // 4. Vive no servidor sem janela nenhuma: alguém fechou a janela solta. A
  //    sessão VOLTA viva, com o shell onde estava — em vez de morrer no TTL ou
  //    de virar uma segunda conexão.
  const orfa = sessoes.find((s) => s.hostId === hostId && s.orfa);
  if (orfa) return { acao: 'reatar', sessaoId: orfa.id, motivo: 'sessão viva sem janela' };
  // 5. Falhou há pouco. Tentar de novo agora seria um laço.
  if (!venceu(agora, ultimaTentativa, ESPERA_ENTRE_TENTATIVAS_MS)) {
    return { acao: 'nada', motivo: 'aguardando o intervalo entre tentativas' };
  }
  // 6. Não existe em lugar nenhum: abrir. `primeira` distingue a entrada na
  //    faixa de uma retentativa, para o aviso na tela não se repetir a cada
  //    minuto durante uma faixa de oito horas.
  return { acao: 'abrir', primeira: !ultimaTentativa, motivo: 'não está aberto em lugar nenhum' };
}

if (typeof window !== 'undefined') {
  window.decidirAcao = decidirAcao;
  window.ESPERA_ENTREGA_MS = ESPERA_ENTREGA_MS;
  window.ESPERA_ENTRE_TENTATIVAS_MS = ESPERA_ENTRE_TENTATIVAS_MS;
  window.normalizarAgenda = normalizarAgenda;
  window.estaNaJanela = estaNaJanela;
  window.descreverAgenda = descreverAgenda;
  window.fimDaJanelaAtual = fimDaJanelaAtual;
  window.DIAS_CURTOS = DIAS_CURTOS;
  window.DIAS_LONGOS = DIAS_LONGOS;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizarAgenda, estaNaJanela, descreverAgenda, fimDaJanelaAtual, decidirAcao,
    ESPERA_ENTREGA_MS, ESPERA_ENTRE_TENTATIVAS_MS, DIAS_CURTOS, DIAS_LONGOS,
  };
}
