---
name: implementation
description: Use ao implementar uma mudança JÁ planejada e aprovada no Vincii Canvas (etapa IMPLEMENTATION do fluxo). Garante diff mínimo, reutilização do código existente, e as convenções reais do projeto (JS puro sem build, CommonJS no backend, script global no browser, pt-BR, comentários que explicam o porquê). Não inicia código sem plano/aprovação.
---

# Implementation — codar no estilo do projeto

Só entre aqui **depois** de planning + aprovação (e architecture, se aplicável).
Referência completa: [CLAUDE.md](../../../CLAUDE.md) §3 e §4.

## Regras

- **Menor diff que resolve.** Nada de refatorar "de carona". Não reformate
  arquivos, não renomeie símbolos legados em bloco.
- **Reutilize** os pontos únicos ([CLAUDE.md](../../../CLAUDE.md) §2) em vez de
  reimplementar. Antes de criar um helper, procure um existente.
- **Imite o arquivo que você edita:** indentação 2 espaços, LF; nomes em **pt-BR**
  para código novo; comentários que explicam o *porquê* (o projeto é denso nisso).
- **Backend = CommonJS** (`require`/`module.exports`). **Frontend = script global**
  em `public/` (sem import/export), exceto `public/desktop.js` e
  `public/scancodes.js` (ESM). Regra que vale nos dois lados → módulo "puro" com a
  guarda dupla `module.exports` + `window.X`.
- **Sem build/bundler/TS.** `public/` é servido como está.
- **Escrita de arquivo de dados** → `gravarAtomico` (`lib/gravaratomico.js`).
  Nunca `writeFileSync`+rename à mão, nunca abra os JSON direto (use `store`,
  `history`, `cofresegredos`).
- **Erro de rota** → helper `fail(res, status, msg)`. Rota que entrega segredo ou
  executa comando → **exige `tokenValido`** (§7 do CLAUDE.md).
- **Segurança** ([CLAUDE.md](../../../CLAUDE.md) §8): `dispose()` na credencial,
  `redigir()` antes da IA, nunca logar segredo, não relaxar as travas do Electron,
  não adicionar `rejectUnauthorized:false` sem TOFU + documentação.
- **Nada de mudança arquitetural** não aprovada (§10). Se surgir a necessidade no
  meio, pare e volte à skill architecture.

## Ao terminar

Não considere "pronto" sem passar por **testing** e **review**. Rode `npm test` e
`npm run lint` e reporte o resultado real.
