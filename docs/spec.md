# My Software Factory — spec do MVP

**Estado:** aprovada para derivar tickets. Requisitos (§3) e decisões técnicas (§4)
estão confirmados; tickets vivem nas GitHub Issues de `Sanmoo/my-software-factory`.
Linguagem: [GLOSSARY](../GLOSSARY.md). Histórico e provas: [design](design.md).

## 1. Objetivo

Um script TypeScript local, usando Sandcastle e Pi, que conduz trabalhos de
engenharia em projetos pessoais e corporativos neste laptop: descobre issues,
admite trabalho com concorrência limitada, implementa, pede ajuda quando
necessário e acompanha PR até merge externo e atualização do tracker.

O ganho pretendido é retirar ações manuais recorrentes do operador, mantendo
supervisão por terminal. Não é a plataforma definitiva com microVMs nem herda
suas exigências estritas de segurança, auditoria, governança ou durabilidade.
Segundo o operador, os fluxos corporativos manuais já são permitidos; a spec
não é uma verificação independente de política corporativa.

## 2. Recorte e exclusões

**MVP inclui desde a primeira entrega:** Jira **e** GitHub Issues, runtime
**Docker**, múltiplos projetos/repositórios configurados em instâncias
independentes (trabalho e pessoal), limite N por instância,
Pi + subagentes e `/implement`, ajuda/resposta, retomada manual e acompanhamento
do ciclo de PR. Não retirar um tracker ou substituir Docker silenciosamente
para diminuir o escopo.

Ficam fora: microVM, motor durável, scheduler distribuído, operação remota,
recuperação/replay automático de implementação, nova TUI ou painel web,
steering ao vivo, trilha de auditoria formal, merge pelo agente e deploy em produção.
Não se promete isolamento de segurança reforçado, proteção contra exfiltração
ou restauração transparente de toda árvore de subagentes.

O limite de investimento acordado — uma ou duas sessões de configuração e uma
tarefa real para demonstrar ganho — é critério de corte, não estimativa comprovada
para todo esse escopo. Adaptação extensa volta ao operador, não vira novo motor.

## 3. Requisitos

### R01 — Projetos e configuração

Operar somente projetos/repositórios habilitados pelo operador. Cada **instância**
(ex.: trabalho, pessoal) é um orquestrador independente, com configuração,
estado, N, fila de comandos e pause próprios; as duas podem rodar ao mesmo
tempo, e cada projeto pertence a exatamente uma instância. Todos os alvos do
§7 são configurados desde a primeira entrega.

Cada projeto associa um escopo de tracker a **exatamente um** repositório:
no GitHub Issues, o próprio repositório das issues; no Jira, a chave do projeto
mais uma label de roteamento. Também declara adapter, branch de destino,
integração de PR, workflow do tracker, perfil Docker/Pi e a conta GitHub usada.
Issue com `ready-for-agent` num projeto Jira configurado mas sem label de
roteamento, ou com mais de uma, não é admitida e aparece no status como
"sem roteamento"/"roteamento ambíguo"; o repositório nunca é inferido do título.

Modelos são explícitos por provider/model e configurados por instância e por
papel agêntico: `implementer` (agente principal), `reviewer-standards`,
`reviewer-spec` e um `default` obrigatório para outros subagentes criados por
`/implement`, registrado no log a cada uso. Não inferir provider pela coincidência
do model ID nem aplicar fallback silencioso. A autenticação do modelo pertence
à instância; não há fallback entre auth corporativa e pessoal. Só a invocação
do Pi e seus subagentes são agênticas: o orquestrador decide por regras.

N, máximo de iterações e intervalos de polling são configuráveis. Credenciais
são referências a autenticação autorizada, não valores versionados. O token da
conta GitHub do projeto é obtido do keyring (`gh auth token --user <conta>`) e
injetado só no processo/container do trabalho, sem trocar a conta ativa do `gh`.
Configuração inválida ou capacidades necessárias indisponíveis são visíveis ao operador.

### R02 — Porta de issue tracker

O núcleo depende de uma porta e de dados normalizados, não de SDK, JQL, sprint,
status ou labels particulares de um fornecedor. Jira e GitHub Issues são adapters.
A porta precisa permitir descobrir candidatos; reler contexto/elegibilidade;
observar e registrar claim/início; obter feedback com identidade; e confirmar done.

A configuração deve declarar a representação concreta de claim, bloqueios,
dependências e transições de cada adapter. `claimed` não é sinônimo de assignee:
no Jira, a issue deve estar atribuída ao operador e ainda assim não claimed.
Não considerar um campo não consultado como ausência de impedimento.

Representações concretas:

| Conceito | Jira Cloud | GitHub Issues |
| --- | --- | --- |
| Pronta para agente | label `ready-for-agent` (nome configurável) | label `ready-for-agent` (nome configurável) |
| Claimed | label `agent-claimed` ou categoria de status diferente de *To Do* | qualquer assignee ou label `agent-claimed` |
| Claim pela factory | adiciona `agent-claimed` e transiciona para doing | adiciona `agent-claimed` e atribui a conta do projeto |
| Doing | transição configurada (padrão "Em andamento") | não existe; o claim registra o início |
| Terminal/done | categoria de status *Done*; transição para done configurada | issue fechada como *completed* |
| Bloqueio | link "is blocked by" (tipos configuráveis) para issue não terminal | dependência nativa `blocked_by` aberta |
| Sprint atual | `sprint in openSprints()`, sem board configurado | não se aplica |

Estados Jira são mapeados por **categoria** de status, não por nome; apenas os
nomes das transições para doing e done são configurados por projeto.

### R03 — Elegibilidade nos dois trackers

Exigir cumulativamente: projeto habilitado, `ready-for-agent`, **não claimed**,
**sem bloqueios e sem dependências**. Tarefa já concluída/terminal ou já acompanhada
pelo script não é um novo candidato. Desconhecimento desses critérios não conta
como true; o candidato não é admitido e a razão fica visível.

No **Jira**, exigir também sprint atual e atribuição ao operador. No **GitHub
Issues**, não adicionar requisito de sprint ou assignee que não foi solicitado.
Relação em que a issue bloqueia outra não significa, por si só, que ela é bloqueada.

Só bloqueador/dependência **não terminal** impede admissão; link para issue já
terminal não bloqueia. Se o estado do bloqueador não puder ser lido, a issue
não é admitida (CA04). A representação efetiva precisa ser verificável no
adapter configurado.

### R04 — Admissão e claim

Reler elegibilidade antes de iniciar. Reservar capacidade local, registrar o
trabalho/claim e mover para doing antes de disparar desenvolvimento local.
Se esse início não for confirmado pelo tracker, não iniciar Pi presumindo sucesso.

Repetir polling não pode duplicar um trabalho. Identidade inclui tracker, projeto
ou repositório e ID da issue, evitando colisões entre fornecedores. Espera não
transforma uma issue acompanhada em candidato novo; claim não ocupa uma vaga.
O script não assume poder tomar um claim de outra pessoa/execução.

### R05 — Concorrência e prioridade

N limita agentes principais ativos, não tool calls ou subagentes. Reservar
capacidade antes do disparo impede ultrapassar o limite durante inícios paralelos.
Inicialmente, permitir uma implementação ativa por repositório, em áreas Git
separadas por trabalho. Espera externa por CI, review do PR ou humano libera a
vaga, mantendo issue, área, sessão e PR acompanhados. Revisão interna e filhos
ativos fazem parte da invocação em desenvolvimento até seu encerramento.

Retomadas/correções têm prioridade sobre tarefas novas e respeitam os mesmos
limites. Entre novas tarefas, usar prioridade do tracker quando disponível e
um desempate estável; a ausência de prioridade no GitHub não elimina o candidato.
Validar primeiro N=1 e depois N=2. N não promete um teto global para processos
filhos ou chamadas ao modelo geradas pelo harness.

### R06 — Docker e ambiente de desenvolvimento

Docker é o runtime do MVP. `noSandbox()` foi autorização para os primeiros
experimentos, não runtime operacional alternativo automático. Falha de Docker
ou do perfil não autoriza execução no host.

O container deve fornecer ferramentas do projeto, Pi, pi-subagents, skills,
extensões e autenticação configuradas. Preservar fora de sua camada descartável
as alterações Git, sessão principal e referências/artefatos necessários à
continuidade. Descartar/recriar container não pode apagar um trabalho aberto.

Não pressupor que perfil, credenciais, extensões ou caminhos do host funcionam
num container Linux. Essa compatibilidade é uma prova ainda necessária. Não
alterar o perfil global do operador como efeito colateral de setup.

### R07 — Desenvolvimento com Pi

Invocar a skill `/implement` instalada, fornecendo contexto da issue/spec,
repositório/branch autorizados, perfil, regras do projeto, base de review e
insumos já aprovados. O agente decide se possui informação suficiente;
`ready-for-agent` expressa intenção do criador, não garante suficiência.

Pode editar, instalar dependências, executar comandos/testes, criar commits,
fazer push e abrir/atualizar PR. Deploy não produtivo é permitido dentro do
trabalho autorizado; **deploy em produção não é permitido**. A autorização
geral de autonomia não inclui merge: esse ponto foi restringido explicitamente.
Não acionar produção por uma ação própria só por ela estar embutida num script.

Usar TDD nas seams previamente acordadas e review em Standards e Spec conforme
as skills. Se uma aprovação/informação exigida estiver ausente, pedir ajuda,
sem inventar resposta humana. Reviewers recebem base, diff exato, spec e padrões;
resultado sem acesso ao material necessário não é review aprovado. O review ocorre dentro da
invocação do `/implement` e a factory não o verifica (ver P06).

### R08 — Resultado e limite de iterações

O agente informa resultado estruturado: pedido de ajuda com pergunta/contexto;
PR pronto para acompanhamento com referência; ou interrupção/falha com motivo.
Logs livres não substituem esse contrato. Saída ausente, inválida ou ambígua
não é sucesso. Sinal presente no prompt/stdout bruto não comprova entrega.
Um resultado "PR pronto" só é aceito depois de a factory confirmar no adapter
de PR que ele existe, está aberto, tem como base a branch de destino e como head
a branch do trabalho; caso contrário é resultado inválido. O vínculo issue ↔ PR
é o registrado pela factory no trabalho, não texto do PR.

Máximo inicial confirmado: **5 iterações Sandcastle por invocação nova**,
facilmente alterável. Retomadas e correções são invocações de 1 iteração; não há
contador acumulado por trabalho.
Cada uma é uma invocação completa do Pi, não um turn/tool call; normalmente uma
basta. Ajuda e entrega pronta encerram antes do máximo. Atingir o limite sem
resultado válido gera pedido de intervenção, não execução ilimitada.

O adapter de execução respeita restrições da biblioteca: com resumeSession,
Sandcastle 0.12.0 exige uma iteração; sua API output também exige uma iteração.
Não combinar opções incompatíveis nem substituir o limite por contador interno
sem decisão explícita. Expor o limite efetivo; retomada sem desfecho válido
volta ao operador. Antes de liberar trabalho ativo, reconciliar o fim do parent
com os filhos relevantes; `agent_end` isolado não prova que terminou tudo.

### R09 — Ajuda e supervisão

Pedido de ajuda termina a invocação ativa, preserva área/sessão e libera vaga.
Só esse trabalho fica bloqueado; o script pode admitir outros. Mostrar a
pergunta no terminal/log e em status, sem exigir serviço remoto de notificação.

CLI mínima, sempre dirigida a uma instância: `status`, `logs <trabalho>`,
`reply <trabalho>`, `resume <trabalho>`, `pause`, `unpause` e `release <trabalho>`.
Reply transmite resposta dirigida; resume solicita continuidade sem informação
nova; pause impede novas admissões e não encerra trabalhos já ativos; unpause
volta a admitir. Release remove o claim e encerra o acompanhamento, preservando
área, sessão e PR; não move a issue para done nem fecha o PR. Os nomes vistos
como `runner` são exemplos, não nome de ferramenta obrigatório.

O operador acompanha por tail de logs. Feedback recebido enquanto um agente
está ativo fica pendente para a próxima invocação; não há steering ao vivo no MVP.

### R10 — Feedback Jira, PR e terminal

Tudo o que a factory/agente publica leva um marcador invisível (GitHub:
`<!-- msf:agent -->`; Jira: prefixo fixo `[msf]`); comentário com marcador nunca
é feedback. Isso é necessário porque o agente publica com as credenciais do operador.

Nas issues (Jira e GitHub), só comentário humano sem marcador iniciado por
`agent:` é resposta dirigida ao trabalho; os demais são conversa entre pessoas.
No PR, qualquer review/comentário novo sem marcador e de autor que não seja bot
é feedback humano, e checks *required* da proteção da branch de destino com
falha (ou, sem required, quaisquer checks com falha) podem disparar correção.
A resposta local via terminal produz o mesmo efeito de uma resposta dirigida,
sem depender de comentário externo para destravar a tarefa.

Registrar identidade/revisão do feedback consumido para não repetir eventos nem
reagir aos relatos do próprio agente. Não transformar comentários em permissão
para novo escopo, merge ou deploy produtivo. Consumir feedback não é declarar
que foi resolvido. Quando não se puder decidir a ação, procurar o humano.

### R11 — PR e conclusão

Depois de publicar PR, acompanhar CI, review e merge pela integração do
repositório configurado, sem manter Pi continuamente vivo para esperar. Novas
correções reativam o mesmo trabalho com vaga quando disponível.

**O agente/script não faz merge.** Após confirmação externa do merge do PR
vinculado na branch de destino, mover a issue para done. PR aberto, CI verde,
fechamento sem merge ou afirmação do modelo não bastam. Done só é confirmado
quando o tracker reconhece a atualização ou já está no estado esperado.

Não escolher fornecedor de PR com base no tracker: issue Jira não define onde
vive seu repositório. O MVP tem um único adapter de PR, para **github.com**;
outros fornecedores (inclusive GitHub Enterprise Server) ficam fora.

### R12 — Falhas e retomada manual

Não repetir implementação automaticamente após falha ambígua ou queda.
Preservar issue, claim, área/branch, commits, PR, modelo/perfil, sessão, pergunta,
feedback pendente/consumido e motivo de interrupção. O usuário local pode
solicitar continuidade da sessão Pi anterior, como “retome de onde parou”.

PR fechado sem merge interrompe aquele trabalho, avisa o humano e mantém card
fora de done. Não reabrir PR nem começar outra implementação sozinho. Reabrir
a sessão principal não retoma automaticamente todos os filhos: verificar seus
estados/resultados e pedir ajuda quando a continuidade não puder ser determinada.
Recuperação manual não exige reconstrução integral de processos após crash.

## 4. Decisões técnicas do MVP

As escolhas seguintes completam o desenho mínimo e foram aprovadas; não são
exigências de uma plataforma durável:

- **P01:** uma instância coordenadora local por configuração (§R01); estado simples por
  trabalho e uma fila de comandos locais. JSON em disco com gravação substitutiva
  é candidato, não imposição de banco/event sourcing ou promessa de fsync/replay.
  Deduplicação local não constitui lock distribuído contra outros operadores.
- **P02:** manter claim até conclusão ou encerramento/liberação explícita pelo
  operador, inclusive em espera/interrupção. Não criar auto-reclaim por timeout.
  Antes de repetir update após erro, consultar o estado externo; leituras podem
  voltar no próximo polling, sem inferir sucesso de uma escrita ambígua.
- **P03:** sem sessão/área/perfil necessário, resume retorna ajuda visível e preserva
  artefatos; não inicia conversa nova automaticamente. Não permitir duas instâncias
  do mesmo agente principal num trabalho ao acionar resume.
- **P04:** se a elegibilidade mudar após admissão, preservar o trabalho e avisar;
  mudanças que retiram autorização ou introduzem impedimento bloqueiam a próxima
  invocação até decisão. Fim de sprint não mata processo automaticamente.
- **P05:** normalizar prioridades por configuração; sem prioridade explícita,
  usar nível padrão e desempate por identidade estável. Nenhuma política de
  deadline, preempção ou fairness sofisticada é exigida.

- **P06:** o review dos dois eixos é parte do `/implement`, na mesma invocação: não é estado da
  factory nem evidência exigida no resultado. O prompt entrega base, diff exato, issue como spec e
  padrões do repositório e diz que "PR pronto" exige os dois reviews aprovados. A factory confirma
  o PR (R08), o modelo explícito por subagente e a reconciliação dos filhos; a CA09 é demonstrada
  por log e sessão no piloto, não por bloqueio. Substitui a checagem de digests do ticket #6.

Esquema de dados e detalhes de API dos adapters (além das representações de R02)
devem ser especificados nos tickets a partir das capacidades observadas dos projetos
configurados, sem remover requisito nem assumir ausência de um campo não lido.
Os tickets são publicados nas GitHub Issues de `Sanmoo/my-software-factory`
(ver `docs/agents/issue-tracker.md`); a redação desta spec não cria tickets.

## 5. Critérios de aceite para derivar tickets

| ID | Demonstração verificável | Requisitos |
| --- | --- | --- |
| CA01 | Duas instâncias (trabalho e pessoal) carregam todos os alvos do §7, com Jira e GitHub Issues e vários repositórios por instância; núcleo usa a mesma porta, sem exigir campos Jira no GitHub. | R01, R02 |
| CA02 | Jira só admite ready-for-agent, unclaimed, sem bloqueios/dependências, sprint atual e assignee operador; cada filtro negativo impede início. | R03 |
| CA03 | GitHub só admite projeto habilitado, ready-for-agent, unclaimed e sem bloqueios/dependências; não exige sprint/assignee Jira. | R03 |
| CA04 | Metadata de impedimento/claim desconhecida e issues terminais não são presumidas elegíveis. | R02, R03 |
| CA05 | Polling repetido não duplica trabalho; tracker confirma início/doing antes de Pi; outro claim não é tomado. | R04 |
| CA06 | N nunca é excedido nos agentes principais; no início há uma implementação ativa por repo; esperas liberam vaga sem readmissão da issue. | R05 |
| CA07 | Retomada/correção tem prioridade e respeita limites, inclusive com outra tarefa ativa no mesmo repo. | R05 |
| CA08 | Docker inicia Pi e filhos com o perfil autorizado; falha não aciona noSandbox; área/sessão sobrevivem ao ciclo do container. | R06 |
| CA09 | /implement recebe contexto/base, executa testes e review dos dois eixos com diff explícito; revisão inconclusiva não vira aprovação. | R07 |
| CA10 | Ajuda/maxIterations/resultado inválido interrompem atividade, preservam sessão/área e ficam visíveis sem bloquear outras tarefas. | R08, R09 |
| CA11 | Reply no terminal e comentário `agent:` no Jira ou GitHub reativam o trabalho; comentários sem `agent:` ou com marcador da factory não; feedback ativo fica pendente; eventos consumidos não se repetem. | R09, R10 |
| CA12 | Falha CI/feedback humano novo provoca correção com vaga; relatos próprios não geram loop. | R10, R11 |
| CA13 | Merge externo confirmado leva a done; PR apenas aberto/fechado sem merge não leva; nenhuma chamada de merge parte da factory. | R11 |
| CA14 | Após interrupção, resume explícito continua o mesmo trabalho/sessão; sem continuidade disponível volta à ajuda, não a novo trabalho silencioso. | R12, P03 |
| CA15 | Operador acompanha logs/status e pode pausar novas admissões; agentes não executam deploy produtivo nem alteram perfil global como setup. | R06, R07, R09 |
| CA16 | Piloto usa os dois trackers e Docker, com todos os alvos configurados, primeiro N=1 e depois N=2, com ao menos uma tarefa real autorizada para medir ganho/limitações. | R01, R05, R06 |
| CA17 | Issue Jira `ready-for-agent` sem label de roteamento ou com duas aparece no status e não é admitida; com uma, vai ao repositório mapeado. | R01, R03 |
| CA18 | Cada papel agêntico usa o provider/model e a auth da sua instância; `default` aparece no log; papel sem configuração ou auth ausente é erro visível, sem fallback; conta ativa do `gh` não muda. | R01, R06 |
| CA19 | Resultado "PR pronto" com PR inexistente, fechado ou com base/head divergentes é inválido; `release` remove o claim sem done. | R08, R09 |

Os exemplos concretos e seams de teste devem acompanhar os tickets, sobretudo
para que /implement não precise buscar aprovação rotineira que já possa constar
da spec do trabalho. Decisão ausente continua sendo pergunta, não aprovação.

## 6. Estratégia de validação e limites de evidência

1. Testes determinísticos do núcleo/contratos com adapters de teste: filtros,
   identidade/deduplicação, vagas, prioridade, resultados e feedback.
2. Conformidade dos dois adapters reais: paginação/contexto, representação de
   claim/dependências, transições e IDs de comentários, usando alvo autorizado.
3. Prova Docker: repetir skill, filho async, ajuda e retomada com sessão/área
   persistentes, modelo barato **github-copilot/gpt-6-luna**, incluindo reviewers.
4. Fluxo ponta a ponta nos dois trackers, com PR/CI/review e merge humano externo;
   registrar setup, intervenção economizada, falhas e mudanças necessárias.

As [provas 003](results/003-copilot-luna.md) e
[004](results/004-implement-help.md) validam caminhos noSandbox com Pi 1.1.0,
pi-subagents 0.77.0 e Sandcastle 0.12.0. **Não validam Docker**, trackers, N ou PR
real. O teste 004 passou operacionalmente, mas não certificou TDD vertical estrita
e precisou corrigir handoff de review. Esses limites não são escondidos pelo smoke.

Credenciais/configuração corporativa e transcrições brutas não são versionadas.
A validação necessária não é uma bateria de segurança/auditoria do projeto
definitivo. Se Docker, um dos trackers ou a composição excederem o envelope
simples acordado, devolver o trade-off ao operador antes de mudar o MVP.

## 7. Alvos configurados

Todos github.com. Labels de roteamento valem dentro do projeto Jira indicado.

**Instância pessoal** (conta `Sanmoo`, tracker GitHub Issues do próprio repo):
`Sanmoo/my-tasks`, `Sanmoo/my-software-factory`, `Sanmoo/my-finances`,
`Sanmoo/lorebase-frontend`, `Sanmoo/lorebase-backend`.

**Instância trabalho** (conta `samuel-santos_bjd`):

| Tracker | Escopo | Repositório |
| --- | --- | --- |
| GitHub Issues | repo | `samuel-santos_bjd/dora-metrics` |
| Jira VAN | label `monolith` | `bancojohndeere/revolving-credit-monolith-backend` |
| Jira VAN | label `dealer-services` | `bancojohndeere/revolving-credit-dealer-services` |
| Jira VAN | label `mfe` | `bancojohndeere/revolving-credit-mfe` |
| Jira VAN | label `fdm` | `bancojohndeere/revolving-credit-fiscal-document-management` |
| Jira VAN | label `common-infra` | `bancojohndeere/revolving-credit-products-common-infra` |
| Jira VAN | label `lambda-auth` | `bancojohndeere/revolving-credit-multi-issuer-lambda-authorizer` |
| Jira VAN | label `playbooks` | `bancojohndeere/revolving-credit-playbooks` |
| Jira CON | label `monolith` | `bancojohndeere/consorcio-monolith-backend` |
| Jira CON | label `mfe` | `bancojohndeere/consorcio-mfe` |
| Jira CON | label `playbooks` | `bancojohndeere/consorcio-playbooks` |

Jira: `https://bancojohndeere.atlassian.net` (Cloud). O nome da transição para
done é confirmado no teste de conformidade do adapter.
