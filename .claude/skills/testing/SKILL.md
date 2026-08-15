---
name: testing
description: Use ao escrever ou rodar testes no Vincii Canvas (etapa TESTING). Cobre o runner próprio (test/rodar.js, um processo por arquivo, contagem na última linha), a exigência de teste de regressão para cada bug, o lint, e a pegadinha da contagem quando um teste emite avisos. Preferir teste de comportamento a asserção de código-fonte.
---

# Testing — o processo de testes do projeto

Referência: [CLAUDE.md](../../../CLAUDE.md) §9 e [CONTRIBUTING.md](../../../CONTRIBUTING.md).

## Como rodar

- **`npm test`** → `test/rodar.js` descobre `test/*.test.js` e roda **cada arquivo
  no seu próprio processo** (vários trocam `SSHC_DATA_DIR`, mexem no `require.cache`
  ou sobem um servidor). Sucesso/falha vem do código de saída.
- **`npm run lint`** → ESLint (só regras caça-bug). Deve passar **sem novos erros**
  (avisos não bloqueiam).
- O CI roda os dois em cada push/PR.
- Servidores de apoio (não são testes): `npm run test-server`, `npm run test-vnc`.

## Como escrever um teste

- Sem framework: `assert` do Node + um contador local (`ok`/`igual`/`naoOk`,
  `n += 1`). A última linha imprime `` `${n} verificações passaram` ``.
- **Isolamento:** defina `process.env.SSHC_DATA_DIR` para um tempdir **antes** de
  requerer qualquer módulo do app (o `store` lê a env ao carregar). Limpe no fim.
- **Regressão obrigatória:** todo bug corrigido ganha um teste que falha antes e
  passa depois. Toda rota/lógica sensível nova ganha teste (modelos:
  `token-rotas.test.js` para integração HTTP, `durabilidade.test.js` para unidade).

## Pegadinha da contagem (importante)

O runner lê a contagem da **última linha de stdout+stderr**. Se o seu teste emite
`console.warn`/`console.error` (mesmo que legítimos), esse aviso vira a última
linha e o arquivo é contado como **0** — mesmo passando. **Silencie o aviso** no
trecho que o provoca e restaure depois:

```js
const warnOrig = console.warn;
console.warn = () => {};
// ... trecho que dispara o aviso ...
console.warn = warnOrig;
```

Padrão já usado em `credenciais.test.js` e `durabilidade.test.js`.

## Padrão a preferir

- **Teste de comportamento** (contra o servidor/módulo real) **vence** asserção de
  código-fonte (regex no arquivo). As asserções de fonte existentes são frágeis;
  só crie uma nova se for realmente o único jeito (como a rede de proteção em
  `terminal-erros.test.js`, que explica o porquê).
- **Nunca** desabilite, pule ou afrouxe um teste para ficar verde.

## Ao reportar

Diga a **contagem real** (`N/M arquivos, K verificações`). Se algo falhou, mostre
a saída — não afirme "passou" sem ter rodado.
