# Teste 004 — round-trip de /implement, ajuda e retomada aprovado

Data: 2026-10-11. Modelo github-copilot/gpt-6-luna; Pi print/JSON via Sandcastle.
**Passou operacionalmente numa fixture; ressalvas metodológicas abaixo.**

## Recorte

Fixture descartável: função TypeScript exportada `slugify(text: string): string`
para ASCII, spec e padrões locais, tracker Markdown sem API externa. Dependências
já instaladas disponibilizadas por symlink; nenhum projeto real, PR ou deploy.
A spec deixou explícito que a seam TDD ainda não havia sido aprovada pelo humano.
Isso é o caso do experimento, não insuficiência acidental de um ticket real.

## Fase de ajuda

Run `.smoke/implement-help/ac575f2b-6841-4ccb-b2d2-4aeb711dcadf/`:

- `/skill:implement` expandiu a skill instalada real, não uma cópia do prompt.
- Eventos registram leitura de implement, coding-guidelines, spec, padrões,
  tracker local e TDD.
- Resultado `needs_help`: “Do you approve the exported slugify(text: string): string
  function as the test seam?”, seguido de `<promise>HELP</promise>`.
- `agent_settled`, sem abort; uma iteração (máximo 5), sem espera por UI/stdin.
- Sem escrita de teste/implementação ou commit; fixture Git intacta.
- Sessão `01a12bbc-3a8b-7333-9f50-7e7f4590c0de` persistida e localizada pelo
  Sandcastle. Estado local guarda modelo, base Git, sessionId e pergunta.

## Resposta humana e continuação

O operador respondeu **sim**. A aprovação foi transmitida, sem resposta inventada,
à mesma sessão Pi pela invocação posterior com SMOKE_REPLY e SMOKE_RUN.

- Mesmo sessionId; uma iteração de retomada, duração aproximada de 121 segundos.
- Função implementada e três testes públicos escritos.
- Commit local da fixture: `699cd0d`, base `02cb481d8a595d38d4ad5f60021129b85db2dffd`.
- Três testes e typecheck aprovados, conferidos independentemente após o retorno
  do agente. Árvore da fixture limpa.
- Resultado final estruturado complete, seguido de sinal de conclusão e
  agent_settled. Não é PR aberto nem merge remoto.

Ajuda/conclusão são extraídas da última mensagem final do assistant, nunca de
um token no prompt/saída bruta. JSON inválido/ambíguo ou sem sinal é rejeitado.
Novos pedidos preservam mudanças/sessão; árvore intacta só é exigida no primeiro
pedido desta fixture. O script verifica teste/typecheck, commit e limpeza antes
aceitar complete; o investigador também inspecionou diff e artefatos dos reviewers.

## Revisão em dois eixos e dificuldades observadas

Houve um primeiro dispatch rejeitado: model foi colocado dentro de cada task do
recurso parallel, cuja interface aceita somente agent/task por item. O agente
corrigiu para modelo top-level, mantendo o mesmo protocolo e provider.

Quatro reviewers executaram em duas ondas, todos `github-copilot/gpt-6-luna:high`,
exitCode 0. Os primeiros não atestaram o intervalo commitado com seu diff tool:
Standards retornou BLOCK por falta do diff; Spec trouxe ressalva de snapshot.
O agente repetiu a revisão com o **diff exato incluído no handoff**. Resultados
finais inspecionados, não apenas resumo do parent:

- **Standards:** sem violações documentadas ou smells identificados no diff fornecido.
- **Spec:** sem requisitos ausentes/parciais, scope creep ou comportamento incorreto.

As duas revisões finais tiveram zero achados. O problema inicial de ferramentas
não foi tratado como aprovação. A orientação de handoff do experimento agora
explicita payload válido e diff, sem alterar skills ou configurações globais.

## Ressalvas importantes

- O agente escreveu os três casos antes da implementação: isso não demonstra
  aderência à disciplina de TDD em fatias verticais da skill instalada.
- O primeiro teste devolveu erro, mas a compactação RTK do resultado apresentou
  contagem ambígua. Portanto não se certifica um red específico a partir daquele
  resumo. Verificações posteriores retornaram TAP completo e exit code 0, e o
  investigador repetiu teste/typecheck independentemente.
- Não é certificação de toda regra de implement/TDD/code-review. Comprova o caminho
  operacional de skill + intervenção real + sessão preservada + implementação
  verificada + revisões com artefato explícito.
- Não testa crash recovery, ajuda originada por filho, Docker, concorrência N,
  Jira/GitHub Issues, monitor PR ou deploy. O parent aguardou filhos headless pela
  extensão, sem TUI, e encerrou após receber resultados.
- Checkpoint antes do review foi explicitamente permitido para que HEAD contivesse
  um diff commitado. Isso não altera a skill global nem autoriza push/merge real.

## Reprodução e evidências

```sh
SMOKE_MODEL=github-copilot/gpt-6-luna npm run smoke:implement
# Após a pergunta e resposta real do operador:
SMOKE_MODEL=github-copilot/gpt-6-luna SMOKE_RUN=CAMINHO_DA_AREA \
SMOKE_REPLY='resposta humana real' npm run smoke:implement
```

Nova execução cria sua própria área/sessão e pergunta. Não reutilizar resposta
presumida. Requer autenticação Copilot e faz chamadas ao modelo; não roda nos
unit tests. Campos iniciais/quadro anterior são históricos, não aprovação geral.

Evidências brutas: help/resume.events.json, logs, reports, state, sessões,
outputs/metas dos reviewers e Git da fixture. Após integração, ficam arquivadas
em `.smoke/implement-help/` no checkout principal, fora do Git. São históricas;
para trabalho ativo, manter área original enquanto houver retomada pendente.

Harness: 15 testes unitários/API e typecheck aprovados. LSP sem erros nos arquivos
alterados. As limitações ficam no backlog para o próximo piloto, não ocultas
por um resultado complete do modelo.
