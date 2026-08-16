# Homem Vitruviano — o que o Canvas já faz, e o que falta alinhar

Este documento tem duas partes. A primeira descreve o que está **implementado e
testado** no Canvas contra o contrato do cofre v1. A segunda registra o que o
time do ERP respondeu às dez perguntas de 11/08/2026 e o que ficou em aberto.

Contrato autoritativo: `docs/INTEGRACAO-CANVAS.md`, no repositório do Homem
Vitruviano. Quando os dois discordarem, ele manda.

Para o contrato geral de cofres (o que vale para qualquer produto), veja
[cofres-de-credenciais.md](cofres-de-credenciais.md). Este arquivo é só sobre o
Homem Vitruviano.

---

## Parte 1 — o que já está pronto

### As quatro rotas

| Rota | O que o Canvas faz com ela |
|---|---|
| `GET /v1/ping` | valida o token, mostra o rótulo dele na tela e lê a lista de **clientes atendidos** com a **janela de atendimento** de cada um |
| `GET /v1/secrets` | popula o seletor de segredos no cadastro do host, com filtro por cliente e busca |
| `GET /v1/secrets/{id}` | lê a credencial **no momento da conexão**, e só |
| `GET /v1/sistemas` | a mesa de trabalho: os sistemas do cliente, com URL |

Arquivo: [`lib/cofres/vitruviano.js`](../lib/cofres/vitruviano.js).
Testes: [`test/vitruviano.test.js`](../test/vitruviano.test.js) — 118 verificações,
mais [`test/cofre-http.test.js`](../test/cofre-http.test.js) no transporte e
[`test/redigir.test.js`](../test/redigir.test.js) na redação.

### Os quatro pontos em que este produto difere do contrato aberto

**1. Dois envelopes de erro.** O cofre responde `{erro:{codigo,mensagem}}` em
português; o que falha antes dele (validação de parâmetro, rota errada, falha
inesperada) responde `{error:{code,message}}` em inglês. O adaptador lê os dois.
Lendo só o primeiro, todo `validation_error` cairia no palpite genérico, viraria
`indisponivel`, e o app tentaria três vezes contra um parâmetro que ele mesmo
mandou errado — mostrando "o cofre está fora do ar", que é mentira.

**2. `indisponivel` (503) não é transitório.** No contrato aberto, 503 quer dizer
"tente de novo". Aqui quer dizer "o cofre está sem chave de cifra" ou "o segredo
não decifra", e a documentação de vocês manda avisar o administrador em vez de
reintentar. O adaptador marca esse erro como **não transitório** e o núcleo do
Canvas obedece — insistir ali só gastaria o limite de 120 req/min contra uma
parede.

**3. A janela de atendimento vira comportamento.** O horário que vem no `ping`
faz o Canvas **abrir sozinho** os hosts daquele cliente e **travar a aba** (o "×"
some) durante o período. Fora dele a aba volta a fechar normalmente. Nada é
derrubado no fim do horário — interromper um comando em execução seria pior —
mas o app **avisa** quando o período termina: *"O atendimento de Velonic
terminou. 2 abas continuam abertas e já podem ser fechadas."* Um aviso por
cliente, e só quando há aba aberta.
Arquivo: [`public/janela.js`](../public/janela.js), 102 verificações em
[`test/janela.test.js`](../test/janela.test.js).

**4. Limites são recusa, não ajuste.** `limite=500` devolve 422 em vez de cortar
em 200. Então o Canvas corta **antes** de perguntar: `limite` em 200, `busca` em
128, `cofre` em 64. E o 422 **não tem `message`** — a explicação mora em
`details`, que é de onde a mensagem da tela sai.

### As duas armadilhas da janela

Vieram da resposta do time do ERP, e as duas quebravam calado:

**`excecoes` NÃO atravessa o dia; `turnos` atravessa.** Vêm no mesmo payload e a
escrita é idêntica, mas significam coisas diferentes. Um turno `22:00→06:00`
(que tem `diaInicio`/`diaFim`) vai de hoje à noite até amanhã de manhã. Uma
exceção `22:00→06:00` vale **dentro da mesma data**: `00:00–06:00` **e**
`22:00–24:00` daquele dia. O Canvas aplicava a regra do turno nas duas, e perdia
a madrugada inteira — o sistema não abria, sem erro em lugar nenhum.

**O corte é por dia-calendário.** Um plantão domingo 22:00 → segunda 06:00 com
feriado na segunda entrega às 23:00 do domingo e **recusa** às 02:00 da segunda.
A escolha conservadora que o Canvas já tinha (exceção manda no dia inteiro) era
a certa, e agora tem teste.

E o feriado substitui os turnos **nos dois sentidos**: um cliente **sem turno
nenhum** abre numa data com exceção de expediente reduzido. "Sem turnos" não
implica "nunca abre".

### Horário de verão

O `fuso` hoje é `-03:00`, fixo. Se o horário de verão voltar, o ERP passa a
mandar a **zona** (`America/Sao_Paulo`) em vez do deslocamento — porque
deslocamento fixo não representa DST. O Canvas já aceita as duas formas, e
calcula o deslocamento **para cada instante consultado**. Antes, um nome de zona
não casava com o formato esperado e virava `-03:00` em silêncio: uma hora errada
todo dia durante o verão, sem nada na tela.

### `expiraEm` não trava nada

É **puramente informativo**: o cofre não para de entregar o segredo depois dessa
data — não existe checagem nenhuma. A leitura certa é "esta senha deve ser
trocada até tal dia". Nada na interface promete que a sessão cai, porque não cai.

### O que o Canvas guarda no disco

Só a **referência**: apelido do cofre + id do segredo + id do cliente + rótulo.
Nunca o valor. A credencial é buscada a cada conexão e vive só em memória, pelo
tempo da sessão — foi a política escolhida ("nunca gravar").

O **token** (`hvk_…`) fica fora do `data.json`, em arquivo próprio com permissão
600, protegido pelo Keychain quando disponível. Ele **não sai no backup**, por
construção.

### Como testar sem o ERP no ar

Há um Homem Vitruviano de mentira no repositório, com as quatro rotas e os dois
envelopes de erro:

```bash
node test/vitruviano-local.js
```

Ele sobe em `http://127.0.0.1:4712/api/cofre/v1` com o token `hvk_teste`, dois
clientes (um 24 h, outro comercial com feriado e véspera reduzida), três sistemas
e quatro segredos. Modos para exercitar os caminhos difíceis:

```bash
node test/vitruviano-local.js --expira --429 --503 --erp-validation --conflict --fora-de-horario
```

E `--sem-cliente` simula o ERP anterior a 11/08/2026, que não mandava `cofre`
em `/v1/secrets` — é o caminho de reserva do seletor de cliente.

---

## Parte 1b — o 502 intermitente (12/08/2026)

Sintoma relatado: "hora conecta, hora não". A causa é do ERP, e o time de lá já
achou o mecanismo e corrigiu — mas o episódio deixa duas lições que valem ficar
escritas.

### O mecanismo

O backend sobe com `alembic upgrade head && exec uvicorn`: a porta fica fechada
enquanto as migrations rodam. `postgres` e `redis` tinham healthcheck; o backend
não — então nada distinguia "subindo" de "no ar", e o gateway roteava para uma
porta fechada. Com deploy automático a cada push (18 em 48 h, 8 num dia só),
isso dá várias janelas de 502 por dia, de poucos segundos, com recuperação
sozinha. Foi exatamente o padrão medido.

Correções do lado deles: healthcheck em `/health` com `start_period` de 60 s;
`last_used_at` deixou de fazer `UPDATE + COMMIT` em toda request autenticada
(agora no máximo 1×/min); e `served_provider_ids` parou de carregar o `Employee`
inteiro com todos os relacionamentos para ler duas colunas.

### A medição que apontou para o lugar errado — minha

Eu medi 30 chamadas com token **inválido** (30/30 em 0,2 s) contra o caminho
autenticado (0,11 s) e concluí que "o 401 não chega ao app, então o problema está
atrás da autenticação". **As duas metades estavam erradas.**

O 401 é gerado pelo app, depois de consultar `vault_api_keys`. A prova está no
corpo: sem cabeçalho ele responde *"Falta o cabeçalho Authorization: Bearer."*;
com token errado, *"Chave de API inválida."* Distinguir os dois exige a consulta
— nenhum proxy genérico produz isso. Logo, 30/30 respostas boas com token
inválido são prova de que **o app estava vivo** naquelas 30 chamadas: eu apenas
não amostrei durante um blip.

E a diferença de tempo era artefato do meu método. Medido depois, mesmo endpoint,
mesmo token inválido, mudando só a conexão:

| | média |
|---|---|
| conexão nova a cada chamada (o que meu laço de `curl` fazia) | 222 ms |
| conexão reaproveitada (o que o Canvas faz) | 99 ms |

Os 123 ms de diferença são handshake TLS. Os 99 ms do caminho inválido e os
110 ms do autenticado são, na prática, o mesmo número — não havia sinal nenhum de
"o caminho autenticado é mais lento".

**A lição:** comparar latência entre dois clientes com política de conexão
diferente não mede o servidor, mede o cliente. Para acusar um caminho de lento,
os dois lados precisam reusar conexão — ou nenhum.

### O que o Canvas faz a respeito

As mitigações continuam valendo mesmo com o healthcheck no ar, porque deploy
ainda reinicia o processo:

- **502/504/408 sem envelope são transitórios** e o app retenta. O `indisponivel`
  do contrato (que traz envelope) continua definitivo.
- **3xx é erro, não sucesso.** Um redirecionamento tinha corpo vazio e virava
  "cofre com zero clientes", calado. É o que um proxy faz ao mandar para uma
  página de login.
- **Carência progressiva** de 5 s, 15 s e 60 s, zerando no primeiro sucesso.
- **Falha com cache cheio não apaga nada**; falha com cache vazio aparece na tela,
  com motivo e prazo.

---

## Parte 2 — o que já foi respondido, e o que continua em aberto

O time do ERP respondeu tudo, verificado contra o código deles. Os dois pedidos
que mudavam código **foram atendidos** e o Canvas já consome as duas coisas.

### Atendido: `cofre` e `cofreNome` em `/v1/secrets`

Cada segredo agora diz de qual cliente é. Isso resolveu o buraco que existia:
escolher um segredo **sem** filtrar por cliente deixava o host sem horário
nenhum. Agora o cliente vem no próprio item, e o filtro é só reserva para ERP
anterior a 11/08/2026.

`cofre` nunca vem null; `cofreNome` pode — e o Canvas trata como anulável (senão
a tela imprimiria "null" no lugar do nome do cliente).

### Atendido: `id` estável por sistema

`/v1/sistemas` traz `id`, e ele sobrevive a renomear. O Canvas usa esse id como
chave e marca internamente quando teve de cair no `cliente + nome` — o que só
acontece com sistema antigo que ainda não passou por um save no ERP, e é frágil
porque **nome não é único por cliente**.

### Respondido, sem mudança de código

| Pergunta | Resposta | O que o Canvas faz |
|---|---|---|
| Exceção no meio de plantão que vira o dia | o cofre **recusa** às 02:00 | a regra conservadora estava certa; agora com teste |
| Algum 503 é transitório? | **nenhum** — os dois casos exigem ação humana | tratado como definitivo, sem retry |
| `expiraEm` | puramente informativo | nada na tela promete queda de sessão |
| As duas `janela` podem divergir? | não por implementação, só por tempo | usa a do ping; a do segredo confirma |
| `campos` de `/v1/sistemas` | **nenhuma** validação de conteúdo | tratado como sensível: não loga, não grava |

### O limite é pior do que eu supus

**120 req/min por IP, do ERP inteiro** — não por token, e não é um balde só do
cofre. Atrás do NAT do escritório, o Canvas divide o contador com a interface web
que os analistas estão usando ao mesmo tempo.

O que o Canvas gasta hoje: **1 requisição por cofre a cada 5 minutos** (a lista
de janelas, em cache no servidor, compartilhada por todas as janelas do app) mais
**1 leitura por conexão**. E o `Retry-After` de um 429 agora é obedecido também
no cache — antes ele tentava de novo a cada 60 s, o que é ajudar a estourar um
balde que já estourou.

**Aceito a oferta de trocar para limite por chave** (hash do Bearer) com fallback
por IP. Não é urgente para o Canvas, mas o problema real de vocês é a interface
web dividindo balde com o resto — isso vai morder alguém num dia de pico.

### Aberto: as duas coisas que vocês ofereceram criar

**1. `funcionario_inativo` — sim, por favor.** Hoje "analista desligado" e
"perdeu o acesso a um cliente" são indistinguíveis, e a mensagem "você não atende
esse cliente" manda a pessoa pedir acesso a um cliente quando o problema é a
conta inteira. Enquanto não existe, o Canvas distingue o que dá: uma lista de
clientes **vazia depois de uma consulta bem-sucedida** passa a dizer "o cofre
respondeu que você não atende nenhum cliente — é cadastro no ERP", em vez de "a
lista ainda não chegou", que deixava a pessoa esperando.

**2. Um campo que distinga "sem turnos" de "encaminhamento desativado" — sim.**
É o pior caso restante: o cliente **tem** trava, o Canvas só não recebe qual é.
Resultado hoje: o host não abre sozinho (correto, conservador) mas, se o analista
clicar fora do expediente, toma 403 sem que nada na tela tivesse como avisar
quando ele podia entrar. Um booleano `horarioOculto: true` já resolveria — dá
para escrever "este cliente tem horário de atendimento, mas ele não está
disponível aqui" em vez de silêncio.

### O que a auditoria do próprio Canvas achou

Reler o contrato de vocês virou uma auditoria adversarial do nosso lado, e ela
achou **sete defeitos nossos** — quatro deles graves, e nenhum tinha nada a ver
com o ERP. Registrado aqui porque dois afetam o que vocês entregam:

- **A trava de certificado nunca entrava em vigor.** O gancho que grava a
  impressão digital era o sexto parâmetro posicional de uma função, e nenhum dos
  oito pontos de chamada o passava. Como o transporte também tinha
  `rejectUnauthorized: false` (para aceitar cofre com certificado autoassinado),
  o resultado era: **qualquer certificado aceito, sempre**, com o token `hvk_`
  indo junto. Corrigido, com teste que sobe dois servidores HTTPS e prova que a
  troca de certificado é recusada.

- **Acento partido entre pacotes.** O corpo da resposta era concatenado
  Buffer a Buffer sem declarar UTF-8. Um "ç" que caísse na fronteira entre dois
  pacotes do socket voltava como lixo — e isso acontece com `caminho`,
  `cofreNome` e nome de sistema, que são justamente os campos com acento.

- **Resposta grande demais pendurava a chamada.** O corte existia, mas rejeitava
  no evento `end`, que `destroy()` impede de acontecer. Descobri porque o teste
  travou em vez de falhar.

Os outros quatro (chave privada fora da lista de redação, `Retry-After` cortado
em 5 s, credencial de Telnet/FTP nunca devolvida, e turno de duração zero virando
24/7 permanente) são internos e já estão corrigidos.

### Os sistemas do cliente viram hosts sozinhos

`/v1/sistemas` deixou de ser uma tela de consulta: os sistemas de cada cliente
aparecem na lista de hosts do Canvas, agrupados pelo nome do cliente, e abrem
como página web. Quem manda é o ERP — renomeou lá, muda aqui; tirou de lá, some
daqui.

Eles **nunca entram no `data.json`**, e é isso que faz o espelho ser espelho:
gravados, sobreviveriam à remoção no ERP e virariam host fantasma; iriam no
backup, e restaurar noutra máquina traria a mesa de trabalho de quem exportou;
e um campo editado à mão seria apagado na renovação seguinte, em silêncio. Por
isso o Canvas também recusa editar e excluir esses hosts, com mensagem dizendo
onde mexer.

Duas consequências que vocês podem querer saber:

- **Sistema sem `url` não vira host.** Ele continua na lista de sistemas, mas
  não há o que abrir. Hoje é o caso de "Rede interna" no exemplo.
- **O horário de atendimento do cliente vale para eles.** Um sistema da Velonic
  abre sozinho e trava a aba durante o expediente da Velonic, sem ninguém
  digitar horário no Canvas. É o encontro das duas rotas de vocês.

Custo em requisição: `/v1/sistemas` entra na MESMA renovação do `/v1/ping`, sem
relógio próprio — duas requisições por cofre a cada 5 minutos, e não duas
contagens independentes que se cruzam.

### Uma coisa que notei lendo o contrato de novo

`/v1/secrets` promete que `cursor` inválido **degrada para a primeira página com
200**, sem erro. Numa varredura paginada isso pode fazer a página 1 voltar no
meio e repetir segredos na lista, sem nada indicando que houve problema. O Canvas
agora ignora id repetido e encerra a varredura quando um cursor se repete — mas
vale vocês saberem que "degrada em silêncio" é uma armadilha para qualquer
cliente que pagine.

---

## Parte 3 — o contrato de 14/ago, consumido (16/08)

A documentação reencaminhada trouxe as respostas às observações do nosso
`docs/tipos-de-conexao.md`, e o Canvas já consome tudo:

### `protocolo` e `dominio` nos segredos

- **`dominio` fecha o RDP com Active Directory de ponta a ponta.** A regra no
  Canvas é a mesma do usuário: o campo digitado no host manda; o do cofre cobre
  quando vazio. Um segredo com `usuario`, `senha` e `dominio` entra no RDP sem
  nada digitado no cadastro.
- **`protocolo` vira selo e ordenação no seletor de segredos.** Entre dois
  segredos do mesmo endereço, o que declara o protocolo do host vem primeiro; um
  segredo cujo protocolo **não bate** com o do host ganha o aviso "segredo de
  TELNET" antes de a pessoa salvar — o descasamento falhava na conexão com cara
  de senha errada. Valor de `protocolo` fora dos seis é descartado na entrada.

### Os tipos novos (`token`, `banco`, `nota`, `certificado`)

A frase que importa do contrato é **"são só DUAS formas"** — e o Canvas agora
decide a forma **pelo campo que veio**, não pelo nome do tipo: `chavePrivada`
presente = forma PEM (autentica como chave, com `passphrase` se houver); senão,
`senha` = valor único. O nome do tipo é só rótulo na tela ("token de API",
"senha de banco", "nota secreta", "certificado"), e um tipo **desconhecido**
mantém o nome e funciona na forma em que chegar — como o contrato promete que
tipos futuros chegarão.

Isso não é detalhe: decidindo pelo nome, `certificado` (que é PEM) caía no ramo
do valor único e estourava com "o cofre não mandou a senha" — com o cofre tendo
mandado tudo.

### As duas ofertas — entregues (16/08) e consumidas

**`funcionario_inativo`** agora fala em todas as rotas de dados, inclusive a
listagem sem filtro que devolvia `200 []` mudo. O Canvas o trata como
definitivo (insistir não recontrata ninguém) e o distingue do `200 []`
legítimo — analista ativo que ainda não atende ninguém — que continua com a
mensagem "é cadastro no ERP".

**`semJanela`** dá nome à ausência de janela, e o cartão do host na aba Hosts
usa os dois nomes, porque os consertos são diferentes:

- `sem_turnos` → selo "⏱ sem turnos no ERP": a credencial não abre em horário
  nenhum até os turnos serem cadastrados lá;
- `encaminhamento_desativado` → selo "⏱ horário não encaminhado": abre por
  clique dentro do horário; o app só não sabe dizer quando.

Valor fora dos dois estados é descartado na entrada, como protocolo estranho.
O aviso de vocês se confirmou aqui: os clientes reais sem turnos vão aparecer
com o primeiro selo até os horários serem cadastrados no ERP.
