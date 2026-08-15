# Achados fora de escopo (registro)

Registro de problemas encontrados **de passagem**, fora do escopo da tarefa em
curso. A disciplina de escopo (ver [CLAUDE.md](../CLAUDE.md) → *Disciplina de
escopo*) manda **não corrigir automaticamente** o que não faz parte do pedido:
registre aqui, informe a severidade, e siga a tarefa quando for seguro.

**Como usar:** ao topar com um problema não relacionado, adicione uma linha na
tabela com `arquivo:linha`, o que é, a evidência e a severidade. Não é uma lista
de tarefas a executar já — é memória para não perder o achado nem inflar o diff
atual. Itens só saem daqui quando viram tarefa própria (planejada e aprovada).

**Severidade:** 🔴 CRÍTICO (perda de dados / vulnerabilidade / indisponibilidade)
· 🟠 ALTO (bug importante ou trava a evolução) · 🟡 MÉDIO (dívida técnica) ·
🟢 BAIXO (melhoria não urgente).

**Status:** `aberto` (registrado, não tratado) · `planejado` (virou tarefa) ·
`resolvido` (corrigido — mova a evidência do commit) · `aceito` (decisão
consciente de não mexer).

---

## Registro

| # | Sev. | Onde | Problema | Status |
|---|------|------|----------|--------|
| 1 | 🟡 | `lib/agent.js:17-18` | Imports mortos (`store`, `credenciais`) — nunca usados no arquivo (apontado pelo lint e pela auditoria). | aberto |
| 2 | 🟢 | `lib/agent-leitura.js:42` | `SEPARADORES` atribuído e não usado (lint). | aberto |
| 3 | 🟢 | `public/app.js` | ~11 avisos de `no-unused-vars` do lint (`termSelectedHost`, `hasRemoteSession`, `e` em catch, etc.) — backlog de limpeza. | aberto |
| 4 | 🟢 | `server.js:1018`, `public/app.js:2731` | Nome antigo `ssh-commander-config.xml` no backup exportado. Mantido de propósito (artefato visível ao usuário). | aceito |
| 5 | 🟢 | `lib/agent-leitura.js:237` | `ssh-commander` numa regex de segurança — intencional (detecta o nome antigo além do atual). | aceito |

## Backlog arquitetural maior (da auditoria — exige tarefa própria e aprovação)

Não são "achados de passagem": são as **FASE 3 e 4** do plano de estabilização,
mudanças grandes que **não** devem ser feitas em silêncio (ver
[CLAUDE.md](../CLAUDE.md) §10). Registradas aqui como ponteiro:

| Sev. | Tema | Nota |
|------|------|------|
| 🟠 | `public/app.js` e `server.js` (god files) | Modularizar aos poucos — só com plano e aprovação; nunca por arrasto. |
| 🟠 | Agenda roda no renderer (`public/app.js`) | Mover a decisão para o servidor (depende da janela aberta hoje). |
| 🟡 | Regras duplicadas (`acharHost` ×3, `humanizaRede` ×2) | Unificar quando houver tarefa que já toque a área. |
| 🟡 | Sem tipagem | Tipagem gradual via JSDoc + `@ts-check`, sem migrar para TS. |
| 🟡 | Segurança em repouso / transporte | Cifrar senhas no `data.json`, pinning de RDP — mudança de comportamento, alinhar antes. |
