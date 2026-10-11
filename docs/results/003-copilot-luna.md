# Teste 003 — protocolo mínimo aprovado com Pi + Copilot/Luna

Data: 2026-10-11. Seleção explícita autorizada pelo operador:
**github-copilot/gpt-6-luna** tanto no parent quanto no filho.
Sempre CLI Pi via Sandcastle; nenhuma CLI Codex foi usada.

## Resultado

Run `.smoke/a0c06e2c-e3a8-42a9-9e95-ed2873cb5fa1/`:

- Node 22.23.2, Pi 1.1.0, pi-subagents 0.77.0, Sandcastle 0.12.0.
- noSandbox, maxIterations 5, thinking minimal.
- Parent lançou exatamente um filho async smoke-marker, sem ferramentas.
- Marcador aleatório existia somente no prompt do filho. Parent incorporou seu
  resultado, sem inspecionar a definição do agente nem usar ferramentas de arquivo.
- Eventos chegaram a agent_settled; ausência de erro/abort verificada.
- Inicial concluída em **uma iteração**.
- Invocação posterior via `RunResult.resume()` abriu **o mesmo sessionId**,
  recuperou o marcador e não lançou novo filho. Uma iteração de retomada.
- Fixture Git permaneceu intacta; duração total ~25,3 segundos.
- Meta do filho confirma github-copilot/gpt-6-luna:minimal, exitCode 0;
  sua sessão registra provider/modelo esperado e zero tool calls.

Evidência local: initial/resume.events.json, initial/resume.log, report.json,
fixture e sessões. Arquivos brutos ignorados pelo Git; resumo sem credenciais
versionado. Após cleanup da worktree, evidências arquivadas sob `.smoke/` no
checkout principal. São evidências históricas, não trabalhos ativos a retomar.

## Duas correções do próprio teste

1. Run e6a43d08-00cc-4bc7-b4ba-852accc95c20: Copilot respondeu, mas a chamada
   do filho foi rejeitada por `options.defaultProgress:false`. Esse campo é de
   definição do agente, não da invocação. As cinco conversas novas repetiram o
   mesmo pedido inválido; zero filhos. Removido apenas o campo, sem mudar modo/modelo.
2. Run 0dc72b97-2107-414d-b2db-6910ac89d958: delegação e marcador passaram, mas
   o teste dizia erroneamente que a sessão não persistiu. O arquivo existia.
   PI_CODING_AGENT_SESSION_DIR apontava para um diretório flat, enquanto a
   busca Sandcastle espera diretórios de projeto sob hostSessionsDir. Configuração
   alinhada: base `sessions/`, diretório Pi `sessions/project/`. Não houve patch
   da biblioteca, adapter novo, mudança global ou incompatibilidade demonstrada
   da versão Pi. Teste filesystem da interface de lookup registra essa restrição.

Cada nova execução corrigiu apenas a causa constatada e manteve o protocolo
Sandcastle → Pi JSON, o provider Copilot e o modelo Luna. Nenhum fallback de CLI.

## Reprodução

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
SMOKE_MODEL=github-copilot/gpt-6-luna npm run smoke:pi
```

Requer autenticação existente Copilot; comando real faz chamadas ao modelo.
Nunca roda implicitamente nos testes unitários. O modelo é obrigatório; não há
fallback para outro provider. Não modificar TLS nem trust store para reproduzir.

## O que este resultado não comprova

Não valida `/implement` inteira, TDD/review com perguntas, Jira/GitHub Issues,
concorrência N, monitor de PR, Docker, deploy ou retomada após queda abrupta.
A retomada testada foi após conclusão limpa do parent; não retomou um filho
interrompido. O teste desabilita skills/contexto/MCP e restringe ferramentas,
mantendo perfil de extensões e autenticação. Próximo passo é ampliar para pedido
de ajuda e `/implement`, sem tratar esse smoke como garantia geral.

O bloqueio TLS de Codex permanece independente e opcional. Os problemas de
sinalização Sandcastle e setup Git global observados anteriormente permanecem
registrados: gate de eventos evita falso sucesso; GIT_CONFIG_GLOBAL fica na
fixture para não alterar identidade Git pessoal.
