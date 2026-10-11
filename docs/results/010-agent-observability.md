# Diagnóstico 010 — atividade do agente ausente nos logs

Data: 2026-10-11. Base investigada: `7d0c28f`, Sandcastle 0.12.0, Pi 1.1.0,
Node 22.23.2. Descoberta durante o [piloto #10](https://github.com/Sanmoo/my-software-factory/issues/10).
Este documento registra diagnóstico e plano aprovado, **não uma correção implementada**.
Spec publicada como [issue #15](https://github.com/Sanmoo/my-software-factory/issues/15).

## Incidente e conclusão

O trabalho observado foi `github:Sanmoo/my-software-factory#13`, não a issue #10.
O agente pediu ajuda na primeira invocação; a pergunta não apareceu no log
principal do runner. Após `reply`, o log detalhado mostrou apenas setup,
`Resuming session`, `Agent started` e avisos `Agent idle for 1/2/3 minutes`.
Isso impediu o operador de perceber atividade intermediária.

A sessão preservada recebeu a resposta e registrou chamadas de ferramentas.
Depois o próprio log mostrou entrega de `pr_ready`, PR #14, parada do agente
e fim da invocação. A factory registrou `waiting-for-pr` com o PR #14.
**Neste incidente, a retomada funcionou; a falha foi de observabilidade.**
PR aberto não é conclusão do trabalho: o merge externo e a confirmação de done
continuam necessários, conforme o glossário e R11.

Cronologia UTC extraída em leitura passiva de registros locais:

| Horário | Evidência |
| --- | --- |
| 20:55:38.082 | Auditoria: invocação nova, limite efetivo 5. |
| 20:55:54.293 | Sessão: resultado `needs_help`. |
| 20:56:04.494 | Auditoria: primeira invocação encerrada em uma iteração. |
| 21:25:59.668 | Auditoria: retomada, limite efetivo 1. |
| 21:26:01.393 | Sessão: resposta humana entregue na mesma sessão. |
| 21:26:05.094 | Sessão: chamadas de ferramentas após a resposta. |
| Sem timestamp individual | Log: avisos de ausência de saída por 1, 2 e 3 minutos. |
| Até 21:33:48.964 na inspeção | Sessão: atividade posterior aos avisos. |
| 21:40:00.195 | Auditoria: retomada encerrada em uma iteração; estado posterior `waiting-for-pr`, PR #14. |

O enqueue/aplicação do reply não tinha timestamp próprio. Os arquivos cresceram
durante a inspeção; não se tratou de snapshot atômico. Transcrições reais e
configuração privada não foram versionadas.

## Reprodução determinística

`src/experiments/agent-log-repro.ts` exercita a API pública do Sandcastle:
`run` + `pi` + `createBindMountSandboxProvider` + `logging.file`.
Somente a execução de comandos do sandbox é substituída. Nenhum Pi, Docker,
modelo, tracker ou credencial é acionado. Git prepara um repositório de fixture;
logs sintéticos ficam em `.smoke/`, ignorada pelo Git.

O cenário mínimo emite início/fim de uma chamada `read`, com `args.path` e
resultado textual. O callback real recebe os dois eventos; as verificações de
visibilidade leem **o arquivo real**, após aguardar seu marcador de término.

```sh
# Vermelho esperado: ausência da chamada/resultado no arquivo padrão.
node --import tsx src/experiments/agent-log-repro.ts

# Controles diagnósticos aprovados (não são testes de uma correção operacional).
node --import tsx src/experiments/agent-log-repro.ts --expect-missing
node --import tsx src/experiments/agent-log-repro.ts --recognized-tool --expect-missing
node --import tsx src/experiments/agent-log-repro.ts --verbose
```

| Controle | Eventos recebidos | Argumentos no arquivo | Resultado no arquivo |
| --- | --- | --- | --- |
| `read` padrão | 2 | não | não |
| Nome reconhecido `Bash`, argumento `command` | 2 | sim | não |
| `read` com captura bruta `verbose` | 2 | sim | sim |

A falha padrão foi repetida. Um cenário anterior com `text_delta` mostrou a
mensagem textual, mas não chamada/resultado. O mínimo prova a perda de eventos
de ferramenta; não reproduz retomada, duração dos avisos ou filhos reais.

## Causa e limites

No Sandcastle 0.12.0, `parsePiStreamLine` usa `TOOL_ARG_FIELDS`, uma tabela
restrita a `Bash`, `WebSearch`, `WebFetch` e `Agent`. Os nomes Pi `read`, `bash`
e `subagent` não são reconhecidos. O parser também não converte
`tool_execution_end`, perdendo resultados no log padrão. A opção `verbose`
persiste os eventos brutos e recuperou ambos no controle.

O MSF, em `src/runtime/docker-sandcastle.ts`, guarda eventos brutos parseados
em memória para interpretar o resultado, mas não os persiste como transcrição
exaustiva. O log principal em `src/cli/run.ts` imprime relatórios de polling,
não as transições de ajuda/desfecho realizadas em background.

O aviso de idle mede ausência de **saída recebida**, não prova inatividade de
todos os processos. Aviso e timeout são caminhos distintos; o runtime MSF usa
600 segundos de timeout. A perda de renderização explica a lacuna dos logs,
mas não significa que ela causa os avisos: o timer da dependência é resetado
por linhas recebidas, mesmo que o parser não as renderize.

Hipóteses testadas: conversão parcial confirmada; ausência de persistência
bruta confirmada; leitura precoce não explica o mínimo, que permanece sem os
eventos após o marcador de término. Não alterar timeout nem adicionar retry
para resolver este incidente.

`verbose: true` é **controle diagnóstico, não proposta suficiente de produto**:
intercala JSON bruto, não oferece o contrato completo de legibilidade,
timestamps, sigilo, filhos ou falhas de gravação.

## Validação da investigação

- Teste público `runSupervision(reply)` → fila → `Admission.poll()` → runner:
  mesma sessão/área, resposta entregue, apenas uma retomada mesmo após novo
  polling; suíte `supervision-cli.test.ts` passou 10/10.
- `npm test`: 362/362; `npm run typecheck`: aprovado na base investigada.
  Os 369 testes relatados pelo agente pertencem ao trabalho do PR #14, não a
  esta base.
- Probe isolado executado em segundos; controle padrão vermelho esperado,
  controles `--expect-missing`, `--recognized-tool --expect-missing` e
  `--verbose` aprovados.
- Nenhuma alteração no runtime operacional, tracker ou trabalho real.

O probe não integra a suíte automática: seu modo padrão deve continuar vermelho
na dependência investigada. O [plano aprovado](../plans/agent-observability.md)
define os testes de regressão da implementação futura.
