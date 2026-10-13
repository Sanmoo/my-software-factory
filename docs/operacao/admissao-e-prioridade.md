# Admissão e prioridade

Regras atuais de descoberta, admissão, claim, capacidade e prioridade do orquestrador.
Linguagem: [GLOSSARY](../../GLOSSARY.md). Representações concretas dos trackers:
[trackers](trackers.md). Execução e supervisão: [execução e supervisão](execucao-e-supervisao.md).

O comportamento vive no código (`src/core/eligibility.ts`, `src/core/admission.ts`,
`src/core/priority.ts`) e nos testes. Esta página descreve o que está implementado; uma
mudança de regra exige mudança de código, testes e esta página, nesta ordem.

## Descoberta e elegibilidade

A elegibilidade é cumulativa: toda regra precisa passar, e cada regra que falha é
informada. **Metadado desconhecido nunca é lido como ausência nem como false** — a issue
não é admitida e o motivo fica visível no status.

Regras do núcleo, para qualquer tracker:

- projeto habilitado na instância;
- label de prontidão presente (nome configurável por projeto);
- issue **não claimed**;
- **sem bloqueios nem dependências pendentes**;
- issue **não terminal** (não done);
- issue ainda **não acompanhada** pelo script.

Regras adicionais do Jira, sobrepostas às do núcleo:

- issue na **sprint atual** (não se aplica ao GitHub Issues);
- issue **atribuída ao operador**.

Somente bloqueador/dependência **não terminal** impede a admissão; link para issue já
terminal não bloqueia. Se o estado do bloqueador não puder ser lido, a issue não é
admitida. Uma relação em que a issue **bloqueia** outra não significa que ela seja
bloqueada.

### Roteamento

Cada issue é roteada a exatamente um repositório de um projeto habilitado:

- **GitHub Issues:** o escopo é o próprio repositório.
- **Jira:** a chave do projeto mais **uma** label de roteamento configurada. Issue
  `ready-for-agent` sem label de roteamento, ou com mais de uma, não é admitida e aparece
  no status como "sem roteamento"/"roteamento ambíguo".

O repositório **nunca** é inferido do título nem do tracker.

### Claim e assignee não são a mesma coisa

`claimed` é a representação do tracker, não o mesmo que estar atribuída a uma pessoa:

- **Jira:** a issue pode estar atribuída ao operador e ainda assim não estar claimed.
  Claimed é a label `agent-claimed` ou uma categoria de status diferente de *To Do*.
- **GitHub Issues:** qualquer assignee **ou** a label `agent-claimed` conta como claimed.

O claim feito pela factory deixa uma **marca própria** na issue (ver
[trackers](trackers.md)); a issue pode continuar claimed depois que essa marca sai. Não
tomar um claim alheio.

## Admissão e confirmação

Sequência de uma admissão:

1. reler a elegibilidade imediatamente antes de iniciar;
2. reservar capacidade local;
3. persistir o trabalho;
4. solicitar o claim ao tracker;
5. **confirmar por releitura** que o claim e o estado *doing* estão visíveis;
6. só então disparar o runner.

Se o início não for confirmado pelo tracker, o Pi **não** é iniciado presumindo sucesso.
Erro de escrita no claim é seguido de releitura: claim presente com origem não comprovada
não inicia o trabalho, e nada registrado volta a ser tentado no próximo polling.

Polling repetido não pode duplicar um trabalho. A identidade inclui tracker, projeto ou
repositório e ID da issue, o que evita colisão entre fornecedores. Espera não transforma
uma issue acompanhada em candidato novo; um claim não ocupa vaga. `release` é o único
caminho que devolve a issue à elegibilidade, e a factory não o faz sozinha.

## Capacidade e prioridade

- `maxConcurrent` (N) limita **agentes principais ativos**, não subagentes nem chamadas de
  ferramenta. A capacidade é reservada antes do disparo, de forma síncrona com a reserva,
  para inícios paralelos não ultrapassarem o limite.
- No máximo **uma implementação ativa por repositório**, em áreas Git separadas por
  trabalho.
- **Espera externa** por CI, review do PR ou humano **libera a vaga**, mantendo issue,
  área, sessão e PR acompanhados. A espera não encerra o acompanhamento nem o claim.
- **Retomadas e correções têm prioridade** sobre tarefas novas e respeitam os mesmos
  limites.
- Entre tarefas novas, vale a prioridade do tracker quando disponível e um desempate
  estável. A ausência de prioridade no GitHub não elimina o candidato.

Ranking de prioridade: menor número = mais urgente. A configuração pode mapear nomes de
prioridade do Jira em inteiros (`priorityRanks`); sem o campo, vale a tabela padrão do
adapter. Prioridade ausente fica no nível padrão; prioridade **desconhecida** (nome que o
mapa não lista) nunca é lida como ausente: ela ordena depois de todas as conhecidas, mas
o candidato continua.

N não promete um teto global para processos filhos ou chamadas ao modelo gerados pelo
harness. A pausa (`pause`) impede **novas admissões**; não encerra trabalhos ativos e não
interrompe o acompanhamento de PRs em espera.

## Manutenção do claim

O claim é mantido até a conclusão ou a liberação explícita pelo operador, inclusive
durante espera ou interrupção. **Não há reclaim automático por timeout**: perder a
execução não equivale a liberar a reserva. A decisão e o motivo estão no
[ADR 0003](../adr/0003-claim-mantido-ate-conclusao-ou-liberacao.md); esta regra não deve
ser revertida por uma suposta "recuperação automática".

`release` remove a marca de claim da factory e encerra o acompanhamento, preservando área,
sessão e PR. Ele **não** move a issue para done nem fecha o PR, e só vale quando a
releitura mostra a marca ausente; enquanto isso, o trabalho mantém o estado.

## Pendências de verificação

A regra histórica de que **retirar autorização ou introduzir impedimento bloqueia a
próxima invocação** de um trabalho já admitido tem aderência integral não comprovada: a
releitura antes de uma retomada confere claim e estado terminal, mas não reconfere label
de prontidão nem bloqueios. A intenção e a incerteza estão registradas numa issue separada
vinculada à limpeza documental; não trate a rechecagem como comportamento comprovado.
