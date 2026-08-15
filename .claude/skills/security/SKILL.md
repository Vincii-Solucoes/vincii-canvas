---
name: security
description: Use ao mexer em QUALQUER coisa que toque credenciais, execução de comando, rede, cofres, o agente de IA, ou o processo Electron no Vincii Canvas. Checklist de segurança ancorado no modelo de ameaça declarado do projeto — impede vazar segredo, enfraquecer autenticação/autorização, ou relaxar as travas do Electron. Também apoia a etapa REVIEW quando o diff é sensível.
---

# Security — checklist do que não pode escorregar

O modelo de ameaça é **declarado e intencional** (ver [SECURITY.md](../../../SECURITY.md)
e README §Segurança). **Respeite-o; não o "corrija" sem entender.** Referência:
[CLAUDE.md](../../../CLAUDE.md) §8.

## Invioláveis

- **Binding só em `127.0.0.1`.** Nunca exponha na rede.
- **Ponto único de credencial:** `lib/credenciais.js` (`resolver()`), sempre com
  `dispose()` (use `try/finally`). Não resolva credencial por fora.
- **Token do processo** nas rotas que entregam segredo ou executam comando, além
  da guarda de origem. Já exigem: `/api/desktop/credencial`,
  `/api/hosts/:id/segredo`, `/api/rdp/consentir`, `/api/export.xml?secrets=1`,
  `/api/files/*`, `/api/agent/start`. **Rota sensível nova nasce com token.**
- **Segredo nunca vai ao navegador** pelas rotas normais (`publicHost` remove
  senha). As exceções são as rotas com token acima (POST + `no-store`).
- **Redação antes da IA:** tudo que vai à API da Anthropic passa por
  `lib/redigir.js`. Não envie saída de comando/host sem isso.
- **Nunca logar segredo** — senha, passphrase, chave de API, `campos` do ERP.
- **Electron endurecido:** `contextIsolation`, `sandbox`, `nodeIntegration:false`,
  sem IPC/preload, permissões negadas, `<webview>` com preferências reescritas.
  **Não relaxe nenhuma dessas travas.**
- **Chave de cofre** mora fora do `data.json` (garantia estrutural contra vazar no
  backup). Não a mova para lá; não a exporte.

## Ao mexer em rede / TLS

- SSH fixa fingerprint (TOFU) e bloqueia mudança; cofres fixam certificado (TOFU).
- Onde há `rejectUnauthorized:false` (RDP, cofre na 1ª conexão) é **trade-off
  documentado**. **Não copie** esse padrão para código novo sem TOFU + comentário
  explicando o porquê, e **nunca** o adicione em silêncio.

## Perguntas antes de fechar

1. Algum segredo pode aparecer em: resposta HTTP não-tokenizada? log? URL/query?
   backup XML? histórico? saída para a IA?
2. Alguma barreira (token, origem, `dispose`, redação, trava do Electron) foi
   afrouxada?
3. Uma rota/entrada nova aceita valor sem validação (path traversal em arquivos,
   injeção em comando, host/porta arbitrários)?
4. A mudança abre um caminho que o modelo de ameaça declarado **não** cobria?

Se qualquer resposta acender alerta, **pare** e trate antes de considerar pronto.
Endurecer o legado (cifrar senha em repouso, fixar cert de RDP) é bem-vindo, mas é
**mudança de comportamento** — proponha e alinhe (§10), não faça de surpresa.
