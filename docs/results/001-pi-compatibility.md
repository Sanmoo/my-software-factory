# Teste 001 — bloqueado antes da delegação

Data: 2026-10-11. **Não comprova compatibilidade nem incompatibilidade dos subagentes.**

## Ambiente e comando

- Node 22.23.2, Pi 1.1.0, pi-subagents 0.77.0.
- Sandcastle 0.12.0, gitHead e99f832f26dc9d245c019a9ddd19fa5dee792427.
- Modelo openai-codex/gpt-6.1-sol, thinking minimal, maxIterations 5, noSandbox.
- `pi auth check --model openai-codex/gpt-6.1-sol --json --no-refresh`: ready;
  esse check não prova conectividade. Nenhuma credencial foi impressa/exportada.
- Comando: `npm run smoke:pi`, dentro da worktree feat/pi-compatibility.

## Evidência

Run local `.smoke/f6cf576d-0278-47b4-9a1d-b2d970c2d513/` preservado:
`initial.events.json`, `initial.log`, `report.json`, fixture e sessão.

1. Pi emitiu quatro respostas assistant com stopReason error, errorMessage
   `fetch failed`, conteúdo vazio e zero tokens. Três retries internos do Pi;
   o experimento em si não foi repetido nem trocou de provider.
2. Nenhum tool_execution_start: **zero subagentes lançados**.
3. Pi emitiu agent_settled com aborted false após esgotar retries.
4. Sandcastle anunciou conclusão após uma iteração. Sem texto do assistant,
   invokeAgent usa stdout bruto como fallback; esse stdout inclui o prompt
   com o token de conclusão. O sinal detectado não comprova entrega.
5. O gate independente rejeitou o resultado pela ausência do marcador oculto.
   Gate melhorado após diagnóstico para reportar stopReason/errorMessage primeiro.
6. Fase de retomada não foi alcançada. Nenhum processo do experimento permaneceu
   ativo na conferência após a falha.

## Limitações adicionais observadas na implementação publicada

- resumeSession exige maxIterations=1; o helper resume já aplica essa restrição.
- Setup executa git config --global, inclusive com noSandbox. O teste redireciona
  GIT_CONFIG_GLOBAL para arquivo da fixture, mantendo configuração pessoal intacta.
- O sucesso deve exigir assistant final válido, delegação real e agent_settled;
  agent_end/sinal de conclusão isolados são insuficientes.

## Próximo passo

Decidir com o operador como resolver o acesso de transporte ao provider ou se
outro provider/modelo já autenticado deve ser usado. Sem fallback automático.
Não afirmar causa exata de rede: os eventos apenas mostram fetch failed.
O script ainda não deve operar em Jira/GitHub Issues nem em projeto real.
