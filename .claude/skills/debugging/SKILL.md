---
name: debugging
description: Use ao investigar um bug ou comportamento inesperado no Vincii Canvas. Conduz o fluxo BUG → DEBUGGING → CAUSA RAIZ → CORREÇÃO → TEST → REVIEW — reproduzir, achar a causa real (não o sintoma), corrigir com o menor diff e travar com um teste de regressão. Impede remendos que mascaram o problema.
---

# Debugging — causa raiz, não sintoma

O projeto tem cultura clara disto: os commits descrevem o defeito **medido**, não
um remendo. Siga o fluxo (ver [CLAUDE.md](../../../CLAUDE.md) §5).

## Fluxo

1. **BUG — capture o fato.** Sintoma exato, como disparar, ambiente (web `npm
   start` vs desktop), e a evidência (mensagem, stack, comportamento).
2. **DEBUGGING — reproduza.** Um teste, script ou passo manual determinístico.
   *"Parece flaky" não é diagnóstico* — flaky só se justifica se o processo morreu
   antes de qualquer teste rodar; o resto se investiga.
3. **CAUSA RAIZ — entenda o porquê.** Leia o caminho inteiro; a falha muitas vezes
   **nasce numa camada e estoura em outra** (ex.: o TDZ do `send` no WebSocket de
   terminal; a perda de chaves quando o Keychain some). Não pare no lugar onde o
   erro aparece.
4. **CORREÇÃO — conserte a causa, com o menor diff.** Proibido mascarar:
   - nada de `try/catch` engolindo o erro, `retry` cego, `setTimeout` para
     "dar tempo", ou desabilitar validação/teste;
   - preserve o comportamento documentado; não afrouxe segurança.
5. **TEST — trave a regressão.** Escreva um teste que **falha antes** do conserto
   e **passa depois** (modelos: `credenciais.test.js`, `terminal-erros.test.js`,
   `durabilidade.test.js`). Rode `npm test` e `npm run lint`. Cuidado com a
   pegadinha da contagem (silencie `console.warn`/`error` que o teste provoca —
   ver skill **testing**).
6. **REVIEW — feche.** Acione a skill **review**. Registre o *porquê* num
   comentário/commit, no tom do histórico.

## Se a causa raiz for arquitetural

Se o conserto real exigir mudar formato de dados, contrato de API ou uma fronteira
(§10 do CLAUDE.md), **pare e alinhe** antes — não faça a mudança estrutural
disfarçada de correção de bug.
