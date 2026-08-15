# Política de Segurança

## Reportar uma vulnerabilidade

Se você encontrar uma vulnerabilidade no Vincii Canvas, **não abra uma issue
pública**. Escreva para **contato@vincii.com.br** com:

- uma descrição do problema e do impacto;
- passos para reproduzir (ou uma prova de conceito);
- a versão do app e o sistema operacional.

Faremos o possível para responder com rapidez e manter você informado sobre a
correção.

## Modelo de ameaça (o que o app assume)

O Vincii Canvas é um aplicativo **local**. Entender o que ele protege — e o que
ele deliberadamente **não** protege — evita relatos sobre comportamento que é
uma escolha consciente:

- O servidor escuta **apenas em `127.0.0.1`**; nada é exposto na rede.
- O app **confia em qualquer processo local** que fale HTTP com ele: uma
  requisição sem cabeçalho `Origin` (curl, script, outro app) é aceita de
  propósito, porque um processo rodando como você já tem os seus privilégios.
  **Não use o app numa máquina compartilhada com outros usuários ao mesmo
  tempo** — eles alcançam `127.0.0.1` também.
- Como defesa em profundidade, as rotas que **entregam segredo** ou **executam
  comandos** exigem, além da guarda de origem, o **token do processo** (sorteado
  a cada abertura, presente só no HTML servido): `/api/desktop/credencial`,
  `/api/hosts/:id/segredo`, `/api/rdp/consentir`, `/api/export.xml?secrets=1`,
  `/api/files/*`, `/api/agent/start`.
- **Credenciais em repouso:** senhas de host e a chave da API ficam em texto
  claro no `data.json` (permissão `600`). As chaves de API de cofre usam o
  armazenamento protegido do sistema (Keychain/DPAPI/libsecret) no app desktop.
  Prefira **agente SSH** ou **chave** à senha, e **cofres** à senha salva.
- **Área de trabalho remota (RDP/VNC):** a senha chega ao navegador (o cliente
  roda lá). O RDP não fixa a identidade do servidor, e o modo legado usa RC4 —
  trate uma conexão RDP em rede não confiável como observável. Ver o README.
- **IA:** tudo que o agente lê é enviado à API da Anthropic (com os segredos
  conhecidos redigidos antes do envio).

Detalhes completos no [README](README.md) (seção *Segurança*) e em
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
