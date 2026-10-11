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

## Lacunas encontradas ao ligar as peças (corrigidas para o piloto)

- Nenhum comando executava o loop com adapters reais: `status` só lê fixture. Criado `run`.
- Uma chave Jira compartilhada por vários projetos (VAN com 7 labels) fazia o runner recusar o job
  como "ambíguo". `RunnerContext` agora leva o `repository` do job.
- O container não conseguia abrir PR: a área clonava do checkout local e a imagem não tinha `gh`.
  A área agora empurra para `https://github.com/<repo>.git` com o `GH_TOKEN` do container
  (credential helper que lê a variável; o token nunca é gravado) e a imagem instala o `gh`.

## Pendências que dependem do operador

1. **Insumos de review.** O runner exige, no commit base, a spec e os padrões em arquivos
   (`reviewInputs`). Nenhum dos repositórios do §7 tem `docs/spec.md`; todos (exceto
   `revolving-credit-playbooks`) têm `AGENTS.md`. O piloto usa `docs/spec.md` + `AGENTS.md` e
   exige que o repositório alvo ganhe o `docs/spec.md` da tarefa. A alternativa de usar o corpo
   da issue como spec muda a evidência de review (digest da spec): é decisão de desenho, não feita aqui.
2. **Jira não chega ao container.** O agente escreve comentários no Jira só se tiver credencial
   no container; hoje ele recebe só o `GH_TOKEN`. A factory (host) continua comentando e fazendo
   transições. Decidir se o container precisa de acesso ao Jira.
3. **Transição done de CON** ainda não confirmada (`npm run conformance:jira` cobre só VAN); o
   wizard pergunta e o piloto valida.
4. **Credencial Jira por nome.** O adapter lê `JIRA_URL`, `JIRA_USERNAME` e `JIRA_API_TOKEN` do
   ambiente; o nome em `credentials.JIRA_TRABALHO.ref` é validado mas não escolhe a variável (R01
   pede referência). Suficiente para uma conta Jira; decidir se vale generalizar.
5. **Modelo e perfil do trabalho.** O piloto usa `github-copilot/gpt-6-luna` nos dois perfis
   (envelope barato da spec §6). O perfil de trabalho precisa dele autenticado.

## Critérios da #10 e como são cobertos

| Critério | Como |
| --- | --- |
| 16 alvos configurados nas duas instâncias | template + `config.test.ts`/`pilot-config.test.ts`; wizard habilita só os do piloto (os demais ficam `enabled: false` até terem `docs/spec.md`) |
| Tarefa real ponta a ponta em GitHub e em Jira | wizard, estágios 10–11; **merge feito por você** |
| N=1 e depois N=2 | estágios 11–12 |
| Relatório | estágio 12 salva medições; `report-template.md` |
| Estouro do envelope volta ao operador | estágio 12 registra e avisa; nada muda no MVP sem decisão |
