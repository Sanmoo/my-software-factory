# Viabilidade — Claim exclusivo entre fábricas pelo Jira Cloud

## Conclusão

**Não demonstrado.** As operações documentadas do Jira Cloud não sustentam,
sozinhas, um protocolo que garanta que no máximo uma fábrica execute um Worker
por Ticket sob aquisição simultânea.

O único candidato que chega perto é **C2 — atualização condicional de uma issue
property em lote**: `PUT /rest/api/3/issue/properties/{propertyKey}` com
`filter: { entityIds: [<issue id>], hasProperty: false }`, gravando um registro
de Claim com a identidade da fábrica. Ele é **condicionalmente suficiente** sob
estas premissas:

- **P-CAS** (a premissa de atomicidade do teste e da escrita) — o teste de elegibilidade (`hasProperty: false`) e a escrita são
  **um único passo indivisível** em relação a jobs concorrentes no mesmo
  Ticket: no máximo um job observa a propriedade ausente e grava; os demais
  observam a propriedade presente e não gravam. **A Atlassian não documenta
  isso.**
- **P-READ** — um `GET` direto da propriedade, depois que a task de aquisição
  está `COMPLETE`, reflete a escrita (ou a ausência dela). **Não documentado.**
  Necessário para **progresso** (resolver resposta perdida e distinguir
  aquisição de “nenhum Ticket elegível”), **não** para segurança.
- **P-PARTICIPANTS** — todas as fábricas que disputam o conjunto executam o
  protocolo, com `factory id` único por instalação; Claims alheios válidos não
  são sobrescritos; a liberação manual respeita a condição de parada.
- **P-RELEASE** — a liberação/transferência manual só ocorre depois de o
  operador parar e confirmar o fim do Worker anterior; a instalação liberada não
  volta a executar aquele Work.

Sem **P-CAS**, a documentação admite a interleaving em que os dois jobs leem
o estado anterior, ambos gravam (last write wins, exatamente a advertência
oficial de concorrência em entity properties) e cada fábrica relê o **próprio**
registro antes da escrita da outra: **dois Workers autorizados**. O harness
enumera 3.432 interleavings sob as semânticas documentadas e encontra 200
delas com dois vencedores; a testemunha está na seção 7.

Sem **P-READ**, a segurança se mantém, mas o progresso se perde: leituras
desatualizadas deixam a aquisição **incerta** — o protocolo não lança, e 924/924
interleavings terminam sem vencedor no modelo de leitura em prefixo.

Os demais candidatos são **inadequados mesmo com leituras frescas**:

- a escrita simples da property (`PUT .../{propertyKey}`) e a lista em lote
  (`POST /issue/properties`) são escritas cegas: as duas fábricas gravam e cada
  uma relê o próprio valor;
- atribuição, edição comum e transição de workflow não são compare-and-set: não
  há condição documentada sobre o valor do Claim, e o `409 “conflicting update”`
  do edit/transition não é um CAS;
- labels e comentários não têm unicidade, dono nem ordenação documentada.

**Isto é um resultado inconclusivo para produção, não uma autorização.** O
protocolo escolhido, as premissas que faltam confirmar e os pré-requisitos não
aprovados voltam ao operador. A tarefa de implementação (`needs-info`) permanece sem
autorização de implementação; o requisito não foi enfraquecido para “melhor
esforço”, lease, expiração, particionamento prévio ou alocação manual.

## 1. Objeto, escopo e método

A pergunta é estreita: **somente Jira Cloud**, sem serviço de coordenação
externo, sem banco ou filesystem compartilhado, sem lease, sem expiração e sem
supervisão remota de saúde. Duas fábricas com máquinas, workspaces e
configurações independentes observam o mesmo Ticket livre e tentam adquirir.
Quer-se saber se o tracker permite que **no máximo uma** receba autoridade
exclusiva confirmada — e não apenas que ambas “marcaram” o Ticket.

O caminho coberto vai da **disputa** à **autorização**: a leitura que alimenta a
descoberta do pool, a escrita condicional, a conclusão assíncrona, a prova do
vencedor, os resultados incertos e a relação com a Acting account. A
investigação é independente da implementação da orquestração Jira em produção e
não depende da investigação do GitHub; nenhuma conclusão daquele provider foi
importada.

Método:

1. **Fontes primárias** — a documentação oficial do Jira Cloud REST API v3 e o
   OpenAPI publicado (`1001.0.0-SNAPSHOT-12ca6ec...`), consultados em
   2026-10-24. Nenhuma garantia do Jira Data Center/Server foi importada: a API
   e a semântica de propriedades são de outra edição.
2. **Candidatos mínimos** — protocolos expressos nas operações documentadas:
   property simples, property condicional em lote, lista em lote, atribuição,
   edição comum, transição, label e comentário.
3. **Argumento de segurança** — premissas de atomicidade, ordenação e
   consistência, com prova sob elas e contraexemplo quando faltam.
4. **Demonstração reproduzível** — um harness determinístico com duas instâncias
   sem estado local compartilhado, Workers observáveis e coordenação somente
   pelo tracker. O simulador concede apenas o que as fontes permitem; o momento
   de avaliação da elegibilidade, o isolamento entre jobs e o conteúdo do
   resultado da task são **knobs explícitos**, não presentes.

O que **não** foi feito: nenhuma mutação em um Jira real, nenhum experimento de
corrida contra a API do Jira Cloud, nenhuma alteração de produção. Um experimento
real de corrida exigiria autorização, um site/fixture próprio e cleanup; ele
seria evidência **complementar**, nunca substituto das garantias necessárias.
Investigar não autoriza mutar Tickets operacionais.

## 2. Fontes primárias e o que elas estabelecem

### 2.1 A superfície de propriedades

Issues do Jira Cloud têm um key/value store por issue
([Entity properties](https://developer.atlassian.com/cloud/jira/platform/jira-entity-properties/)):

> “Entity properties can be modified by all users that have permission to edit
> the entity. […] Entity properties can be modified by all apps in the system
> and exist in a global namespace.”

> “Entity properties are not sandboxed on a per-user basis. This means that the
> same entity property can be edited by two users. **There is no mechanism to
> handle concurrent edits by users to the one property. A property contains the
> data that was most recently saved.**”

Limites documentados: chave de até 255 bytes, valor de até 32.768 bytes. Não há
dono, autoria observável, versão, `ETag` ou revisão.

### 2.2 A atualização condicional em lote (o candidato)

[`PUT /rest/api/3/issue/properties/{propertyKey}`](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-properties/#api-rest-api-3-issue-properties-propertykey-put)
documenta um filtro de elegibilidade:

> “The filter identifies issues eligible for update using these criteria:
> `entityIds` Only issues from this list are eligible. `currentValue` Only issues
> with the property set to this value are eligible. `hasProperty`: If `true`,
> only issues with the property are eligible. If `false`, only issues without
> the property are eligible.”

> “If more than one criteria is specified, they are joined with the logical
> **AND**: only issues that satisfy all criteria are eligible.”

E a operação é:

> “**transactional**, either all eligible issues are updated or, when errors
> occur, none are updated.”

> “**asynchronous**. Follow the `location` link in the response to determine the
> status of the task and use `Get task` to obtain subsequent updates.”

O endpoint documenta somente `303`, `400` e `401`. O `409` “another bulk update
on the same issues is already in progress. Retry the request later.” aparece nos
dois endpoints **POST** em lote (`/issue/properties` e `/issue/properties/multi`),
mas **não** neste `PUT` condicional.

### 2.3 As operações que não são condicionais

- **Escrita simples** — `PUT /rest/api/3/issue/{issueIdOrKey}/properties/{propertyKey}`:
  grava e devolve `200` (atualizado) ou `201` (criado). Nenhuma pré-condição,
  nenhum `If-Match`, nenhuma unicidade.
- **Lista em lote** — `POST /rest/api/3/issue/properties`: até 10 propriedades e
  10.000 issues; transacional em caso de erro; **sem filtro**. O `409` só diz
  “retry later”, não é um CAS sobre o valor.
- **Multi em lote** — `POST /rest/api/3/issue/properties/multi`: explicitamente
  **não transacional** (“Updating some entities may fail”).
- **Atribuição** — `PUT /rest/api/3/issue/{issueIdOrKey}/assignee`: escrita cega
  de um campo; a conta pode ser compartilhada, e a documentação não dá
  unicidade nem identidade de instância.
- **Edição comum** — `PUT /rest/api/3/issue/{issueIdOrKey}`: “Issue properties
  may be updated as part of the edit”. O `409` documentado é “the issue could
  not be updated due to a conflicting update” — sem condição, versão ou valor.
- **Transição** — `POST /rest/api/3/issue/{issueIdOrKey}/transitions`: o mesmo
  `409` genérico; nenhuma condição ligada ao Claim; usar status como lock
  exigiria mudança de workflow (pré-requisito não aprovado) e não seria CAS.
- **Label/comentário** — labels acumulam (conjunto, sem dono); comentários não
  têm ordenação de aplicação documentada (o `id` não é documentado como
  atribuído na ordem das escritas concorrentes) e a criação é cega.
- **Varredura do OpenAPI** — nenhuma operação declara `If-Match`,
  `If-None-Match`, `ETag` ou parâmetro de versão; o único parâmetro de header do
  documento é `Atlassian-Transfer-Id`. Um header não declarado não é garantia.

### 2.4 Documentação, inferência e experimento

| Afirmação | Status |
| --- | --- |
| Critérios `entityIds`/`currentValue`/`hasProperty`, combinados com AND | **documentação** |
| Transação tudo-ou-nada **em caso de erro** | **documentação** |
| `303` + `Location`, task assíncrona; resultado específico da operação | **documentação** |
| “asynchronous tasks are not guaranteed to be run in order” | **documentação** |
| Propriedades: sem mecanismo para edições concorrentes; “most recently saved” vence | **documentação** |
| Sem `If-Match`/`ETag` em nenhuma operação v3 | **documentação** (varredura do OpenAPI) |
| Busca JQL pode omitir atualizações recentes | **documentação** |
| O filtro é avaliado no **apply** (e não no enqueue) | **inferência** — uma das duas leituras compatíveis; a documentação não escolhe |
| O filtro é fixado no **enqueue** | **inferência** — a outra leitura compatível; o harness explora as duas |
| Jobs concorrentes sobre a mesma issue são isolados/serializados | **inferência** (o `409` dos POSTs sugere, mas não é contrato do PUT nem CAS) |
| O resultado da task diz quantas/ quais issues foram atualizadas | **não documentado** — o resultado é “specific to the operation”, e a operação não o descreve |
| `GET` direto da property é read-after-write consistente | **não documentado** |
| P-CAS (teste + escrita indivisíveis) | **não documentado** — premissa indispensável |
| Dois jobs concorrentes podem ambos atualizar sob as semânticas documentadas | **experimento no simulador**, consistente com a documentação; não é experimento contra o Jira |
| Um experimento real de corrida no Jira Cloud | **não executado** (sem autorização/fixture) |

### 2.5 Escopo: Jira Cloud, não outra edição

Todas as citações acima são da documentação **Jira Cloud** v3. Nada foi inferido
da documentação Data Center/Server, onde a API de propriedades e o
comportamento de concorrência podem diferir. “Jira Cloud” aqui é o produto cuja
base URL é o site `*.atlassian.net`; a identidade do Ticket inclui o site.

## 3. Candidatos mínimos tracker-only

| # | Candidato | Por que não garante exclusividade |
| --- | --- | --- |
| C1 | `PUT` simples da property + releitura | Escrita cega, last write wins. A e B gravam; A relê antes da escrita de B e lança; B relê depois e lança. **2 Workers no harness.** |
| C2 | `PUT /issue/properties/{key}` com `hasProperty:false` + `entityIds` | O filtro **parece** um CAS, mas a documentação não fixa quando é avaliado nem isola jobs concorrentes. Sob P-CAS funciona; sem ela, os dois gravam. **Candidato condicional.** |
| C3 | `POST /issue/properties` (lista, transacional) | A transação protege o conjunto contra erros, não contra um job concorrente que grava a mesma issue. Sem filtro: escrita cega. **2 Workers.** |
| C4 | Atribuição (`PUT assignee`) + releitura | Campo único, escrita cega; a conta pode ser compartilhada (as duas leem “eu”). Não identifica instância. **2 Workers.** |
| C5 | Edição comum (`PUT /issue`) com label/campo por fábrica | Labels acumulam; a edição é cega; o `409` é “conflicting update”, não uma condição sobre o Claim. **2 Workers.** |
| C6 | Transição de workflow | Sem condição sobre o valor do Claim; exige mudança de workflow; o `409` genérico não elege vencedor. **2 Workers** no modelo; pré-requisito não aprovado. |
| C7 | Comentário com menor `id` | A criação é cega e a ordem dos `id` concorrentes não é documentada; a listagem pode omitir um comentário já aplicado. Não há ordem do provedor que eleja um vencedor; não foi modelado porque a documentação não oferece a base. |
| C8 | Lease/expiração/quiescência (esperar e reler) | Troca exclusividade por melhor esforço e reintroduz o problema: uma sobrescrita posterior pode ocorrer depois da última leitura. Rejeitado pelo requisito. |

C2 é o único candidato que **poderia** satisfazer o requisito, e apenas sob
P-CAS. Não foi encontrado candidato melhor “só com o documentado”: todas as
demais mutações são escritas cegas, e nenhuma operação documentada é um
`create-if-absent` ou test-and-set.

## 4. C2 em detalhe: avaliação, isolamento e prova

### 4.1 Transação não é exclusividade do teste e da escrita

“Transactional, either all eligible issues are updated or, when errors occur,
none are updated” descreve **atomicidade em caso de erro**: o conjunto elegível
é atualizado por inteiro ou não é. Não descreve **isolamento** entre dois jobs
concorrentes, nem diz que a leitura da elegibilidade e a escrita são um único
passo. Duas transações podem, sob leitura não serializável, ambas ler
“propriedade ausente” e ambas gravar; a última vence. Isso é exatamente o que a
advertência de entity properties permite (“most recently saved” vence) e o que o
harness reproduz com dois jobs não isolados.

### 4.2 Quando a elegibilidade é avaliada

A documentação não responde. Duas leituras são compatíveis com o texto:

- **no enqueue** — o conjunto elegível é fixado quando o `303` é devolvido;
- **no apply** — o job relê a propriedade quando executa.

As duas importam. Sob o modelo documentado (sem isolamento), um snapshot no
enqueue produz **520/3.432** interleavings com dois vencedores; mesmo
**concedendo** escritas serializadas (P-CAS), um snapshot no enqueue ainda
produz **60/924**: os dois jobs foram aprovados antes de qualquer escrita e
gravam em sequência. Um `409` que rejeitasse “outro bulk update em andamento”
não resolveria sozinho esse caso, e o `PUT` condicional sequer documenta `409`.

### 4.3 Distinguir aquisição efetiva de “nenhum Ticket elegível”

O `303` só diz que a task foi agendada. A task `COMPLETE` só diz que o job
terminou; o conteúdo do `result` é “specific to the operation”, e a operação de
property não o descreve. Portanto, **com a documentação, a resposta não
distingue**:

- “meu job atualizou o Ticket” de “meu job não encontrou nenhum Ticket
  elegível”; e, pior, **não distingue** “eu sou o único vencedor” de “eu sou um
  dos dois vencedores”.

A releitura do valor só prova que o valor **atual** é o meu (ou é o de outro).
Sem P-CAS, dois jobs podem ambos gravar; cada fábrica relê o próprio valor
antes da sobrescrita da outra, e ambas se autorizam. A tarefa de “provar o
vencedor” precisa da atomicidade, não de uma leitura posterior.

Duas falhas são distinguíveis pela documentação, mas por motivos diferentes:
uma conexão que **nunca chegou a agendar** o job não pode ter escrito nada; e
uma task `FAILED` é a transação documentada como “none are updated”. Em ambas é
seguro tratar como **não adquirido** e tentar de novo, sem consumir Attempt. O
caso perigoso é a escrita aplicada com resposta perdida: ele não é nenhum dos
dois, e por isso só pode ser **incerto**.

### 4.4 Ordem assíncrona

“Asynchronous tasks are not guaranteed to be run in order” é documentado. O
protocolo não pode usar ordem de submissão nem de conclusão como desempate: o
job de B pode executar antes do de A. A decisão precisa vir do teste condicional
no momento da escrita. O harness explora a inversão (A submete primeiro, B
aplica primeiro) e, sob P-CAS, B vence com um único Worker.

### 4.5 O critério `currentValue`

`currentValue` é o outro critério de elegibilidade documentado. A aquisição usa
`hasProperty:false`; `currentValue` serve a uma atualização condicionada ao valor
observado (por exemplo, uma transferência ou renovação de Claim). Ele sofre da
**mesma indeterminação**: a documentação não diz quando o valor é comparado nem
isola o teste da escrita, e a advertência de concorrência em entity properties
continua valendo. Duas transferências condicionadas ao mesmo valor observado
podem ambas passar e gravar em sequência; o harness tem
`current-value-transfer-documented` (dois jobs aplicados, o Claim final é o da
segunda) e `current-value-transfer-cas` (só um job aplicado). Portanto
`currentValue` **não** é um primitivo mais forte que `hasProperty:false` e não
resolve P-CAS; ele herda exatamente a mesma lacuna.

## 5. Protocolo ponta a ponta (C2)

### 5.1 Identidades

Terminologia: `Claim` e `Padlock` são os termos do `GLOSSARY.md`. Aqui o
**Padlock** é o valor da property que autoriza (a marca), e a **apresentação**
é a atribuição à Acting account e o label que completam o Claim. "Claim
parcial" e "Claims anteriores" são os termos da spec; o `GLOSSARY`
não é alterado porque este protocolo ainda não foi adotado.

- **Ticket identity** — `jira:<site>:<stableId>` (provider + site + id imutável
  da issue). A chave legível (`OPS-1`) é apresentação: repete-se entre sites e
  pode mudar; nunca entra na identidade nem no registro do Claim. Sub-issues têm
  ids distintos e são Tickets distintos.
- **Factory id** — identidade da instalação, configurada pelo operador, estável
  entre reinícios e **única entre instalações concorrentes**. Não é a Acting
  account.
- **Acting account** — autentica as escritas e recebe a atribuição. Pode ser a
  mesma conta em todas as fábricas (a v0.1 usa uma conta de operador). A API da
  property **não expõe o autor** da escrita; a conta não identifica a instância.
  O `factory id` no valor é a identidade, sob P-PARTICIPANTS.
- **Nonce** — correlaciona a aquisição e a resposta perdida; não é lease, não
  expira e **não** é a autoridade. Um valor com o meu `factory id` e outro
  nonce continua sendo meu Claim.
- **Valor gravado** (JSON, chave namespaced `com.sanmoo.msf.claim`):

```json
{
  "protocol": "msf-jira-claim/v1",
  "factory": "<factory-id>",
  "nonce": "<correlação>",
  "ticket": "jira:<site>:<stableId>",
  "account": "<acting account id>",
  "destination": "github:<site>:<repo>",
  "createdAt": "<ISO-8601>"
}
```

`account`, `destination` e `createdAt` são **auditoria**: o Destination não pode
tornar o Claim invisível a uma fábrica com outro Destination, e o tempo nunca é
expiração. `destination` é gravado para o log, não para decidir.

### 5.2 Operações de uma aquisição

1. **Observação** — ler a property diretamente (ou vir do JQL do pool, que pode
   estar desatualizado) e a issue.
   - registro válido meu → já tenho o Claim (verificar e, se preciso, recuperar);
   - registro válido de outra fábrica → **indisponível**; não escrever, não
     limpar;
   - valor presente e ilegível (protocolo desconhecido, campo faltando, Ticket
     errado) → **incerto**; não escrever, não limpar;
   - property ausente mas com marca legada (label `agent-claimed` ou atribuição
     à Acting account) → **indisponível/incerto** (Claim anterior; não promover,
     não limpar);
   - nada → **livre** (observação, nunca autoridade).
2. **Escrita condicional** — um `PUT` com `entityIds: [issueId]`,
   `hasProperty: false` e o valor acima. Aceitar o `303` + `Location`. Um `201`
   de property simples não é usado (não é condicional).
3. **Conclusão assíncrona** — acompanhar a task até `COMPLETE`/`FAILED`. Se
   `FAILED`, a transação documenta que nada foi atualizado → **não adquirido**.
   Se `COMPLETE` e o resultado (quando existir) disser `updated: 0` → **sem
   Ticket elegível** (indisponível). Caso contrário, verificar.
4. **Verificação** — `GET` direto da property:
   - registro válido com o meu `factory id` → **autorizado**;
   - registro válido de outra fábrica → **indisponível**;
   - ausente → **incerto** (pode ser leitura desatualizada ou job não aplicado);
   - ilegível → **incerto**.
5. **Apresentação** — atribuir a Acting account e adicionar o label
   `agent-claimed`. Só depois disso o Claim está completo no vocabulário da
   fábrica.
6. **Lançamento** — somente com **autorizado** e apresentação completa. A
   Reservation local nasce antes do Worker; o Attempt é consumido no lançamento.

A ordem importa: **autoridade primeiro, apresentação depois**. Escrever a
apresentação antes da property criaria um “Claim parcial” (label/atribuição sem
autoridade) que todo participante corretamente trataria como indisponível,
travando o Ticket até ação manual. Se a apresentação falhar depois da property,
a fábrica **segura** (não lança, não consome Attempt) e repete a apresentação;
as outras fábricas já veem a property e ficam fora.

### 5.3 Prova do vencedor

O vencedor é observável por qualquer leitor: o valor atual da property é um
registro válido cujo `ticket` é a identidade do Ticket e cujo `factory` é a
instância autorizada. A prova é recomputável a partir do tracker — **desde que
P-CAS valha**. Sem P-CAS, o valor atual não prova que houve um único
escritor: o perdedor também pode ter gravado e relido o próprio valor antes da
sobrescrita.

### 5.4 Resultados incertos

São incertos: resposta perdida de qualquer escrita, task desconhecida (o `303`
se perdeu), leitura de verificação que falhou ou que não mostra o próprio
registro, Claim ilegível, Claim para outro Ticket e Claim parcial. Duas falhas
**não** são incertas: a conexão que nunca chegou a agendar (nada pôde ser
escrito) e a task `FAILED` (a transação documentada como “none are updated”)
são **não adquirido**. Em todos os casos incertos:

- **não lançar**;
- **não remover** um Claim que possa ser alheio;
- **não consumir Attempt**;
- manter a aquisição pendente e repetir a verificação numa varredura seguinte.

Uma leitura posterior **isolada** não é tratada como resolução da corrida: a
confirmação é a verificação do Claim que a própria fábrica já escreveu. Se o
próprio registro continua invisível, continua incerto. Não há retry cego de
escrita enquanto o resultado é incerto; sob P-CAS um reenvio com
`hasProperty:false` seria inofensivo, mas a regra conservadora é verificar.

Ausência de Reservation local **não** comprova abandono: outra instalação pode
ser a dona do Claim. O Claim continua “Unbacked” apenas como observação local;
o operador decide.

### 5.5 Claims anteriores, Recovery local e participantes

- **Claim anterior** — property de outra convenção, valor ilegível ou
  label/atribuição sem property → indisponível/incerto. O protocolo novo não o
  promove nem o apaga.
- **Recovery local** — a instalação original verifica o próprio Claim e relança
  a **mesma** Attempt (número preservado, nenhuma Attempt nova). Isso não dá
  autoridade a outra fábrica e não é takeover.
- **Morte, silêncio, passagem do tempo e perda de contato** — não alteram os
  fatos do tracker e não há lease/expiração/health check remoto. O Claim
  permanece; outra fábrica o respeita indefinidamente. O protocolo não tem canal
  para outra instalação e não pergunta pela saúde dela: uma dona inalcançável
  com Worker vivo continua dona, e uma dona morta também. O tempo não autoriza
  nada.
- **Participantes** — a garantia pressupõe que **todas** as fábricas que
  disputam o conjunto obedeçam ao protocolo e tenham `factory id` único.
  Instalações antigas que ignoram a property, edições manuais que violem a
  condição de parada e Workers hostis **não** estão cobertos. O harness mostra um
  não participante sobrescrevendo o Claim e rodando um segundo Worker: é a
  violação declarada da premissa, não uma falha do protocolo.

### 5.6 Liberação/transferência manual

Fora do protocolo e do código de aquisição. O operador **para e confirma** o fim
do Worker anterior; só então remove o Claim inteiro: property, atribuição e
label (`DELETE /issue/{issueIdOrKey}/properties/{propertyKey}` + edição dos
marcadores). O harness recusa a liberação enquanto observa um Worker vivo e sem
confirmação explícita. Uma edição no tracker **não** interrompe o Worker
remotamente: parar o Worker é uma ação separada do operador, e a liberação não a
substitui. Se o Claim for ilegível, a remoção é manual na UI — a ferramenta não
apaga o que não consegue ler.

### 5.7 Permissões, configuração e custos

- **Permissões** — *Browse projects* (ler a issue e a property) e *Edit issues*
  (gravar a property) no projeto de cada Ticket; *Assign issues* para a
  apresentação (atribuição). A API de *Bulk edit issues*
  (`POST /bulk/issues/fields`) exige a permissão global *Bulk change*; a
  documentação do endpoint de property lista apenas *Browse projects* e *Edit
  issues*. A conta pode ser compartilhada; o `factory id` é configuração, não
  login.
- **Configuração** — chave namespaced da property (≤255 bytes; valor ≤32 KB),
  `factory id` único por instalação, credencial da Acting account e o site Jira.
  Nada de workflow, campo customizado, app Forge/Connect ou automação.
- **Custo por aquisição** — observação (1 leitura da property) + 1 escrita
  condicional + polls da task + 1 leitura de verificação + 2 escritas de
  apresentação ≈ **5–6 requisições**. Em pontos: leituras e escritas custam 1
  ponto cada (≈6 pontos). Limites: 50 req/s para `PUT`, 100 req/s para `GET`/
  `POST` (burst por endpoint), quota horária por tenant; `429` com
  `Retry-After`. Fábricas que compartilham conta/tenant compartilham o orçamento;
  o protocolo não tem prioridade entre elas.
- **Auditoria** — o valor da property é o registro. A API não expõe autor nem
  histórico da property (não há changelog documentado para ela); a task é
  retida por 14 dias. Qualquer portador da conta com *Edit issues* pode
  sobrescrever a property: a garantia depende de participação, não de
  imutabilidade.
- **Custo de incerteza** — com leituras desatualizadas, um Ticket pode ficar
  parado em “incerto” até uma leitura confirmar; não há expiração nem takeover
  para destravar. O operador resolve.

### 5.8 Pré-requisitos não aprovados (decisão do operador)

Nada abaixo foi adotado; fica exposto para decisão:

1. **Garantia da Atlassian para P-CAS** (e, idealmente, para P-READ e para o
   conteúdo do resultado da task). É uma resposta de fornecedor/documentação,
   não uma configuração.
2. **App Forge/Connect ou serviço externo** que ofereça um CAS transacional.
   Introduz coordenação externa ao tracker-only e não está aprovado.
3. **Mudança de workflow** (status/validator como lock). Exige mudança de
   workflow, não é CAS por si, e conflita com a separação entre Claim e ciclo de
   vida do Ticket (ADR 0004).
4. **Regra de Jira Automation** — pré-requisito de plano/feature; a execução de
   regras é assíncrona e não tem atomicidade documentada; não é CAS.
5. **Lease, expiração, takeover, particionamento prévio ou alocação manual** —
   rejeitados pelo requisito; não substituem exclusividade.
6. **Experimento concorrente real no Jira Cloud** — exige autorização, site e
   fixtures próprios com cleanup; complementa, não substitui, as garantias.

## 6. Premissas e argumento de segurança

### 6.1 Premissas

- **P-CAS (não documentada, indispensável).** Para jobs concorrentes de
  atualização condicional na mesma issue, o teste de elegibilidade e a escrita
  são um passo indivisível: no máximo um job com `hasProperty:false` grava, e
  sua escrita é visível a qualquer teste de elegibilidade posterior. É um
  compare-and-set sobre a ausência da property.
- **P-READ (não documentada; só progresso).** Um `GET` direto da property após
  a task `COMPLETE` reflete a escrita (ou a ausência). Não é necessária para
  segurança; é necessária para resolver resposta perdida e para distinguir
  aquisição de “nenhum elegível”.
- **P-PARTICIPANTS.** Todas as fábricas que disputam o conjunto executam o
  protocolo; `factory id` único entre instalações concorrentes; nenhum
  participante sobrescreve um Claim válido alheio; a liberação manual só ocorre
  após parar e confirmar o Worker anterior.
- **P-RELEASE.** A instalação liberada não volta a executar aquele Work; seu
  Recovery local só vale para um Claim que ela ainda possui. Uma leitura
  desatualizada de um Claim já liberado não é autoridade.
- **P-IDENTITY.** A identidade é site + `stableId`; o valor nomeia o Ticket e a
  fábrica; a chave da property é reservada ao protocolo; valor ilegível é
  incerteza, nunca “livre”.

### 6.2 Prova sob P-CAS e P-PARTICIPANTS

Suponha duas fábricas distintas `f` e `g` que lançam. Lançar exige um resultado
“autorizado”: uma leitura devolveu um registro válido com o próprio `factory
id`. Sejam `R_f` e `R_g` esses registros. Uma property tem um único valor por
vez: a escrita substitui o anterior (“most recently saved”). Logo, no momento da
leitura de `f`, o valor era `R_f`; no de `g`, `R_g`. Como as fábricas são
distintas, `R_f ≠ R_g`; houve pelo menos uma escrita entre as duas leituras.
Seja `W_g` a escrita que tornou `R_g` o valor corrente. Para `W_g` ser aceita,
seu filtro `hasProperty:false` tinha de valer no momento do teste. Por
P-CAS, teste e escrita são o mesmo passo, então imediatamente antes de `W_g`
a property estava ausente. Mas, por P-PARTICIPANTS, nenhum participante
sobrescreve um Claim válido; e, por P-RELEASE, uma liberação manual no meio só
poderia ter ocorrido após o operador parar e confirmar o fim do Worker de `f`, o
que impediria o lançamento de `f`. Logo, imediatamente antes de `W_g` o valor
ainda era `R_f` (presente), contradizendo a ausência exigida. Portanto, no
máximo uma fábrica lança.

**Progresso** (P-CAS + P-READ): uma fábrica sozinha observa livre, submete; se
o filtro casar no momento da escrita, grava; a task completa; o `GET` direto vê
o próprio registro; ela apresenta e lança. Se o filtro não casar (outra escreveu
antes), o `GET` vê o registro alheio → indisponível; ou, com leitura
desatualizada, fica incerta e não lança. Assim, quando há escrita vencedora há
progresso; a incerteza só adia.

**Falhas e incerteza não abrem buraco na prova.** Falha antes da escrita
(conexão que não chegou a agendar) e task `FAILED` (transação documentada como
“none are updated”) são **não adquirido**, não autorização. Escrita aplicada com
resposta perdida, task desconhecida, conclusão assíncrona fora de ordem e leitura
de verificação falha ou ausente produzem **incerto**: nenhum desses caminhos
devolve um registro válido com o `factory id` da fábrica, e sem essa leitura não
há lançamento. Claim parcial: a autoridade é um único valor de property — uma
escrita por issue, atômica sob P-CAS —; a apresentação é separada e, se
falhar, a fábrica segura sem lançar e sem consumir Attempt.

**Fronteira da leitura desatualizada.** O único caminho em que uma leitura
desatualizada poderia reautorizar um Worker é um Claim **já liberado**: a
instalação antiga, retomada depois da liberação, leria um registro seu que não é
mais o atual. P-RELEASE fecha isso exigindo que a instalação liberada não seja
retomada com autoridade antiga: ao reiniciar, ela só retoma uma Attempt se
confirmar o Claim **atual**, e o operador não a reinicia antes da transferência.
O harness não simula essa retomada pós-liberação; é uma limitação declarada e
depende da condição de parada do operador, não de uma garantia da API.

### 6.3 Onde cada premissa é necessária

| Falta | O que acontece | Evidência no harness |
| --- | --- | --- |
| P-CAS | Dois jobs leem a ausência, ambos gravam; cada fábrica relê o próprio valor antes da sobrescrita e lança. | `documented-apply-not-isolated`: **200/3.432** com 2 Workers; testemunha na seção 7.2. |
| Avaliação no apply (em vez de enqueue) | Um snapshot no enqueue aprova os dois; mesmo **concedendo** escritas serializadas (P-CAS), as duas escritas em sequência acontecem. | `documented-enqueue-not-isolated`: **520/3.432**; `premise-enqueue-serialized`: **60/924** com 2 Workers. |
| P-READ | Segurança preservada; nenhuma verificação confirma o próprio registro; ninguém lança. | `cas-premise-prefix-reads`: **924/924 sem vencedor**. |
| P-PARTICIPANTS | Um não participante sobrescreve o Claim e roda um segundo Worker. | `non-participant-breaks-the-premise`: **2 Workers**. |
| P-RELEASE | Liberação sem fim confirmado, ou recuperação de Claim liberado, pode autorizar um Worker sobre o antigo. | `manual-release-needs-confirmed-end`: liberação **recusada** com Worker vivo e sem confirmação. |
| P-IDENTITY | Chaves de apresentação iguais entre sites colidiriam; o Claim de um Ticket bloquearia outro. | `two-sites-same-key-and-id`: **2 Workers**, Claims separados. |

### 6.4 Por que não há um candidato melhor “só com o documentado”

Todas as mutações de issue documentadas examinadas são **escritas cegas**: não
há `If-Match`, `ETag`, chave de idempotência, unicidade de label ou
`create-if-absent`. A única operação que aceita uma condição é C2, e a
documentação não garante que o teste e a escrita sejam atômicos. Uma decisão
tomada a partir de uma leitura pode ser superada por uma escrita posterior; uma
“quiescência” por tempo é lease/melhor esforço. Isso **não** prova a
impossibilidade de todo protocolo tracker-only no Jira Cloud; prova que, com as
operações documentadas examinadas, a garantia **não foi demonstrada**.

## 7. Demonstração reproduzível

### 7.1 O que o simulador concede — e o que não concede

O harness está em `experiments/jira-claim` (comandos no README). Duas `Factory`
independentes (estado local, `factory id` e Destination próprios, Acting account
compartilhada) disputam um Ticket; nenhum mapa de estado local é compartilhado
entre elas, o único meio de coordenação é o `JiraCloud` simulado, e os Workers
são handles observáveis (o runtime é o instrumento de observação, não um canal
de coordenação).

O modelo **não** tem lock, fila, lease, relógio de expiração nem oráculo de
vencedor. Ele tem knobs explícitos para o que a documentação **não** fixa:

- `eligibilityAt: "enqueue" | "apply"` — quando o filtro é avaliado;
- `isolation: "none" | "serialized"` — `serialized` **é a premissa P-CAS**,
  não um presente do simulador; `none` permite que dois jobs leiam o estado
  anterior e ambos gravem;
- `readModel: "fresh" | "prefix"` — leitura direta fresca ou que omite a última
  escrita;
- `searchStale` — a busca JQL pode omitir atualizações recentes (documentado);
- `taskResult: "undocumented" | "counts"` — o resultado da task é desconhecido
  ou, na variante mais forte, reporta a contagem atualizada.

A ordem de aplicação dos jobs é escolha da exploração, porque a documentação diz
que tasks assíncronas não são ordenadas.

### 7.2 Matriz exaustiva de interleavings

Para o candidato C2, a exploração enumera **todas** as extensões lineares dos
passos de duas fábricas: observação, submissão, leitura de elegibilidade,
commit, conclusão da task, verificação e lançamento. `serialized` reduz a cadeia
(leitura+escrita em um passo); `none` separa leitura e commit — o que permite a
ambos lerem o estado anterior.

As variantes `cas-premise*` e `premise-enqueue-serialized` são **premissas**:
`serialized` é P-CAS (teste + escrita indivisíveis); a variante de enqueue
concede P-CAS apenas para mostrar que o momento da avaliação, sozinho, já
quebra a exclusividade. Nas variantes `documented-*`, "documentado"
significa que nenhuma atomicidade foi concedida; o momento da avaliação é a
inferência em teste.

| variante | premissa | runs | 1 vencedor | 2 vencedores | 0 vencedor |
| --- | --- | ---: | ---: | ---: | ---: |
| `documented-apply-not-isolated` | documentado | 3.432 | 3.232 | **200** | 0 |
| `documented-enqueue-not-isolated` | documentado | 3.432 | 2.912 | **520** | 0 |
| `premise-enqueue-serialized` | P-CAS (enqueue) | 924 | 864 | **60** | 0 |
| `documented-apply-prefix-reads` | documentado | 3.432 | 1.200 | 0 | 2.232 |
| `documented-stale-search` | documentado | 3.432 | 3.232 | **200** | 0 |
| `cas-premise-stale-search` | P-CAS | 924 | 924 | 0 | 0 |
| `cas-premise` | P-CAS | 924 | 924 | 0 | 0 |
| `cas-premise-prefix-reads` | P-CAS | 924 | 0 | 0 | 924 |
| `cas-premise-task-counts` | P-CAS | 924 | 924 | 0 | 0 |

A leitura correta da tabela:

- **documentado, leituras frescas**: 200 interleavings com **dois** Workers.
  Testemunha (eventos):
  `A:observe A:submit A:begin B:observe B:submit B:begin A:commit A:complete A:verify A:launch B:commit B:complete B:verify B:launch`.
  A verifica e lança antes de B gravar; B grava e verifica o próprio valor
  depois; o valor final é de B e **os dois** Workers estão vivos. As requisições
  mostram dois `PUT bulk issue property` agendados e dois `bulk job -> applied`.
- **P-CAS concedido, enqueue**: 60/924 interleavings com dois Workers.
  Testemunha:
  `A:observe A:submit B:observe B:submit A:apply A:complete A:verify A:launch B:apply B:complete B:verify B:launch`.
  As escritas não se sobrepõem; o snapshot de elegibilidade do enqueue é que
  aprova os dois antes de qualquer escrita. Sem serialização, o mesmo cenário
  documentado produz 520/3.432.
- **documentado, leitura em prefixo**: 0 dois-vencedores, mas 2.232 sem
  vencedor. A leitura desatualizada **mascara** a corrida neste modelo; isso não
  é uma garantia, e o caso de leitura fresca acima é o contraexemplo decisivo.
- **P-CAS**: 0 dois-vencedores em todas as 924 interleavings, com progresso
  em 924. Com leitura em prefixo, a segurança continua e o progresso se perde
  (924 sem vencedor): só entra em jogo P-READ.
- **P-CAS + resultado com contagem**: não muda a segurança; a contagem só
  reduz incerteza, e sua existência/formato **não é documentada**.

### 7.3 Cenários dos critérios de aceitação

`npm run run` imprime a tabela e grava `runs/evidence.json`. Fatos observados
(não nomes de helpers):

| cenário | Workers | Attempts | Claim |
| --- | ---: | --- | --- |
| Ticket livre, sem disputa | 1 | A:1 | A |
| Disputa simultânea sob P-CAS | 1 | A:1, B:0 | A |
| Disputa simultânea sob o documentado | **2** | A:1, B:1 | B |
| Mesmo Ticket, Destinations diferentes — P-CAS | 1 | A:1, B:0 | A |
| Mesmo Ticket, Destinations diferentes — documentado | **2** | A:1, B:1 | B |
| Dois sites, mesma chave e mesmo id | 2 | A:1, B:1 | A, B |
| Sub-issue e pai | 2 | A:1, B:1 | A, B |
| Tickets distintos | 2 | A:1, B:1 | A, B |
| Claim existente | 1 | A:1, B:0 | A (B não escreve) |
| Resposta perdida | 1 | A:1, B:0 | A (0 antes de verificar; 1 submissão) |
| Leitura de verificação falha | 1 | A:1 | A (0 antes; incerto, sem lançar) |
| Job `FAILED` (transação: nada atualizado) | 1 | A:1 | A (retry permitido) |
| Conexão falha antes de agendar | 1 | A:1 | A (nada escrito; retry permitido) |
| `currentValue`: duas transferências — documentado | 0 | A:0, B:0, C:0 | C (2 jobs aplicados) |
| `currentValue`: duas transferências — P-CAS | 0 | A:0, B:0, C:0 | B (1 job aplicado) |
| Sem Reservation local | 1 | A:1, B:0 | A (B não escreve) |
| Morte + 30 dias | 0 vivos | A:1, B:0 | A (sem takeover) |
| Contato perdido (Worker vivo) | 1 | A:1, B:0 | A (B não supervisiona) |
| Recovery local | 1 | A:1, B:0 | A (mesmo Attempt; 2 starts) |
| Claim sem Worker | 1 | A:1, B:0 | A (Reserved without Attempt) |
| Claim parcial (apresentação falha) | 1 | A:1, B:0 | A (segura sem lançar) |
| Claim ilegível | 0 | B:0 | ilegível (preservado) |
| Claim anterior (label+atribuição) | 0 | B:0 | ausente (B não escreve) |
| Liberação manual | 1 | A:1, B:1 | B (recusada com Worker vivo/sem confirmação; liberada após o fim; então B) |
| Não participante | **2** | A:1 | intruso (fora da garantia) |
| Busca desatualizada + P-CAS | 1 | A:1, B:0 | A (B não lança) |
| Verificação desatualizada | 0 | A:0 | A (incerto, sem lançar) |
| Task fora de ordem + P-CAS | 1 | A:0, B:1 | B (submissão A→B, aplicação B→A) |
| C1 property simples | **2** | A:1, B:1 | B |
| C3 lista em lote | **2** | A:1, B:1 | B |
| C4 atribuição | **2** | n/a (start direto) | — |
| C5 edição comum (label) | **2** | n/a (start direto) | — |
| C6 transição | **2** | n/a (start direto) | — |

Os cenários de “dois Workers” dos candidatos C1/C3–C6 mostram que a falha não é
do protocolo C2: é do tipo de escrita. Os cenários “1 Worker” sob P-CAS são a
demonstração positiva **condicionada** — não uma demonstração de que o Jira
oferece P-CAS.

### 7.4 Limites da demonstração

- A matriz roda **no simulador**. Não é um experimento contra o Jira Cloud; é a
  exploração do espaço que a documentação admite. Um experimento real de
  concorrência exigiria autorização, site/fixture próprio e cleanup.
- O modelo não reproduz todos os detalhes do Jira (limites internos, locks de
  banco, replicação, retries do servidor). Ele reproduz apenas o que a
  documentação permite e marca como premissa o que ela não fixa.
- O resultado da task é modelado nas duas formas (“desconhecido” e “contagem”);
  a forma real, se existir, precisa ser descoberta — e não substitui P-CAS.
- A retomada de uma instalação **depois** de uma liberação manual, com leitura
  desatualizada do Claim antigo, não é simulada: ela é fechada por P-RELEASE
  (a instalação liberada não volta a executar aquele Work), não pela API.
- A **inalcançabilidade** não é um estado modelado: o protocolo não tem canal
  para a dona, então não há o que falhar. O cenário de perda de contato prova
  que B não consulta a saúde da dona — não que detectaria uma dona viva.
- Nenhuma mutação real, nenhuma credencial, nenhum Ticket operacional.

## 8. Conclusão e o que volta ao operador

### 8.1 Resposta explícita

**Não demonstrado sob as garantias documentadas; condicionalmente suficiente sob
P-CAS/P-READ/P-PARTICIPANTS/P-RELEASE, que a Atlassian não documenta.** O
candidato não é “inadequado por construção” — ele é o único que pode funcionar —
mas a garantia necessária não está estabelecida. O requisito **não** foi
enfraquecido: nada aqui autoriza “melhor esforço”, lease, expiração, takeover,
particionamento prévio ou alocação manual.

### 8.2 Lacunas que precisam de esclarecimento da Atlassian

1. O `PUT /rest/api/3/issue/properties/{propertyKey}` avalia o filtro
   (`hasProperty:false`, `entityIds`, `currentValue`) **no início da execução
   do job** (e não no enqueue) e o aplica **atomicamente** com a escrita, em
   relação a jobs concorrentes na mesma issue? Ou o conjunto elegível é fixado
   no enqueue?
2. Dois jobs concorrentes com `hasProperty:false` podem ambos atualizar a mesma
   issue? Um recebe `409`, ou ambos são aplicados (last write wins)?
3. Qual é o conteúdo do `result` da task desse endpoint? Ele informa issue ids
   ou contagem atualizada, permitindo distinguir “atualizei 1” de “nenhuma
   elegível”?
4. Um `GET` direto da property após `COMPLETE` é read-after-write consistente?
5. Existe algum primitivo documentado de escrita condicional (`If-Match`, versão)
   para properties de issue que não esteja no OpenAPI v3?

Sem respostas (ou sem uma garantia equivalente), a implementação seguinte para
Jira não tem base de segurança. Alternativas que introduzam serviço externo,
app, mudança de workflow ou lease **não** foram adotadas; são decisões do
operador.

### 8.3 O que concluir a investigação não significa

Fechar esta investigação **não** aprova o protocolo, **não** escolhe um
mecanismo e **não** torna a implementação seguinte pronta. As decisões, as
limitações e os pré-requisitos não aprovados voltam ao operador; a implementação permanece
`needs-info` até uma decisão explícita.

### Evidências recuperáveis

- `experiments/jira-claim/RELATORIO.md` — este relatório.
- `experiments/jira-claim/src/` — modelo, protocolo, explorador, cenários e
  testes (68 testes).
- `npm test` — identidade, semântica do modelo, matriz exaustiva e cenários.
- `npm run run` → `runs/evidence.json` — matriz completa, testemunhas de
  interleaving, cenários e as citações das fontes primárias.
