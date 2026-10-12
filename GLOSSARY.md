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

**Perfil de runtime**:
Configuração do agente do operador (autenticação, pacotes, skills, extensões e agents)
que um trabalho reproduz ao rodar fora do host. Delimitado pelas origens permitidas e
por itens obrigatórios: sem um obrigatório, o trabalho não é admitido.
_Avoid_: instância, ambiente, perfil global do operador como sinônimo

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
O claim feito pela factory deixa na issue uma marca própria; a issue pode
continuar claimed depois que essa marca sai.
_Avoid_: assignee como claim, claim como vaga, todo claim como marca da factory

**Liberação**:
Encerramento, pelo operador, do acompanhamento de um trabalho que não está em
invocação: remove a marca de claim da factory, sem levar a issue a done nem
fechar o PR. Só vale quando a releitura do tracker não mostra mais essa marca;
status da issue e atribuições de outras pessoas ficam como estão.
_Avoid_: liberação como fim de todo claim, liberação como volta à elegibilidade, liberação de vaga

**Confirmação por releitura**:
Reconhecimento de uma alteração na issue só quando a leitura do tracker depois da
escrita a mostra e a leitura de antes não a mostrava. Sem a leitura de antes, a
alteração fica apenas tentada. Vale igual para as escritas da factory e do agente.
_Avoid_: gradação, graduação, confirmação sozinho, escrita aceita como confirmada

**Escrita direta do agente**:
Alteração que o agente faz sozinho na issue do seu trabalho, reconhecida pela
chamada de ferramenta e confirmada só por releitura. Em outra issue ou outro
repositório, é relatada sem confirmação.
_Avoid_: chamada de ferramenta como alteração feita, relato do agente como confirmação

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

**Item de feedback**:
Unidade de feedback acionável que guarda seu tipo e sua origem: comentário humano
do PR, resposta dirigida, falha de check ou conflito do PR. A origem acompanha o
item até a invocação que o trata; nunca é reconhecida pelo texto.
_Avoid_: resposta como sinônimo de qualquer item, reconhecer a origem pelo texto

**Triagem de feedback do PR**:
Escolha, pelo operador, de quais comentários humanos do PR o trabalho vai tratar
e como. É um pedido de ajuda: o que não for escolhido não é tratado nem perguntado
de novo. Checks, conflitos e respostas dirigidas do mesmo lote não passam por ela:
ficam como itens retidos. Só termina com a resposta do operador; uma invocação
que para antes dela não conclui a triagem.
_Avoid_: agente decidindo sozinho quais comentários atender, triagem como aprovação de escopo novo

**Item retido**:
Item de feedback do lote de uma triagem que não é comentário do PR: falha de
check, conflito ou resposta dirigida. Espera a escolha do operador e é tratado
na mesma invocação que aplica essa escolha; enquanto a triagem não termina,
continua retido.
_Avoid_: retido como descartado, feedback acionável como só checks e conflitos

**Log principal**:
Fluxo contínuo de uma instância em que o operador acompanha transições de
trabalhos, falhas e ações humanas necessárias, com comandos que pode copiar.
_Avoid_: console, log do runtime, histórico local como sinônimo

**Log detalhado**:
Fluxo de uma única invocação, próximo da experiência interativa do agente:
mensagens públicas, chamadas de ferramentas e seus resultados.
_Avoid_: log principal, log do runtime como sinônimo

**Log do filho**:
Registro de um subagente (filho) lançado pelo agente principal, com o que o
principal observou dele: lançamento, atualizações recebidas e desfecho. Não
contém a atividade interna do filho, que o principal não observa.
_Avoid_: log detalhado, log do subagente como atividade completa

**Trabalho interrompido**:
Trabalho cuja invocação parou sem desfecho válido, seja por queda do
orquestrador, falha na execução ou parada declarada pelo agente. Fica parado
até uma retomada manual ou uma liberação; nunca é reexecutado automaticamente.
_Avoid_: pedido de ajuda, intervenção necessária, falha como conclusão

**Retomada manual**:
Continuidade de um trabalho solicitada explicitamente pelo operador a partir
da sessão anterior e da área preservada.
_Avoid_: recuperação automática, nova implementação para contornar uma falha

**Conclusão**:
Reconhecimento do merge externo do PR vinculado e confirmação do trabalho como
done no tracker.
_Avoid_: PR aberto como conclusão, sucesso declarado pelo agente como merge
