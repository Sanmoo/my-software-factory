# Teste 008 — runner Docker: `/implement` real em Sandcastle, com retomada

Data: 2026-10-11. Modelo **github-copilot/gpt-6-luna** para todos os papéis (implementer,
reviewer-standards, reviewer-spec e default). Runtime: Sandcastle 0.12.0 com `docker()`,
sem `noSandbox`. Fixture local descartável, sem tracker, sem PR, sem push.

**Resultado: demonstração aprovada na fixture.** Uma invocação nova pediu ajuda dentro do limite
de 5 iterações; a continuação, com 1 iteração e a mesma sessão Pi, implementou `slugify` com
TDD e fez um commit local na mesma área Git, em outro container. Não houve merge, deploy ou
chamada de tracker. O resultado final da fixture é `interrupted` com motivo
`fixture local: sem PR`, porque PR e checagem de PR ainda não existem (ver limites).

## Versões

- Host: macOS arm64, Node 22.23.2, Sandcastle 0.12.0, Pi 1.1.0
  (`@earendil-works/pi-coding-agent`).
- Docker: Engine 29.2.1, daemon em VM Linux (colima).
- Imagem `msf-docker-runner:local`: mesma base e mesmo Dockerfile do spike 005
  (`node:22-bookworm-slim`, Pi 1.1.0, usuário com UID/GID do host). Copiada para
  `src/runtime/docker-image/`; o spike não foi alterado.

## Setup necessário

1. Build com UID/GID do host:
   `docker build --build-arg AGENT_UID=$(id -u) --build-arg AGENT_GID=$(id -g) -t msf-docker-runner:local src/runtime/docker-image`
2. Token: `gh auth token --user Sanmoo` lido pelo runner e passado somente como env `GH_TOKEN`
   do container. Nunca escrito em área, registro, auditoria ou relatório (a demo varre esses
   arquivos e falharia se achasse o valor). `gh auth status` antes e depois idêntico
   (`activeGhUnchanged: true`).
3. Perfil: `~/.pi/agent` montado somente leitura no mesmo caminho do host; `prepare-profile.sh`
   copia para um `~/.pi/agent` local do container. Sem alteração do perfil global.
4. `npm run smoke:docker-runner` (única execução; a demo não aceita outro modelo).

## Como o runner foi exercitado

Demo (`src/experiments/docker-runner-demo.ts`), em ordem:

1. **Negativo, sem modelo:** imagem inexistente. O runner devolveu interrupção visível com o
   motivo do Sandcastle/preflight (`Image ... is missing`), não criou área do trabalho e não
   chamou o agente.
2. **Invocação nova (`new`):** limite efetivo 5. O log do Sandcastle mostra `Max iterations: 5`
   e `Iteration 1/5`; o agente pediu ajuda (seam ainda não aprovado) e a iteração terminou pelo
   sinal de conclusão. Resultado: `needs_help`.
3. **Continuação (`resume`)** com nota do operador (aprovação do seam), em outro container: log
   `Max iterations: 1`, `Resuming session`, `Iteration 1/1`. Resultado: `interrupted`
   (`fixture local: sem PR`).

## Observado dentro do Docker

- **Sessão Pi preservada fora do container:** uma única sessão para o trabalho
  (`sessionFiles: 1`). O registro do trabalho guarda o mesmo `sessionId` antes e depois da
  continuação (`sameSession: true`). O arquivo de sessão contém os dois prompts: o do
  `/skill:implement` na primeira invocação e o de continuação na segunda.
- **Área Git preservada:** a área é um clone do branch alvo na base, no branch do trabalho
  (`msf/github-fixture-docker-runner-1`). Após o container da continuação, a área está limpa
  (`areaClean: true`) e tem 1 commit desde a base (`fixtureCommitsSinceBase: 1`), o commit
  feito pelo agente. O commit da primeira invocação não existiu (pediu ajuda antes de editar).
- **Contenedores descartados:** `sandcastleContainersLeft: 0` após cada invocação.
- **Modelo:** a sessão tem um único par `github-copilot/gpt-6-luna`; nenhuma chamada a
  subagente (`subagent calls: 0`), logo nenhum uso de `default` foi observado.
- **Trabalho do agente na continuação:** `src/slugify.ts` e `test/slugify.test.ts`. Na execução final
  o teste tem 2 casos e passou 2/2 no host (`node --test test/slugify.test.ts`), com a árvore limpa.
  Na execução anterior, de mesmo código de runner exceto pelo prompt, o agente escreveu 3 casos e
  passou 3/3. Os exemplos da spec (`" Hello, WORLD!! "`, `""`, `"TypeScript & Pi"`) são a referência.
- **Varredura de segredo:** nenhum arquivo de estado ou auditoria contém o token.

## Custo dentro do envelope

Somente gpt-6-luna, sessão inteira (duas invocações): 13 mensagens do assistente com uso
reportado, 74.374 tokens, custo estimado pelo próprio Pi de US$ 0,00117. Não é fatura do
Copilot.

## Observado vs apenas documental

Observado ao vivo:
- imagem ausente recusada antes de qualquer área ou agente;
- pedido de ajuda em `new` com limite 5 e término em 1 iteração;
- continuação em outro container, mesma sessão Pi e mesma área, limite 1;
- ausência de container remanescente e de token nos arquivos;
- `gh` ativo inalterado.

Apenas documental, coberto por teste unitário sem Docker ou não exercitado:
- **Revisão:** `pr_ready` só passa com aprovação nos dois eixos, ligada ao base, ao HEAD final,
  ao digest do diff exato e aos digests de spec e padrões, feita pelo modelo configurado de
  cada reviewer. Não houve review nem PR nesta execução.
- **Uso de `default`:** cada lançamento de subagente é registrado com seu papel e modelo; um
  lançamento sem modelo ou com modelo não configurado é interrupção. Não exercitado ao vivo.
- **Reconciliação de filhos:** filho async só é reconciliado pela notificação de conclusão
  (`subagent-notify`, forma observada no spike 005); filho síncrono pelo resultado da ferramenta.
  Sem filho nesta execução.
- **Falha de Docker/perfil no meio da execução e recriação após queda abrupta:** o preflight
  (daemon, imagem, perfil, token) é coberto por teste com boundary falso; a queda abrupta não
  foi provocada.
- **Limite de iterações sem sinal:** sem sinal de conclusão, o resultado é lista vazia e a
  admissão pede intervenção. Não provocado ao vivo.

## Limites e riscos residuais

- **PR não verificado:** `pr_ready` ainda não é confirmado no adapter de PR (#8). Um
  `pr_ready` com revisões aprovadas passa adiante sem essa checagem; por isso a fixture termina
  em `interrupted`.
- **Revisão é evidência declarada:** o runner não lê o conteúdo do que o reviewer recebeu. Ele
  exige que a evidência esteja ligada ao estado final (base, HEAD, digests) e aos modelos
  configurados. Uma revisão mentirosa com digests corretos não seria detectada.
- **`default` e modelo compartilhado:** se o modelo de um lançamento é igual ao de `default`
  e de um reviewer, o lançamento é logado com os dois papéis; não há como saber o papel real.
- **Pi-lens excluído do container** (herdado do spike): a cópia do `settings.json` do
  container remove `npm:pi-lens`.
- **Perfil limitado:** só `~/.pi/agent` e `~/.agents` são montados. Raízes de conta de trabalho
  não estão no container; skills que apontam para elas são puladas com aviso.
- **Token:** o `GH_TOKEN` aparece em `docker inspect` enquanto o container existe (limite do
  env do Sandcastle, igual ao spike).
- **Continuação sem texto do operador:** o `RunnerContext` ganhou `note` (aditivo). A admissão
  ainda não o preenche; a resposta/feedback ligados ao `reply`/`resume` chegam com a CLI (#7).
- **Área e logs:** a auditoria fica em `runs/<trabalho>.audit.jsonl` e o log do Sandcastle em
  `areas/<trabalho>/logs/`. O comando `logs` ainda não os mostra.
- **Clone a partir de checkout local:** a área é clonada de um caminho local (`repositorySource`).
  A origem real dos projetos ainda não é configurada; isso fica para a ligação com a CLI.
- **Dockerfile copiado do spike** com três avisos do linter (apt sem versão fixa, sem
  `pipefail`, `ls` em laço); mantidos iguais ao spike, que foi aprovado.

## Reprodução

```sh
docker info
docker build --build-arg AGENT_UID=$(id -u) --build-arg AGENT_GID=$(id -g) \
  -t msf-docker-runner:local src/runtime/docker-image
npm ci --ignore-scripts
npm test
npm run typecheck
npm run smoke:docker-runner
```

Requer Docker, Copilot autenticado no perfil Pi e `gh` com a conta `Sanmoo`. Faz chamadas ao
modelo; nunca roda em `npm test`. Evidência bruta em `.smoke/docker-runner/<execução>/`
(ignorada pelo Git, sem transcrição neste documento).
