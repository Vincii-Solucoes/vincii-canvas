'use strict';

// Extração do comando digitado a partir da TELA do terminal.
//
// A captura do histórico lê a linha já renderizada no Enter e precisa separar
// o prompt do comando. Reconhecer o prompt é a única defesa contra capturar
// lixo de dentro de vim/top/tail — linha sem prompt reconhecível NÃO é
// registrada.
//
// Por muito tempo "prompt" aqui queria dizer prompt de SHELL DE PC: um
// terminador com espaço depois ('$ ', '# ', '% '…). Equipamento de rede não
// escreve assim — o comando cola no fim do prompt:
//
//   <HUAWEI>display version                  roteador/switch Huawei (VRP)
//   HRP_M<USG6000>display hrp state          VRP em par de firewalls (HRP)
//   [HUAWEI-GigabitEthernet0/0/1]undo shut   VRP, visão de sistema
//   MA5680T(config)#display board 0          OLT Huawei (SmartAX)
//   MA5680T(diagnose)%%display cpu           OLT em modo diagnose
//   Router#show running-config               Cisco e afins
//   Admin\gponline#show onu_state            Fiberhome
//   [admin@MikroTik] /interface> print       MikroTik (RouterOS)
//   ygor@mx-core> show bgp summary           Juniper (Junos)
//
// — e um dia inteiro de manutenção em OLT saía do Canvas sem uma linha de
// histórico.
//
// A PRIMEIRA versão disto reconhecia "qualquer coisa entre colchetes" e
// "qualquer coisa entre <>" — e a revisão provou com execução que isso gravava
// "[sudo] password for ygor:" a cada sudo, linha de log "[INFO] …" no tail -f,
// e uma entrada de lixo por página no More da OLT. As regras abaixo são
// estruturais, cada uma presa por um caso real em test/historico-prompts.test.js:
//
//   - colchete de VRP não tem espaço DENTRO ([HUAWEI-Gi0/0/1]) nem DEPOIS
//     (o comando cola no ']'). "[sudo] senha", "[INFO] msg", "[Board
//     Properties]" e "[2026-08-16 10:32]" falham numa das duas;
//   - o que sobra depois de um prompt <...> não pode conter '<' — comando VRP
//     não tem '<', e é isso que separa <HUAWEI>display de <tag>valor</tag>;
//   - nome de equipamento tem 2+ caracteres, termina em letra/dígito e não
//     contém ':' nem '/' — "2>arquivo", "https://…#x" e "foo->bar()" falham;
//   - resposta de DIÁLOGO nunca é comando: More, (y/n), [confirm], pedido de
//     senha/usuário e o "{ <cr>… }" do save da OLT são recusados no fim.

// Shells de PC: o terminador aparece em qualquer ponto da linha (o prompt
// costuma ter usuário@máquina antes) e SEMPRE tem espaço depois.
const TERMINADORES_DE_SHELL = ['❯ ', '➜ ', '$ ', '# ', '% '];

// Equipamentos de rede: casam do COMEÇO da linha até o fim do prompt. A ordem
// importa — o MikroTik vem antes do colchete de VRP porque o prompt dele é
// "[usuário@equipamento] /caminho>" e cortar só o colchete deixaria o caminho
// grudado no comando.
const PROMPTS_DE_REDE = [
  // [admin@MikroTik] > cmd | [admin@MikroTik] /interface bridge> print
  // | [admin@MikroTik] <SAFE> /ip firewall> add …   (Safe Mode)
  { re: /^\[[^\[\]]{1,64}\]\s+(?:<SAFE>\s+)?(?:\/[\w /-]{0,64})?>\s?/ },
  // <HUAWEI>display … | HRP_M<USG6000>display …
  // `semSinalDe: '<'`: se o resto ainda tem '<', isto era XML/HTML, não prompt.
  { re: /^(?:HRP_[MS])?<[^<>\s]{1,64}>/, semSinalDe: '<' },
  // [HUAWEI-Gi0/0/1]undo … — sem espaço dentro NEM depois do colchete.
  { re: /^(?:HRP_[MS])?\[[^\[\]\s]{1,64}\](?=\S)/ },
  // MA5680T#cmd | MA5680T(config-if-gpon-0/1)#cmd | Router>cmd
  // | MA5680T(diagnose)%%cmd | Admin\gponline#cmd
  // Nome: 2+ caracteres, termina em letra/dígito, sem ':' nem '/'.
  { re: /^[A-Za-z0-9][\w.\\-]{0,61}[A-Za-z0-9](?:\([^()\s]{1,48}\))?(?:%%|[#>])/ },
  // Juniper: ygor@mx-core> show … — com espaço depois do '>', como Junos ecoa.
  { re: /^[\w.-]{1,32}@[\w.-]{1,64}[>#]\s/ },
];

// Respostas de diálogo NÃO são comando. O Enter num "Password:", num
// "(y/n)[n]:", no "---- More ----" da paginação ou no "{ <cr>… }" do save da
// OLT junta o texto do diálogo ao comando da linha de cima — e cada página do
// More viraria uma entrada de lixo no histórico. Vale para os DOIS caminhos
// (shell e rede): o lixo "ssh servidorPassword:" do shell é da mesma família.
const DIALOGOS = [
  /---- More ----/i,
  /\(y\/n\)\S{0,16}$/i,
  /\[confirm\]\s*\w?$/i,
  /\{ <cr>[^}]*\}:?\s*[\w-]*$/,
  /(?:password|senha)[^:]{0,40}:\s*$/i,
  /(?:user ?name|login|usu[aá]rio)[^:]{0,40}:\s*[\w.@-]*$/i,
];

function ehDialogo(texto) {
  return DIALOGOS.some((re) => re.test(texto));
}

// Recebe as linhas renderizadas a partir da DO CURSOR para cima (linhas[0] é a
// linha do cursor) e devolve o comando sem o prompt — ou '' quando nenhuma das
// linhas tem um prompt reconhecível, ou quando o que sobrou é diálogo.
function extrairComando(linhas) {
  const partes = [];
  for (const texto of linhas || []) {
    if (typeof texto !== 'string') break;
    partes.unshift(texto);
    // Shell decide primeiro em CADA linha: num wrap de comando longo no PC, a
    // continuação (linha do cursor) pode começar com algo que parece prompt de
    // rede — mas aí a linha é a própria, e o prompt de shell está acima.
    if (TERMINADORES_DE_SHELL.some((t) => texto.includes(t))) {
      const cmd = semPromptDeShell(partes.join('').replace(/\s+$/, ''));
      return ehDialogo(cmd) ? '' : cmd;
    }
    for (const p of PROMPTS_DE_REDE) {
      if (p.re.test(texto)) {
        // O prompt está no começo da linha mais antiga coletada — que é também
        // o começo da junção, então o corte vale na linha juntada (com wrap).
        const juntadas = partes.join('').replace(/\s+$/, '');
        const cmd = juntadas.replace(p.re, '').trim();
        if (p.semSinalDe && cmd.includes(p.semSinalDe)) return '';
        return ehDialogo(cmd) ? '' : cmd;
      }
    }
  }
  return ''; // sem prompt reconhecível → não registra (evita capturar dentro de vim/top)
}

// Remove o prompt de shell, pegando o que vem após o ÚLTIMO terminador.
function semPromptDeShell(linha) {
  let corte = -1;
  for (const t of TERMINADORES_DE_SHELL) {
    const i = linha.lastIndexOf(t);
    if (i >= 0 && i + t.length > corte) corte = i + t.length;
  }
  return corte >= 0 ? linha.slice(corte).trim() : '';
}

if (typeof window !== 'undefined') {
  window.extrairComando = extrairComando;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extrairComando, TERMINADORES_DE_SHELL, PROMPTS_DE_REDE, DIALOGOS };
}
