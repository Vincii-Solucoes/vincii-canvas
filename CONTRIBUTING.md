# Contribuindo com o Vincii Canvas

## Rodar o projeto

Requer **Node.js 20** (ver `.nvmrc`; o mínimo é 18).

```bash
npm ci            # instala as dependências travadas pelo package-lock
npm start         # modo web em http://127.0.0.1:3033
npm run desktop   # app desktop (Electron) em modo desenvolvimento
```

## Rodar os testes

```bash
npm test
```

O runner é próprio (`test/rodar.js`): descobre todo `test/*.test.js` e roda
**cada arquivo no seu processo** (vários trocam `SSHC_DATA_DIR`, mexem no
`require.cache` ou sobem um servidor). Sucesso/falha vem do código de saída; a
contagem sai da **última linha** de cada teste (`N verificações passaram`) — por
isso, se um teste emitir avisos, silencie-os no trecho que os provoca para não
virarem a última linha.

Não há framework: cada teste usa `assert` do Node e um contador local. Servidores
locais de apoio (não são `*.test.js`): `npm run test-server` (SSHd),
`npm run test-vnc`.

O CI (`.github/workflows/ci.yml`) roda `npm test` a cada push e PR, e a release
depende desse passo.

## Estilo

- **JavaScript puro** — CommonJS no backend (`lib/`, `server.js`), script clássico
  de escopo global no navegador (`public/`). Sem bundler e sem build step.
- 2 espaços, `end_of_line = lf`, UTF-8 (ver `.editorconfig`).
- Comentários explicam o **porquê** (a decisão, o bug medido), não o óbvio — siga
  o tom que já existe no código.
- Módulos "puros" que valem nos dois lados (browser + Node) usam a guarda dupla
  `if (typeof module...) module.exports` + `if (typeof window...) window.X` — veja
  `public/protocolos.js`, `public/agenda.js`.

## Segredos e dados sensíveis

- `data.json`, `history.json` e `cofres-chaves.json` guardam credenciais e ficam
  **fora do controle de versão** (`.gitignore`). Nunca os commite.
- Não coloque chave de API nem senha em código, teste ou exemplo.

## Branches e commits

- Desenvolva em uma branch de tópico; abra PR contra a branch padrão.
- Mensagens de commit descritivas, no tom do histórico do projeto (o "porquê" da
  mudança, não só o "o quê").

## Reportar vulnerabilidades

Veja [SECURITY.md](SECURITY.md).
