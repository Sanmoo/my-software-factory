# Trackers

Como a factory representa claim, bloqueios, dependências e transições em cada tracker, e
como lê o feedback. Linguagem: [GLOSSARY](../../GLOSSARY.md). Admissão e prioridade:
[admissão e prioridade](admissao-e-prioridade.md).

O núcleo depende de uma **porta normalizada** (`src/tracker/port.ts`) e de dados
normalizados, não de SDK, JQL, sprint, status ou labels particulares de um fornecedor. Jira
e GitHub Issues são adapters (`src/tracker/jira.ts`, `src/tracker/github.ts`); a
configuração declara a representação concreta de cada um. Um campo **não consultado** nunca
conta como ausência de impedimento: metadado desconhecido rejeita a admissão.

O adapter só **escreve** (informa o que fez). Quem decide o desfecho é o núcleo, que lê
antes, pede a escrita, **relê** e compara os snapshots. A decisão está no
[ADR 0001](../adr/0001-confirmacao-por-releitura-no-nucleo.md).

## Roteamento

Cada issue pertence a exatamente um repositório de um projeto habilitado; a regra e o
efeito na admissão estão em [admissão e prioridade](admissao-e-prioridade.md). Uma
instância pode misturar trackers: o roteador envia cada chamada ao adapter do escopo da
issue e **nunca** cai para outro tracker quando o escopo não está configurado.

## Representações concretas

| Conceito | Jira Cloud | GitHub Issues |
| --- | --- | --- |
| Pronta para agente | label configurável (padrão `ready-for-agent`) | label configurável (padrão `ready-for-agent`) |
| Claimed | label `agent-claimed` **ou** categoria de status diferente de *To Do* | qualquer assignee **ou** label `agent-claimed` |
| Claim pela factory | adiciona `agent-claimed` e transiciona para doing | adiciona `agent-claimed` e atribui a conta do projeto |
| Doing | transição configurada (padrão "Em andamento") | não existe; o claim registra o início |
| Terminal/done | categoria de status *Done*; transição para done configurada | issue fechada como *completed* |
| Bloqueio | link "is blocked by" dos tipos configurados, para issue não terminal | dependência nativa `blocked_by` aberta |
| Sprint atual | `sprint in openSprints()`, sem board configurado | não se aplica |

No Jira, estados são mapeados por **categoria** de status, nunca por nome; apenas os nomes
das transições para doing e done são configurados por projeto. Uma transição indisponível
recusa o claim. Fechar o GitHub como `not planned` **não** é done: o status fica
desconhecido e a elegibilidade rejeita.

A **marca de claim da factory** é exposta normalizada pela porta:

- Jira: a label `agent-claimed` (a issue pode seguir claimed por status ou por outra
  pessoa depois que a label sai).
- GitHub: a label `agent-claimed` e a conta atribuída.

`release` remove só essa marca. A liberação só é confirmada quando a releitura não mostra
nenhuma parte dela; status da issue e atribuições de outras pessoas ficam como estão.

## Feedback

`src/core/operator-input.ts` coleta as respostas dirigidas da issue e aplica os comandos
locais: a resposta no terminal e `agent:` na issue passam pelo mesmo `receiveFeedback`.
O acompanhamento de feedback do PR pertence a `src/core/pr-tracking.ts`.

Tudo o que a factory/agente publica leva um **marcador invisível** (GitHub:
`<!-- msf:agent -->`; Jira: prefixo fixo `[msf]`). Comentário com marcador **nunca** é
feedback. Isso importa porque o agente publica com as credenciais do operador.

Fontes de feedback consideradas:

- **Issues (Jira e GitHub):** só comentário humano **sem marcador** iniciado por `agent:`
  é resposta dirigida ao trabalho; os demais são conversa entre pessoas.
- **PR:** qualquer review/comentário novo sem marcador e de autor que não seja bot é
  feedback humano (conversa, inline e corpo de review). A resposta local via terminal
  produz o mesmo efeito, sem depender de comentário externo.
- **Checks do PR:** checks *required* da proteção da branch de destino com falha ou, sem
  required, quaisquer checks com falha. Estado ou obrigatoriedade desconhecidos tornam o
  caso indecidível, não aprovado.
- **Conflito do PR** com a branch de destino.

Um comentário editado depois é um evento novo: a identidade do feedback inclui id e
revisão. Eventos consumidos são registrados para não repetir. A resposta dirigida
`agent:` é lida só em trabalhos que ainda aceitam entrada do tracker; trabalho done,
liberado ou que exige intervenção não consome comentário da issue.

Consumir feedback não é declará-lo resolvido nem transformá-lo em permissão para novo
escopo, merge ou deploy produtivo. Quando a factory não consegue decidir pela regra, ela
procura o humano.

## Credenciais e identidade

- **Jira:** só por variáveis de ambiente `JIRA_URL`, `JIRA_USERNAME` e `JIRA_API_TOKEN`,
  exigidas apenas ao iniciar (`run`) uma instância com projeto Jira. Nenhum arquivo da
  factory guarda o token.
- **GitHub:** o token da conta do projeto é obtido do keyring (`gh auth token --user
  <conta>`) e injetado apenas no processo/container do trabalho; a conta ativa do `gh` não
  muda. O `config.json` referencia credenciais por nome, nunca pelo valor.

## Pendências conhecidas

- A transição de done do projeto Jira **CON** ainda não foi confirmada; o piloto a valida.
  Para VAN, a transição confirmada é `Itens concluídos`.
- A credencial Jira é lida das variáveis de ambiente fixas; o nome em
  `credentials.<nome>.ref` é validado, mas não escolhe a variável. Suficiente para uma
  conta Jira.
