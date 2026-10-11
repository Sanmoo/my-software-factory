# My Software Factory

Mini orquestrador local em TypeScript, com Sandcastle e Pi, para trabalho de
engenharia supervisionado. Repositório privado; em fase de teste de compatibilidade.

## Estado atual

- Bootstrap TypeScript e teste reproduzível de Pi headless/subagentes/retomada.
- **Teste real passou com Pi + github-copilot/gpt-6-luna**: filho async, resultado
  incorporado e retomada da mesma sessão, com uma iteração em cada fase.
  [Resultado e limites](docs/results/003-copilot-luna.md).
- **Round-trip de `/implement` também passou na fixture**: pedido de ajuda,
  aprovação humana, mesma sessão retomada, código/testes, commit e revisão em
  dois eixos. [Resultado e ressalvas](docs/results/004-implement-help.md).
- Codex continua com bloqueio TLS independente, documentado no
  [diagnóstico](docs/results/002-tls-diagnosis.md); não é requisito deste piloto.
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
SMOKE_MODEL=github-copilot/gpt-6-luna npm run smoke:pi
```

`SMOKE_MODEL` é obrigatório e inclui provider: o teste não escolhe nem troca
provider automaticamente. A execução inicial usou openai-codex/gpt-6.1-sol;
esta escolha não foi uma comprovação de equivalência ao perfil interativo.

`SMOKE_MAX_ITERATIONS` altera o máximo (padrão 5). A retomada usa uma iteração,
como requerido por Sandcastle. `noSandbox()` roda no host, não isola processos.
Fixture, sessões e logs ficam em `.smoke/`, ignorado pelo Git; não use código real.
O teste mantém extensões/autenticação locais, mas desabilita contexto, skills,
MCP e ferramentas de projeto. Esse primeiro smoke não valida `/implement`.

O experimento ampliado usa a skill instalada e pede aprovação real da seam TDD:

```sh
SMOKE_MODEL=github-copilot/gpt-6-luna npm run smoke:implement
# Após resposta humana, usando a área impressa pelo comando:
SMOKE_MODEL=github-copilot/gpt-6-luna SMOKE_RUN=CAMINHO_DA_AREA \
SMOKE_REPLY='resposta humana real' npm run smoke:implement
```

Ele habilita skills e ferramentas da fixture, mantendo MCP desativado. Não roda
em projeto real nem usa tracker/PR/deploy. Consulte as ressalvas de TDD e dos
reviewers no [relatório](docs/results/004-implement-help.md).

Detalhes: [design](docs/design.md), [resultado atual](docs/results/003-copilot-luna.md)
e [próximos passos](docs/backlog.md). Não versionar transcrições brutas,
credenciais ou configuração corporativa.
