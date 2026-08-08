'use strict';

// Agenda de um host: a faixa de horário, TODO DIA, em que a conexão dele
// precisa ficar aberta.
//
// Durante a faixa o app abre a sessão sozinho e ela não pode ser fechada — o
// "×" da aba some. Fora da faixa nada muda: a aba continua aberta e volta a ser
// fechável. Nada é derrubado automaticamente no fim do período; interromper um
// comando em execução seria pior do que deixar uma aba a mais na tela.
//
// Houve uma seleção de dias da semana aqui, removida a pedido. Ela ainda pode
// aparecer em dado gravado (data.json de uma versão anterior, ou um backup .xml
// exportado por ela): `normalizarAgenda` IGNORA o campo em vez de recusar, e a
// faixa passa a valer todo dia. Recusar transformaria um backup legítimo em erro
// de importação; e apagar em silêncio sem dizer nada seria pior ainda, então
// quem importa vê no diálogo que a faixa vale todo dia.
//
// Tudo aqui é horário LOCAL da máquina. O app é local por definição (o servidor
// escuta só em 127.0.0.1), então o relógio de quem usa é o relógio certo — e
// converter para UTC só criaria uma discrepância na virada do horário de verão.
//
// O caso que mais dá errado é a faixa que ATRAVESSA A MEIA-NOITE (22:00–02:00,
// uma janela de manutenção típica). Nela a comparação ingênua
// `minutos >= inicio && minutos < fim` é sempre falsa, e a agenda simplesmente
// nunca abriria. O tratamento está em `estaNaJanela` e é o motivo de este
// módulo existir separado, com teste próprio.

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
  const inicioBruto = String(bruto.inicio || '').trim();
  const fimBruto = String(bruto.fim || '').trim();
  // Sem horário nenhum é o mesmo que não ter agenda: é assim que o formulário
  // desliga o recurso. Um `dias` remanescente de versão antiga não segura a
  // agenda viva sozinho — sem horário não há faixa.
  if (!inicioBruto && !fimBruto) return null;

  const inicio = emMinutos(inicioBruto);
  const fim = emMinutos(fimBruto, true); // só o fim aceita 24:00
  if (inicio === null || fim === null) {
    throw new Error('Informe a hora de início e a de fim no formato HH:MM '
      + '(ou marque "até o fim do dia" no lugar da hora de fim).');
  }
  // Início igual ao fim não descreve nada: pode ser "zero minuto" ou "o dia
  // inteiro", e escolher por conta própria é chutar.
  if (inicio === fim) {
    // A mensagem NÃO manda digitar 24:00: um <input type="time"> recusa esse
    // valor e deixa o campo vazio, então instruir a digitá-lo era mandar o
    // usuário para um beco sem saída. Quem liga o fim do dia é a caixa de
    // marcação do formulário.
    throw new Error('A hora de fim precisa ser diferente da de início. '
      + 'Para o dia inteiro, comece em 00:00 e marque "até o fim do dia".');
  }
  // `dias` sai de propósito: a forma canônica é só a faixa. O que vier gravado
  // de antes é descartado aqui, num lugar só, em vez de sobreviver como campo
  // morto que a próxima pessoa tentaria interpretar.
  return { inicio: inicioBruto, fim: fimBruto };
}

// A pergunta que o app faz o tempo todo: agora está dentro da janela?
function estaNaJanela(agenda, agora) {
  if (!agenda) return false;
  const ini = emMinutos(agenda.inicio);
  const fim = emMinutos(agenda.fim, true);
  if (ini === null || fim === null || ini === fim) return false;

  const min = agora.getHours() * 60 + agora.getMinutes();
  // Faixa dentro do mesmo dia.
  if (ini < fim) return min >= ini && min < fim;
  // Faixa que atravessa a meia-noite (22:00–02:00): valendo todo dia, ela é
  // simplesmente "depois do início OU antes do fim". Enquanto havia dias da
  // semana era preciso decidir a QUEM a madrugada pertencia, e essa era a parte
  // mais fácil de errar — some junto com os dias.
  return min >= ini || min < fim;
}

// Texto curto para a tela ("Seg a Sex, 08:00–18:00"). Agrupar dias seguidos
// evita o "seg, ter, qua, qui, sex" que ninguém lê.
function descreverAgenda(agenda) {
  if (!agenda || !agenda.inicio || !agenda.fim) return '';
  const vira = emMinutos(agenda.inicio) > emMinutos(agenda.fim, true)
    ? ' (todo dia, virando a madrugada)' : ' (todo dia)';
  return `${agenda.inicio}–${agenda.fim}${vira}`;
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
  window.FIM_DO_DIA = FIM_DO_DIA;
  window.decidirAcao = decidirAcao;
  window.ESPERA_ENTREGA_MS = ESPERA_ENTREGA_MS;
  window.ESPERA_ENTRE_TENTATIVAS_MS = ESPERA_ENTRE_TENTATIVAS_MS;
  window.normalizarAgenda = normalizarAgenda;
  window.estaNaJanela = estaNaJanela;
  window.descreverAgenda = descreverAgenda;
  window.fimDaJanelaAtual = fimDaJanelaAtual;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizarAgenda, estaNaJanela, descreverAgenda, fimDaJanelaAtual, decidirAcao,
    FIM_DO_DIA, ESPERA_ENTREGA_MS, ESPERA_ENTRE_TENTATIVAS_MS,
  };
}
