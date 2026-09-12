'use strict';

// MTU Detect — descobre o MTU efetivo do caminho até um alvo (PMTU) com pings
// DF (don't fragment) de tamanhos variados, por busca binária. Se o pacote
// passa, o caminho aguenta aquele tamanho; se um roteador responde "frag
// needed", não aguenta. O maior payload que passa + cabeçalhos = MTU do caminho.
//
// Roda local (spawn do ping do sistema) ou remoto por SSH (o servidor executa a
// `linha` e lê a saída). Por isso tudo aqui é puro e injetável: comandoSonda
// monta a linha, classificarResposta lê o texto, buscar recebe a sonda como
// função. Quem spawna/SSHa é o server.js — este módulo não toca em rede.
//
// Convenção de tamanhos: "payload" é SÓ os dados ICMP (o -s/-l do ping).
// MTU = payload + overhead, onde overhead = 20 (IP) + 8 (ICMP) = 28 no IPv4 e
// 40 (IPv6) + 8 (ICMPv6) = 48 no IPv6. Logo 1472 + 28 = 1500 (Ethernet).

const OVERHEAD_V4 = 28;
const OVERHEAD_V6 = 48;
// 576 é o MTU mínimo que todo host IPv4 deve aceitar (RFC 791) → payload 548.
// Abaixo disso o problema não é MTU, é outra coisa (ICMP bloqueado, sem rota).
const MIN_PAYLOAD_V4 = 548;
const MAX_PAYLOAD_V4 = 1500 - OVERHEAD_V4; // 1472
// IPv6 não fragmenta no caminho e exige MTU ≥ 1280 (RFC 8200) → payload 1232.
const MIN_PAYLOAD_V6 = 1280 - OVERHEAD_V6; // 1232
const MAX_PAYLOAD_V6 = 1500 - OVERHEAD_V6; // 1452
// log2(1472−548) ≈ 10 passos de bisseção + a sonda do teto + a do piso = 12.
// Cabe exato; acima disso é sonda com defeito (resposta oscilando), não busca.
const MAX_TENTATIVAS = 12;
const TIMEOUT_S = 2;
// 65535 (maior datagrama IP) − 28. O ping recusa acima disso de qualquer jeito.
const MAX_PAYLOAD_ABSOLUTO = 65507;

// Tabela de MTUs conhecidos, do maior ao menor, para o explicar() marcar qual
// bate. IPsec varia com cifra/modo — 1460 é o "típico" de ESP túnel com AES;
// WireGuard é fixo em 1420 sobre IPv4 (80 bytes de overhead).
const MTUS_CONHECIDOS = [
  { mtu: 1500, nome: 'Ethernet' },
  { mtu: 1492, nome: 'PPPoE' },
  { mtu: 1480, nome: 'IPIP' },
  { mtu: 1476, nome: 'GRE' },
  { mtu: 1460, nome: 'IPsec ESP (típico)' },
  { mtu: 1420, nome: 'WireGuard' },
  { mtu: 1280, nome: 'mínimo IPv6' },
];

// Mesma guarda do monitor/tcpping/mtr: só IP ou hostname plausível, e nada
// começando com "-" (o ping leria como FLAG, não como alvo). Copiada aqui de
// propósito: importar lib/monitor.js só por isso puxaria o spawn e o laço.
function validarAlvo(alvo) {
  return typeof alvo === 'string' && alvo.length > 0 && alvo.length <= 255
    && /^[a-zA-Z0-9.:_-]+$/.test(alvo) && !/^-/.test(alvo);
}

function payloadValido(p) {
  return Number.isInteger(p) && p >= 0 && p <= MAX_PAYLOAD_ABSOLUTO;
}

// Monta o ping DF de UM pacote. `linha` é a forma que vai pelo SSH; cmd/args a
// forma que vai pro spawn (sem shell). Devolve:
//   { cmd, args, linha }   — normal
//   null                   — plataforma sem DF (BusyBox)
//   { erro }               — alvo/payload inválido
//
// Flags por plataforma (cada ping tem sua própria ideia de "DF" e "timeout"):
//   darwin   ping -c 1 -D -s P -t 2 alvo      (-t no macOS é timeout em s, não TTL)
//   linux    ping -c 1 -M do -s P -W 2 alvo   (iputils; -M do = DF)
//   win32    ping -n 1 -f -l P -w 2000 alvo   (-w em ms)
//   routeros /ping address=alvo count=1 size=(P+overhead) do-not-fragment
//   busybox  null — o ping do BusyBox não tem opção de DF (nem -M nem -D);
//            ele fragmenta em silêncio e a busca daria sempre "ok". Melhor
//            recusar do que mentir um MTU de 1500.
//
// RouterOS: o `size` do /ping é o tamanho do PACOTE IP inteiro (cabeçalho IP +
// ICMP + dados) — o mínimo aceito é 28, que é exatamente 20+8 com zero dados.
// Por isso size = payload + overhead, e não payload. Assim "size=1500" testa o
// mesmo pacote que "-s 1472" no Linux, e a busca fica na mesma escala.
function overheadValido(o) {
  return Number.isInteger(o) && o >= 0 && o <= 1000;
}

function comandoSonda(alvo, payload, plataforma, overhead = OVERHEAD_V4) {
  if (!validarAlvo(alvo)) return { erro: 'Alvo inválido. Use um IP ou nome de host.' };
  if (!payloadValido(payload)) return { erro: `Payload inválido (0–${MAX_PAYLOAD_ABSOLUTO}).` };
  // Só o RouterOS usa o overhead, e ele entra na linha de comando — um valor
  // torto ("x", null) viraria "size=1472x". Cai no padrão IPv4 em vez de vazar.
  if (!overheadValido(overhead)) overhead = OVERHEAD_V4;
  const p = plataforma || process.platform;
  const P = String(payload);
  let cmd; let args;
  if (p === 'busybox') return null;
  if (p === 'darwin') { cmd = 'ping'; args = ['-c', '1', '-D', '-s', P, '-t', String(TIMEOUT_S), alvo]; }
  else if (p === 'win32') { cmd = 'ping'; args = ['-n', '1', '-f', '-l', P, '-w', String(TIMEOUT_S * 1000), alvo]; }
  else if (p === 'routeros') { cmd = '/ping'; args = [`address=${alvo}`, 'count=1', `size=${payload + overhead}`, 'do-not-fragment']; }
  else { cmd = 'ping'; args = ['-c', '1', '-M', 'do', '-s', P, '-W', String(TIMEOUT_S), alvo]; }
  // Sem aspas: alvo e payload já passaram no filtro (sem espaço/metacaractere).
  return { cmd, args, linha: `${cmd} ${args.join(' ')}` };
}

// Frases de "precisa fragmentar" por SO/idioma. O erro pode vir LOCAL (o
// próprio kernel recusa: "Message too long") ou de um ROTEADOR no caminho
// ("Frag needed and DF set"). Para a busca dá no mesmo: aquele tamanho não passa.
// No IPv6 não existe DF: o roteador manda "Packet too big" (ICMPv6 tipo 2), que
// o iputils/macOS imprimem literalmente — sem ele aqui, a sonda v6 cairia no
// "100% packet loss" e viraria 'timeout', deixando a busca inconclusiva à toa.
const RE_FRAG = /message too long|frag(?:mentation)? needed|needs to be fragmented|precisa ser fragmentado|packet too (?:large|big)|fragmentation-needed/i;
// Erros que não são nem "passou" nem "fragmentou" nem "sumiu": sem rota, host
// desconhecido, sem permissão de raw socket. A busca aborta neles — não adianta
// bisseccionar contra um alvo que não existe.
// "TTL expired in transit" / "Time to live exceeded" (laço de roteamento) entra
// aqui porque o Windows sai com código 0 e "0% loss" nesse caso — sem a frase,
// o desempate por perda zero daria 'ok' num pacote que nunca chegou.
const RE_ERRO = /unreachable|inacess[ií]vel|unknown host|could not find host|name or service not known|temporary failure in name resolution|not permitted|operation not permitted|n[ãa]o foi poss[ií]vel encontrar|no route to host|network is down|invalid value|bad value|no such|unrecognized option|not found|command not found|no such command|syntax error|ttl expired|ttl expirado|time to live exceeded|invalid argument|packet size too large/i;
// "sumiu": nada voltou. No Windows pt-BR o "(100% de perda)" quebra linha entre
// o "de" e o "perda", por isso o \s+.
const RE_TIMEOUT = /request timed? ?out|tempo limite|esgotad|\btimeout\b|100(?:\.0)?%\s*(?:packet loss|de\s+perda)|packet-loss=100%/i;
// Uma resposta de verdade traz TTL e tempo (qualquer SO/idioma). RouterOS não
// imprime "ttl=", mas resume "received=N".
// "hlim=" é o ttl do ping6 do macOS/BSD.
const RE_RESPOSTA = /\b(?:ttl|hlim)[=\s:]*\d|\b(?:time|tempo)[=<]\s*[\d.,]+\s*ms|received=[1-9]/i;
// A versão "forte": ttl E tempo na MESMA linha (Linux/macOS "ttl=57 time=9.8 ms",
// Windows "tempo=10ms TTL=55", em qualquer ordem) ou o resumo do RouterOS. Só
// isso é prova de que o pacote voltou — e é checada ANTES de erro/timeout para
// um hostname como "timeout.local" ou "gw-unreachable" não contaminar o veredito
// (o nome aparece no cabeçalho "PING host" e no rodapé das estatísticas).
// "TTL expired in transit" e "Time to live exceeded" não passam: falta o "=".
// Linha a linha com duas regexes simples, e não uma só com `.*` no meio: a
// forma única é quadrática numa linha longa cheia de "ttl" sem "time=".
const RE_TTL = /\b(?:ttl|hlim)[=\s:]*\d/i;
const RE_TEMPO = /\b(?:time|tempo)[=<]\s*[\d.,]+\s*ms/i;
function temRespostaForte(t) {
  if (/received=[1-9]/i.test(t)) return true;
  return t.split('\n').some((l) => RE_TTL.test(l) && RE_TEMPO.test(l));
}
// Perda zero explícita — aceita como "ok" quando o código de saída é 0 e o
// texto não tem a linha de resposta (idioma que não reconheço).
const RE_SEM_PERDA = /\b0(?:\.0)?%\s*(?:packet loss|de\s+perda|loss)|packet-loss=0%|Recebidos = [1-9]|Received = [1-9]/i;

// Lê a saída do ping DF e diz o que aconteceu com aquele tamanho:
//   'fragmentacao' — não passa (local ou roteador avisou)
//   'ok'           — passou (resposta com ttl/tempo e sem perda total)
//   'timeout'      — sumiu em silêncio
//   'erro'         — sem rota / host inválido / sem permissão / saída irreconhecível
//
// O texto manda; o código de saída só desempata quando não há linha de
// resposta reconhecível: código 0 + "0% de perda" explícito vale como 'ok'.
// Não confio em código 0 sozinho porque o ping do Windows sai com 0 até em
// "Destination host unreachable" (que também diz "0% loss" — por isso o
// unreachable é checado ANTES da perda).
//
// Ordem: fragmentação > resposta forte > erro > timeout > resposta fraca.
// Fragmentação primeiro porque o macOS junta "Message too long" com "100%
// packet loss" na mesma saída; resposta forte antes de erro/timeout pelo
// hostname (ver RE_RESPOSTA_FORTE). Com count=1 nunca há resposta E erro
// de verdade no mesmo texto, então a ordem não esconde nada.
function classificarResposta(texto, codigoDeSaida) {
  const t = typeof texto === 'string' ? texto : '';
  if (RE_FRAG.test(t)) return 'fragmentacao';
  if (temRespostaForte(t)) return 'ok';
  if (RE_ERRO.test(t)) return 'erro';
  if (RE_TIMEOUT.test(t)) return 'timeout';
  if (RE_RESPOSTA.test(t)) return 'ok';
  if (codigoDeSaida === 0 && RE_SEM_PERDA.test(t)) return 'ok';
  return 'erro';
}

// O atalho: Linux ("mtu=1500" / "mtu = 1492") e macOS ("MTU 1500") já dizem o
// MTU do salto que recusou. Não é o PMTU garantido (um salto mais à frente pode
// ser menor), mas é um chute muito bom para a próxima sonda. Fora de 68–65535
// não é MTU, é ruído (ex.: "mtu" dentro de um hostname).
//
// Uma só classe [\s=:]* entre "mtu" e o número, de propósito: a forma óbvia
// `\s*[=:]?\s*` tem dois \s* adjacentes e, com "mtu" seguido de muito espaço
// (saída remota via SSH é texto arbitrário), o motor tenta todas as divisões
// entre os dois — 1 MB de espaços trava o processo por minutos.
function extrairMtuSugerido(texto) {
  const m = (typeof texto === 'string' ? texto : '').match(/\bmtu[\s=:]*(\d{2,5})\b/i);
  if (!m) return null;
  const v = Number(m[1]);
  return v >= 68 && v <= 65535 ? v : null;
}

// Uma tentativa da sonda. Aceita 'ok'|'fragmentacao'|'timeout'|'erro' puro ou
// { resultado, mtuSugerido } (quando quem chama já passou a saída pelo
// extrairMtuSugerido). Exceção da sonda vira 'erro' — a busca aborta limpa.
const RESULTADOS = new Set(['ok', 'fragmentacao', 'timeout', 'erro']);

async function sondar(sonda, payload, tentativas) {
  let r;
  try { r = await sonda(payload); } catch (e) { r = { resultado: 'erro', erro: e && e.message }; }
  const bruto = typeof r === 'string' ? r : r && r.resultado;
  // Qualquer coisa fora dos quatro estados é sonda com defeito, não "falhou":
  // guardar a string crua faria a busca tratar lixo como fragmentação silenciosa.
  const resultado = RESULTADOS.has(bruto) ? bruto : 'erro';
  const t = { payload, resultado };
  // Só entra no atalho o que é MTU de verdade: inteiro em 68–65535. Uma string
  // ("1492") ou fração (1492.5) vinda de uma sonda mal-feita viraria payload
  // não inteiro na próxima sondagem.
  const sug = r && typeof r === 'object' ? Number(r.mtuSugerido) : NaN;
  if (Number.isInteger(sug) && sug >= 68 && sug <= 65535) t.mtuSugerido = sug;
  tentativas.push(t);
  return t;
}

// Busca binária do maior payload que passa com DF.
//   1. sonda o teto (max): passou → é o MTU (o caso comum, 1500, gasta 1 ping)
//   2. sonda o piso (min): falhou → não é problema de MTU, devolve pmtu null
//   3. bissecção entre piso (passa) e teto (não passa) até ficarem vizinhos
//
// 'timeout' CONTA COMO FALHA. Motivo: com DF ligado e o ICMP "frag needed"
// bloqueado no caminho (firewall que descarta todo ICMP de erro — comuníssimo),
// o pacote grande some sem aviso — exatamente o buraco negro de PMTU que a
// ferramenta existe para achar. Se timeout contasse como "passou", a busca
// diria 1500 num link que na verdade engole tudo acima de 1492. O preço é que
// um alvo simplesmente fora do ar também vira "falha"; por isso o resultado
// carrega `inconclusivo: true` quando NENHUMA falha foi fragmentação explícita —
// a tela precisa dizer "ninguém avisou, os pacotes só sumiram".
//
// Atalho: quando a sonda devolve mtuSugerido (o "mtu=1492" do Linux/macOS), a
// próxima sonda vai direto em sugerido−overhead em vez de bisseccionar. Se
// passa, é o PMTU (o salto que avisou limita por cima); se fragmenta de novo com
// nova sugestão, segue o atalho; se não, volta à bissecção com o teto ajustado.
//
// Devolve { pmtu, payloadMax, overhead, tentativas, atalho, inconclusivo,
//           convergiu, motivo }. pmtu null quando o piso não passou.
async function buscar(sonda, opcoes) {
  // `opcoes = {}` como padrão não cobre null (só undefined) — e null é o que
  // chega quando a tela manda o JSON sem opções.
  const o = opcoes && typeof opcoes === 'object' ? opcoes : {};
  const ipv6 = !!o.ipv6;
  const overhead = overheadValido(o.overhead) ? o.overhead : (ipv6 ? OVERHEAD_V6 : OVERHEAD_V4);
  const min = Number.isInteger(o.min) ? o.min : (ipv6 ? MIN_PAYLOAD_V6 : MIN_PAYLOAD_V4);
  const max = Number.isInteger(o.max) ? o.max : (ipv6 ? MAX_PAYLOAD_V6 : MAX_PAYLOAD_V4);
  // Teto e piso são sondados sempre (são eles que dizem se há o que buscar),
  // então o mínimo honesto é 2 — abaixo disso "respeitar o teto" seria mentira.
  const teto = Number.isInteger(o.maxTentativas) ? Math.max(2, o.maxTentativas) : MAX_TENTATIVAS;
  const tentativas = [];
  const base = { overhead, tentativas, atalho: false, inconclusivo: false, convergiu: false, motivo: null };

  if (typeof sonda !== 'function') return { ...base, pmtu: null, payloadMax: null, motivo: 'Sonda não informada.' };
  if (!payloadValido(min) || !payloadValido(max) || min > max) {
    return { ...base, pmtu: null, payloadMax: null, motivo: `Faixa inválida (${min}–${max}).` };
  }

  // Inconclusivo = as falhas foram SÓ sumiço: houve timeout, ninguém avisou
  // fragmentação e nenhuma sonda deu 'erro' (erro tem motivo próprio — "sem
  // rota" não é "os pacotes sumiram", e o explicar() não pode dizer os dois).
  const fecharInconclusivo = () => tentativas.some((t) => t.resultado === 'timeout')
    && !tentativas.some((t) => t.resultado === 'fragmentacao' || t.resultado === 'erro');
  const abortar = (motivo) => ({ ...base, pmtu: null, payloadMax: null, inconclusivo: fecharInconclusivo(), motivo });

  // 1. teto
  const topo = await sondar(sonda, max, tentativas);
  if (topo.resultado === 'erro') return abortar('A sonda falhou (sem rota, host inválido ou sem permissão para ping).');
  if (topo.resultado === 'ok') {
    return { ...base, pmtu: max + overhead, payloadMax: max, convergiu: true, motivo: `Passou no maior tamanho testado (${max + overhead}); o MTU real pode ser maior.` };
  }
  let sugerido = topo.mtuSugerido || null;

  // 2. piso
  if (min === max) return abortar(fecharInconclusivo() ? 'O único tamanho testado sumiu sem resposta.' : 'O único tamanho testado não passou.');
  const piso = await sondar(sonda, min, tentativas);
  if (piso.resultado === 'erro') return abortar('A sonda falhou (sem rota, host inválido ou sem permissão para ping).');
  if (piso.resultado !== 'ok') {
    return abortar(fecharInconclusivo()
      ? `Nem ${min + overhead} bytes voltaram — o alvo não responde a ping ou o ICMP está bloqueado; não dá para medir MTU.`
      : `Até ${min + overhead} bytes fragmentam — abaixo do mínimo da rede; algo além de MTU está errado no caminho.`);
  }

  // 3. bissecção — lo sempre passou, hi sempre falhou
  let lo = min; let hi = max; let atalho = false;
  while (hi - lo > 1 && tentativas.length < teto) {
    let alvo; let pulo = false;
    if (sugerido && sugerido - overhead > lo && sugerido - overhead < hi) { alvo = sugerido - overhead; atalho = true; pulo = true; }
    else alvo = Math.floor((lo + hi) / 2);
    sugerido = null;
    const t = await sondar(sonda, alvo, tentativas);
    if (t.resultado === 'erro') return abortar('A sonda falhou no meio da busca.');
    if (t.resultado === 'ok') {
      lo = alvo;
      // O salto que avisou "mtu=N" recusa qualquer coisa acima de N; se N−overhead
      // passou, não há o que procurar entre ele e o teto — fecha aqui.
      if (pulo) hi = alvo + 1;
    } else { hi = alvo; sugerido = t.mtuSugerido || null; }
  }
  const convergiu = hi - lo <= 1;
  return {
    ...base, pmtu: lo + overhead, payloadMax: lo, atalho, convergiu,
    inconclusivo: fecharInconclusivo(),
    motivo: convergiu ? null : `Parou em ${teto} tentativas sem fechar a faixa (${lo + overhead}–${hi + overhead}); o valor é o piso confirmado.`,
  };
}

// Texto pronto para a tela. Sempre traz a tabela de MTUs conhecidos com o que
// bateu marcado — o valor sozinho diz pouco; "1492 = PPPoE" é o diagnóstico.
function explicar(resultado) {
  const r = resultado || {};
  const overhead = r.overhead || OVERHEAD_V4;
  const linhas = [];
  if (r.pmtu == null) {
    linhas.push('MTU do caminho: não determinado.');
    if (r.motivo) linhas.push(r.motivo);
    if (r.inconclusivo) linhas.push('Nenhum roteador avisou fragmentação; os pacotes só sumiram. Pode ser ICMP bloqueado ou alvo fora do ar — não dá para afirmar nada sobre o MTU.');
  } else {
    linhas.push(`MTU do caminho: ${r.pmtu} (payload ICMP ${r.payloadMax} + ${overhead} de cabeçalho).`);
    if (r.motivo) linhas.push(r.motivo);
    if (r.inconclusivo) linhas.push('Atenção: acima desse tamanho os pacotes sumiram sem aviso de fragmentação (buraco negro de PMTU ou ICMP filtrado). Conexões que dependem de PMTU discovery vão travar nesse caminho.');
    if (r.atalho) linhas.push('Um roteador do caminho informou o MTU (atalho), o que encurtou a busca.');
  }
  const n = Array.isArray(r.tentativas) ? r.tentativas.length : 0;
  if (n) linhas.push(`${n} sonda${n === 1 ? '' : 's'} enviada${n === 1 ? '' : 's'}.`);
  linhas.push('');
  linhas.push('Valores conhecidos:');
  let bateu = false;
  for (const c of MTUS_CONHECIDOS) {
    const bate = r.pmtu === c.mtu;
    bateu = bateu || bate;
    linhas.push(`  ${c.mtu}  ${c.nome}${bate ? '  ← bate com o medido' : ''}`);
  }
  if (r.pmtu != null && !bateu) {
    // Sem bater em nada, o mais útil é dizer o que está logo acima — é o
    // encapsulamento provável menos algum overhead extra (VLAN, MPLS, IPsec).
    const acima = MTUS_CONHECIDOS.filter((c) => c.mtu > r.pmtu).pop();
    linhas.push(acima
      ? `  ${r.pmtu} não é um valor padrão; fica ${acima.mtu - r.pmtu} bytes abaixo de ${acima.nome} (${acima.mtu}) — provável encapsulamento extra no caminho.`
      : `  ${r.pmtu} está abaixo de todos os padrões conhecidos.`);
  }
  linhas.push('Para PPPoE o esperado é 1492; para túneis GRE/IPIP, 1476/1480; WireGuard 1420; IPv6 nunca abaixo de 1280.');
  return linhas.join('\n');
}

module.exports = {
  comandoSonda, classificarResposta, extrairMtuSugerido, buscar, explicar, validarAlvo,
  OVERHEAD_V4, OVERHEAD_V6, MIN_PAYLOAD_V4, MAX_PAYLOAD_V4, MIN_PAYLOAD_V6, MAX_PAYLOAD_V6,
  MAX_TENTATIVAS, TIMEOUT_S, MTUS_CONHECIDOS,
};
