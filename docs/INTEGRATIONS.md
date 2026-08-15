# Integrações Externas — Vincii Canvas

> **Estado atual.** Tudo que o app fala com o mundo fora da máquina, e as
> variáveis de ambiente que o configuram.

## 1. API da Anthropic (Claude)

- **Onde:** `lib/ai.js` (assistente e gerador de playbook) e `lib/agent.js`
  (agente autônomo). SDK `@anthropic-ai/sdk`, carregado com `try/catch` para
  degradar com mensagem amigável se ausente.
- **Chave:** `process.env.ANTHROPIC_API_KEY` tem precedência sobre
  `settings.apiKey` (do `data.json`). Nunca é devolvida ao navegador (só
  `hasApiKey`).
- **Modelos:** lista fixa em `lib/ai.js` — `claude-opus-5` (padrão),
  `claude-sonnet-5`, `claude-haiku-4-5`, `claude-opus-4-8`. Modelo fora da lista
  é rejeitado.
- **Uso:** streaming (`messages.stream`) no assistente e no agente; o agente tem
  **uma única ferramenta**, `run_command`. Saída estruturada (JSON schema) no
  gerador de playbook.
- **O que sai para a API:** as mensagens do usuário + nome/endereço do host; no
  terminal, também a saída recente dos comandos. **A imagem da tela não vai.**
  Antes do envio, `lib/redigir.js` remove segredos conhecidos (senhas do
  `data.json`, passphrases, a chave da API e credenciais vivas de cofre), e a
  saída é rotulada como dado não confiável (defesa contra prompt-injection).

## 2. GitHub Releases API

- **Onde:** `server.js`, rota `GET /api/update-check`.
- **O quê:** consulta `releases/latest` do repositório do `package.json`
  (`Vincii-Solucoes/vincii-canvas`), cache de 1 h, compara com a versão local.
  Fica desligada enquanto o repositório for um placeholder `OWNER/REPO`.
- **Auto-update:** no app empacotado (Windows/Linux), `electron-updater` usa o
  mesmo GitHub Release como feed. macOS/web só mostram a faixa de aviso.

## 3. Cofres de credenciais

Registro de adaptadores em `lib/cofres/index.js`. Dois adaptadores hoje:

- **Vitruviano** (`lib/cofres/vitruviano.js`) — o ERP "Homem Vitruviano" da
  Vincii. `baseUrl` padrão `https://homemvitruviano.vincii.com.br/api/cofre/v1`,
  chave `hvk_…`. Capacidades: listar segredos, clientes e sistemas, e janela de
  atendimento por cliente.
- **Nativo / "contrato aberto"** (`lib/cofres/nativo.js`) — qualquer cofre que
  implemente três rotas (`GET /ping`, `/secrets`, `/secrets/{id}`). Contrato em
  [cofres-de-credenciais.md](cofres-de-credenciais.md).

**Transporte comum** (`lib/cofres/http.js`): a chave vai **sempre** em
`Authorization: Bearer` (nunca em query); só `https://` (exceto loopback); **TOFU
de certificado** — `rejectUnauthorized:false` com fixação da impressão SHA-256 na
primeira conexão e conferência depois. Timeout 15 s (`VC_COFRE_TIMEOUT_MS`), teto
de corpo 2 MiB, recuo exponencial só para erros transitórios.

**Núcleo:** `lib/credenciais.js` é o único ponto que resolve a credencial de um
host, com `dispose()` obrigatório. A senha vinda do cofre vive só em memória pelo
tempo da conexão.

## 4. Hosts remotos (protocolos)

| Protocolo | Biblioteca / técnica | Onde |
|---|---|---|
| **SSH / SFTP** | `ssh2` | `lib/runner.js`, `lib/terminal.js`, `lib/files.js` |
| **Telnet** | cliente próprio (RFC 854/1073/1091) | `lib/telnet.js` |
| **FTP / FTPS** | `basic-ftp` | `lib/files.js` |
| **RDP** | proxy RDCleanPath no servidor + IronRDP (WASM) no navegador | `lib/rdp*.js`, `public/desktop.js` |
| **VNC** | ponte de bytes no servidor + noVNC no navegador | `lib/desktop.js`, `public/desktop.js` |
| **Web** | `<webview>` do Electron | `public/app.js` |

Notas de segurança de transporte (estado atual):

- **SSH:** host key fixada na primeira conexão (TOFU) e bloqueia se mudar.
- **RDP (TLS):** o proxy usa `rejectUnauthorized:false` e **não fixa** certificado
  — quem autentica é o CredSSP dentro do WASM.
- **RDP legado (Standard Security):** RC4 + MD5/SHA-1, **sem** autenticar o
  servidor; conecta só após consentimento explícito por host.
- **FTP:** modo `auto` cai para texto claro se o TLS falhar; modo `confia`
  desliga a validação do certificado.

## 5. Serviços do sistema operacional (via Electron)

- **`safeStorage`** — armazenamento protegido do SO para as chaves de cofre
  (Keychain/DPAPI/libsecret). Injetado em `lib/cofresegredos.js` por
  `desktop/main.js`. Fora do Electron não existe: as chaves ficam em texto claro
  `600`, e a tela avisa.
- **`shell.openExternal`** — abrir links no navegador do sistema.
- **`session.fromPartition`** — partição isolada por host nas abas web; limpeza
  ao apagar um host web.
- **`electron-updater`** — auto-update (Windows/Linux).

## 6. Variáveis de ambiente

Nenhuma é obrigatória para o funcionamento básico. Nenhuma contém segredo em
código. As principais:

| Variável | Efeito |
|---|---|
| `PORT` | Porta do modo web (padrão 3033). No desktop a porta é aleatória. |
| `ANTHROPIC_API_KEY` | Chave da API (tem precedência sobre a do `data.json`). |
| `SSH_AUTH_SOCK` | Necessária para autenticação por agente SSH. |
| `SSHC_DATA_DIR` | Diretório dos arquivos JSON (o desktop aponta para o perfil do usuário). |
| `SSHC_DESKTOP` | Marca o modo desktop (o main do Electron define). |
| `SHELL` / `COMSPEC` | Shell exibido em `/api/local-info`. |
| `VC_RDP_HS_MS`, `VC_RDP_SEM_AUTOLOGON`, `VC_RDP_SEM_ALINHAR` | Ajustes do caminho RDP. |
| `VC_TERM_TTL_MS` | TTL da sessão de terminal órfã (padrão 5 min). |
| `VC_COFRE_TIMEOUT_MS` | Timeout das chamadas a cofre (padrão 15 s). |
| `SSHD_LOCAL_PORT`, `SSHD_LOCAL_*` | Servidor SSH local de teste. |

> Um `.env.example` com a lista completa e comentada acompanha o repositório.
