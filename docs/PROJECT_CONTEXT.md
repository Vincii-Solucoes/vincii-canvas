# Contexto do Projeto — Vincii Canvas

> Documento de **estado atual**: descreve o produto como ele é hoje, extraído do
> código. Não descreve uma versão idealizada. Companheiros:
> [ARCHITECTURE.md](ARCHITECTURE.md), [DATABASE.md](DATABASE.md),
> [INTEGRATIONS.md](INTEGRATIONS.md).

## O que é

Vincii Canvas é um aplicativo **local** para equipes de suporte/operações de TI.
Roda de duas formas, sobre o **mesmo** código de servidor:

- **App desktop** (Electron) — macOS, Windows e Linux, com instaladores próprios
  e auto-update (Windows/Linux). Entrada: `desktop/main.js`.
- **Servidor web standalone** — `npm start`, abre em `http://127.0.0.1:3033`.
  Entrada: `server.js`.

O servidor escuta **apenas em `127.0.0.1`**. Nada é exposto na rede.

## Objetivo

Operar uma frota de servidores a partir de uma máquina: executar sequências de
comandos em vários hosts de uma vez, abrir terminais e telas remotas, transferir
arquivos e automatizar tarefas com IA — com as credenciais guardadas localmente
ou buscadas num cofre externo na hora de conectar.

## Tipos de usuário

**Um só**: o operador na sua própria máquina. Não há cadastro de usuários,
papéis, RBAC nem multi-tenancy. O único recorte de "contexto" é o de
**cliente/segmento** (para variáveis e para o cofre), que não é uma fronteira de
permissão. O modelo é "uma pessoa, uma máquina".

## Módulos (9 abas + subsistemas)

Interface em `public/` (SPA vanilla, sem framework). Abas (`public/index.html`,
lógica em `public/app.js`):

1. **Terminal** — multi-sessão: SSH, Telnet, terminal local, RDP/VNC (área de
   trabalho) e páginas web. Cada aba tem assistente e agente de IA próprios. A
   conexão de terminal **sobrevive à janela** (`lib/termsessions.js`).
2. **Executar** — execução em lote de playbooks/comandos em N hosts (paralelo até
   5), com pré-visualização e stream ao vivo.
3. **Hosts** — CRUD de hosts com grupo, ícone, cor, agenda e cofre.
4. **Playbooks** — listas de comandos; geração por IA.
5. **Arquivos** — gerenciador de dois painéis (local ↔ remoto), SFTP/FTP.
6. **Favoritos** — comandos favoritos por escopo (global/host).
7. **Histórico** — trilha de comandos (humano/IA/lote), com filtros e relatório.
8. **Variáveis** — globais + perfis/segmentos; `{{VAR}}`; `@cada` para ranges.
9. **Configurações** — tema, fonte do terminal, chave da API, cofres, backup XML.

**Subsistemas transversais:** cofres de credenciais (2 adaptadores),
IA/automação (assistente, gerador de playbook, agente autônomo), agenda/horário
de atendimento, presença entre janelas, backup/restauração XML, auto-update.

## Fluxos principais

- **Conectar a um host:** clicar no host → `openSession` roteia por protocolo →
  terminal (WebSocket), tela remota (canvas/WASM) ou webview.
- **Execução em lote:** escolher playbook/comandos → marcar hosts → pré-visualizar
  → executar (SSE ao vivo) → cancelar.
- **Automação com IA:** *Assistente* sugere comandos (nada roda sozinho);
  *Agente autônomo* executa num laço com **portão de aprovação** (supervisionado)
  ou sem confirmação (automático). Limite de 30 passos; saída tratada como dado
  não confiável (anti prompt-injection).
- **Agenda:** cada host pode ter uma faixa de horário diária; dentro dela o app
  abre a conexão sozinho e trava a aba.
- **Cofres:** em vez de gravar a senha no `data.json`, o host guarda só a
  **referência** (cofre + segredo); a senha é lida do cofre na hora de conectar e
  não fica em disco.

## Como os módulos se relacionam

Tudo converge para dois pontos: **`lib/credenciais.js`** (o único ponto que
resolve a credencial de um host) e **`lib/store.js`** (o estado persistente). A
entidade central é o **host**; `cofre` e `segredo` o ligam a credenciais
externas; `agenda` e a `janela` de atendimento do ERP governam a conexão
automática. Ver [DATABASE.md](DATABASE.md).

## O que o produto NÃO faz (para não supor demais)

- Não há autenticação de usuário nem papéis — ver [ARCHITECTURE.md](ARCHITECTURE.md).
- Não há banco de dados — a persistência é em arquivos JSON.
- Execução em lote e agente autônomo **exigem SSH**: hosts Telnet/FTP/VNC/RDP/web
  são recusados por essas funções.
- Na aba de área de trabalho (RDP/VNC) e nas páginas web, a IA só tira dúvida —
  o agente autônomo fica indisponível (não há terminal).

## Divergências código × README (estado real)

- O README menciona "até 20 agentes simultâneos"; `MAX_RUNS` em `lib/agent.js` é
  retenção de runs **encerrados**, não teto de concorrência.
- Resta o nome antigo do projeto (`ssh-commander`) em dois lugares **de
  propósito**: no nome do arquivo de backup exportado (`ssh-commander-config.xml`,
  para não mudar um artefato visível ao usuário) e numa regex de segurança de
  `lib/agent-leitura.js` (que detecta leitura dos dados do próprio app pelo nome
  antigo, além do atual — remover reduziria cobertura).
