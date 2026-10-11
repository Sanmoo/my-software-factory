# My Software Factory

Desenvolvimento local supervisionado de trabalhos vindos de issue trackers.
As decisões e os contratos estão na [spec](docs/spec.md); este arquivo define linguagem.

## Language

**Orquestrador local**:
Responsável por admitir trabalhos, acionar agentes, acompanhar resultados e
procurar o humano quando uma decisão ou informação é necessária.
_Avoid_: motor durável, plataforma definitiva

**Instância**:
Orquestrador local em execução com sua configuração própria, como trabalho ou
pessoal. Limites, estado e comandos não são compartilhados entre instâncias.
_Avoid_: ambiente, perfil

**Roteamento**:
Associação de uma issue a exatamente um repositório de um projeto habilitado.
Roteamento ausente ou ambíguo impede a admissão e fica visível ao operador.
_Avoid_: inferir o repositório pelo título ou pelo tracker

**Trabalho**:
Atendimento acompanhado de uma issue admitida, incluindo desenvolvimento,
intervenções humanas e acompanhamento do PR até seu desfecho.
_Avoid_: ticket como execução, invocação do agente como trabalho inteiro

**Invocação**:
Uma execução do agente principal para desenvolver ou dar continuidade a um trabalho.
Seu encerramento não implica a conclusão do trabalho.
_Avoid_: turn como invocação, invocação encerrada como trabalho concluído

**Claim**:
Indicação de que uma issue está reservada para atendimento por alguém ou algum trabalho.
Não se confunde com atribuição a uma pessoa nem com capacidade de execução.
_Avoid_: assignee como claim, claim como vaga

**Issue elegível**:
Issue roteada a um projeto habilitado, pronta para agente, sem claim e sem
bloqueios ou dependências pendentes, que também satisfaz as regras específicas
do seu tracker.
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
Informação nova dirigida ao trabalho por uma pessoa, falha de check relevante
do PR ou conflito do PR com a branch de destino, capaz de motivar resposta ou
correção. Na issue, só conta o que a pessoa endereça explicitamente ao agente;
no PR, todo comentário humano é dirigido ao trabalho.
_Avoid_: qualquer comentário da issue como comando, relato do próprio agente como feedback,
conflito como impedimento, conflito desconhecido como ausência de conflito

**Triagem de feedback do PR**:
Escolha, pelo operador, de quais comentários humanos do PR o trabalho vai tratar
e como. É um pedido de ajuda: o que não for escolhido não é tratado nem perguntado
de novo. Checks e conflitos não passam por ela.
_Avoid_: agente decidindo sozinho quais comentários atender, triagem como aprovação de escopo novo

**Retomada manual**:
Continuidade de um trabalho solicitada explicitamente pelo operador a partir
da sessão anterior e da área preservada.
_Avoid_: recuperação automática, nova implementação para contornar uma falha

**Conclusão**:
Reconhecimento do merge externo do PR vinculado e confirmação do trabalho como
done no tracker.
_Avoid_: PR aberto como conclusão, sucesso declarado pelo agente como merge
