# Homem Vitruviano — o que o Canvas já faz, e o que falta alinhar

Este documento tem duas partes. A primeira descreve o que está **implementado e
testado** no Canvas contra a especificação do cofre v1. A segunda é a lista de
perguntas para quem mantém o ERP — são pontos em que a especificação deixa
espaço para duas leituras, e onde escolher errado dá erro silencioso.

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
Testes: [`test/vitruviano.test.js`](../test/vitruviano.test.js) — 93 verificações.

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
Arquivo: [`public/janela.js`](../public/janela.js), 67 verificações em
[`test/janela.test.js`](../test/janela.test.js).

**4. Limites são recusa, não ajuste.** `limite=500` devolve 422 em vez de cortar
em 200. Então o Canvas corta **antes** de perguntar: `limite` em 200, `busca` em
128, `cofre` em 64.

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
node test/vitruviano-local.js --expira --429 --503 --erp-validation --fora-de-horario
```

---

## Parte 2 — o que preciso alinhar com vocês

Em ordem de impacto. As três primeiras mudam código.

### 1. `/v1/secrets` não diz de qual cliente é o segredo — pode incluir?

Hoje a listagem devolve `id`, `nome`, `caminho`, `tipo`, `usuario`, `host`,
`porta`, `atualizadoEm` — mas **não** o cliente. Só `/v1/sistemas` traz `cofre` e
`cofreNome`.

Isso significa que não há como, olhando um segredo, saber a qual janela de
atendimento ele obedece. O Canvas contorna guardando o cliente **no momento em
que o analista escolhe o segredo** (ele escolheu filtrando por cliente, então a
tela sabe). Funciona, mas é frágil: um segredo escolhido sem filtro fica sem
cliente, e o host não segue horário nenhum.

**Pedido:** incluir `cofre` e `cofreNome` em cada item de `/v1/secrets`, como já
existe em `/v1/sistemas`. É o mesmo dado, no mesmo formato.

### 2. Sistemas não têm id estável

A especificação diz para usar `cofre + nome` como chave. Isso quer dizer que
renomear um sistema no ERP quebra qualquer referência que o Canvas tenha
guardado, sem aviso. Há um id interno que possa ser exposto?

### 3. Uma exceção pode cair no meio de um turno que atravessa o dia?

Exemplo: plantão de domingo 22:00 até segunda 06:00, e a segunda é feriado
(`fechado: true`).

O Canvas hoje decide de forma **conservadora**: a exceção manda no dia inteiro
dela e corta o turno que entrou na madrugada. A lógica é que o cofre é a trava
real — se ele fosse recusar a credencial às 02:00 do feriado, manter a tela
aberta produziria um laço de conexões negadas.

**Pergunta:** o cofre de vocês recusa ou aceita a credencial às 02:00 desse
feriado? Se aceita, invertemos a regra.

### 4. Algum 503 é transitório?

Tratamos **todo** `indisponivel` como definitivo, pelo texto da documentação
("não adianta reintentar"). Se houver um caso de 503 que passa sozinho
(manutenção, reinício), ele precisa de código próprio — senão o analista vai
precisar clicar de novo à toa.

### 5. O que `expiraEm` do segredo significa exatamente?

Instante em que a credencial **deixa de ser válida no destino** (a senha muda no
servidor), ou em que **o cofre para de entregá-la**? A tela precisa dizer coisas
diferentes: "esta senha vence às 18:00, sua sessão vai cair" é diferente de
"depois das 18:00 você vai precisar pedir de novo".

### 6. O limite de 120 req/min é por chave ou por IP?

Se for por IP, um escritório inteiro atrás do mesmo NAT compartilha o limite, e
a conta muda: com dez analistas, são 12 requisições por minuto cada um. Hoje o
Canvas busca a lista de janelas a cada 5 minutos por cofre e lê o segredo uma vez
por conexão, o que é folgado por chave — mas apertado se o limite for por IP.

### 7. A `janela` de `/v1/secrets/{id}` pode divergir da de `/v1/ping`?

Ambas trazem a janela do cliente. Se elas puderem diferir (uma mais atual que a
outra), qual manda? O Canvas hoje usa a do `ping`, porque é a que ele tem sem
gastar uma leitura de segredo.

### 8. Qual código o analista desligado recebe?

Quando alguém sai da empresa ou perde o acesso a um cliente, a próxima chamada
volta com `sem_permissao` (403), `chave_invalida` (401) ou `cliente_inativo`
(403)? A mensagem na tela muda bastante: "fale com seu gestor" é diferente de
"seu token foi revogado".

### 9. E se o horário de verão voltar?

O `fuso` é fixo em `-03:00`. Se o horário de verão voltar, muda o campo `fuso`
por cliente, ou mudam os `turnos`? O Canvas calcula com o deslocamento declarado,
nunca com o relógio da máquina — então segue vocês, mas precisa saber onde olhar.

### 10. `campos` de `/v1/sistemas` é texto livre

A política de vocês diz que senha não deveria ir aí, mas nada impede. O Canvas
trata esses valores como potencialmente sensíveis: não registra em log e não
grava em disco. Vale confirmar se essa é a expectativa — ou se há validação no
ERP que eu possa assumir.

---

## Resumo do que muda se vocês aceitarem o pedido 1

Se `/v1/secrets` passar a trazer `cofre` e `cofreNome`:

- some a necessidade de guardar o cliente no cadastro do host;
- um segredo escolhido sem filtro passa a ter janela também;
- hosts restaurados de backup antigo ganham horário sozinhos.

É a mudança de maior efeito da lista, e a mais barata: um campo que vocês já têm,
numa rota que já existe.
