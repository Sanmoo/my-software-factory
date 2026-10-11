# My Software Factory

Mini orquestrador local em TypeScript, com Sandcastle e Pi, para trabalho de
engenharia supervisionado. Repositório privado; em fase de teste de compatibilidade.

## Estado atual

- Bootstrap TypeScript e teste reproduzível de Pi headless/subagentes/retomada.
- **Teste real bloqueado por `fetch failed` no provider**, antes da delegação.
- Ainda não há polling, concorrência, CLI operacional nem adapters de tracker.
- Issue tracker será acessado por porta e adapters: Jira no trabalho e GitHub
  Issues nos projetos pessoais. Campos Jira não pertencem ao contrato central.

## Desenvolvimento

Requer Node 22+, Git, Pi no PATH e pi-subagents instalado no perfil local.

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
```

O teste real faz chamadas ao modelo já autenticado e não roda em `npm test`:

```sh
SMOKE_MODEL=openai-codex/gpt-6.1-sol npm run smoke:pi
```

`SMOKE_MAX_ITERATIONS` altera o máximo (padrão 5). A retomada usa uma iteração,
como requerido por Sandcastle. `noSandbox()` roda no host, não isola processos.
Fixture, sessões e logs ficam em `.smoke/`, ignorado pelo Git; não use código real.
O teste mantém extensões/autenticação locais, mas desabilita contexto, skills,
MCP e ferramentas de projeto. Não valida ainda `/implement` completa.

Detalhes: [design](docs/design.md), [resultado](docs/results/001-pi-compatibility.md)
e [próximos passos](docs/backlog.md). Não versionar transcrições brutas,
credenciais ou configuração corporativa.
