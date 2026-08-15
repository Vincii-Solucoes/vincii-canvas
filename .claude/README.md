# .claude/skills — processo do projeto

Estas skills operacionalizam o [CLAUDE.md](../CLAUDE.md) em dois fluxos. São
versionadas de propósito (o resto de `.claude/`, como `settings.local.json`, fica
fora do git). Cada skill dispara pela sua `description`, ou pode ser invocada pelo
nome.

## Fluxo de funcionalidade

```
SUA IDEIA → planning → architecture → SUA APROVAÇÃO → implementation → testing → review → DONE
```

- **planning** — analisa antes de codar: lê a área, procura reuso, define o menor
  diff, e PARA para a sua aprovação.
- **architecture** — avalia impacto em fronteiras; o que muda arquitetura exige
  aprovação explícita (nada silencioso).
- **implementation** — implementa no estilo do projeto, com diff mínimo e reuso.
- **testing** — o processo de testes (runner próprio, regressão, lint, a pegadinha
  da contagem).
- **review** — portão final contra o CLAUDE.md antes de "pronto".

## Fluxo de bug

```
BUG → debugging → CAUSA RAIZ → CORREÇÃO → testing → review → DONE
```

- **debugging** — reproduzir, achar a causa raiz (não o sintoma), corrigir com o
  menor diff e travar com teste de regressão.

## Fluxo de refactor

```
REFACTOR → refactor → (rede de testes → passos pequenos → comportamento idêntico) → testing → review → DONE
```

- **refactor** — mudar a forma sem mudar o comportamento. Opcional e oportunista;
  refactor estrutural grande exige `architecture` + aprovação. Um padrão novo
  nunca obriga a refatorar o legado.

## Transversal

- **security** — checklist para qualquer coisa que toque credenciais, execução,
  rede, cofres, agente de IA ou o Electron. Apoia a etapa **review** quando o diff
  é sensível.

> Princípio que atravessa tudo: **respeitar o projeto existente**. Um padrão novo
> (TARGET STANDARD) nunca obriga a refatorar código antigo — ver a distinção
> CURRENT STATE / TARGET STANDARDS / MIGRATION RULES no [CLAUDE.md](../CLAUDE.md).
