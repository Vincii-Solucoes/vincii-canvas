---
name: architecture
description: Use ao avaliar se uma mudança no Vincii Canvas toca fronteiras arquiteturais — dividir os god files, mudar formato de dados/persistência, alterar contrato de API/WebSocket/SSE, criar camada/abstração nova, trocar CommonJS↔ESM, adicionar dependência, ou mexer em segurança/binding/modos web+desktop. Decide o que exige APROVAÇÃO EXPLÍCITA antes de implementar e impede mudança arquitetural silenciosa.
---

# Architecture — impedir mudança arquitetural silenciosa

O Vincii Canvas tem uma arquitetura **atual e intencional** (ver
[docs/ARCHITECTURE.md](../../../docs/ARCHITECTURE.md)). Esta skill garante que
mudanças estruturais sejam **conscientes e aprovadas**, nunca efeito colateral de
outra tarefa. **Não imponha uma arquitetura nova.**

## Gatilhos que EXIGEM parar e alinhar com o usuário

Se a mudança faz qualquer um destes, **descreva a mudança, o motivo e o risco, e
peça aprovação** antes de implementar ([CLAUDE.md](../../../CLAUDE.md) §10):

- **Dividir/mover** blocos entre `public/app.js`, `server.js` e novos arquivos, ou
  entre camadas (frontend ↔ backend).
- **Framework de UI, bundler, build step, TypeScript**, ou troca em massa
  CommonJS↔ESM.
- **Banco de dados**, versionamento de schema, ou mudança de **formato** dos JSON
  (`data.json`, `history.json`, `cofres-chaves.json`).
- **Camada de serviço/abstração** nova da qual outros arquivos passem a depender.
- **Contrato** de rota HTTP (status, formato, nome) ou de WebSocket/SSE que o
  `public/app.js` consome — o contrato é implícito, não versionado.
- **Segurança / modelo de ameaça** (§8 do CLAUDE.md), binding `127.0.0.1`, ou algo
  que quebre um dos **dois modos** (web `npm start` e desktop Electron).
- **Dependência** nova (o projeto tem poucas, de propósito).

## Como decidir

1. **A mudança cabe no estilo existente?** Prefira sempre a opção que **preserva o
   comportamento observável** e imita os padrões do arquivo que você edita.
2. **Dá para resolver sem tocar a fronteira?** Quase sempre sim — resolva assim.
3. **Se a fronteira é inevitável:** documente a decisão (o quê, por quê, risco,
   alternativa descartada) e **obtenha o "pode ir"**. Não embuta a mudança
   arquitetural num commit de outra coisa.

## Princípios (do próprio projeto)

- Fronteira Electron **limpa** (sem IPC/preload) — não introduza IPC.
- `lib/credenciais.js` é o **ponto único** de credencial; `lib/store.js` o ponto
  único de estado. Não crie caminhos paralelos.
- Módulos "puros" compartilhados usam a **guarda dupla** browser+Node (§3).
- Código legado divergente **não é dívida a pagar agora**: só migra por decisão
  própria e aprovada, nunca por arrasto.
