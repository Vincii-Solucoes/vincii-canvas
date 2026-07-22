# Vincii Canvas

Aplicação **local** (web e desktop) para executar sequências de comandos em vários servidores via SSH, com **variáveis segmentadas** — você escreve os comandos uma vez com `{{VARIAVEL}}` e troca os valores por segmento (cliente, ambiente, host…) — além de um terminal interativo com IA e automação. Identidade visual da **Vincii** (vincii.com.br).

## Requisitos

- Node.js 18 ou superior

## Instalação e uso

```bash
cd ssh-commander
npm install
npm start
```

Abra **http://127.0.0.1:3033** no navegador. Para trocar a porta: `PORT=3555 npm start`.

## Aplicativo desktop (multiplataforma)

A mesma aplicação roda como app desktop nativo via Electron — macOS, Windows e Linux:

```bash
npm run desktop     # abre a janela do app (modo desenvolvimento)
npm run dist        # gera o instalador do sistema atual (pasta dist/)
npm run dist:dir    # gera só o app desempacotado (mais rápido, para testar)
```

- **Dados**: no modo desktop, o `data.json` fica no perfil do usuário — `~/Library/Application Support/ssh-commander` (macOS), `%APPDATA%/ssh-commander` (Windows), `~/.config/ssh-commander` (Linux). Na primeira execução, um `data.json` existente da pasta do projeto é migrado automaticamente.
- **Instaladores**: macOS gera `.dmg`/`.zip`, Windows `NSIS`/`.zip`, Linux `AppImage`/`.deb` (alvos no bloco `build` do `package.json`). O ideal é gerar cada instalador no próprio sistema operacional (ou em CI): `npx electron-builder --mac`, `--win`, `--linux`.
- **Assinatura**: sem certificado de desenvolvedor o app sai sem assinatura — roda normalmente, mas macOS/Windows podem exibir aviso de segurança na primeira abertura ao distribuir para outras máquinas.
- **Modo web continua existindo**: `npm start` segue funcionando igual; os dois modos compartilham o mesmo código de servidor.

## Atualizações (avisar via GitHub)

O app pode **avisar** quando há uma versão nova publicada no GitHub (não instala sozinho — mostra um aviso com botão de download; funciona sem certificado de assinatura, no Mac, Windows, Linux e no modo web).

Para ligar:

1. **Aponte o repositório** no `package.json` — troque o placeholder pelo seu repositório público:
   ```json
   "repository": { "type": "git", "url": "https://github.com/SEU-USUARIO/SEU-REPO" }
   ```
   Enquanto estiver com `OWNER/REPO`, a verificação fica **desligada** (nenhum aviso aparece).
2. **Publique uma release** — o deploy é automatizado por GitHub Actions ([.github/workflows/release.yml](.github/workflows/release.yml)): suba o `version` do `package.json` (ex.: `1.1.0`), faça commit e rode:
   ```bash
   git tag v1.1.0 && git push origin main --tags
   ```
   O CI compila os instaladores de **macOS, Windows e Linux** (cada um no seu runner) e o `electron-builder` publica tudo num **GitHub Release** `v1.1.0`. Sem certificado, os apps saem sem assinatura (funcionam; só exibem aviso na 1ª abertura).
3. Pronto: ao abrir, o app consulta o **último release**, compara com a versão instalada e, se houver uma mais nova, mostra a faixa **"Nova versão X disponível — Ver / baixar"** (dispensável; não repete a mesma versão). A verificação é feita pelo servidor local (`GET /api/update-check`), com cache de 1 hora.

> Repositório **público** significa que o **código-fonte fica visível**. Segredos não vão junto: `data.json` (senhas/chave da API) fica só na máquina e já está no `.gitignore` (junto com `node_modules/` e `dist/`).

## Conceitos

- **Hosts** — os servidores de destino, organizados em **grupos** (ex.: Produção, Laboratório), com visual inspirado no Termius: cards com avatar, endereço e etiquetas. Cada host pode receber um **ícone** de sistema/dispositivo (Linux, Ubuntu, Debian, Windows, macOS, roteador, switch, firewall, banco de dados, container, Docker, Kubernetes, nuvem, storage…) e uma **cor** à escolha — para bater o olho e reconhecer o host na hora. Se nenhum ícone for escolhido, o avatar mostra a inicial do nome; a cor pode ser automática (derivada do nome) ou fixa da paleta. Ícone e cor aparecem em todos os lugares (aba Hosts, barra lateral do Terminal e seletor da aba Executar) e vão no backup `.xml`. Autenticação por **agente SSH**, **chave privada** ou **senha**, com botão de teste de conexão. O fingerprint do servidor é fixado na primeira conexão (TOFU); se mudar depois, a conexão é bloqueada até você usar "esquecer fingerprint" no cadastro do host. Na aba **Terminal**, a **barra lateral** mostra o **terminal da própria máquina** ("Meu computador") no topo e os **hosts acessados recentemente** logo abaixo (cada um com um "×" para tirar da lista); a **busca** lista todos os hosts para conectar a qualquer um. Clicar conecta na hora, com indicador verde quando conectado.
- **Playbooks** — listas nomeadas de comandos (um por linha; linhas vazias e iniciadas com `#` são ignoradas). Também é possível executar comandos avulsos sem salvar. O botão **✨ Criar com IA** gera um playbook a partir de uma descrição em linguagem natural — a IA já usa `{{variáveis}}` reutilizáveis e `@cada` para ranges, e você **revisa e edita** o rascunho antes de salvar (requer chave da API na aba Configurações).
- **Variáveis** — use `{{NOME}}` em qualquer comando. Fontes, da menor para a maior precedência:
  1. **Globais** (aba Variáveis)
  2. **Perfil / segmento** escolhido na execução
  3. **Variáveis do host** (no cadastro de cada host)
  4. **Sobrescritas** digitadas na hora de executar

  Variáveis embutidas (sempre disponíveis): `{{host.name}}`, `{{host.host}}`, `{{host.port}}`, `{{host.user}}`.
- **Perfis (segmentos)** — conjuntos nomeados de variáveis para alternar contexto rapidamente, ex.: "Cliente A — Produção" com `CLIENTE=a`, `AMBIENTE=prod`.
- **Backup / exportação (.xml)** — na aba Variáveis, o botão **⤓ Exportar .xml** baixa toda a configuração (playbooks, hosts, perfis e variáveis globais) num arquivo XML bem-formado. Por padrão, **segredos não são incluídos** — o arquivo só registra que existiam (`hasPassword="true"`, etc.). Marcando a opção **"Incluir senhas e chave da API"**, o export passa a conter senhas, passphrases e a chave da API **em texto claro** (para um backup completo) — há uma confirmação antes de baixar, o arquivo sai como `...-com-segredos.xml` e o próprio XML avisa que é sensível (`includesSecrets="true"`). O botão **⤒ Importar .xml** restaura um arquivo desses em outra máquina (ou mescla playbooks/hosts de outro lugar): faz **upsert por nome** — itens com o mesmo nome são atualizados, os novos são criados e **nada é apagado**. Se o arquivo tiver segredos, as senhas/chave também são importadas.
- **Ranges e listas (`@cada`)** — uma variável pode guardar uma faixa ou lista, ex.: `VLANS=100-110,150,200-205`. Dois usos:
  - **Literal**: `switchport trunk allowed vlan {{VLANS}}` insere o texto como está (`100-110,150,200-205`).
  - **Expansão**: uma linha `@cada VLAN em {{VLANS}}: vlan {{VLAN}}` é repetida uma vez para cada item da lista — ranges numéricos `A-B` são expandidos (inclusive; aceita decrescente) e itens não numéricos entram como texto. Também aceita lista literal (`@cada PORTA em 1-24: interface Gi0/{{PORTA}}`) e variáveis dentro da faixa (`@cada V em {{INICIO}}-{{FIM}}: …`). Dentro da linha, a variável do laço vence qualquer outra de mesmo nome; `@each … in …:` funciona como sinônimo. O separador entre a lista e o comando é o primeiro `:` seguido de espaço (por isso itens como `08:00` funcionam — deixe sempre um espaço após o `:` do separador). Linhas que começam com `@cada` mas não seguem o formato geram erro claro em vez de irem para o SSH. Limites de segurança: 4094 itens por lista e 6000 comandos por host após a expansão. A pré-visualização mostra todas as linhas já expandidas.
- **Pré-visualização** — mostra os comandos já resolvidos por host, sem executar nada, e aponta variáveis não definidas.
- **Execução** — paralela entre hosts (até 5 ao mesmo tempo; há opção de um por vez) e sequencial dentro de cada host. Opções: parar no primeiro erro (por host), timeout por comando e cancelamento no meio da execução. A saída (stdout/stderr, código de saída, duração) aparece ao vivo.
- **Terminal** (aba própria) — um **terminal SSH interativo** de verdade (shell com PTY, via xterm.js) para o host escolhido. Também é possível abrir **vários** terminais ao mesmo tempo (inclusive para o mesmo host), cada um numa aba. **Cada aba tem seu próprio assistente e agente de IA, independentes** — dá para ter um agente instalando algo num host, outro configurando um switch e um terminal manual **ao mesmo tempo** (o backend suporta até 20 agentes simultâneos); uma bolinha na aba indica quando o agente daquela sessão está trabalhando (teal) ou aguardando aprovação (amarelo), mesmo enquanto você olha outra aba. Quando **não há nenhuma conexão remota**, o app abre automaticamente um **terminal local da própria máquina** ("Meu computador") — um shell de verdade no seu sistema (zsh/bash no macOS/Linux; PowerShell/cmd no Windows), detectado automaticamente. Ao lado, um painel de IA (Claude) com **dois modos**:
  - **Assistente** — a IA **sugere** comandos a partir de linguagem natural; cada um aparece em um bloco com os botões **Inserir** (digita no terminal, sem Enter) e **Inserir e executar**. Nada roda sozinho.
  - **Agente autônomo** — você descreve uma **tarefa** e a IA a cumpre **sozinha**: executa comandos via SSH, lê as saídas e decide os próximos passos, num laço, enquanto você **acompanha cada passo ao vivo**. Dois botões de partida:
    - **Supervisionado** — pausa e pede sua aprovação em **comandos perigosos** (rm -rf, mkfs, dd, shutdown, firewall, etc.).
    - **Automático** — executa tudo sem pedir confirmação, para você não precisar interagir; há um aviso único antes de iniciar.

    Em ambos há **Parar** imediato e limite de 30 passos por tarefa. A saída dos comandos é sempre tratada como **dado não confiável** — o agente é instruído a nunca seguir instruções embutidas nela (defesa contra prompt injection vindo de um servidor comprometido). O modo ativo (🛡 supervisionado / ⚡ automático) fica indicado no topo do feed.

  A aparência do terminal (fonte e tamanho) é ajustável na aba **Configurações** → "Aparência do terminal", com prévia ao vivo; a escolha é aplicada na hora e salva para as próximas aberturas.
- **Tema claro/escuro** — a interface tem modo **claro** (padrão) e **escuro**, alternável pelo botão de sol/lua no cabeçalho ou na aba **Configurações** → "Tema". A preferência é lembrada nesta máquina. O terminal e os blocos de código permanecem escuros nos dois temas (visual de console).

  Ambos os modos usam sua chave da API Anthropic, configurada na aba **Configurações** (ou a variável de ambiente `ANTHROPIC_API_KEY`), com créditos ativos. **Enquanto não houver chave configurada, os recursos de IA ficam ocultos** — o painel Assistente/Agente e o botão "✨ Criar com IA" só aparecem depois que uma chave é informada; sem chave, o terminal ocupa a largura toda e a chave é informada na aba **Configurações**.

## Segurança

- O servidor escuta **apenas em 127.0.0.1** — nada é exposto na rede.
- Os dados ficam em `data.json` (criado com permissão `600`). **Senhas, passphrases e a chave da API Anthropic são gravadas nesse arquivo em texto claro** — prefira agente SSH ou chave sempre que possível; a chave da API nunca é devolvida ao navegador.
- **IA (assistente)**: só devolve texto; quem executa é você.
- **IA (agente autônomo)**: aí sim a IA executa comandos por conta própria — por isso as salvaguardas: acompanhamento ao vivo, parar a qualquer momento, limite de passos e confirmação de comandos perigosos (ligada por padrão). Use com um usuário SSH de privilégio adequado à tarefa. A saída dos comandos é tratada como dado não confiável.
- Autenticação por agente exige a variável `SSH_AUTH_SOCK` no ambiente em que o app foi iniciado (inicie pelo terminal).
- Timeout encerra a conexão SSH do host, mas o processo remoto pode continuar rodando em alguns casos.

## Servidor SSH de teste

Para experimentar sem tocar em servidores reais:

```bash
npm run test-server
```

Sobe um SSH local em `127.0.0.1:2222` (usuário `demo`, senha `segredo123`) que executa os comandos **na sua própria máquina**. Cadastre-o como host no app e teste playbooks à vontade.

## Estrutura

```
server.js          API HTTP + arquivos estáticos (Express)
lib/store.js       persistência em data.json
lib/vars.js        parsing e resolução de {{variáveis}}
lib/runner.js      motor SSH (ssh2): conexões, execução, eventos SSE
lib/terminal.js    terminal SSH interativo (WebSocket + shell/PTY)
lib/localterm.js   terminal local da própria máquina (WebSocket + PTY)
lib/ai.js          assistente de IA (Anthropic Claude), streaming
lib/agent.js       agente autônomo: laço tool-use, guarda de comandos perigosos
public/            interface web (HTML/CSS/JS puro)
desktop/main.js    processo principal do Electron (app desktop)
build/icon.png     ícone do aplicativo
test/sshd-local.js servidor SSH local de teste
data.json          seus dados (gerado ao usar; não versionar)
dist/              instaladores gerados (não versionar)
```
