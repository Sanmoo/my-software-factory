# My Software Factory

Desenvolvimento local supervisionado de trabalhos vindos de issue trackers.
Este arquivo define a linguagem do projeto. As decisões duradouras ficam nos
[ADRs](docs/adr/) e as regras atuais na [documentação operacional](docs/operacao/).

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
Configuração do agente do operador (autenticação, pacotes, skills, extensões, agents e as
ferramentas que ele declara no mise) que um trabalho reproduz ao rodar fora do host.
Delimitado pelas origens permitidas e por itens obrigatórios: sem um obrigatório, o
trabalho não é admitido. Os pacotes e as ferramentas convergem uma vez, num diretório
persistente por perfil sob o `--home`; o retrato do perfil carrega o lock e a declaração
de mise de onde eles vêm (ADR 0004).
_Avoid_: instância, ambiente, perfil global do operador como sinônimo

**Roteamento**:
Associação de uma issue a exatamente um repositório de um projeto habilitado.
Roteamento ausente ou ambíguo impede a admissão e fica visível ao operador.
_Avoid_: inferir o repositório pelo título ou pelo tracker

**Admissão**:
Decisão de tomar uma issue elegível como trabalho acompanhado. Ser elegível não
significa ter sido admitida; o trabalho é o atendimento que passa a ser acompanhado.
_Avoid_: elegibilidade como admissão, invocação como admissão

**Trabalho**:
Atendimento acompanhado de uma issue admitida, incluindo desenvolvimento ou
assistência ao humano, intervenções humanas e acompanhamento do PR quando houver.
_Avoid_: ticket como execução, invocação do agente como trabalho inteiro

**Acompanhamento do PR**:
Seguimento do PR vinculado ao trabalho: observa CI e review, recebe feedback e
conflitos que podem pedir correção ou ajuda e confirma o merge externo. O trabalho
só é concluído quando o tracker confirma a issue em done por releitura.
_Avoid_: PR pronto como trabalho concluído, merge feito pela factory

**Trabalho humano assistido**:
Atendimento conduzido pelo humano com apoio interativo do agente, voltado à
triagem, ao esclarecimento ou ao apoio ao trabalho humano, e não à implementação
autônoma. Seu fim não implica o encerramento da issue.
_Avoid_: implementação autônoma com pedido de ajuda, sessão encerrada como issue concluída

**Atendimento concluído**:
Resultado alcançado por um trabalho humano assistido, como uma triagem resolvida
ou uma issue esclarecida. Não implica que a issue esteja concluída.
_Avoid_: issue concluída, processo encerrado como atendimento concluído

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
invocação: remove a marca de claim da factory, sem levar a issue a done nem fechar
o PR; no trabalho humano assistido, encerra também a autorização de atendimento.
Só vale quando a releitura confirma essas remoções; status da issue e atribuições
de outras pessoas ficam como estão.
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
Issue roteada a um projeto habilitado, autorizada para seu fluxo de atendimento,
sem claim e sem bloqueios ou dependências pendentes, que também satisfaz as
regras específicas do seu tracker.
_Avoid_: label como garantia de contexto completo, campos Jira como regra universal

**Vaga**:
Capacidade para um agente principal trabalhar ativamente em implementação
autônoma; espera externa por CI, review do PR ou resposta humana não a ocupa.
_Avoid_: reserva até o merge, limite de subagentes ou de iterações

**Sessão assistida**:
Interação aberta entre o humano e o agente para conduzir um trabalho humano
assistido. Permanece aberta enquanto aguarda o humano; seu encerramento não
significa atendimento concluído.
_Avoid_: vaga de execução autônoma, atendimento concluído como sessão encerrada

**Arquivo de ambiente da execução assistida**:
Arquivo `KEY=VALUE` privado (0600, em diretório 0700) no diretório de estado de
uma execução assistida: é por ele que a credencial da **conta do projeto do
trabalho** chega ao container, que a recebe por `--env-file` — só o caminho entra
no comando digitado na aba, e o valor nunca aparece na aba, no `ps` nem em log. O
arquivo sai quando a existência do container prova que o cliente docker já o leu;
sem token da conta, a abertura é recusada, sem fallback
(src/core/assist-flow.ts; ticket #76; ADR 0005).
_Avoid_: `-e GH_TOKEN=<valor>` no `docker run`, credencial ambiente do host como
fallback, arquivo deixado como credencial em repouso

**Pedido de ajuda**:
Solicitação do agente que precisa de informação ou decisão humana, ou chegou ao
limite de iterações, sem declarar o trabalho concluído.
_Avoid_: falha silenciosa, processo indefinidamente esperando uma pessoa

**Ponto de atenção**:
Item persistente, consultável localmente, que registra uma ação humana necessária
a um trabalho específico; não depende da entrega de notificação nem de log
passageiro, sobrevive a reinício da instância e encerra-se quando resolvido pelo
operador ou por liberação do trabalho.
_Avoid_: notificação (que é a entrega), pedido de ajuda (que é do agente),
log passageiro

**Atenção do operador**:
Chamado da sessão da instância ao operador local: sessão aberta, decisão
necessária, intervenção ou pedido de ajuda, combinando notificação desktop
quando disponível com o registro que fica na instância. Falha ou ausência de
canal não interrompe o trabalho nem elimina o registro
(src/core/attention.ts; especificação #48, item 5).
_Avoid_: notificação presumida antes do canal executado, linha passageira de log
como chamamento

**Pendência**:
Registro do que ainda precisa do operador, consultável nos comandos locais e
persistente entre ciclos e reinícios: falha de entrega nunca o elimina, e a
mudança de estado do trabalho é o que o encerra
(src/core/attention.ts; consultável em `status`, arquivos em `pendencias/`).
_Avoid_: notificação entregue como pendência encerrada, pergunta repetida a cada ciclo

**Aprovação (atendimento)**:
Autorização explícita do operador, por comando local, para registrar o resultado
proposto de um atendimento humano assistido e executar as ações aprovadas, cada
uma confirmada por releitura; nada é escrito no tracker antes dela
(comando `approve`; especificação #48, item 4).
_Avoid_: fim da sessão como aprovação, aprovação implícita pela inação

**Retomada agendada de uso único**:
A forma PERSISTIDA da retomada autorizada: a autorização fica gravada no registro
da sessão e é tentada antes de novos atendimentos; uma nova interrupção exige nova
decisão, e esperar capacidade ou reprovar pré-verificação não a consome
(src/core/assist-flow.ts; especificação #48, item 5).
_Avoid_: preservação de sessão como autorização, autorização reutilizável,
retomada manual como agendamento

**Reconciliação**:
Ao reiniciar uma instância, decisão sobre cada identidade de trabalho
persistida contra a execução real no container — o nome do container gravado na
sessão, nunca só PID, presença da pane ou texto de terminal — antes de qualquer
nova admissão; execução desconhecida mantém a capacidade reservada e pede
intervenção (src/core/assist-flow.ts `reconcile`; especificação #48, item 5).
_Avoid_: recuperação como reexecução do agente, encerramento inferido da saída do processo

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
até uma retomada manual, uma retomada autorizada de trabalho humano assistido
ou uma liberação; não é reexecutado sem autorização.
_Avoid_: pedido de ajuda, intervenção necessária, falha como conclusão

**Retomada manual**:
Continuidade de um trabalho solicitada EXPLICITAMENTE pelo operador, a partir da
sessão anterior e da área preservada, nos DOIS fluxos (autônomo e humano
assistido): o comando local, ou a tecla `t` no atendimento assistido, vale para a
tentativa daquele momento e não autoriza nenhuma abertura futura
(src/core/assist-flow.ts `resume`; src/core/operator-actions.ts `retomar`).
_Avoid_: recuperação automática, pedido de agora como autorização permanente,
nova implementação para contornar uma falha

**Retomada autorizada**:
Autorização explícita do operador, dada na resposta afirmativa à pergunta de
continuidade de um trabalho humano assistido interrompido, para UMA próxima
abertura desta mesma sessão, tentada antes de novos atendimentos: é de uso único e
distinta do pedido manual, que vale só para o momento em que é feito. Preservar a
sessão não autoriza, por si só, sua retomada (spec #48, item 5; #57).
_Avoid_: replay automático, sessão preservada como autorização, pedido manual como
autorização permanente

**Conclusão**:
Reconhecimento do merge externo do PR vinculado a um trabalho de implementação
autônoma e confirmação desse trabalho como done no tracker.
_Avoid_: PR aberto como conclusão, sucesso declarado pelo agente como merge
