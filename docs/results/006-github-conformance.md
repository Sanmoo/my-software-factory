# Teste 006 — conformidade do adapter GitHub Issues

Data: 2026-10-11. Ticket #4 (t04). Alvo autorizado: `Sanmoo/my-software-factory`,
conta de projeto `Sanmoo`. Resultado: **passou** no recorte do teste de
conformidade (duas issues descartáveis). Não cobre Jira, GitHub Enterprise,
paginação com dados reais acima de uma página, nem corrida entre dois claims.

## Ambiente

- Node 22.23.2; gh 2.97.0; adapter em `src/tracker/github.ts`.
- Credencial: token da conta `Sanmoo` obtido por `gh auth token --user Sanmoo`
  dentro do adapter e injetado apenas no env (`GH_TOKEN`) das chamadas REST.
  Nenhum token foi impresso, gravado ou versionado.
- Conta ativa do `gh` antes e depois da execução, idêntica (`gh auth status`,
  só as linhas de conta): `Sanmoo` ativa; `samuel-santos_bjd` inativa.
  Nenhum `gh auth switch`.

## Comandos

```bash
gh auth status 2>&1 | grep -E "Logged in|Active account"   # antes e depois
npx tsx --test test/github-tracker.test.ts test/github-gh-cli.test.ts
npx tsx src/experiments/github-conformance.ts --confirm      # cria e fecha #11 e #12
```

O script recusa rodar sem `--confirm`. Uma guarda interna recusa qualquer escrita
em issue diferente das duas criadas por ele.

## Issues tocadas

| Issue | Papel | Estado final |
| --- | --- | --- |
| #11 `[msf-test] conformance 2026-10-11` | sujeito do teste, label `ready-for-agent` | fechada como `completed` |
| #12 `[msf-test] blocker 2026-10-11` | bloqueador (sem label de prontidão) | fechada como `completed` |

Nenhuma outra issue recebeu escrita. As escritas do script foram só nos caminhos
`repos/Sanmoo/my-software-factory/issues` (criação) e `issues/11`, `issues/12`.

## Resultados por passo

| Passo | Resultado observado |
| --- | --- |
| criar issues descartáveis | #11 e #12 criadas (HTTP 201) |
| `discoverCandidates` | lista de candidatos paginada lida (9 itens: #1–#9). **#11 não apareceu nesta primeira leitura** (ver observações) |
| `readIssue` antes do claim | `claimed` = false (conhecido); elegível pelas regras do núcleo |
| `addBlockedBy(#11, #12)` | `blockers` = [#12, terminal false]; elegibilidade rejeitada (`no-blockers`) |
| `removeBlockedBy` | `blockers` = []; elegível de novo |
| `claim` | aceito; releitura: assignee `Sanmoo`, labels `ready-for-agent`, `agent-claimed` |
| `claim` repetido | rejeitado: `issue já claimed`, sem escrita |
| `releaseClaim` | `claimed` = false; issue continua aberta; sem assignee |
| `claim` novamente | aceito |
| `postComment` + `readComments` | id `6112336916`; autor `Sanmoo`; `isBot` = false; corpo contém `<!-- msf:agent -->`; total 1 |
| `markDone(#11)` | `done` (confirmado por releitura: fechada como `completed`) |
| `markDone(#11)` repetido | `already-done`, sem escrita |
| `markDone(#12)` | `done` |

Chamadas de escrita registradas (método, caminho, HTTP): POST issues (201, 201);
POST `issues/11/dependencies/blocked_by` (201); DELETE `…/blocked_by/<id db>` (200);
POST `issues/11/labels` (200); POST `issues/11/assignees` (201); DELETE
`issues/11/labels/agent-claimed` (200); DELETE `issues/11/assignees` (200); POST
`issues/11/labels` (200); POST `issues/11/assignees` (201); POST
`issues/11/comments` (201); PATCH `issues/11` (200); PATCH `issues/12` (200).

## Observações

1. **Discovery logo após a criação.** A primeira leitura de candidatos não incluiu
   #11, apesar de criada com `ready-for-agent` e aberta. A consulta somente leitura
   feita depois, com a mesma query, não traz #11 porque ela já estava fechada, então
   não foi possível repetir a leitura com a issue aberta. A causa mais provável é
   atraso de listagem logo após a criação; **não foi isolada nem medida**. Impacto
   previsto: a factory faz polling periódico, então a issue entra no ciclo seguinte,
   e `claim` relê o estado antes de qualquer agente rodar.
2. **Label `agent-claimed` criada pela API.** O label não existia no repositório;
   o primeiro `POST .../labels` o criou (cor `#ededed`). Efeito colateral no repo,
   fora das issues.
3. **#11 fechada com resíduos de claim.** O script termina com `markDone`, sem
   `releaseClaim` depois do último claim; por isso #11 fechada ainda tem o label
   `agent-claimed` e assignee `Sanmoo`. Não foi feita escrita extra só para limpar.
4. **Identidade de comentário.** Na instância pessoal o operador e a conta do
   projeto são o mesmo usuário; o comentário da factory aparece como `isBot` = false.
   A distinção de R10 depende do marcador `<!-- msf:agent -->`, não do autor.
5. **Segredos.** A saída do script (JSON) não contém tokens. A verificação de conta
   usou só as linhas `Logged in`/`Active account`.

## Limites

- Corrida entre dois claims não foi exercitada: a confirmação é só por releitura.
- Falha de leitura de dependências (Unknown → não elegível) é coberta por teste
  determinístico com boundary falso, não contra a API real.
- Paginação com mais de uma página foi coberta com boundary falso (120 issues),
  não com a API real.
- Jira (#5) e PR (#8) não são cobertos aqui.
