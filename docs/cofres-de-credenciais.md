# Cofres de credenciais — descritivo da integração

Como o Vincii Canvas passa a buscar senhas em **cofres externos**, por chave de
API, em vez de guardá-las em `data.json`.

A integração é **geral**: vários cofres configurados ao mesmo tempo, de produtos
diferentes, e cada host aponta para o segredo de um deles. O contrato aberto
descrito na Parte A é apenas o primeiro provedor — o mais simples de implementar
para quem tem uma API própria (é o caso do Homem Vitruviano); os demais entram
por adaptador.

Decisões já tomadas:

| | |
|---|---|
| Conexão | Chave de API |
| Retenção da senha | **Nunca gravada em disco.** Buscada a cada conexão, vive em memória e some |
| Escrita no cofre | Nenhuma. O Canvas só **lê** |
| Quantos cofres | Vários, simultâneos, de produtos diferentes |

---

## A arquitetura: um núcleo, muitos adaptadores

```
                        ┌─ lib/cofres/nativo.js        (contrato aberto, Parte A)
lib/credenciais.js ─────┼─ lib/cofres/vault.js         (HashiCorp Vault)
   (núcleo)             ├─ lib/cofres/bitwarden.js
                        ├─ lib/cofres/senhasegura.js
                        └─ … um arquivo por produto
```

O núcleo não sabe nada de produto nenhum. Ele sabe três coisas: pedir a lista,
pedir um segredo, e o que fazer quando dá errado. Cada adaptador traduz um
produto para o formato abaixo.

### O formato canônico

Tudo que um adaptador precisa devolver. É a única forma que o resto do app
enxerga — `runner.js`, `terminal.js`, `files.js` e o RDP/VNC nunca sabem de qual
produto veio.

**Referência** (o que a listagem devolve, sem valor nenhum):

```json
{
  "id": "…",                    // opaco, estável, definido pelo produto
  "nome": "root@web-01",
  "caminho": "Infraestrutura/Produção",
  "tipo": "senha",              // "senha" | "chave-ssh"
  "usuario": "root",
  "host": "10.0.0.5",           // opcional — permite sugerir o segredo certo
  "porta": 22                   // opcional
}
```

**Segredo** (o que a leitura devolve):

```json
{ "tipo": "senha", "usuario": "root", "senha": "…", "expiraEm": "2026-08-08T02:15:00Z" }
```

```json
{ "tipo": "chave-ssh", "usuario": "root", "chavePrivada": "-----BEGIN …", "passphrase": "…" }
```

**Erro** — o núcleo decide o comportamento a partir do código, nunca do texto:

| Código | O que o Canvas faz |
|---|---|
| `chave_invalida` / `chave_expirada` | Para de tentar em **todos** os hosts daquele cofre e leva à configuração. Martelar um cofre com chave revogada costuma bloquear a chave de vez |
| `sem_permissao` | Falha só aquele host, com o motivo na aba |
| `nao_encontrado` | Falha o host e sugere reescolher o segredo no cadastro |
| `limite_de_taxa` | Respeita `Retry-After`, recua exponencialmente |
| `indisponivel` | Recuo exponencial; em lote, marca o host como não executado |

Traduzir o erro do produto para um destes códigos é responsabilidade do
adaptador. É o que evita os dois piores comportamentos: desistir de um cofre que
só estava reiniciando, e martelar um cofre com chave morta.

### Cada adaptador se declara

Os produtos não são iguais, e fingir que são produz uma interface que mente. Cada
adaptador exporta um descritor, e a tela de configuração **se monta a partir
dele**:

```js
module.exports = {
  tipo: 'vault',
  nome: 'HashiCorp Vault',
  // Campos que a tela vai pedir. Um `segredo: true` vai para o armazenamento
  // protegido e nunca para o backup.
  config: [
    { chave: 'baseUrl', rotulo: 'Endereço', tipo: 'url', obrigatorio: true },
    { chave: 'token',   rotulo: 'Token',    tipo: 'senha', obrigatorio: true, segredo: true },
    { chave: 'mount',   rotulo: 'Mount KV', tipo: 'texto', padrao: 'secret' },
  ],
  // O que este produto SABE fazer. A interface se adapta em vez de oferecer
  // botão que não funciona.
  capacidades: { listar: true, buscar: false, tipos: ['senha', 'chave-ssh'] },

  async ping(cfg) { /* … */ },
  async listar(cfg, { busca, cursor, limite }) { /* … */ },
  async ler(cfg, id) { /* … */ },
};
```

`capacidades.listar: false` é um caso real e precisa existir: há produto que só
lê por caminho, e há política que concede leitura sem listagem. Quando é o caso,
o cadastro do host **pede o caminho digitado** em vez de abrir um seletor — em
vez de mostrar uma lista eternamente vazia.

---

## Parte A — o contrato aberto (provedor `nativo`)

Para quem tem API própria e quer a integração mais direta: implementando estas
três rotas, o Canvas funciona sem adaptador nenhum.

**Autenticação**

```http
Authorization: Bearer <chave-de-api>
User-Agent: VinciiCanvas/1.26 (cofre v1)
```

A chave identifica **uma instalação do Canvas**, não uma pessoa: uma por máquina,
para revogar uma sem derrubar as outras e o log do cofre saber de onde veio cada
leitura. **Permissão mínima: leitura**, restrita às pastas necessárias.

**`GET /v1/ping`** — confere a chave e descreve o alcance. É o botão *Testar
conexão*.

```json
{
  "produto": "Homem Vitruviano", "versao": "1.0",
  "chave": { "id": "chv_7f3a", "rotulo": "Canvas — MacBook do Ygor",
             "expiraEm": "2027-01-31T00:00:00Z" },
  "permissoes": ["ler"],
  "cofres": [{ "id": "infra", "nome": "Infraestrutura" }]
}
```

`expiraEm` é opcional e vale ouro: com ele o Canvas avisa **antes** de a chave
vencer, em vez de o usuário descobrir numa madrugada de manutenção.

**`GET /v1/secrets?busca=&cofre=&limite=&cursor=`** — devolve `{itens:[…],
proximoCursor}` com as **referências** do formato canônico. Nunca inclui valor de
segredo, em campo nenhum.

**`GET /v1/secrets/{id}`** — a única rota que devolve valor, um segredo por
chamada. Responde com `Cache-Control: no-store`.

Isso não é rigor decorativo: com a leitura sempre por id, cada linha do log de
auditoria do cofre é o acesso a um segredo específico, e uma listagem não vira
um dump.

**Erros** — corpo uniforme em qualquer status ≥ 400, com os códigos da tabela do
formato canônico:

```json
{ "erro": { "codigo": "sem_permissao", "mensagem": "A chave não alcança o cofre 'clientes'." } }
```

**TLS** — `https://` obrigatório. Certificado autoassinado entra no mesmo modelo
que o app já usa para gerência de equipamento: **fixado na primeira conexão** e
conferido nas seguintes; mudou, recusa até você esquecer o pino. Não existe
opção "aceitar qualquer certificado" — o cofre de senhas seria o pior lugar do
app para tê-la.

**Lista de conformidade**, para o outro lado conferir sozinho:

- [ ] Três rotas sob `/v1`
- [ ] `Authorization: Bearer` aceito; chave em query string **recusada**
- [ ] `GET /v1/secrets` nunca inclui valor de segredo
- [ ] `GET /v1/secrets/{id}` responde com `Cache-Control: no-store`
- [ ] Erros usam `{erro:{codigo,mensagem}}` com os códigos da tabela
- [ ] 429 acompanha `Retry-After`
- [ ] Chave sem permissão devolve 403 — não 404, não lista vazia
- [ ] HTTPS com certificado estável

---

## Parte B — adaptadores para produtos existentes

O que cada adaptador precisa cobrir. **As rotas exatas eu fixo contra a
documentação do fabricante na hora de escrever cada um** — abaixo está o modelo
de autenticação e o formato do segredo, que é o que decide o desenho; não vou
afirmar caminho de API de produto que eu não conferi.

| Produto | Autenticação | Lista? | Particularidade que o adaptador resolve |
|---|---|---|---|
| **Nativo** (Parte A) | Bearer | sim | nenhuma — é o formato canônico |
| **HashiCorp Vault** (KV v2) | token, ou AppRole com renovação | sim | o segredo é um mapa livre de campos; qual campo é a senha vira configuração |
| **Bitwarden Secrets Manager** | token de acesso da organização | sim | segredo é par chave/valor, sem noção de usuário |
| **Bitwarden / Vaultwarden** (cofre normal) | não expõe API de servidor simples | — | precisa da CLI local (`bw serve`); avaliar se compensa |
| **senhasegura** | OAuth2 `client_credentials`, token com validade | sim | renovação do token dentro do adaptador |
| **CyberArk** (CCP) | certificado de cliente ou allowlist de app | **não** | leitura por `Safe`+`Object`; usa o caminho digitado |
| **1Password Connect** | token do Connect, por cofre | sim | item tem vários campos; mapear qual é senha |
| **AWS Secrets Manager** | SigV4 (perfil/role) | sim | não é chave de API; o adaptador usa o SDK |
| **Azure Key Vault** | OAuth2 (Entra ID) | sim | idem — identidade, não chave |

Os dois últimos merecem uma decisão sua: eles **não** usam chave de API, e sim
identidade da nuvem. Cabem na mesma arquitetura (o descritor de config declara os
campos que precisar), mas fogem do "conectar via chave de API" que você pediu.
Deixo fora da primeira leva salvo se você disser que precisa.

**Ordem que eu proporia:** `nativo` primeiro (destrava tudo e você já tem o
Homem Vitruviano), depois os dois que você mais usar. Cada adaptador novo é um
arquivo e um teste, sem tocar no núcleo — é esse o ponto da arquitetura.

---

## Parte C — o que muda dentro do Canvas

### O problema de hoje, medido

A senha do host é lida em **sete lugares diferentes**:

| Onde | O quê |
|---|---|
| `lib/runner.js:84-90` | SSH em lote (e, por tabela, o agente de IA) |
| `lib/terminal.js:120` | login automático de Telnet |
| `lib/files.js:195` | FTP/FTPS |
| `server.js` → `/api/desktop/credencial` | RDP e VNC |
| `lib/agent.js:199-215` | `redigir()`, que tira segredo da saída antes de mandar à IA |
| `lib/exportxml.js:99-113` | export do backup |
| `server.js` → `publicHost` | redação antes de devolver ao navegador |

Sete leitores diretos de `host.auth.password` é exatamente como este projeto já
perdeu campo três vezes (protocolo, `rdpDomain`, `url`): alguém acrescenta um
caminho e esquece de um dos sete. A integração **não pode** virar o oitavo.

### `lib/credenciais.js` — um ponto de resolução, e só um

```js
// resolver(host) -> { type, password?, privateKey?, passphrase?, dispose() }
```

Todo caminho de conexão passa a chamar `await credenciais.resolver(host)` em vez
de ler `host.auth` na mão. O objeto devolvido vive **em memória** pelo tempo da
conexão, registra o valor no cadastro de redação (abaixo) enquanto existir, e tem
`dispose()` — chamado ao encerrar a sessão — que apaga o valor e o tira do
cadastro.

Numa **execução em lote**, resolve **uma vez por host**, não uma por comando: em
40 hosts × 30 comandos, é a diferença entre 40 e 1200 leituras no cofre, e entre
um log de auditoria legível e um ilegível.

### Onde a credencial pode chegar

| Protocolo | A senha chega ao navegador? |
|---|---|
| SSH, Telnet, SFTP, FTP | **Não.** Cofre → processo Node → `ssh2`/`basic-ftp` |
| RDP, VNC | **Sim, inevitavelmente.** O cliente roda no renderer (IronRDP em WebAssembly, noVNC) |

O caminho de RDP/VNC já é assim hoje e não muda com o cofre. O que muda é que a
senha deixa de existir em disco. **Não é o mesmo que "a senha nunca sai do
servidor"** — o descritivo diz isso em vez de prometer o contrário.

### O buraco que a integração abre na redação para a IA

`lib/agent.js:199` monta a lista de segredos a remover da saída de comando **a
partir do `data.json`**. Sem senha lá, a lista fica vazia — e uma senha vinda do
cofre que apareça na saída de um comando **iria em texto claro para a API da
Anthropic**.

Por isso o `dispose()` não é higiene, é requisito: enquanto uma credencial está
resolvida ela fica no cadastro de redação, e `redigir()` passa a ler dali **além**
do `data.json`.

### Configuração dos cofres

```jsonc
"cofres": [
  {
    "apelido": "vitruviano-prod",     // ÚNICO, escolhido por você, estável
    "tipo": "nativo",
    "nome": "Homem Vitruviano",
    "config": { "baseUrl": "https://cofre.empresa/v1" },
    "certificadoFixado": "sha256/…"
  }
]
```

Os campos marcados `segredo: true` no descritor do adaptador **não ficam aqui**:
vão para o armazenamento protegido, por apelido.

### O host aponta pelo APELIDO, não por id gerado

```jsonc
{
  "auth": { "type": "cofre" },
  "segredo": {
    "cofre": "vitruviano-prod",       // apelido, não id de instalação
    "id": "sec_01HZX8Q3",
    "rotulo": "root@web-01"           // só para exibir
  }
}
```

Isto é uma decisão de projeto, não detalhe: se a referência apontasse para um id
gerado na instalação, restaurar o backup noutra máquina — onde os cofres foram
recriados com ids novos — deixaria **todo host apontando para o vazio**, sem
erro nenhum até a hora de conectar. Casando por apelido, o mesmo backup restaura
funcionando desde que o cofre exista com o mesmo apelido do outro lado.

Consequências a tratar:

- **Cofre ausente na importação:** o host entra, o cadastro mostra
  `⚠ cofre "vitruviano-prod" não configurado`, e conectar falha com essa
  mensagem — não com "senha inválida".
- **Renomear apelido** reaponta todos os hosts que o usam. A tela avisa quantos
  são antes de confirmar.
- `auth.type` ganha `"cofre"` nas três listas brancas de `server.js` (linhas 543,
  655 e 797 hoje).

### Backup

| Item | Vai no `.xml`? | Por quê |
|---|---|---|
| `segredo` do host (apelido + id + rótulo) | **Sim** | É referência, não segredo. Sem ela a restauração devolve um host que não conecta |
| Lista de cofres, sem os campos `segredo: true` | **Sim** | Endereço e tipo são configuração; restaurar noutra máquina só pede a chave |
| Chaves/tokens dos cofres | **Não, nunca** — nem com "incluir segredos" | Um `.xml` vazado com a chave dentro entrega o **cofre inteiro**, não uma senha |
| Certificado fixado do cofre | **Não** | Mesma família de `fingerprint` e `webCert`: prova de identidade aprendida nesta máquina |

A exclusão da chave é **inconsistente de propósito** com a chave da API da
Anthropic, que hoje é exportada com o opt-in. A diferença é o que cada uma abre.
Se você preferir consistência, é decisão sua e eu mudo.

`segredo` precisa entrar em `HOST_FILHOS` de `public/backup-campos.js`, o que faz
a guarda de três pernas do `test/backup.test.js` cobri-lo automaticamente — export,
leitura do XML e gravação na importação.

### Onde a chave de API mora

A chave do cofre tem alcance muito maior que uma senha de host: abre **todas**.

- **App desktop:** `safeStorage` do Electron (Keychain no macOS, DPAPI no Windows,
  libsecret no Linux). O app ainda não usa `safeStorage` em lugar nenhum; este é
  o caso que justifica.
- **Modo web (`npm start`):** `safeStorage` não existe. Grava em `data.json`,
  **com aviso explícito na tela** de que ali é texto claro.

### Interface

**Configurações → "Cofres de credenciais"** — lista dos cofres configurados, com
**Adicionar** (escolhe o produto, e o formulário se monta pelo descritor do
adaptador), **Testar** (chama `ping` e mostra rótulo da chave, permissões, cofres
alcançados e validade), **Esquecer certificado fixado** e **Remover** (avisando
quantos hosts ficam órfãos).

**Cadastro de host → Autenticação** — quarta opção ao lado de Agente SSH / Chave
privada / Senha: **Cofre**. Escolhe qual cofre, e então:
- adaptador **com** listagem → seletor com busca; se o host já tem endereço, os
  segredos cujo `host` bate aparecem primeiro;
- adaptador **sem** listagem → campo de caminho digitado, com o formato do
  produto no *placeholder*.

**Card do host** — etiqueta `🔑 vitruviano-prod` no lugar de `Senha`; em vermelho
se o cofre não estiver configurado.

**Conexão rápida** — pode escolher um segredo do cofre sem cadastrar host.

### Quando o cofre não responde

| Situação | O que acontece |
|---|---|
| Conexão manual | A aba abre e mostra o erro do cofre, com o código. Nada de "falha ao conectar" genérico |
| Execução em lote | O host entra como **não executado**, com motivo. Os demais seguem |
| Host com **agenda** | Nova tentativa a cada minuto, como já é hoje; só o primeiro aviso vai para a tela |
| Chave inválida/expirada | Para de tentar em todos os hosts **daquele cofre** e leva à configuração |

### Plano de teste

1. **`test/cofre-local.js`** — um cofre de mentira, no espírito do
   `test/sshd-local.js` que já existe: implementa o contrato nativo, mais os
   modos `--expira`, `--429`, `--503`, `--lento` e `--sem-listagem`. Destrava o
   desenvolvimento sem depender de ninguém e serve de implementação de
   referência para quem for escrever o outro lado.
2. **`test/credenciais.test.js`** — resolução por tipo; mapeamento de **cada**
   código de erro para o comportamento da tabela; recuo exponencial; `dispose()`
   apagando o valor; e o teste que mais importa: **um segredo resolvido é
   redigido da saída que vai para a IA**.
3. **`test/cofres-adaptadores.test.js`** — para cada adaptador, o mesmo lote de
   respostas cruas do produto entra e o formato canônico sai. É o teste que
   impede um produto novo de vazar formato próprio para dentro do núcleo.
4. **Integração de ponta a ponta** — cofre de mentira + `sshd-local` + conexão
   real, provando que a senha nunca é gravada: `grep` no `data.json` depois de
   conectar.
5. **`test/backup.test.js`** — `segredo` no host de referência; e o caso do
   **apelido ausente**, que é onde a restauração quebra em silêncio.

---

## Riscos e decisões que ficam com você

1. **A chave concentra risco.** Hoje um vazamento do `data.json` entrega as
   senhas que estão nele; com cofre, entrega a chave — e a chave entrega tudo que
   alcança. Mitigar com `safeStorage`, permissão mínima por pasta, uma chave por
   máquina e validade curta.
2. **Dependência de disponibilidade.** Sem o cofre no ar, nenhum host
   `type: "cofre"` conecta. Vale manter um ou dois hosts críticos com chave SSH
   local como caminho de emergência.
3. **RDP/VNC não mantêm a senha fora do navegador.** Limitação de arquitetura.
4. **A chave fora do backup é inconsistente de propósito** com a da Anthropic.
5. **AWS e Azure não usam chave de API.** Cabem na arquitetura, mas fogem do que
   você pediu. Ficam de fora da primeira leva salvo se você disser o contrário.

## O que preciso de você para começar

1. **Quais produtos**, em ordem de prioridade. Escrevo o `nativo` de qualquer
   forma; os demais dependem dessa lista.
2. Para cada um: **endereço, uma chave de teste somente leitura** e, se o
   certificado for autoassinado, a impressão digital SHA-256.
3. Se algum já tem API própria e documentada, **a documentação** — aí escrevo um
   adaptador em cima do que existe, em vez de pedir que implementem o contrato.
