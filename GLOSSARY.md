# My Software Factory

Desenvolvimento local supervisionado de trabalhos vindos de issue trackers.
As decisões e os contratos estão na [spec](docs/spec.md); este arquivo define linguagem.

## Language

**Orquestrador local**:
Responsável por admitir trabalhos, acionar agentes, acompanhar resultados e
procurar o humano quando uma decisão ou informação é necessária.
_Avoid_: motor durável, plataforma definitiva

**Trabalho**:
Atendimento acompanhado de uma issue admitida, incluindo desenvolvimento,
intervenções humanas e acompanhamento do PR até seu desfecho.
_Avoid_: ticket como execução, invocação do agente como trabalho inteiro

**Claim**:
Indicação de que uma issue está reservada para atendimento por alguém ou algum trabalho.
Não se confunde com atribuição a uma pessoa nem com capacidade de execução.
_Avoid_: assignee como claim, claim como vaga

**Issue elegível**:
Issue de projeto habilitado, pronta para agente, sem claim e sem bloqueios ou
dependências, que também satisfaz as regras específicas do seu tracker.
_Avoid_: label como garantia de contexto completo, campos Jira como regra universal

**Vaga**:
Capacidade para um agente principal trabalhar ativamente; espera externa por
CI, review do PR ou resposta humana não a ocupa.
_Avoid_: reserva até o merge, limite de subagentes ou de iterações

**Pedido de ajuda**:
Solicitação do agente que precisa de informação ou decisão humana, ou chegou ao
limite de iterações, sem declarar o trabalho concluído.
_Avoid_: falha silenciosa, processo indefinidamente esperando uma pessoa

**Feedback acionável**:
Informação nova dirigida ao trabalho por uma pessoa ou falha de check relevante
do PR, capaz de motivar resposta ou correção.
_Avoid_: qualquer comentário como comando, relato do próprio agente como feedback

**Retomada manual**:
Continuidade de um trabalho solicitada explicitamente pelo operador a partir
da sessão anterior e da área preservada.
_Avoid_: recuperação automática, nova implementação para contornar uma falha

**Conclusão**:
Reconhecimento do merge externo do PR vinculado e confirmação do trabalho como
done no tracker.
_Avoid_: PR aberto como conclusão, sucesso declarado pelo agente como merge
