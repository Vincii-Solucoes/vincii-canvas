---
name: planning
description: Use ao iniciar QUALQUER nova funcionalidade ou mudança não-trivial no Vincii Canvas, ANTES de escrever código. Transforma uma ideia em um plano analisado (o que já existe e pode ser reutilizado, escopo mínimo, impacto) e PARA para a aprovação do usuário. Primeira etapa do fluxo: IDEIA → PLANNING → ARCHITECTURE → APROVAÇÃO → IMPLEMENTATION → TESTING → REVIEW.
---

# Planning — analisar antes de implementar

Regra de ouro do projeto (ver [CLAUDE.md](../../../CLAUDE.md) §1): **nenhuma linha
de código antes da análise**. Esta skill produz o plano; ela **não implementa**.

## Passos

1. **Entenda o pedido** e delimite o escopo real. Se estiver ambíguo, pergunte.
2. **Leia a área.** Localize os arquivos envolvidos e trace o caminho:
   rota (`server.js`) → serviço/lib (`lib/*`) → persistência (`store`/`history`/
   `cofresegredos`) → UI (`public/app.js`). Leia os **comentários** da região — o
   projeto explica o *porquê* das decisões.
3. **Procure o que já existe (anti-duplicação).** Antes de propor função, módulo,
   rota, componente ou helper novos, procure equivalentes por nome e por
   comportamento. Consulte a tabela de pontos únicos em [CLAUDE.md](../../../CLAUDE.md) §2
   (`lib/credenciais.js`, `lib/store.js`, `lib/vars.js`, `public/protocolos.js`,
   `lib/gravaratomico.js`, `lib/redigir.js`, helper `fail()`…). **Reutilizar vence
   criar.**
4. **Avalie o impacto arquitetural.** Se o pedido encosta em fronteiras (dividir
   god files, formato de dados, contrato de API, camada nova, dependência nova,
   segurança, os dois modos web/desktop), acione a skill **architecture** e trate
   como mudança que exige aprovação explícita ([CLAUDE.md](../../../CLAUDE.md) §10).
5. **Escreva o plano**, contendo:
   - o problema e o resultado esperado;
   - os arquivos a tocar e o **menor diff** que resolve;
   - o que será **reutilizado** (com caminho) em vez de criado;
   - riscos e como testar (quais testes novos/rodados);
   - quaisquer decisões de arquitetura que precisam de aval.
6. **PARE e peça aprovação.** Não passe para implementation sem o "pode ir".

## Não faça

- Não comece a codar "enquanto planeja".
- Não proponha código novo quando já existe implementação adequada.
- Não proponha reescrever/reorganizar código legado que o pedido não exige
  ([CLAUDE.md](../../../CLAUDE.md): novo padrão não obriga tocar no antigo).
