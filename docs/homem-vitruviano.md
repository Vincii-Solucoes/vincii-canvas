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
derrubado no fim do horário — interromper um comando em execução seria pior.
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

### Uma coisa que notei lendo o contrato de novo

`/v1/secrets` promete que `cursor` inválido **degrada para a primeira página com
200**, sem erro. Numa varredura paginada isso pode fazer a página 1 voltar no
meio e repetir segredos na lista, sem nada indicando que houve problema. O Canvas
agora ignora id repetido e encerra a varredura quando um cursor se repete — mas
vale vocês saberem que "degrada em silêncio" é uma armadilha para qualquer
cliente que pagine.
