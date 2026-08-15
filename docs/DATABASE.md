# Persistência de Dados — Vincii Canvas

> **Estado atual.** O projeto **não tem banco de dados** relacional nem ORM. A
> persistência é em **arquivos JSON** no disco. Este documento faz o papel de um
> "esquema": entidades, chaves e relacionamentos.

## Onde os dados moram

Diretório base: `SSHC_DATA_DIR` — o perfil do usuário no app desktop
(`~/Library/Application Support/…`, `%APPDATA%\…`, `~/.config/…`) ou a raiz do
projeto no modo web (`npm start`).

| Arquivo | Módulo | Conteúdo | Proteção em repouso |
|---|---|---|---|
| `data.json` | `lib/store.js` | Configuração inteira: hosts, playbooks, profiles, favorites, globals, settings, cofres | **Texto claro**, `chmod 600`, escrita atômica (grava `.tmp` e faz `rename`) |
| `cofres-chaves.json` | `lib/cofresegredos.js` | Chaves/tokens de API dos cofres, por apelido | `safeStorage` do sistema (Keychain/DPAPI/libsecret) **quando disponível**; senão texto claro `600` |
| `history.json` | `lib/history.js` | Trilha de comandos executados | Texto claro, `600`, gravação adiada (~400 ms) |

Notas de estado:

- **`data.json` não é cifrado.** A única proteção é a permissão de arquivo.
  Senhas de host e a chave da API da Anthropic ficam em texto claro nele.
- **`cofres-chaves.json`** mora **fora** do `data.json` de propósito: é uma
  garantia estrutural de que a chave de um cofre nunca vai para o backup XML.
- Recuperação de corrupção: `data.json` inválido é copiado para
  `data.json.corrompido-<timestamp>` e o app começa vazio; `history.json`
  corrompido é apagado sem cópia. Os três arquivos são ignorados pelo git.

## Entidades e chaves

Relacionamentos são **por string** (sem integridade referencial imposta).

### host — `data.json.hosts[]` (PK `id`)

Campos: `id`, `name`, `host`, `port`, `username`, `protocol`
(`ssh|telnet|ftp|vnc|rdp|web`), `ftps` (`auto|yes|confia|no`), `rdpDomain`,
`url` (host web), `group`, `icon`, `color`, `agenda{inicio,fim}`, `vars{}`,
`fingerprint` (TOFU SSH), `webCert` (TOFU cert web), `rdpLegadoOk` (consentimento
do RDP antigo), `auth{}`, `segredo{}`.

- `auth = { type: 'agent'|'key'|'password'|'cofre', keyPath, password, passphrase }`
- `segredo = { cofre, id, cliente, rotulo }` — **referência a cofre, nunca valor**

### cofre — `data.json.cofres[]` (PK `apelido`)

`{ apelido, tipo, nome, config{}, espelharSistemas, certificadoFixado }`. Os
campos marcados como secretos no descritor do adaptador **não** ficam aqui; vão
para `cofres-chaves.json`.

### chave de cofre — `cofres-chaves.json` (PK `apelido`)

Mapa `apelido → { <campo secreto>: valor }`. Envelope `{ formato: 'protegido' |
'texto-claro', ... }`.

### demais coleções em `data.json`

- **profile** `{ id, name, vars{} }`
- **playbook** `{ id, name, description, commands[] }`
- **favorite** `{ id, command, label, hostId|null }`
- **globals** — mapa `NOME → valor`
- **settings** — `apiKey`, `model`, `termFont`, `termFontSize`,
  `cofreChavesNoSistema`, `ui{ theme, greetHidden, aiCollapsed, sidebarCollapsed }`

### entrada de histórico — `history.json[]`

`{ id, ts, command, source: 'human'|'ai', origin, hostId, machine, ip, username,
port, local }`. Teto ~5.000 entradas.

### em memória (nunca tocam o disco)

- **quickhost** — host avulso da conexão rápida, `id: 'qc_…'`, TTL 24 h.
- **host espelhado do ERP** — derivado de um sistema do cofre Vitruviano,
  `id: 'erp:<apelido>:<idSistema>'`, `protocol:'web'`; nunca gravado nem exportado.
- **credencial resolvida** — o valor da senha vindo do cofre, efêmero, com
  `dispose()` obrigatório.

## Enums de fato

| Campo | Valores |
|---|---|
| `host.protocol` | `ssh`, `telnet`, `ftp`, `vnc`, `rdp`, `web` |
| `auth.type` | `agent`, `key`, `password`, `cofre` |
| `host.ftps` | `auto`, `yes`, `confia`, `no` |
| `history.source` | `human`, `ai` |
| agente `aprovacao` | `tudo`, `escrita`, `perigosos`, `nunca` |

## Relacionamentos (por string)

- `host.segredo.cofre` → `cofre.apelido`. Renomear o apelido reaponta os hosts;
  remover o cofre deixa hosts **órfãos de propósito** (o app mostra isso).
- `cofre.apelido` → chave em `cofres-chaves.json` e no cache de janelas.
- `host.segredo.cliente` → cliente do cofre — é o que liga o host ao horário de
  atendimento.
- `favorite.hostId` / `history.hostId` → `host.id` (`'local'` é valor especial).

## Riscos de integridade conhecidos (estado atual)

- **Sem versionamento de schema**: nenhum campo de versão; a única migração
  (`lib/store.js`) é aplicada incondicionalmente a cada carga. Abrir um `data.json`
  de versão mais nova com um binário antigo pode reserializar e perder campos.
- **Sem lock de arquivo**: duas instâncias apontando ao mesmo diretório podem
  sobrepor escritas.
- **Escrita atômica sem `fsync`**: o `rename` evita ler pela metade, mas uma
  queda de energia logo após pode deixar a entrada de diretório apontando para
  conteúdo não persistido.
- **Referências sem cascata**: favoritos ficam órfãos quando o host é removido.

> Uma correção específica já aplicada: `lib/cofresegredos.js` agora **recusa**
> sobrescrever um `cofres-chaves.json` protegido quando o processo não alcança o
> Keychain, em vez de rebaixar tudo para texto claro e apagar as chaves.
