# Marco Zero — Vincii Canvas

> **A partir daqui sabemos exatamente o que temos.**

Marco Zero **não** é refazer o sistema. É o ponto em que o projeto passou a ser
**compreensível, previsível e controlável**: o estado atual está mapeado, os
problemas críticos foram corrigidos, e existe um processo para evoluir sem quebrar
o que funciona. A dívida técnica restante **não** foi eliminada de propósito — ela
está registrada, e será tratada progressivamente, não num mutirão antes de evoluir
o produto.

Data do marco: **2026-08-15** · base: `main` em `2b1e31f`.

## O que compõe o Marco Zero

```
PROJETO ATUAL → AUDITORIA → DOCS DO ESTADO ATUAL → MAPA DO BANCO →
MAPA DAS INTEGRAÇÕES → CORREÇÃO DOS CRÍTICOS → CLAUDE.md → SKILLS →
TESTES BASE → ═══ MARCO ZERO ═══ → NOVAS FEATURES (planejar → implementar → testar → review)
```

| Etapa | Entregue em |
|---|---|
| **Auditoria** | Varredura multi-agente; 74 achados verificados contra o código, classificados 🔴🟠🟡🟢. |
| **Docs do estado atual** | [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md), [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Mapa do banco** | [DATABASE.md](DATABASE.md) — persistência em JSON (não há SGBD): entidades, chaves, enums. |
| **Mapa das integrações** | [INTEGRATIONS.md](INTEGRATIONS.md) — Anthropic, GitHub, cofres, protocolos, variáveis de ambiente. |
| **Correção dos críticos** | FASE 0: perda de chaves de cofre (Keychain inalcançável) e token do processo nas rotas sensíveis (`export.xml?secrets=1`, `/api/files/*`, `/api/agent/start`), `.gitignore` do `cofres-chaves.json`. |
| **CLAUDE.md** | [../CLAUDE.md](../CLAUDE.md) — convenções atuais + CURRENT STATE / TARGET STANDARDS / MIGRATION RULES + disciplina de escopo. |
| **Skills** | [../.claude/skills/](../.claude/skills/) — `planning`, `architecture`, `implementation`, `debugging`, `testing`, `review`, `refactor`, `security`. |
| **Testes base** | Suíte verde como rede de segurança + CI rodando lint e testes em cada push/PR. |

## Baseline verificado (a rede de segurança)

- **`npm test`** → verde. Baseline atual: **32 arquivos, ~1.394 verificações**.
- **`npm run lint`** → 0 erros (avisos são backlog, ver [ACHADOS.md](ACHADOS.md)).
- **CI** (`.github/workflows/ci.yml`) roda lint + testes a cada push e PR; a
  release depende do teste passar.
- Cada correção crítica entrou com **teste de regressão** (`credenciais.test.js`,
  `token-rotas.test.js`, `durabilidade.test.js`).

> Rode `npm ci && npm run lint && npm test` para confirmar o baseline a qualquer
> momento. Enquanto esses três estiverem verdes, o Marco Zero está de pé.

## O que NÃO faz parte do Marco Zero (de propósito)

A dívida técnica **não** foi zerada — isso seria semanas "arrumando a casa" sem
evoluir o produto. Fica **registrada e priorizada**, para tratamento progressivo:

- **Achados fora de escopo e backlog arquitetural** → [ACHADOS.md](ACHADOS.md).
- **FASE 3 e 4** do plano de estabilização (modularizar os god files, mover a
  agenda para o servidor, tipagem gradual, endurecimento de transporte) — cada uma
  é **tarefa própria, planejada e aprovada** (nunca por arrasto; ver
  [../CLAUDE.md](../CLAUDE.md) §10).

## A partir daqui (depois do Marco Zero)

**Nenhuma feature grande começa direto no código.** Todo trabalho entra por um dos
três fluxos, conduzidos pelas skills:

- **Feature:** `planning` → `architecture` → **aprovação** → `implementation` →
  `testing` → `review`.
- **Bug:** `debugging` (reproduzir → causa raiz → correção) → `testing` → `review`.
- **Refactor:** `refactor` (rede de testes → passos pequenos → comportamento
  idêntico) → `review`. Opcional e oportunista — nunca forçado por convenção nova.

`security` é transversal a qualquer diff que toque credencial, execução, rede ou o
Electron.

> Regra que atravessa tudo: **respeitar o projeto existente**. Melhoria é
> progressiva; um padrão novo nunca obriga a refatorar o legado.
