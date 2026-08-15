# CLAUDE.md — guia para trabalhar neste repositório

Este arquivo orienta o Claude (e qualquer pessoa) a mexer no **Vincii Canvas**
sem quebrar o que existe. Ele **descreve o projeto como ele é** e define padrões
para o que for novo — sem impor uma arquitetura nova sobre o código atual.

## Diretriz principal

> **Respeite o projeto que existe. Evolução, não revolução.**

Este é um app **maduro**, com decisões conscientes e bem comentadas. Antes de
"melhorar" qualquer coisa, presuma que o que está lá tem um motivo — muitas vezes
o motivo está escrito num comentário logo acima. Leia primeiro.

Três níveis aparecem ao longo deste guia, e a diferença entre eles é obrigatória:

- **CURRENT STATE** — como o projeto funciona hoje. É o que você deve **respeitar
  e imitar** ao mexer em código existente.
- **TARGET STANDARDS** — o que **código novo** deve seguir. Derivam dos melhores
  padrões que o próprio projeto já usa, não de uma stack nova.
- **MIGRATION RULES** — como o código legado *pode* migrar aos poucos. Sempre
  **opcional e oportunista**.

> **Nunca exija refatorar código antigo só porque um padrão novo foi criado.** Um
> TARGET STANDARD não é licença para reescrever o que funciona. Código legado que
> não segue o padrão novo **não é bug**.

Documentação de apoio (leia antes de mexer na área correspondente):
[docs/PROJECT_CONTEXT.md](docs/PROJECT_CONTEXT.md),
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/DATABASE.md](docs/DATABASE.md),
[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md),
[CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md).

---

## 1. Antes de implementar qualquer coisa

**Análise antes de código — obrigatório.** Não escreva a primeira linha antes de:

1. **Entender o pedido** e onde ele encosta no código. Localize os arquivos e
   trace o caminho (rota → serviço/lib → persistência → UI).
2. **Procurar o que já existe.** Antes de criar função, módulo, rota, componente
   de UI ou helper, **procure um equivalente** (`grep`/busca por nome e por
   comportamento). Reutilizar vence criar. Ver §2 e §3.
3. **Ler os comentários da região.** O projeto explica o *porquê* das decisões no
   próprio código; um comentário costuma dizer por que a solução óbvia não serve.
4. **Confirmar o escopo mínimo.** Faça o menor diff que resolve o pedido. Não
   refatore "de carona".

Se, ao analisar, você perceber que o pedido implica uma **mudança de arquitetura,
de formato de dados ou de contrato de API**, **pare e sinalize** antes de
implementar (ver §10).

---

## 2. Não duplicar componentes e serviços

Duplicação já custou caro aqui — o próprio código registra bugs causados por
listas e regras copiadas (a lista de protocolos que fez todo host RDP restaurar
como SSH; a lista `TIPOS_DE_AUTH` copiada em três pontos). **Não repita esse
erro.**

**Pontos únicos que você DEVE reutilizar (nunca reimplementar):**

| Preocupação | Use | Não faça |
|---|---|---|
| Resolver a credencial de um host | `lib/credenciais.js` (`resolver()`) | Ler `host.auth`/cofre por conta própria |
| Ler/gravar o estado (`data.json`) | `lib/store.js` (`get()`/`save()`) | Abrir `data.json` direto |
| Escrever arquivo de dados com segurança | `lib/gravaratomico.js` (`gravarAtomico`) | `fs.writeFileSync` + rename à mão |
| Variáveis `{{VAR}}`, `@cada`, precedência | `lib/vars.js` | Parsear variável por conta própria |
| Protocolos, portas, `SEM_TERMINAL`, `PROTOCOLOS_SESSAO` | `public/protocolos.js` | Repetir a lista de protocolos |
| Redigir segredos antes da IA | `lib/redigir.js` | Montar a lista de segredos manualmente |
| Fechar WebSocket com motivo | `lib/wsclose.js` | `ws.close(code, motivoLongo)` (estoura 123 bytes) |
| Ícones/cores de host | `public/host-icons.js` | Novo conjunto de ícones |
| Agenda/horário do host | `public/agenda.js`, `public/horario.js` | Recalcular faixa horária |
| Erro de rota (HTTP) | helper `fail(res, status, msg)` em `server.js` | `res.status().json()` cru |

**Antes de adicionar um helper**, procure um existente. Aviso concreto do estado
atual: já há duplicação real (ex.: `acharHost` em 3 arquivos, `humanizaRede` em 2)
— **não some à pilha**. Se precisar de algo que já existe duplicado, prefira o
ponto que resolve melhor e, se for barato, unifique (ver §10 antes de unificar
entre camadas).

---

## 3. Reutilizar o código existente

**CURRENT STATE.** O backend é **CommonJS** (`require`/`module.exports`). O
frontend é **script clássico de escopo global** em `public/` (sem `import`/
`export`; funções e `const` no escopo global compartilhado) — **exceto**
`public/desktop.js` e `public/scancodes.js`, que são ES modules. Alguns módulos
"puros" (regras que valem nos dois lados) são carregados **no navegador e no
Node** com a guarda dupla no rodapé:

```js
if (typeof module !== 'undefined' && module.exports) module.exports = { ... };
if (typeof window !== 'undefined') window.X = X;
```

Exemplos: `public/protocolos.js`, `public/agenda.js`, `public/weburl.js`,
`public/horario.js`. **Se uma regra precisa valer nos dois lados, use esse padrão
em vez de duplicá-la.**

**TARGET STANDARDS (código novo).**
- Prefira **estender um módulo existente** a criar um novo paralelo.
- Regra compartilhada backend↔frontend → um módulo "puro" com a guarda dupla.
- Lógica de domínio nova, se possível, em um **arquivo próprio de `lib/`**
  (testável isolado), em vez de engordar `server.js` ou `public/app.js`.

**MIGRATION RULES.** Não é obrigatório mover código legado para módulos novos.
Ao **tocar** numa função que já está duplicada, você *pode* consolidá-la se o
risco for baixo e houver teste — mas isso é oportunista, nunca um mutirão.

---

## 4. Convenções de código

**CURRENT STATE.**
- **JavaScript puro, sem build, sem bundler, sem TypeScript.** `public/` é servido
  como está por `express.static`. Não introduza etapa de build.
- **Indentação 2 espaços, LF, UTF-8** (`.editorconfig`). Node 20 (`.nvmrc`).
- **Comentários explicam o *porquê*** (a decisão, o bug medido), em **pt-BR**, e
  são densos. Mantenha esse tom; não troque comentários de contexto por óbvios.
- **Nomenclatura mista pt/en** no código antigo (`acharHost`, `startRun`). Os
  módulos mais recentes (cofres, agenda, credenciais) são **pt-BR**.
- **Tratamento de erro:** helper `fail(res, status, msg)` no backend; `catch {}`
  vazio é usado **de propósito** em operações best-effort (não "conserte" um
  catch vazio sem entender se ele é intencional).
- Existem **dois arquivos grandes** (`public/app.js`, `server.js`). Eles são o
  estado atual — organizados por seções comentadas.

**TARGET STANDARDS (código novo).**
- Nomes novos em **pt-BR**, acompanhando os módulos recentes.
- Funções **pequenas e de responsabilidade única**; evite closures gigantes.
- Comente o *porquê* quando a decisão não for óbvia — no estilo do projeto.
- `npm run lint` deve passar **sem novos erros** (só caça-bugs; ver §9).
- `catch` que engole erro de gravação/estado deve, no mínimo, **deixar rastro**
  (`console.warn`) — não silêncio total.

**MIGRATION RULES.** Não reformate arquivos inteiros, não rode um formatter em
massa, não renomeie símbolos legados em bloco. Estilo antigo divergente **não é
motivo** para editar um arquivo.

---

## 5. Bugs: investigar a causa raiz

O projeto tem uma cultura clara disto — os commits descrevem o defeito **medido**,
não o sintoma remendado. Siga:

1. **Reproduza** o bug (teste, script, ou passo manual claro). "Parece flaky" não
   é diagnóstico.
2. **Entenda o *porquê*** — a causa real, não o lugar onde o erro aparece. Leia o
   caminho todo (a falha muitas vezes nasce numa camada e estoura em outra).
3. **Corrija a causa**, com o menor diff. Não mascare com try/catch, retry cego,
   `setTimeout`, nem desabilitando uma validação.
4. **Escreva um teste de regressão** que falha antes e passa depois (ver §9). Foi
   o que o projeto fez com o TDZ do terminal, com a perda de chaves de cofre, etc.
5. **Registre o *porquê*** num comentário/commit, no tom do histórico.

Nunca desative, pule ou afrouxe um teste para "ficar verde".

---

## 6. Banco de dados / persistência

**CURRENT STATE.** **Não há banco de dados.** A persistência é em **arquivos
JSON** (`data.json`, `history.json`, `cofres-chaves.json`), descrita em
[docs/DATABASE.md](docs/DATABASE.md). `lib/store.js` é um **singleton** de estado;
`lib/history.js` e `lib/cofresegredos.js` cuidam dos outros dois. Relacionamentos
são **por string**, sem integridade referencial imposta.

**Regras (valem para código novo E ao mexer no existente):**
- **Nunca** leia/escreva os arquivos de dados diretamente. Use `store.get()`/
  `store.save()`, `lib/history.js`, `lib/cofresegredos.js`.
- **Toda escrita nova de arquivo de dados usa `gravarAtomico`** (`lib/gravaratomico.js`)
  — atômica e durável. Não copie o padrão `writeFileSync`+`rename` à mão.
- **Segredos:** senha/passphrase de host e a `apiKey` seguem no `data.json`
  (estado atual). A **chave de cofre** mora **fora** do `data.json`, em
  `cofres-chaves.json` (garantia estrutural de que não vai ao backup) — não mova
  segredo de cofre para o `data.json`.
- **Migração de formato:** ajustes de schema ao **ler** ficam em `migrar()` de
  `lib/store.js`. Não espalhe "se for do formato antigo" pelo código.
- **Nunca** apague/rebaixe dados sensíveis em silêncio. Ex.: `cofresegredos.gravar`
  recusa sobrescrever um arquivo protegido quando o Keychain está inalcançável;
  `history`/`store` fazem backup `.corrompido-*` antes de começar vazio.
- Arquivos de dados são **git-ignored**. Nunca os commite.

**TARGET STANDARDS.** Entidade nova → documente-a em `docs/DATABASE.md`. Valide o
tipo ao ler (não confie que o JSON está bem-formado).

**MIGRATION RULES.** Introduzir um banco de verdade, versionar schema, ou trocar o
formato dos JSONs é **mudança arquitetural** — só com aprovação explícita (§10).

---

## 7. APIs

**CURRENT STATE.** ~64 rotas HTTP `/api/*` e 4 upgrades WebSocket
(`/api/terminal`, `/api/localterminal`, `/api/rdp`, `/api/vnc`), todas em
`server.js`. Um middleware único faz a **guarda de origem** (Host/Origin, anti
DNS-rebinding). Erros de cofre são devolvidos **como HTTP 200 com corpo de estado**
— isso é **deliberado** (o front trata como estado, não como falha). SSE para
execução em lote e agente.

**Regras:**
- Rota nova segue os padrões existentes: valide a entrada (veja `parseHostBody`,
  `cleanVars`), use o helper `fail(res, status, msg)`, e devolva JSON.
- **Toda rota que entrega segredo ou executa comando EXIGE o token do processo**
  (`tokenValido`), além da guarda de origem. Hoje já exigem:
  `/api/desktop/credencial`, `/api/hosts/:id/segredo`, `/api/rdp/consentir`,
  `/api/export.xml?secrets=1`, `/api/files/*`, `/api/agent/start`. Uma rota nova
  desse tipo **nasce com token** — não confie só na origem.
- Segredo **nunca** vai ao navegador pelas rotas normais (`publicHost` remove
  senha). As exceções são as rotas com token acima, e são POST + `no-store`.
- Não mude o código de status nem o formato de uma rota existente sem checar quem
  consome no `public/app.js` (o contrato é implícito, não versionado).

**TARGET STANDARDS.** Ao adicionar uma rota, considere extrair a regra para uma
função testável sem `req`/`res` (facilita teste e reuso). Documente rotas novas.

**MIGRATION RULES.** A ausência de uma camada de serviço é o estado atual; **não é
obrigatório** criar uma para mexer numa rota. Extraia serviço só quando agregar
valor real à mudança em curso.

---

## 8. Segurança

Leia [SECURITY.md](SECURITY.md) e a seção *Segurança* do README. O modelo de
ameaça é **declarado e intencional** — respeite-o, não o "corrija" sem entender.

**CURRENT STATE / regras invioláveis:**
- O servidor escuta **só em `127.0.0.1`**. Não exponha na rede.
- **Ponto único de credencial:** `lib/credenciais.js`. Toda credencial resolvida
  tem `dispose()` — chame-o (use `try/finally`).
- **Redação antes da IA:** tudo que vai para a API da Anthropic passa por
  `lib/redigir.js`. Não envie saída de comando/host à IA sem isso.
- **Nunca logue segredo** (senha, passphrase, chave de API, `campos` do ERP). É
  política do projeto e é respeitada — mantenha.
- **Token do processo** nas rotas sensíveis (§7). Não afrouxe.
- **Electron endurecido:** `contextIsolation`, `sandbox`, `nodeIntegration:false`,
  sem IPC/preload, permissões (câmera/mic/notificação) negadas, `<webview>` com
  preferências reescritas. **Não relaxe nenhuma dessas travas.**
- **TLS/host key:** SSH fixa fingerprint (TOFU) e bloqueia mudança; cofres fixam
  certificado (TOFU). Onde há `rejectUnauthorized:false` (RDP, cofre na 1ª
  conexão) é **trade-off documentado** — não copie esse padrão para código novo
  sem justificar e documentar, e nunca o adicione em silêncio.

**TARGET STANDARDS.** Código novo não introduz segredo em `data.json` além do que
já existe; não devolve segredo ao navegador; não desliga verificação de
certificado sem TOFU + documentação. Rode `security-review` mentalmente em
qualquer coisa que toque credencial, execução de comando ou rede.

**MIGRATION RULES.** Endurecer o legado (ex.: cifrar senhas em repouso, fixar
certificado de RDP) é bem-vindo, mas é **mudança de comportamento** — proponha e
alinhe antes (§10), não faça de surpresa.

---

## 9. Processo de testes

**CURRENT STATE.** Runner próprio: `npm test` → `test/rodar.js` descobre
`test/*.test.js` e roda **cada arquivo no seu processo** (vários trocam
`SSHC_DATA_DIR`, mexem no `require.cache` ou sobem servidor). Sem framework: cada
teste usa `assert` do Node e um contador local; a contagem sai da **última linha**
(`N verificações passaram`). Há também `npm run lint` (ESLint, só caça-bugs) e o
CI (`.github/workflows/ci.yml`) roda lint + testes em cada push/PR.

**Regras (obrigatórias antes de considerar algo "pronto"):**
- **`npm test` verde e `npm run lint` sem novos erros.** Diga a contagem real; se
  algo falhou, reporte com a saída — não afirme "passou" sem rodar.
- **Todo bug corrigido ganha um teste de regressão** que falha antes do conserto.
- **Toda rota/lógica sensível nova ganha teste** (veja `token-rotas.test.js`,
  `durabilidade.test.js` como modelos de integração e de unidade).
- **Cuidado com a contagem:** se o seu teste emite `console.warn`/`error`, ele
  vira a última linha e o runner conta 0 — **silencie o aviso** no trecho que o
  provoca (padrão já usado em `credenciais.test.js`, `durabilidade.test.js`).
- **Não** desabilite, pule ou afrouxe teste para passar.

**TARGET STANDARDS.** Prefira **teste de comportamento** (contra o servidor/módulo
real) a **asserção de código-fonte** (regex no arquivo). As asserções de fonte
existentes são frágeis; não crie novas a menos que seja o único jeito (como o
teste da rede de proteção em `terminal-erros.test.js`, que explica por quê).

**MIGRATION RULES.** Não é preciso reescrever as suítes de asserção de fonte. Ao
tocar numa área coberta só por elas, *considere* adicionar um teste de
comportamento — opcional.

---

## 10. Nada de mudança arquitetural silenciosa

**Pare e alinhe com a pessoa ANTES de:**

- **Dividir os god files** (`public/app.js`, `server.js`) ou mover blocos entre
  camadas. Eles são o estado atual; quebrá-los é um projeto, não um efeito
  colateral de outra tarefa.
- Introduzir **framework de UI, bundler, build step, TypeScript**, ou trocar
  CommonJS↔ESM em massa.
- Introduzir **banco de dados**, versionar schema, ou **mudar o formato** dos
  arquivos JSON.
- Criar **camada de serviço/abstração** nova que outros arquivos passem a
  depender.
- Mudar **contrato de API** (status, formato, nome de rota) ou de **WebSocket/SSE**
  consumido pelo front.
- Alterar **modelo de ameaça / travas de segurança** (§8), o binding `127.0.0.1`,
  ou o comportamento dos **dois modos** (web `npm start` e desktop Electron) —
  qualquer mudança precisa continuar funcionando nos dois.
- Adicionar **dependência** nova (o projeto tem poucas, de propósito).

Se uma tarefa *exige* uma dessas, **descreva a mudança, o motivo e o risco, e
peça aprovação** — não a embuta num commit de outra coisa. Prefira sempre a opção
que **preserva o comportamento observável** e cabe no estilo existente.

---

## Fluxo rápido (resumo operacional)

1. **Entenda** o pedido e leia a área (código + comentários + doc relevante).
2. **Procure** o que já existe; reutilize (§2, §3). Não duplique.
3. **Faça o menor diff** que resolve, no estilo do arquivo que você está editando.
4. **Bug?** Causa raiz + teste de regressão (§5, §9).
5. **Rode** `npm test` e `npm run lint`; reporte o resultado real.
6. **Mudança de arquitetura/dados/API/segurança?** Sinalize antes (§10).
7. **Novo padrão não obriga tocar no legado.** Deixe o antigo em paz até haver
   motivo próprio para editá-lo.
