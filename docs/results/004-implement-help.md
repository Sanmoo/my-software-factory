# Teste 004 — pedido de ajuda de /implement, continuação pendente

Data: 2026-10-11. Modelo github-copilot/gpt-6-luna; Pi print/JSON via Sandcastle.
**Fase de ajuda aprovada; implementação/revisão após resposta ainda não executada.**

## Recorte

Fixture descartável: função TypeScript exportada `slugify(text: string): string`
para ASCII, spec e padrões locais, tracker Markdown sem API externa. Dependências
já instaladas disponibilizadas por symlink; nenhum projeto real, PR ou deploy.
A spec deixou explícito que a seam TDD ainda não havia sido aprovada pelo humano.
Isso é o caso do experimento, não uma insuficiência acidental de um ticket real.

## Resultado observado

Run `.smoke/implement-help/ac575f2b-6841-4ccb-b2d2-4aeb711dcadf/`:

- `/skill:implement` expandiu a skill instalada real, não uma cópia do seu prompt.
- Eventos registram leitura de implement, coding-guidelines, spec, padrões,
  tracker local e TDD.
- Resultado final estruturado:
  `needs_help`, pergunta “Do you approve the exported slugify(text: string): string
  function as the test seam?”, seguido de `<promise>HELP</promise>`.
- `agent_settled`, sem abort; uma iteração (máximo 5), sem espera por UI/stdin.
- Não escreveu teste/implementação e não fez commit; fixture Git intacta.
- Sessão `01a12bbc-3a8b-7333-9f50-7e7f4590c0de` persistida e encontrada pela
  interface de busca Sandcastle.
- Estado issue-like local guarda modelo, base Git, sessionId e pergunta. Ainda
  não é scheduler, notificação, tracker adapter ou CLI operacional da factory.

A ajuda é lida da última mensagem final do assistant, nunca de um token no
prompt/saída bruta. JSON inválido, ambíguo ou sem sinal apropriado é rejeitado.
Teste inicial pode parar antes de implementar; isso não conta como entrega completa.

## Continuação

O operador precisa aprovar ou ajustar a seam. Apenas a resposta real será passada
por `SMOKE_REPLY`, com `SMOKE_RUN` apontando para a área preservada, à mesma
sessão Pi. Não criar nova conversa para contornar o bloqueio.

```sh
SMOKE_MODEL=github-copilot/gpt-6-luna npm run smoke:implement
# Depois de resposta humana, no mesmo checkout/worktree:
SMOKE_MODEL=github-copilot/gpt-6-luna \
SMOKE_RUN=.smoke/implement-help/ac575f2b-6841-4ccb-b2d2-4aeb711dcadf \
SMOKE_REPLY='resposta humana real' npm run smoke:implement
```

Na continuação, conferir testes/typecheck da fixture, diff/commits e revisão em
dois eixos com filhos Luna. Resultado complete do modelo não basta para aprovar
esse conjunto. Novos pedidos de ajuda preservam mudanças já feitas e a sessão;
a restrição de árvore intacta aplica-se apenas ao primeiro pedido do experimento.

## Estado do desenvolvimento do experimento

15 testes unitários/API e typecheck passaram; LSP nos quatro arquivos alterados
sem erros. Branch test/implement-help e worktree .worktrees/implement-help-smoke
preservadas até a resposta. Não integrado em main nem publicado ainda.
