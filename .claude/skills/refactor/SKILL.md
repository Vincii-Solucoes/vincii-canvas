---
name: refactor
description: Use quando a tarefa é explicitamente um REFACTOR do Vincii Canvas — reorganizar, extrair, renomear ou desduplicar SEM mudar comportamento (não é feature nem bug). Exige rede de testes antes de mexer, passos pequenos e reversíveis, e comportamento idêntico ponta a ponta. Refactor aqui é opcional e oportunista: um padrão novo nunca obriga a refatorar o legado.
---

# Refactor — mudar a forma, não o comportamento

Refactor no Vincii Canvas é **melhoria progressiva**, nunca "arrumar a casa" em
massa. Referência: [CLAUDE.md](../../../CLAUDE.md) (Diretriz principal, §3, §10 e
*Disciplina de escopo*).

## Antes de começar

- **Refactor é opcional.** Não refatore código legado **só porque** um padrão novo
  (TARGET STANDARD) foi criado. Divergir do padrão novo **não é bug**.
- **Justifique o momento.** Refatore quando: (a) o usuário pediu, ou (b) você já
  está tocando aquela área por outra razão e a melhoria é barata e local.
- **Refactor estrutural grande** (dividir `public/app.js`/`server.js`, mover entre
  camadas, criar abstração da qual outros dependam, trocar CommonJS↔ESM) é
  **mudança arquitetural**: acione a skill **architecture** e obtenha **aprovação
  explícita** antes (§10). Não faça em silêncio nem "de carona".

## Fluxo

1. **Rede de testes primeiro.** O comportamento a preservar precisa estar coberto.
   Se não estiver, **escreva testes de caracterização** (de comportamento, contra
   o módulo/servidor real) que passam **antes** do refactor — eles são o contrato
   que garante que nada mudou. Ver skill **testing**.
2. **Passos pequenos e reversíveis.** Uma transformação por vez (extrair função,
   unificar duplicata, renomear num escopo). Rode `npm test` + `npm run lint`
   **entre os passos**; fique verde o tempo todo.
3. **Comportamento IDÊNTICO.** Zero mudança observável: mesmas respostas de API,
   mesmos efeitos, mesmos contratos de WS/SSE. Se precisar mudar comportamento,
   **não é refactor** — é feature ou bug, e vai pelo fluxo próprio.
4. **Sem scope creep.** Refatore só o que a tarefa nomeou. Não reformate arquivos
   inteiros, não renomeie em massa, não toque módulos vizinhos.
5. **Achou um bug no meio?** **Pare de misturar.** Registre em
   [docs/ACHADOS.md](../../../docs/ACHADOS.md) com severidade e siga o refactor; ou,
   se for crítico, troque para a skill **debugging** — mas **corrigir bug dentro de
   um refactor** esconde a mudança de comportamento no meio da mudança de forma.
6. **Preserve a intenção dos comentários.** O projeto explica o *porquê* das
   decisões; ao mover código, leve o comentário junto — não o descarte.

## Review (portão)

Acione a skill **review**. O diff de um bom refactor mostra **forma movida,
comportamento igual**: os testes existentes continuam passando **sem mudança de
intenção** (no máximo ajuste mecânico de nome/caminho), e nenhum arquivo não
relacionado foi tocado. Se um teste precisou mudar de *expectativa*, houve mudança
de comportamento — reavalie.
