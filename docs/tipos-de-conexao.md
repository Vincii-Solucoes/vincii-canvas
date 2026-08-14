# Tipos de conexão do Vincii Canvas

Documento para o time do **Homem Vitruviano**. Descreve o que o Canvas sabe
conectar e o que ele precisa receber do cofre em cada caso — para que vocês
saibam o que faz sentido cadastrar em `/v1/secrets` e em `/v1/sistemas`.

Extraído do código: `public/protocolos.js` (lista e portas), `server.js`
(validação do cadastro), `lib/credenciais.js` (ponto único de resolução) e os
clientes de cada protocolo em `lib/`.

---

## 1. Os seis protocolos

| Protocolo | Porta padrão | O que abre | Credencial |
|---|---|---|---|
| **SSH** | 22 | terminal de texto | agente, chave ou senha |
| **Telnet** | 23 | terminal de texto | senha (por vigia de prompt) |
| **FTP / FTPS** | 21 | gerenciador de arquivos | usuário + senha |
| **VNC** | 5900 | área de trabalho remota | senha |
| **RDP** | 3389 | área de trabalho remota | usuário + senha (+ domínio) |
| **Web** | 443 | página dentro de uma aba | nenhuma |

Dois recortes que o código faz e valem conhecer:

- **`PROTOCOLOS_SESSAO`** — todos menos FTP. O FTP é transferência de arquivo:
  não tem aba de terminal nem de tela, então nada que "abre sessão" o inclui
  (inclusive a agenda por horário, que ignora hosts FTP).
- **`SEM_TERMINAL`** — VNC, RDP e Web. Não executam comando, então o agente de IA
  e a execução em lote os recusam.

---

## 2. As quatro formas de autenticação

O campo é `auth.type`, e os valores são exatamente estes quatro:

### `agent` — agente SSH da máquina
Usa o `SSH_AUTH_SOCK` do sistema. Nenhum segredo é guardado nem pedido. Se o
agente não estiver disponível, o Canvas recusa com mensagem explícita em vez de
cair para outro método em silêncio.

### `key` — chave privada em arquivo
Guarda o **caminho** da chave no disco da máquina (`~/.ssh/id_rsa`, por exemplo)
e, opcionalmente, a passphrase.

### `password` — senha no próprio cadastro
A senha fica no `data.json` do app, em texto claro. É decisão consciente do dono
do app; o backup avisa quando o arquivo exportado contém segredos.

### `cofre` — a credencial vem de vocês
O host **não guarda credencial nenhuma**: guarda uma referência
`{ cofre, id, cliente, rotulo }` e busca o valor a cada conexão. É a forma que
esta integração adiciona, e a política é **nunca gravar** — o valor vive só em
memória, pelo tempo da sessão.

---

## 3. O que o Canvas faz com o segredo, por protocolo

Isto é o que importa para vocês: o que cadastrar do lado do ERP.

### SSH
`/v1/secrets/{id}` pode devolver os dois tipos que o contrato prevê:

- **`tipo: "senha"`** → vira autenticação por senha (`cfg.password`), com
  `tryKeyboard` ligado para servidores que pedem por teclado-interativo.
- **`tipo: "chave-ssh"`** → a chave privada vem **em memória** e nunca toca o
  disco; a `passphrase` é usada se vier. Este é o único protocolo do Canvas que
  aproveita `chave-ssh`.

O campo `usuario` do segredo é usado **só quando o host não define usuário** —
quem manda é o cadastro do host, senão editá-lo deixaria de ter efeito.

### Telnet
**Senha e, quando o host não tiver usuário cadastrado, também o `usuario` do
segredo.**

O Telnet não autentica no protocolo: quem pergunta é o próprio equipamento, em
texto na tela. O Canvas observa a saída à procura dos prompts, responde ao de
login com o usuário do cadastro do host ou — na falta dele — com o `usuario` do
segredo, e ao de senha com a senha do segredo. Uma vez por prompt; o vigia
desliga no primeiro caractere que o analista digitar, após o login, ou após
20 segundos.

Isso importa no cadastro: host Telnet **pode ser salvo sem usuário** (a
validação só exige usuário para SSH, porque o login é do equipamento). Nesses
casos o `usuario` do segredo é a única fonte — sem ele, o equipamento fica
parado no `login:` e a sessão parece travada.

`tipo: "chave-ssh"` não faz sentido aqui.

### FTP / FTPS
**Usuário + senha**, e os dois recuos são **independentes**: sem usuário (nem no
host nem no segredo) entra como `anonymous`; sem senha, manda `anonymous@`.

Vale saber porque produz um login híbrido silencioso: um segredo de
`tipo: "chave-ssh"` apontado num host FTP com usuário cadastrado faz o Canvas
tentar `usuario-real / anonymous@` — o servidor responde "530 Login incorrect" e
a tela mostra falha de senha, sem dizer que o tipo do segredo é que estava
errado. **Segredo de FTP tem de ser `tipo: "senha"`.**

Há quatro modos de criptografia no cadastro do host (`auto`, `yes`, `confia`,
`no`) — isso é configuração do host, não do segredo.

### VNC
Só **senha**. O servidor local até manda um campo de usuário junto (é a mesma
rota do RDP), mas o cliente VNC o descarta: o protocolo clássico autentica só
com senha. Cadastrar usuário num segredo de VNC não faz mal, e também não tem
efeito.

### RDP
**Usuário + senha**, mais o **domínio** quando o servidor usa Active Directory.
O domínio hoje é campo do host (`rdpDomain`), não do segredo — veja o pedido na
seção 5.

### Web
**Nenhuma credencial.** O Canvas abre a página numa aba e quem faz login é a
própria página. É o tipo usado pelos **sistemas** que vocês devolvem em
`/v1/sistemas` — eles viram hosts `web` automaticamente.

---

## 4. Uma ressalva honesta sobre VNC e RDP

Nesses dois protocolos, o cliente roda **no navegador** dentro do app (noVNC e
IronRDP em WebAssembly). Então a senha precisa chegar até lá: ela sai do servidor
local para a interface, pelo tempo do handshake.

Isso é assim desde antes do cofre existir e não muda com ele. O que a integração
muda é a **origem**: com cofre, a senha é buscada na hora e nunca existiu em
disco. Mas dizer "a senha nunca sai do servidor" seria mentira nesses dois casos,
e preferimos escrever do que deixar implícito.

Nos demais (SSH, Telnet, FTP), a credencial não sai do processo do servidor
local **durante a conexão**. Há uma exceção, e ela é sob ação explícita do
analista: o menu de variáveis da sessão tem a opção "colar a senha", feita para
responder a um `sudo` no meio do terminal. Nesse clique — e só nele — o valor é
resolvido e enviado à interface, por uma rota protegida por token do processo e
`Cache-Control: no-store`.

O backup exportado "com segredos" também carrega as senhas que estão no
`data.json`. As de cofre não, porque não existem em disco.

---

## 5. O que ajudaria vir do cofre

Hoje o contrato v1 entrega `senha`, `chavePrivada`, `passphrase` e `usuario`.
Isso cobre SSH, Telnet, FTP e VNC inteiros. Três observações:

**1. Domínio, para RDP.** Um campo opcional `dominio` no segredo cobriria o RDP
com Active Directory de ponta a ponta. Hoje o analista precisa digitar o domínio
no cadastro do host, mesmo com a senha vindo de vocês.

**2. Porta, quando não for a padrão.** `/v1/secrets` já traz `host` e `porta` na
listagem, e o Canvas os usa para ordenar a lista (o segredo cujo endereço bate
com o do host aparece primeiro). Se vocês quiserem que o cadastro do host seja
gerado a partir do cofre, `porta` já está lá — falta só o protocolo.

**3. Protocolo, se um dia fizer sentido.** Um campo `protocolo` com um dos seis
valores acima permitiria o Canvas montar o host inteiro a partir do segredo, do
mesmo jeito que hoje monta a partir de `/v1/sistemas`. Não é urgente; é a
evolução natural se vocês quiserem que o ERP descreva o acesso completo, e não só
a credencial.

---

## 6. Resumo para o cadastro no ERP

Se a pergunta for "o que eu cadastro para o analista conseguir entrar", a
resposta por tipo de acesso:

| O analista precisa entrar em… | Cadastre em `/v1/secrets` como | O Canvas usa |
|---|---|---|
| Servidor Linux por terminal | `senha`, ou `chave-ssh` (+ passphrase) | SSH |
| Roteador / switch legado | `senha` (+ `usuario`, se o host não tiver) | Telnet |
| Servidor de arquivos | `senha` (+ `usuario`) — nunca `chave-ssh` | FTP/FTPS |
| Windows por área de trabalho | `senha` (+ `usuario`) | RDP |
| Máquina com VNC | `senha` | VNC |
| Painel web do cliente | — cadastre em `/v1/sistemas`, com `url` | Web |

A última linha é a diferença que vale destacar: **painel web não é segredo, é
sistema**. Cadastrado em `/v1/sistemas` com `url`, ele aparece sozinho na lista
de hosts do analista, agrupado pelo nome do cliente, e abre no horário de
atendimento dele.
