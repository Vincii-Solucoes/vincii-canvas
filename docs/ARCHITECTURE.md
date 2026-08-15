# Arquitetura Atual — Vincii Canvas

> **Estado atual**, não idealizado. Descreve como o código está organizado hoje,
> incluindo as concentrações (os "god files") e os pontos fortes a preservar.

## Visão geral

```
┌─────────────────────────────────────────────────────────────────────┐
│  ELECTRON (desktop/main.js) — processo principal, SEM IPC nem preload │
│  • sobe o mesmo servidor do modo web em 127.0.0.1:porta-aleatória     │
│  • BrowserWindow endurecida: contextIsolation, sandbox,               │
│    nodeIntegration:false, permissões (câmera/mic/notif.) negadas      │
│  • safeStorage (Keychain/DPAPI/libsecret) p/ chaves de cofre          │
│  • auto-update (Windows/Linux), TOFU de certificado de abas web       │
│  (no modo `npm start` este processo não existe — o servidor roda só)  │
└───────────────────────────────┬─────────────────────────────────────┘
                                 │ carrega http://127.0.0.1:porta
┌───────────────────────────────▼─────────────────────────────────────┐
│  FRONTEND (public/) — SPA vanilla de aba única, no renderer           │
│  • public/app.js (~5.800 linhas): 9 abas, estado global, handlers     │
│  • módulos "puros" carregados nos 2 lados (browser + Node via require):│
│    protocolos.js, agenda.js, horario.js, weburl.js, colar.js…         │
│  • public/desktop.js (ES module): noVNC + IronRDP WASM rodam AQUI      │
│  Comunicação: fetch (JSON) + WebSocket + SSE                          │
└───────────────────────────────┬─────────────────────────────────────┘
                                 │ HTTP / WS / SSE  (guarda de origem + token)
┌───────────────────────────────▼─────────────────────────────────────┐
│  BACKEND (server.js, ~1.950 linhas) — Express                         │
│  • ~64 rotas HTTP (/api/*) + 4 upgrades WebSocket                     │
│    (/api/terminal, /api/localterminal, /api/rdp, /api/vnc)            │
│  • middleware único de guarda: Host + Origin (anti DNS-rebinding)     │
│  • roteamento + validação + regra de negócio inline (sem service layer)│
└───────┬───────────────┬───────────────┬───────────────┬──────────────┘
        │               │               │               │
   SERVIÇOS         CONEXÕES        CREDENCIAIS      IA / AUTOMAÇÃO
   lib/runner       lib/terminal    lib/credenciais  lib/ai.js
   lib/files        lib/telnet      (ponto único)    lib/agent.js
   lib/history      lib/localterm   lib/cofres/*     lib/agent-leitura
   lib/presenca     lib/rdp*(7)     lib/cofresegredos
   lib/quickhosts   lib/desktop(VNC)
        │               │               │               │
┌───────▼───────────────▼───────────────▼───┐   ┌───────▼───────────────┐
│  PERSISTÊNCIA (JSON em disco, sem banco)   │   │  INTEGRAÇÕES EXTERNAS  │
│  data.json / cofres-chaves.json /          │   │  Anthropic, GitHub     │
│  history.json  (ver DATABASE.md)           │   │  Releases, cofres, host│
└────────────────────────────────────────────┘  │  (ver INTEGRATIONS.md) │
                                                 └────────────────────────┘
```

## Os três processos/contextos

| Contexto | Onde | Papel |
|---|---|---|
| **Main do Electron** | `desktop/main.js` | Sobe o servidor local, cria a janela endurecida, injeta `safeStorage`, faz auto-update e o TOFU de certificado das abas web. Existe só no app desktop. |
| **Renderer** | `public/` no BrowserWindow (ou no navegador, no modo web) | Toda a interface. Roda os clientes de RDP (WASM) e VNC (noVNC). Não tem privilégio de Node. |
| **Servidor** | `server.js` + `lib/` | HTTP/WS/SSE, protocolos de conexão, credenciais, IA. Idêntico nos dois modos. |

**Ponto forte a preservar:** a fronteira Electron é limpa — **não há IPC nem
preload**. Todo o contrato renderer↔backend é HTTP/WS local com um token de
processo. O renderer nunca ganha `require`/Node.

## Onde vive cada responsabilidade transversal

| Preocupação | Onde está | Observação |
|---|---|---|
| **Autenticação do app** | `server.js` — middleware de guarda Host/Origin (anti DNS-rebinding) + token de processo | O token vai no HTML servido e é sorteado a cada abertura. É exigido nos upgrades WebSocket e nas rotas que entregam/executam algo sensível: `/api/desktop/credencial`, `/api/hosts/:id/segredo`, `/api/rdp/consentir`, `/api/export.xml?secrets=1`, `/api/files/*`, `/api/agent/start`. |
| **Autorização** | Inexistente — um único usuário | Modelo "1 pessoa, 1 máquina". Um processo local sem `Origin` é aceito de propósito (ver "Modelo de ameaça"). |
| **Regra de negócio** | Inline nas rotas de `server.js` e em `public/app.js` | Sem camada de serviço; algumas regras existem nos dois lados (agenda, casamento de host na importação). |
| **Validações** | `parseHostBody`/`cleanVars` (server), e módulos puros `weburl.js`, `agenda.js`, `colar.js`, `protocolos.js` compartilhados browser+Node | Padrão bom: a mesma validação vale nos dois lados. |
| **Acesso ao "banco"** | `lib/store.js` (singleton `get()`/`save()`) | Objeto global mutável, serializado inteiro a cada `save()`. Ver DATABASE.md. |
| **Chamadas externas** | `lib/cofres/http.js`, `lib/ai.js`, `lib/agent.js`, e o fetch do GitHub em `server.js` | Cofres: TOFU de certificado. RDP: `rejectUnauthorized:false` (ver INTEGRATIONS.md). |
| **Tratamento de erros** | Helper `fail(res,status,msg)`; erros de cofre viram HTTP 200 (estado, não falha) | **Sem** middleware de erro do Express e **sem** `uncaughtException`/`unhandledRejection`. |
| **Logs** | Só `console.*` (poucas chamadas); sem logger de requisições, níveis ou rotação | Nenhum segredo é logado (política explícita e respeitada). |

## Comunicação renderer ↔ backend

Três mecanismos:

- **fetch (JSON)** via o helper `api()` em `public/app.js` — CRUD, estado, cofres,
  configurações.
- **WebSocket** — terminais (`/api/terminal`, `/api/localterminal`) e telas
  (`/api/rdp`, `/api/vnc`). Roteados à mão por `pathname` no handler de `upgrade`,
  com guarda de origem + token na query.
- **SSE (EventSource)** — execução em lote (`/api/runs/:id/stream`) e agente
  autônomo (`/api/agent/:id/stream`).

## Estado

- **Servidor:** singleton `lib/store.js` (persistido) + mapas em memória
  (`termsessions`, `presenca`, `quickhosts`, cache de cofre em `dadosdecofre`).
- **Renderer:** variáveis de módulo em `public/app.js` (`state`, `sessions[]`,
  `prefs`, etc.). Não há store formal. Preferências de UI moram no servidor
  (`data.json`) e são injetadas no HTML na carga.

## Concentrações conhecidas (estado atual, não idealizado)

- **`public/app.js` (~5.800 linhas):** um único script clássico com ~30 domínios,
  todo o estado e todos os handlers no mesmo escopo global. Organizado por seções
  comentadas, mas sem fronteiras de módulo.
- **`server.js` (~1.950 linhas):** roteamento + validação + regra de negócio +
  roteamento de WebSocket, sem camada de serviço.

Estas concentrações são a principal fonte de custo de evolução do projeto. Não
são bugs; são dívida estrutural. Ver o plano de estabilização (fora deste doc).

## Modelo de ameaça (declarado)

O app **confia em qualquer processo local** que fale HTTP com ele: requisição sem
`Origin` (curl, script, outro app) é aceita de propósito, pois a premissa é que
um processo rodando como o usuário já tem os privilégios dele. A consequência a
ter em mente numa **máquina compartilhada** é descrita no README. Não use o app
logado numa máquina que outras pessoas acessam ao mesmo tempo.

Como defesa em profundidade, as rotas que entregam segredo ou executam comandos
exigem, além da guarda de origem, o **token de processo** (ver a tabela acima).
