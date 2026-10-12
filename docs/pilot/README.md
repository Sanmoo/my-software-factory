# Piloto (issue #10, CA16)

Roda a factory de verdade: instâncias `pessoal` e `trabalho`, trackers GitHub Issues e Jira,
Docker, primeiro N=1 e depois N=2. A parte que só uma pessoa pode fazer (credenciais, tarefas
reais, merge) é conduzida por um wizard.

```sh
./scripts/pilot-wizard.sh      # idempotente: lembra o que já salvou em .pilot/pilot.env
```

O wizard gera, em `.pilot/` (git-ignored: token Jira, caminhos desta máquina):

- `config.json`: a partir de [`config.template.json`](config.template.json), com todos os alvos do §7;
- `local.json`: perfis Pi, checkouts, imagem e insumos de review desta máquina;
- `run.sh`: `.pilot/run.sh <pessoal|trabalho> [--check|--once]`.

## O que existe para o piloto

| Peça | Onde |
| --- | --- |
| Config dos alvos do §7 (**16** alvos, não 13: 5 pessoais + 11 do trabalho) | `config.template.json` |
| Loop da instância (polling, admissão, runner Docker, PR, feedback) | `npm run run` (`src/cli/run.ts`) |
| Check de prontidão, só leitura | `.pilot/run.sh <instância> --check` |
| Composição dos adapters reais | `src/cli/compose.ts`, `src/tracker/routing.ts` |
| Modelo do relatório | [`report-template.md`](report-template.md) → `docs/results/009-pilot.md` |

Supervisão enquanto roda: `npm run logs`, `reply`, `resume`, `release`, `pause`, `unpause`
(`--help` de cada um), com `--state-dir .pilot/state/<instância>`.

No terminal, o log principal do `run` sai em formato humano: hora local, coluna curta do
trabalho (`#13`, `PAY-7`), marcador e cor de severidade (`·` info, `✓` progresso, `!` atenção,
`✗` erro); área, sessão e logs secundários ficam no histórico (`npm run logs`). `NO_COLOR` tira as
cores; `FORCE_COLOR=1` liga o formato humano fora de um terminal. Redirecionado, o log mantém o
formato plano (ISO UTC, `[instância]`, todos os campos). Nos dois, a mesma falha repetida sai
uma vez, com lembrete a cada 5 min e aviso de recuperação.

## Lacunas encontradas ao ligar as peças (corrigidas para o piloto)

- Nenhum comando executava o loop com adapters reais: `status` só lê fixture. Criado `run`.
- Uma chave Jira compartilhada por vários projetos (VAN com 7 labels) fazia o runner recusar o job
  como "ambíguo". `RunnerContext` agora leva o `repository` do job.
- O container não conseguia abrir PR: a área clonava do checkout local e a imagem não tinha `gh`.
  A área agora empurra para `https://github.com/<repo>.git` com o `GH_TOKEN` do container
  (credential helper que lê a variável; o token nunca é gravado) e a imagem instala o `gh`.

## Review dentro do /implement

O review dos dois eixos roda dentro da invocação do `/implement`; a factory não o verifica e não há
estado nem evidência de review no resultado. O prompt entrega ao agente a base, o comando do diff
exato, a issue como spec e o `AGENTS.md` como padrões, e manda reportar `pr_ready` só com os dois
reviews aprovados. A factory confirma o PR no adapter (R08) e continua exigindo modelo explícito por
subagente e filhos reconciliados. O piloto demonstra a CA09 pelo log e pela sessão.

## Triagem de comentários do PR (issue #21)

Comentário humano novo no PR (conversa, inline ou corpo de review) não vira correção direta: a
correção invoca `/skill:gh-address-comments`, que numera threads e comentários com resumo e proposta
e termina como pedido de ajuda (sem mudar código nem fazer push). Responda por `reply` ou `agent:` na
issue; a retomada aplica só o que você escolheu (`1 e 3`, `2: responda que X`), junto com os checks com
falha e o conflito do mesmo lote. Item não citado fica sem ação e com o thread aberto. Lote só com
check com falha e/ou conflito vai direto para correção.

Pré-requisitos, verificados por `.pilot/run.sh <instância> --check`:

- **Skill no perfil Pi autorizado.** O operador a linka, o setup não mexe no perfil:
  `ln -s ~/.agents/skills/gh-address-comments <perfil>/skills/gh-address-comments`. Sem ela, comentário
  humano vira pedido de ajuda visível (nunca correção sem triagem) e nada é consumido.
- **`python3` na imagem do runner**, exigido pelo script da skill: reconstrua a imagem
  (`docker build ... src/runtime/docker-image`).

## Pendências que dependem do operador

1. **Jira fora do container (decidido).** O container só recebe o `GH_TOKEN`; o agente não escreve
   no Jira e reporta pelo resultado estruturado. Hoje a factory não posta a pergunta no card nem o
   bloqueia: a ajuda aparece em `status`/`logs` e se responde por `reply` ou comentário `agent:`.
   Modo unattended (comentar e bloquear o card) seria um ticket à parte.
2. **Transição done de CON** ainda não confirmada (`npm run conformance:jira` cobre só VAN); o
   wizard pergunta e o piloto valida.
3. **Credencial Jira por nome.** O adapter lê `JIRA_URL`, `JIRA_USERNAME` e `JIRA_API_TOKEN` do
   ambiente; o nome em `credentials.JIRA_TRABALHO.ref` é validado mas não escolhe a variável (R01
   pede referência). Suficiente para uma conta Jira; decidir se vale generalizar.
4. **Modelo e perfil do trabalho.** O piloto usa `github-copilot/gpt-6-luna` nos dois perfis
   (envelope barato da spec §6). O perfil de trabalho precisa dele autenticado.

## Critérios da #10 e como são cobertos

| Critério | Como |
| --- | --- |
| 16 alvos configurados nas duas instâncias | template + `config.test.ts`/`pilot-config.test.ts`; wizard habilita só os do piloto (os demais ficam `enabled: false` até terem `docs/spec.md`) |
| Tarefa real ponta a ponta em GitHub e em Jira | wizard, estágios 10–11; **merge feito por você** |
| N=1 e depois N=2 | estágios 11–12 |
| Relatório | estágio 12 salva medições; `report-template.md` |
| Estouro do envelope volta ao operador | estágio 12 registra e avisa; nada muda no MVP sem decisão |
