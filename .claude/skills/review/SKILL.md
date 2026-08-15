---
name: review
description: Use antes de considerar QUALQUER mudança pronta no Vincii Canvas (etapa REVIEW / DONE dos dois fluxos). Revisa o diff contra o CLAUDE.md — duplicação, reutilização, convenções, regras de banco/API/segurança, testes, e ausência de mudança arquitetural silenciosa. É o portão final antes de "pronto".
---

# Review — portão final antes de "pronto"

Revise o **diff inteiro** (`git diff`) contra as regras do projeto antes de
declarar concluído. Referência: [CLAUDE.md](../../../CLAUDE.md).

## Checklist

**Escopo e reutilização**
- [ ] O diff é o **menor** que resolve? Nada de refatoração ou renomeação "de
      carona"?
- [ ] Reutilizou os pontos únicos (§2) em vez de reimplementar? **Nenhuma
      duplicação nova** (função/rota/componente/lista repetida)?
- [ ] Código legado não foi alterado só por causa de um padrão novo?

**Convenções (§3, §4)**
- [ ] Estilo do arquivo preservado (2 espaços, LF; pt-BR no novo)?
- [ ] Sem build/bundler/TS introduzidos? CommonJS/script-global respeitados?
- [ ] Comentários explicam o *porquê* onde a decisão não é óbvia?

**Banco / persistência (§6)**
- [ ] Escrita de dados via `gravarAtomico`; leitura/escrita via `store`/`history`/
      `cofresegredos`, nunca no arquivo direto?
- [ ] Nenhum dado sensível apagado/rebaixado em silêncio? Segredo de cofre segue
      fora do `data.json`?

**API (§7)**
- [ ] Rota nova valida entrada e usa `fail()`? Se entrega segredo ou executa
      comando, **exige `tokenValido`**?
- [ ] Não mudou status/formato de rota consumida pelo `public/app.js` sem checar o
      consumidor?

**Segurança (§8)** — se tocou credencial/execução/rede/Electron, acione a skill
**security**.
- [ ] `dispose()` na credencial; `redigir()` antes da IA; nada de segredo em log;
      travas do Electron intactas; sem `rejectUnauthorized:false` novo sem TOFU +
      doc?

**Testes (§9)**
- [ ] `npm test` verde e `npm run lint` sem novos erros (com a contagem real)?
- [ ] Bug corrigido tem teste de regressão? Lógica sensível nova tem teste?

**Arquitetura (§10)**
- [ ] **Nenhuma mudança arquitetural silenciosa.** Se houve mudança de fronteira,
      ela foi descrita e **aprovada** — não embutida?
- [ ] Os **dois modos** (web e desktop) continuam funcionando; binding `127.0.0.1`
      preservado?

## Resultado

Se algum item falhar, **volte** à etapa correspondente (implementation/testing/
architecture). Só declare **DONE** com o checklist limpo, e reporte honestamente o
que foi feito, testado e o que ficou de fora.
