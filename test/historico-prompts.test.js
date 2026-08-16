'use strict';

// Captura do histórico: reconhecer o prompt é reconhecer o EQUIPAMENTO.
//
// "Quando acessei um switch olt huawei, não obtive o histórico" — foi assim que
// o defeito chegou. A captura lia a linha renderizada no Enter e procurava um
// terminador de prompt de shell de PC ('$ ', '# '… com espaço depois). O CLI
// da Huawei cola o comando no fim do prompt (<HUAWEI>display, MA5680T#display),
// nenhum terminador casava, e a função devolvia '' — que é o mesmo caminho da
// defesa "não capturar dentro de vim". Resultado: um dia de manutenção em OLT
// saía do Canvas sem uma linha de histórico, sem erro nenhum.
//
// A PRIMEIRA correção reconhecia "qualquer [colchete]" e "qualquer <tag>" no
// começo da linha — e a revisão adversarial provou por execução que isso
// gravava "[sudo] password for ygor:" a cada sudo, linha de log do tail -f, e
// uma entrada de lixo por página do More da OLT. TODO caso demonstrado pela
// revisão está aqui embaixo, como verificação permanente: os prompts reais que
// PASSARAM a ser reconhecidos, e as linhas que continuam sendo recusadas.

const assert = require('assert');
const { extrairComando } = require('../public/comando');

let n = 0;
const igual = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// A tela chega como no xterm: linhas[0] é a linha do cursor, depois as de cima.

// ---------- 1. shells de PC: nada mudou ----------

igual(extrairComando(['ygor@mac ~ % ls -la']), 'ls -la', 'zsh do Mac');
igual(extrairComando(['root@web-01:~# systemctl restart nginx']), 'systemctl restart nginx',
  'bash de root — o "# " COM espaço é shell de PC, não OLT');
igual(extrairComando(['~/api ❯ npm test']), 'npm test', 'starship/pure');
igual(extrairComando(['user@host:~$ echo "a > b"']), 'echo "a > b"',
  'um ">" DENTRO do comando não é prompt de rede: o terminador de shell decide primeiro');

// wrap: o comando continua na linha do cursor; o prompt está na de cima
igual(extrairComando(['--exclude node_modules', 'user@host:~$ grep -r "x" . ']),
  'grep -r "x" . --exclude node_modules', 'comando com wrap junta as linhas');

// As TRÊS regressões que a revisão provou na primeira versão: a continuação do
// wrap começava com algo que parecia prompt de rede e roubava o comando.
igual(extrairComando(['2>err.log', 'user@host:~$ node build.js --flags ']),
  'node build.js --flags 2>err.log',
  '"2>" não é equipamento: nome de equipamento tem 2+ caracteres');
igual(extrairComando(['1> logs/out.log 2>&1', 'ygor@web-01:~$ node server.js --port 8080 ']),
  'node server.js --port 8080 1> logs/out.log 2>&1', 'idem para "1>"');
igual(extrairComando(['https://example.com/page#section -o out.html', 'user@host:~$ curl ']),
  'curl https://example.com/page#section -o out.html',
  '"https://…#âncora" não é equipamento: nome não contém ":" nem "/"');

// ---------- 2. Huawei VRP (roteador e switch) ----------

igual(extrairComando(['<HUAWEI>display version']), 'display version',
  'visão de usuário: o comando cola no ">" — era exatamente o que não capturava');
igual(extrairComando(['<OLT-CENTRO-01>display board 0']), 'display board 0',
  'nome real de equipamento, com hífen');
igual(extrairComando(['[HUAWEI]sysname OLT-CENTRO']), 'sysname OLT-CENTRO', 'visão de sistema');
igual(extrairComando(['[HUAWEI-GigabitEthernet0/0/1]undo shutdown']), 'undo shutdown',
  'visão de interface: colchete com barra e ponto dentro');
igual(extrairComando(['HRP_M<USG6000V1>display hrp state']), 'display hrp state',
  'firewall em par HRP: o prefixo HRP_M/HRP_S vem antes do prompt');
igual(extrairComando(['HRP_S[USG6000V1]display hrp interface']), 'display hrp interface',
  'HRP na visão de sistema');

// ---------- 3. OLT Huawei (SmartAX), Cisco, Fiberhome ----------

igual(extrairComando(['MA5680T#display board 0']), 'display board 0',
  'o "#" SEM espaço é OLT — era lixo para o terminador de shell');
igual(extrairComando(['MA5680T(config)#display ont info 0 1']), 'display ont info 0 1',
  'modo config');
igual(extrairComando(['MA5680T(config-if-gpon-0/1)#ont add 1 sn-auth']), 'ont add 1 sn-auth',
  'modo interface gpon');
igual(extrairComando(['MA5680T(diagnose)%%display cpu']), 'display cpu',
  'modo diagnose: o terminador é "%%" — sem espaço, não é o "% " do zsh');
igual(extrairComando(['MA5680T>enable']), 'enable', 'modo usuário da OLT');
igual(extrairComando(['Router#show running-config']), 'show running-config', 'Cisco enable');
igual(extrairComando(['SW-CORE.velonic>show ip route']), 'show ip route',
  'nome com ponto — hostname de verdade');
igual(extrairComando(['Admin\\gponline#show onu_state slot 3 pon 4']),
  'show onu_state slot 3 pon 4', 'Fiberhome: diretório com contrabarra no prompt');
igual(extrairComando(['User>enable']), 'enable', 'Fiberhome no modo usuário');

// comando de OLT com wrap: o prompt fica na linha de cima
igual(extrairComando(['omci ont-lineprofile-id 10', 'MA5680T(config-if-gpon-0/1)#ont add 1 sn-auth ']),
  'ont add 1 sn-auth omci ont-lineprofile-id 10',
  'provisionamento longo wrapa e continua valendo');

// linha de ERRO acima do prompt não rouba o comando (o "% " do Cisco parece
// terminador de zsh — mas o prompt de rede da linha do cursor decide antes)
igual(extrairComando(['Router#show ip route', '% Unknown command or computer name']),
  'show ip route',
  'o erro "% …" da tela anterior não vira prefixo do comando');

// ---------- 4. MikroTik (RouterOS) e Juniper ----------

igual(extrairComando(['[admin@MikroTik] > ip address print']), 'ip address print',
  'prompt raiz do RouterOS');
igual(extrairComando(['[admin@MikroTik] /interface bridge> print']), 'print',
  'com caminho no prompt: o caminho é PROMPT, não comando — cortar só o '
  + 'colchete deixaria "/interface bridge> print" no histórico');
igual(extrairComando(['[ygor@rb-borda] /ip firewall filter> add chain=forward']),
  'add chain=forward', 'caminho de dois níveis');
igual(extrairComando(['[admin@MikroTik] <SAFE> /ip firewall filter> add chain=input']),
  'add chain=input',
  'Safe Mode: o "<SAFE>" é do prompt — a primeira versão o deixava no comando');
igual(extrairComando(['ygor@mx-core-poa> show bgp summary']), 'show bgp summary',
  'Juniper: usuário@equipamento com espaço depois do ">"');

// ---------- 5. o que continua NÃO sendo capturado ----------

igual(extrairComando(['esta linha não tem prompt nenhum']), '',
  'linha sem prompt → não registra (é a defesa do vim/top)');
igual(extrairComando(['veja <isso>aqui no texto']), '',
  'um <colchete> no MEIO do texto não é prompt: os padrões de rede são '
  + 'ancorados no começo da linha');
igual(extrairComando(['{ "json": "de saída" }']), '', 'saída JSON não vira comando');
igual(extrairComando(['<HUAWEI>']), '', 'Enter num prompt vazio não registra comando vazio');
igual(extrairComando(['MA5680T#']), '', 'idem na OLT');
igual(extrairComando(['[admin@MikroTik] > ']), '', 'idem no MikroTik');
igual(extrairComando([]), '', 'sem linhas, sem comando');

// O corpus da revisão: cada linha abaixo FOI capturada pela primeira versão.

igual(extrairComando(['[sudo] password for ygor:']), '',
  'o pedido de senha do sudo NÃO é comando — era gravado "password for ygor:" '
  + 'a cada sudo (colchete de prompt não tem espaço depois do "]")');
igual(extrairComando(['[sudo] senha para ygor:']), '', 'idem em pt-BR');
igual(extrairComando(['[sudo] password for ygor:', 'ygor@mac:~$ sudo systemctl restart nginx']),
  '',
  'e com o prompt do shell na linha de cima TAMBÉM não: o resto termina em '
  + '"password …:" — diálogo de senha nunca vira comando, nem colado no sudo');
igual(extrairComando(['[INFO] Started VinciiCanvas in 3.2 seconds']), '',
  'linha de log com [INFO] não é prompt (espaço depois do colchete)');
igual(extrairComando(['[  OK  ] Started nginx - high performance web server']), '',
  'linha do systemd não é prompt (espaço dentro do colchete)');
igual(extrairComando(['', '', '[2026-08-16 10:32:11] POST /api/login 401']), '',
  'Enter no tail -f: a linha de log com timestamp fica a 2 linhas do cursor e '
  + 'NÃO vira comando');
igual(extrairComando(['[1/4] Resolving packages...']), '', 'progresso de yarn/npm não é prompt');
igual(extrairComando(['[ ] comprar leite']), '', 'checklist de Markdown no vim não é prompt');
igual(extrairComando(['[minha âncora](https://exemplo.com) no texto']), '',
  'link de Markdown no vim: o "](" cola como num prompt VRP, mas prompt de '
  + 'VRP não tem espaço DENTRO do colchete');
igual(extrairComando(['<hostname>olt-centro-01</hostname>']), '',
  'XML não é prompt VRP: o que sobra depois de um prompt <…> não pode conter "<"');
igual(extrairComando(['<title>Vincii Canvas</title>']), '', 'HTML idem');
igual(extrairComando(['<config>ativa o modo x</config>']), '', 'XML de configuração idem');

// A paginação REAL da OLT: Enter no More com cabeçalhos de seção na janela.
// A primeira versão gravava uma entrada de lixo POR PÁGINA do display elabel.
igual(extrairComando(['  ---- More ----', 'BarCode=021GPB6TC1234567', 'BoardType=H801GPBD', '[Board Properties]']),
  '', 'o cabeçalho [Board Properties] tem espaço dentro: não é prompt');
igual(extrairComando(['  ---- More ----', '[Slot_2]']), '',
  '[Slot_2] no fim da linha não tem comando colado: não é prompt');

// Sub-prompts de diálogo: o Enter na RESPOSTA juntava o diálogo ao comando da
// linha de cima ("enablePassword:", "reload…[confirm]").
igual(extrairComando(['Password:', 'Router>enable']), '',
  'a senha do enable não gera entrada — nem o "enablePassword:" de antes');
igual(extrairComando(['Proceed with reload? [confirm]', 'Router#reload']), '',
  'a confirmação do reload não é comando');
igual(extrairComando(['  Are you sure to continue? (y/n)[n]:y', 'MA5680T(config)#board confirm 0']),
  '', 'o (y/n) da OLT não é comando — mesmo com o "y" ecoado');
igual(extrairComando(['{ <cr>|configuration<K>|data<K> }:', 'MA5680T(config)#save']), '',
  'o diálogo do save da OLT não é comando');
igual(extrairComando(['>>User name:admin', 'banner do equipamento']), '',
  'o login da OLT não é comando (e o usuário ecoado não vai para o histórico)');

// E o legítimo continua passando: "password" DENTRO de comando não é diálogo.
igual(extrairComando(['MA5680T(config)#terminal user password']), 'terminal user password',
  'comando que TERMINA em "password" (sem dois-pontos) é comando de verdade');

console.log(`\n${n} verificações passaram`);
