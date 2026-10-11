# Teste 007 — conformidade do adapter Jira (VAN)

Data: 2026-10-11. Ticket #5 (R02, R03, R10, §7; CA02). Adapter `src/tracker/jira.ts`,
conformidade `src/experiments/jira-conformance.ts` (`npm run conformance:jira`).
**Resultado: aprovado nos dois recortes exigidos** (leitura sem escrita em issues reais;
escrita apenas em issues `[msf-test]` fora de sprint). Sem modelo; nenhuma credencial
impressa, versionada ou gravada neste relatório. A admissão ponta a ponta no Jira fica para #10.

## Ambiente e credenciais

- Node 22.23.2, `npm ci --ignore-scripts`. Credenciais somente pelas variáveis
  `JIRA_URL`, `JIRA_USERNAME`, `JIRA_API_TOKEN` (presença verificada por nome; valores não lidos
  para registro). A conta do operador foi resolvida por `GET /rest/api/3/myself`; o `accountId`
  não é registrado aqui e é o valor que deve ir em `jira.operator` na configuração.
- Projeto: VAN (`bancojohndeere.atlassian.net`). Nenhum comando tocou CON, GitHub ou sprints.

## Parte 1 — leitura (zero escritas)

Comando: `npm run conformance:jira` (sem `--write`). O guard de fetch do script recusa qualquer
requisição que não seja GET ou o `POST /rest/api/3/search/jql`.

- Candidatos `ready-for-agent` em VAN: **12** (VAN-1289, 1290, 1291, 1292, 1294, 1295, 1301–1306).
- Escritas realizadas: **0**.
- Sprint (`sprint in openSprints()` respondido sem erro, portanto o projeto tem board):
  5 candidatos na sprint aberta (VAN-1289, 1290, 1291, 1292, 1294), 7 fora (VAN-1295, 1301–1306).
- Atribuição: **nenhum** dos 12 candidatos está atribuído à conta do operador; todos são
  rejeitados por `assignee-operador` com essa razão.
- Roteamento (§7): nenhum dos 12 tem label de roteamento; todos aparecem como
  "sem roteamento" e não são admitidos. Contagem por label em VAN: `mfe` 4 issues, `playbooks` 0
  (antes da escrita de teste), `monolith`, `dealer-services`, `fdm`, `common-infra`, `lambda-auth` 0.
  Achado para o operador: as labels de roteamento da §7 quase não aparecem nas issues prontas.
- Bloqueios reais lidos com estado: VAN-1290 bloqueada por VAN-1289 (não terminal), VAN-1292 por
  VAN-1289, VAN-1291 por VAN-1290, VAN-1304 por VAN-1303 e VAN-1264, VAN-1306 por VAN-1305 e VAN-1267,
  entre outros. Cada bloqueio tem categoria lida (não terminal).
- Categorias lidas: 4 em *In Progress* (VAN-1289 a 1292), 8 em *To Do*. Nenhuma `unknown`.
- Tipos de link no projeto incluem `Blocks` (inward "is blocked by", outward "blocks").
- Transições listadas em uma issue em andamento: `Itens Pendentes`, `Em andamento`,
  `Itens concluídos`, `Ready`, `Reviewing`, `Biz Homologation`, `To Deploy`, `Cancelled`,
  `Ready for Review`.

## Parte 2 — escrita em issues `[msf-test]` fora de sprint

Issues: **VAN-1319** e **VAN-1320**, tipo "Tarefa", prefixo `[msf-test]`, labels `playbooks` e
`ready-for-agent`, atribuídas ao operador, criadas sem sprint.

Histórico honesto de duas execuções:

1. `npm run conformance:jira -- --write --done "Itens concluídos"` criou VAN-1319 (intenção:
   bloqueada) e VAN-1320 (intenção: bloqueadora). Ambas foram lidas fora de sprint. O
   `POST /rest/api/3/issueLink` foi enviado com `inwardIssue` = bloqueada e `outwardIssue` =
   bloqueadora, e criou o link **invertido** (VAN-1319 bloqueia VAN-1320). A execução parou ao
   ler a resposta 201 sem corpo: bug do próprio helper HTTP, corrigido (teste vermelho antes).
   Resultado: as duas issues foram criadas com o link invertido e não foram apagadas.
2. Após a correção, a execução com os papéis lidos de volta do Jira:
   `npm run conformance:jira -- --write --test-issues VAN-1320:VAN-1319 --done "Itens concluídos"`.
   Assim, **VAN-1320 é a bloqueada** e **VAN-1319 é a bloqueadora**. O payload correto para
   criar um bloqueio é `inwardIssue` = bloqueadora (origem de "blocks") e `outwardIssue` =
   bloqueada; o script usa esse payload quando precisa criar um link.

Resultado da execução 2 (cada passo verificado no Jira):

| Passo | Resultado |
| --- | --- |
| Fora de sprint antes de escrever | `openSprint` = false nas duas issues; JQL `sprint is not EMPTY` = false |
| Link | VAN-1320 "is blocked by" VAN-1319, lido dos dois lados |
| Elegibilidade bloqueada (antes) | `no-blockers: bloqueada por #VAN-1319 (não terminal)` e `sprint-atual: fora da sprint atual` |
| Claim da bloqueadora (VAN-1319) | `accepted`; label `agent-claimed` e transição `Em andamento` confirmadas por reread |
| Segundo claim | `rejected: issue já claimed`, sem escrita |
| Comentário `[msf]` | id 83324, lido de volta com prefixo `[msf]` |
| Done da bloqueadora | `done` pela transição `Itens concluídos`; repetido: `already-done` |
| Elegibilidade bloqueada (depois) | só `sprint-atual: fora da sprint atual`; bloqueio terminal |
| Claim, comentário e done da bloqueada (VAN-1320) | `accepted`; comentário lido; `done`; repetido `already-done` |
| Estados finais | VAN-1319 e VAN-1320 em `done`, sem sprint, não apagadas |

Motivo de rejeição reportado: `sprint-atual: fora da sprint atual` (é o "fora da sprint"
do critério CA02).

Escritas realizadas na execução 2 (guard do script, lista completa):
`PUT` VAN-1319 (claim: label), `POST` VAN-1319 transições (doing), `POST` VAN-1319 comentário,
`POST` VAN-1319 transições (done), e o mesmo para VAN-1320. Nenhuma escrita em issue real.
Escritas da execução 1: criação de VAN-1319 e VAN-1320, `PUT` de atribuição nas duas e um
`POST` de `issueLink`, descritos acima.

## Transições confirmadas

- **Doing:** `Em andamento` (categoria *In Progress*). Usada com sucesso a partir de *To Do*
  (claim da VAN-1319 e da VAN-1320) e confirmada por reread.
- **Done:** `Itens concluídos` (categoria *Done*). É o nome configurado para done em VAN.
  `Cancelled` também é categoria *Done*, mas é cancelamento; não foi usada.

## Limites e riscos residuais

- Nenhum candidato real estava atribuído ao operador nem tinha label de roteamento: o pipeline
  real não admite nada hoje. Não é falha do adapter; é o estado de VAN no momento.
- O operador precisa ser configurado como `accountId` (não e-mail); o adapter compara o
  `accountId` do assignee com `jira.operator`.
- Claim: se a transição doing falhar depois de a label ser adicionada, a label fica e o claim
  precisa de liberação explícita (P02). Não há reversão automática.
- Sem tratamento de 429/rate limit; respostas de erro não ecoam corpo (sem vazamento).
- O adapter lê apenas a primeira página de comentários com `maxResults=100` e segue `startAt`.
- Ticket #10 cobre a admissão ponta a ponta no Jira, que este teste não exercita.
