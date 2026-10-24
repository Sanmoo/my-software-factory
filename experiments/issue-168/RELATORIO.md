# Viabilidade — Claim exclusivo entre fábricas pelo GitHub Issues (#168)

## Conclusão

**Não demonstrado.** Nenhum protocolo mínimo sustentado apenas por operações
documentadas do GitHub Issues garante, com as garantias que o provedor
documenta, que no máximo uma fábrica execute um Worker por Ticket sob aquisição
simultânea.

O candidato mínimo que chega mais perto — **`claim-sequence`**, um único
comentário de Claim ordenado pelo `id` atribuído pelo GitHub, vencendo o menor
`id` — é **condicionalmente suficiente** sob duas premissas que o GitHub **não
documenta**:

- **P1** — o `id` do comentário é atribuído na ordem em que as escritas
  concorrentes são aplicadas;
- **P2** — nenhuma leitura mostra um Claim aplicado depois e esconde um Claim
  aplicado antes (leitura fresca, ou ao menos visibilidade em prefixo).

Sem P1, um escritor posterior pode receber um `id` menor e também se declarar
vencedor. Sem P2, cada fábrica pode ver só o próprio Claim e ambas se
autorizarem. O harness reproduz os dois contraexemplos; com as duas premissas e
leitura de verificação fresca, o argumento de segurança fecha e o protocolo
autoriza exatamente uma fábrica em todas as intercalações exploradas. Com
visibilidade apenas em prefixo, ele ainda nunca autoriza duas, mas uma
verificação que não vê o próprio registro termina em incerteza — nenhum
vencedor naquele traço, e a fábrica repete a verificação.

Os demais candidatos são **inadequados** mesmo sob as leituras mais fortes:

- a marca atual (label `agent-claimed` + atribuição à Acting account),
  re-lida depois da escrita, autoriza **as duas** fábricas com leituras frescas;
- o lock de conversa não tem dono e autoriza as duas;
- labels únicas com desempate escolhido pelo cliente (menor label) são
  superadas por um Claim posterior com chave menor;
- a regra “só autorizo se não houver nenhum outro Claim” é segura, mas quando
  duas fábricas escrevem antes de verificar, **ninguém** vence: o Ticket fica
  com dois Claims e exige liberação manual.

**Isto é um resultado inconclusivo para produção, não uma autorização.** O
protocolo escolhido, as premissas que faltam confirmar e os próximos passos
retornam ao operador. A issue #170 (`needs-info`) permanece sem autorização de
implementação; o requisito não foi enfraquecido para “melhor esforço”, lease,
expiração, particionamento ou alocação manual.

## 1. Objeto e método

A pergunta é estreita: **somente GitHub Issues**, sem serviço de coordenação
externo, sem banco ou filesystem compartilhado, sem lease, sem expiração e sem
supervisão remota de saúde. Duas fábricas com máquinas, workspaces e
configurações independentes observam o mesmo Ticket livre e tentam adquirir.
Quer-se saber se o tracker permite que **no máximo uma** receba autoridade
exclusiva confirmada, e não apenas que ambas “marcaram” o Ticket.

Método:

1. **Fontes primárias** — a documentação oficial do GitHub REST (versão de API
   `2026-03-10`, consultada em 2026-10-24) para cada operação que os candidatos
   usam: comentários, labels, atribuição, lock e leituras; mais as páginas de
   requisições condicionais, rate limits e permissões de token.
2. **Candidatos mínimos** — cinco protocolos expressos nas mesmas três fases
   que uma fábrica real tem: leitura antes da escrita, escritas cegas e leitura
   de verificação.
3. **Argumento de segurança** — as premissas de atomicidade, ordenação e
   consistência de que cada candidato depende, com prova sob as premissas e
   contraexemplo quando uma falta.
4. **Demonstração reproduzível** — um harness determinístico com duas
   instâncias sem estado local compartilhado, Workers controláveis e fatos
   observáveis no tracker. O simulador concede somente o que as fontes
   permitem: escrita cega por requisição, resposta que pode se perder, leitura
   que pode voltar desatualizada. Ele **não** oferece compare-and-set, fila,
   lease ou oráculo de vencedor.

O que **não** foi feito: nenhuma mutação no tracker real, nenhum experimento de
corrida contra a API do GitHub, nenhuma alteração de produção. Experimentos que
mutam o tracker exigem autorização e fixtures próprias com cleanup; investigar
não autoriza mutar Tickets operacionais. Um teste de corrida real, se um dia
autorizado, seria evidência complementar — nunca substituto das garantias.

## 2. Fontes primárias: operações e o que elas garantem

As citações abaixo são da documentação oficial. A coluna “não estabelece” é a
parte que importa: é onde a intuição de “editei e reli, então adquiri” falha.

| Operação | O que a documentação estabelece | O que **não** estabelece |
| --- | --- | --- |
| Requisições condicionais ([best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests)) | `ETag`/`If-None-Match` e `Last-Modified`/`If-Modified-Since` para `GET`; um `304` não consome rate limit. “Conditional requests for unsafe methods, such as `POST`, `PUT`, `PATCH`, and `DELETE` are not supported unless otherwise noted in the documentation for a specific endpoint.” | Nenhum `If-Match`/CAS para escrita em issue, comentário, label, atribuição ou lock. Não há “escreva se ninguém escreveu”. |
| [Update an issue](https://docs.github.com/en/rest/issues/issues#update-an-issue) (`PATCH`) | `labels` “to **replace** the set of labels on this issue”; `assignees` “to **replace** the set of assignees”; sem parâmetro de revisão/condição; resposta `200` ou erro. | Não há condição de versão, “claim if unowned”, unicidade de dono nem prova de quem venceu. É uma escrita cega; duas escritas concorrentes se sobrescrevem. |
| [Add assignees](https://docs.github.com/en/rest/issues/assignees#add-assignees-to-an-issue) | “Adds up to 10 assignees to an issue. Users already assigned to an issue are not replaced.” | Atribuição é **aditiva** e múltipla: com contas distintas, ambas ficam atribuídas; com a mesma conta, as duas leem “eu estou atribuído”. Atribuição não identifica instância nem autoridade exclusiva. |
| [Lock an issue](https://docs.github.com/en/rest/issues/issues#lock-an-issue) | “Users with push access can lock an issue or pull request's conversation.” O snapshot expõe `locked` (booleano) e `active_lock_reason`. | É um lock de **conversa**, sem dono documentado. O `locked` não diz quem travou; dois `PUT /lock` não elegem vencedor. |
| [Create an issue comment](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment) | Anexa um comentário e devolve o objeto criado, com `id`; sujeito a secondary rate limiting; token com “Issues” write. | Não há chave de idempotência nem pré-condição documentada; repetir por timeout pode criar dois comentários. A resposta não prova que nenhum concorrente também escreveu. |
| [List issue comments](https://docs.github.com/en/rest/issues/comments#list-issue-comments) | “By default, issue comments are ordered by ascending ID.” Paginação (`per_page` máx. 100). | Ordenar a **apresentação** por `id` não estabelece que os `id` sejam atribuídos na ordem de aplicação das requisições concorrentes, nem que a listagem contenha todo comentário já aplicado (pode faltar um). |
| [Rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) | 5.000 requisições/hora para usuário autenticado; limites secundários; recomenda-se serializar e espaçar requisições mutativas em ≥ 1 s. | Não há prioridade, reserva ou exclusão entre clientes que compartilham o mesmo token/conta. |

Nenhuma operação acima, isolada ou em conjunto, é um **create-if-absent** ou um
test-and-set documentado. O candidato que usa o `id` do comentário depende,
portanto, de uma ordenação que a documentação **não** promete — exatamente a
lacuna que a conclusão registra.

## 3. Candidatos e por que a intuição não basta

Os cinco candidatos estão implementados em `src/protocols.ts` e explorados em
todas as intercalações de `write`/`verify`/`launch` das duas instâncias.

### C1 — marca atual: label `agent-claimed` + atribuição à Acting account, re-lida

É o Claim atual em termos de protocolo. A verificação lê “o label existe e a
minha conta está atribuída”. **Não pergunta quem escreveu.** Com a mesma conta
(as duas fábricas podem usar a conta do operador; a v0.1 usa), as duas leem a
própria conta atribuída. Com contas distintas, a atribuição é aditiva e as duas
também leem a própria conta. Resultado no harness: **20/20 intercalações com
leitura fresca autorizam as duas**; 132/420 até com leituras em prefixo.
Editar, atribuir e reler não demonstra aquisição exclusiva.

### C2 — label único por fábrica, “só autorizo se nenhum outro Claim aparecer”

A leitura de verificação exige `valid.length === 1`. É **segura** sempre que a
leitura não esconde um Claim anterior atrás de um posterior (fresca ou em
prefixo): um verificador que vê o Claim alheio recusa. Mas se as duas escrevem
antes de qualquer verificação, as duas veem os dois Claims e **as duas
recusam**: 0 vencedores, dois Claims permanentes, Ticket parado até liberação
manual. Segurança sem progresso não satisfaz a disputa autônoma. Pior: com uma
leitura que omite dois escritos já aplicados, as duas podem ver só o próprio
Claim e **as duas vencem** (460/7040).

### C3 — label único + menor label vence

O desempate é escolhido pelo cliente, não pelo provedor. A fábrica A escreve e
verifica antes de B escrever, vê só o próprio label e se autoriza; B escreve um
label lexicograficamente menor, verifica depois, vê os dois e também se
autoriza. É inseguro até com leitura fresca (4/20 intercalações). O `id` do
comentário em C5 só resolve isso porque a ordem é atribuída pelo provedor no
momento da escrita — e mesmo assim apenas sob P1.

### C4 — lock de conversa

O lock é um estado compartilhado sem dono. As duas travam (a segunda chamada é
idempotente), as duas releem `locked: true` e o próprio comentário, e as duas se
autorizam: **20/20 com leitura fresca**. Não identifica instância.

### C5 — `claim-sequence`: um comentário marcado, menor `id` vence

É o candidato mínimo que pode funcionar. O Claim no sentido do `GLOSSARY.md`
(mark **+** atribuição à Acting account) é composto pela escrita do label
`agent-claimed`, pela atribuição e por **um** comentário com o registro
completo; o `id` devolvido pelo GitHub ordena os registros, e o menor `id` é o
vencedor. Label e atribuição são **apresentação**: mantêm a derivação de pool e
as instalações antigas vendo o Ticket reservado e tornam a superfície
compatível com o Claim atual, mas **não** são prova de autoridade. Só o registro
e seu `id` decidem.

Sob P1 + P2 e leitura de verificação fresca, é seguro e sempre encontra um
vencedor (20/20 intercalações). Com visibilidade em prefixo, continua seguro
(0/812 com dois), mas 420/812 traços terminam sem vencedor porque a verificação
não viu o próprio registro — incerteza, e a fábrica repete a verificação. Sem P1
(8/20 com `id` fora da ordem de aplicação) ou sem P2 (1120/7040 com uma leitura
que omite um Claim já aplicado; 1472/7040 no perfil mais fraco), aparecem dois
vencedores. A seção 5 dá o
protocolo completo e a seção 6, o argumento.

## 4. Protocolo C5 ponta a ponta

### Identidade

- **Ticket identity** — provedor + site + `repo` + número estável. O
  Destination **não** entra: duas fábricas com Destinations diferentes
  disputam o mesmo Ticket. Sub-issues têm números distintos e são Tickets
  distintos.
- **Factory id** — identidade da instalação, atribuída pelo operador na
  configuração, estável entre reinícios e **única entre instalações
  concorrentes**. Não é a Acting account. É o que a confirmação de parada do Worker anterior
  identifica.
- **Nonce** — identificador do escrito de aquisição, único por incarnação do
  processo (um reinício gera outro). Correlaciona a resposta perdida e
  identifica **qual** registro é desta aquisição; não é lease e não expira. A
  autoridade é o registro (factory id + nonce) que a própria aquisição escreveu
  e a Reservation local conserva.
- **Acting account** — autentica as escritas e recebe a atribuição. Pode ser a
  mesma conta em todas as fábricas; por isso a atribuição é apresentação, nunca
  identidade. O comentário é autorado por essa conta, mas o corpo carrega o
  factory id.

Formato do registro (um comentário; marcador `<!-- msf:claim -->`):

```text
<!-- msf:claim -->
factory: <factory-id>
claim: <nonce>
ticket: github:<site>:<repo>#<number>
```

Um corpo com o marcador e campos faltando, duplicados, desconhecidos ou com
outro Ticket é **malformado**: incerteza, nunca “sem Claim”.

### Operações de uma aquisição

1. **Leitura de observação** — listar os comentários (todas as páginas) e os
   labels do Ticket.
   - Claim válido, label `agent-claimed` sem registro legível, ou Claim de
     outra convenção → **indisponível**; não escrever, não limpar.
   - Marcador malformado → **incerto**; não escrever, não limpar.
   - Nada → **livre**; seguir.
2. **Escrita do padlock** — `POST /issues/{n}/labels` com `agent-claimed`
   (idempotente). Serve à apresentação/pool; não decide nada.
3. **Escrita da atribuição** — `POST /issues/{n}/assignees` com a Acting
   account (idempotente/aditiva). Completa o Claim no vocabulário do glossário
   e a superfície que a fábrica atual conhece; não decide nada.
4. **Escrita do registro** — `POST /issues/{n}/comments` com o registro. Uma
   única requisição; não há retry cego depois de resposta perdida.
5. **Leitura de verificação** — listar os comentários novamente.
   - Marcador malformado ou nenhum registro válido visível → **incerto**.
   - O menor `id` entre os registros válidos é **o meu registro** (mesmo
     factory id **e** mesmo nonce desta aquisição) → **autorizado**.
   - Qualquer outro registro é o menor, ou existe registro sem que o meu
     apareça → **indisponível**. Um Claim da mesma instalação sem a Reservation
     local que o comprove não é meu por semelhança de nome.
6. **Lançamento** — somente com **autorizado**. A Reservation local é criada
   antes do Worker. Um Attempt só é consumido no lançamento.

O vencedor é **observável por qualquer leitor**: o comentário de menor `id`
entre os Claims válidos do Ticket, com o factory id no corpo. Não depende de
quem é a conta, de quem está atribuído, nem de relógio local. A prova é
recomputável a partir do tracker — desde que P1/P2 valham.

### Resultado incerto

Incerteza cobre: resposta perdida de qualquer escrita, falha antes da escrita,
leitura de verificação que não mostra o próprio registro, Claim parcial (só o
padlock), marcador malformado, Claim para outro Ticket, e leitura que falhou.
Em todos: **não lançar**, **não remover Claim que possa ser alheio**, **não
consumir Attempt**. A fábrica mantém o Claim pendente e repete a verificação
numa varredura seguinte; ela **não** descarta o pendente e faz uma observação
nova (isso poderia escrever um segundo Claim). Se a Reservation local se perdeu
por completo, o Claim fica sem registro neste workspace: a fábrica o trata como
alheio e o operador decide — “Unbacked claim” continua sendo uma observação
local, não prova de abandono global. Isso vale também para um Claim da **mesma**
instalação: sem o registro local que o comprove (factory id + nonce), ele não
autoriza takeover.

Um Claim parcial (padlock aplicado, registro não) é o caso terminal simétrico:
o dono não reescreve (a resposta pode ter se perdido), nenhuma outra fábrica
pode assumir, e o Ticket fica indisponível até a liberação manual — o mesmo
desfecho do deadlock do `strict-unique`, mas por incerteza, não por dois Claims.

Uma leitura posterior, **isolada**, não é tratada como resolução da corrida: a
confirmação é a verificação do Claim que a própria fábrica já escreveu. Se o
registro próprio continua invisível, continua incerto.

### Claims anteriores, Recovery local e fábricas não participantes

- **Claim anterior** (label `agent-claimed`/atribuição sem registro) →
  indisponível. O protocolo novo não o promove nem o apaga.
- **Recovery local** — a instalação original restaura a Reservation, verifica o
  próprio Claim e relança a **mesma** Attempt (o número não muda, nenhum
  Attempt novo é consumido). Isso não dá autoridade a outra fábrica.
- **Abandono, morte, perda de contato, passagem do tempo** — não alteram os
  fatos do tracker e não há lease/expiração/health check remoto. O Claim
  permanece; outra fábrica o respeita indefinidamente.
- **Fábricas não participantes** — não estão cobertas. Uma instalação antiga
  que ignora o comentário e só olha labels, ou um Worker hostil que ignora o
  protocolo, pode executar. A garantia pressupõe que **todas** as fábricas que
  disputam o conjunto obedeçam ao protocolo. O padlock ajuda a derivar o pool,
  mas não é uma barreira contra quem não participa.

### Liberação/transferência manual

Fora do protocolo e do código de aquisição. O operador **para e confirma** o
fim do Worker anterior e só então remove o Claim (comentário + label). Uma
edição no tracker **não** interrompe o Worker remotamente; o harness até recusa
a liberação enquanto observa um Worker vivo (o registro de Workers é a
testemunha do experimento; na instalação real, a confirmação é do operador). Se
o Claim for malformado, a remoção é manual na UI — a ferramenta não apaga o que
não consegue ler.

### Permissões e custos

- **Permissão** — token fine-grained com “Issues” **write** (comentário, label,
  atribuição; “Issues” read para as leituras); um GitHub App equivalente. Um
  PAT clássico precisa de `repo`/`public_repo`.
- **Custo por aquisição** — 1 listagem inicial (paginada; 100 comentários por
  página) + 1 escrita de label + 1 escrita de atribuição + 1 escrita de
  comentário + 1 listagem de verificação ≈ **5 requisições + páginas**. A
  liberação manual acrescenta remoções.
- **Rate limit** — 5.000/h por usuário autenticado. Todas as fábricas que
  compartilham a Acting account compartilham o mesmo orçamento; o protocolo não
  tem prioridade entre elas. Limites secundários recomendam requisições
  serializadas e ≥ 1 s entre escritas mutativas; as três escritas do Claim
  podem custar ~2 s de latência. Falhas/retries acrescentam custo e nunca são
  tratados como autorização.
- **Auditoria** — o comentário de Claim é o registro; o factory id no corpo é a
  identidade. Como a conta pode ser compartilhada, o login não distingue
  instâncias; qualquer portador da conta pode editar/apagar comentários alheios.
  A garantia depende de participação, não de imutabilidade.

## 5. Premissas e argumento de segurança

### Premissas

- **P0 — aplicação atômica por requisição.** Cada escrita tem um ponto de
  aplicação e é aplicada por inteiro (um comentário existe ou não; um label é
  adicionado ou não). Um Claim multi-escrita pode ficar parcial (label sem
  comentário), e o protocolo trata isso como incerteza. A documentação não
  declara transações; o modelo usa apenas o mínimo de uma criação de objeto.
- **P1 — ordem dos ids.** O `id` do comentário é atribuído na ordem total em
  que as escritas concorrentes são aplicadas. **Não documentado.** A doc diz
  apenas que a listagem é ordenada por `id` crescente.
- **P2 — visibilidade.** Nenhuma leitura mostra um Claim aplicado depois e
  esconde um Claim aplicado antes. Equivalentes suficientes: leitura fresca
  (vê tudo que foi aplicado antes de ser servida) ou visibilidade em prefixo
  (se mostra um escrito posterior, mostra os anteriores). **Não documentado.**
- **P3 — participantes.** Todas as fábricas que disputam o conjunto executam o
  protocolo; factory ids são únicos entre instalações concorrentes; a liberação
  manual respeita a confirmação de que o Worker anterior terminou.

### Prova sob P0–P3

Sejam dois Claims aplicados, com ids ordenados pela aplicação (P1). Seja `c*` o
de menor id — o primeiro aplicado. Uma fábrica que decide depois de escrever
o próprio Claim faz a leitura de verificação depois da própria escrita, que é
posterior à aplicação de `c*`. Por P2, essa leitura vê `c*` (se vê um Claim
posterior, vê os anteriores; se é fresca, vê todos). O menor id é `c*`; só a
instalação que possui o **registro** `c*` (factory id + nonce da sua aquisição)
recebe `authorized`; qualquer outra recebe `unavailable`, inclusive a mesma
instalação numa aquisição posterior ou sem Reservation local. A própria dona de
`c*`, se verificar antes de qualquer outro Claim, autoriza `c*` e lança; Claims
posteriores veem `c*` e recusam. Logo, no máximo uma instância autoriza. Se a
dona de `c*` não vê o próprio registro na verificação, o resultado é incerto e
ela não lança; ninguém mais autoriza — segurança preservada, progresso adiado
para uma nova verificação.

Progresso: um Ticket livre, sem concorrência, escreve `c*`, a verificação vê
`c*` e autoriza; um Worker inicia. Esse caso não depende de ordenação
concorrente, apenas de P0/P2 para o próprio registro.

### Onde cada premissa é necessária (contraexemplos executados)

| Falta | O que acontece | Evidência |
| --- | --- | --- |
| P1 | A escreve e verifica antes de B escrever (vê só A, id maior); B escreve e recebe id menor; B verifica e vê os dois, menor é o próprio → B também autoriza. | `unordered-ids-two-winners`: 2 Workers vivos; `fresh+unordered`: 8/20 intercalações com 2. |
| P2 | A verifica omitindo o Claim de B e B verifica omitindo o de A; cada uma vê só o próprio e autoriza. | `stale-read-two-winners`: 2 Workers vivos; `holey+ordered`: 1120/7040 com 2. |
| P1+P2 | Seguro; a única perda é incerteza quando a verificação não vê o próprio registro. | `prefix+ordered`: 0/812 com 2; `linearizable`: 0/20 com 2 e 20/20 com 1. |
| P3 (participante) | Uma fábrica antiga ignora o comentário e lança pelo label/estado antigo; o protocolo não a impede. | Limitação declarada, não simulada como garantia. |

### Por que não existe um candidato melhor “só com o documentado”

Todas as mutações documentadas de Issues são **escritas cegas**: não há
`If-Match`, CAS, chave de idempotência ou “crie se ausente”. Uma decisão só pode
vir de uma leitura. Para que uma decisão antecipada não seja superada, a chave
do vencedor precisa acompanhar a ordem de aplicação do provedor (P1) ou existir
uma barreira de quiescência — e barreira por tempo/lease/expiração está fora de
escopo e seria melhor esforço. Além disso, o verificador precisa enxergar os
Claims anteriores (P2). Nenhuma das duas é documentada. Isso **não** prova a
impossibilidade de todo protocolo tracker-only; prova que, com as operações
documentadas examinadas, a garantia não foi demonstrada.

## 6. Demonstração reproduzível

O harness está em `experiments/issue-168` (isolamento e comandos no README). Duas
`FactoryInstance` independentes (factory ids `zeta` e `alpha`, sem estado
compartilhado) disputam um Ticket; o único meio entre elas é o `SimTracker`; os
Workers são controláveis; os fatos ficam no tracker.

O modelo de leitura é explícito e **não** concede atomicidade mais forte que a
API:

- escritas são cegas e cada requisição é aplicada por inteiro; um Claim de
  várias escritas pode ficar parcial;
- a **leitura de verificação** pode devolver uma projeção de escritas já
  aplicadas: `all` (premissa mais forte), um `prefixo` (visibilidade monotônica,
  ainda premissa) ou uma **omissão** de até duas escritas aplicadas (admissão
  mais fraca; a doc não exclui); a matriz fixa as duas observações iniciais
  como frescas — a barreira exige que ambas tenham visto o Ticket livre. Uma
  observação desatualizada tem cenário próprio: ela pode mostrar “livre” com
  Claim existente, mas não cria autoridade; a verificação é que decide;
- o `id` do comentário é atribuído na aplicação, mas a ordem em relação às
  escritas concorrentes é uma escolha explícita do ambiente (`apply` ou
  `reverse`), não um presente do simulador;
- não há fila, lock, lease, relógio ou vencedor embutido; a única ordenação é a
  dos `id` que o próprio modelo atribui, e ela é justamente o objeto de P1.

`npm run run` imprime a matriz protocolo × modelo. Resultado (cópia da execução
registrada; `runs/evidence.json` contém a matriz e os cenários, com um exemplo de traço por resultado):

| protocolo | holey+unordered | fresh+unordered | prefix+ordered | linearizable | holey+ordered |
| --- | --- | --- | --- | --- | --- |
| current-mark | UNSAFE 1044/1804 | UNSAFE 20/20 | UNSAFE 132/420 | UNSAFE 20/20 | UNSAFE 1044/1804 |
| strict-unique | UNSAFE 460/7040 | safe 8/20 (12 sem vencedor) | safe 308/812 (504 sem vencedor) | safe 8/20 (12 sem vencedor) | UNSAFE 460/7040 |
| min-label | UNSAFE 1296/7040 | UNSAFE 4/20 | UNSAFE 22/812 | UNSAFE 4/20 | UNSAFE 1296/7040 |
| conversation-lock | UNSAFE 480/1804 | UNSAFE 20/20 | UNSAFE 44/420 | UNSAFE 20/20 | UNSAFE 480/1804 |
| claim-sequence | UNSAFE 1472/7040 | UNSAFE 8/20 | safe 392/812 (420 sem vencedor) | safe 20/20 | UNSAFE 1120/7040 |

Os “X sem vencedor” são leituras que não mostram o próprio registro (incerteza,
sem lançamento) ou o deadlock do `strict-unique`; nenhum deles é dois Workers.
O perfil `holey+unordered` é o mais fraco (até duas omissões + ids sem ordem
documentada); `prefix+ordered` e `linearizable` concedem P1/P2 explicitamente.
A matriz **não** é prova de garantia da API: ela mostra o que cada premissa
compra e o que falta.

Cenários (cada um com o tracker, o registry de Workers e workspaces próprios):

| Cenário | Fato observado |
| --- | --- |
| `free-ticket-progress` | 1 Worker, 1 Attempt, 1 Claim |
| `simultaneous-acquisition` | A `authorized`, B `unavailable`; 1 Worker; B com 0 Attempts |
| `current-mark-double-authorization` | as duas `authorized`; 2 Workers vivos |
| `conversation-lock-double-authorization` | as duas `authorized`; 2 Workers vivos |
| `destinations-do-not-bypass` | mesmo Ticket identity com Destinations diferentes; B `unavailable`; 0 escritas de B |
| `distinct-sub-issues-parallel` | #200 e #201, 1 Worker vivo em cada, em paralelo |
| `existing-claim-no-takeover` | Claim de A sem Reservation em B: B `unavailable`, 0 escritas, 0 Attempts |
| `lost-response` | escrita aplicada + resposta perdida: 0 lançamento, 0 Attempt, Claim preservado; B respeita; a verificação posterior da mesma fábrica confirma e lança 1 |
| `failed-before-write` | nada aplicado; A incerta, 0 Attempt; B adquire o Ticket livre e lança 1 |
| `partial-claim` | só o padlock aplicado: A incerta, B indisponível, 0 lançamento, 0 Attempt; Claim preservado; a nova varredura de A continua incerta e não escreve — parado até liberação manual |
| `uncertain-resweep` | resposta perdida: a nova observação de A é incerta e não escreve; a verificação do MESMO Claim autoriza e lança 1 |
| `same-installation-without-reservation` | Claim da mesma instalação sem Reservation local: indisponível, 0 escritas, 0 Attempt |
| `stale-observation` | B observa “livre” com Claim de A aplicado; verifica e vê A: indisponível; A autoriza e lança 1 |
| `unreadable-claim` | marcador incompleto: incerto; 0 lançamento; 0 Attempt |
| `stale-read-two-winners` | duas leituras omitem o Claim alheio: 2 Workers vivos |
| `unordered-ids-two-winners` | ids fora da ordem de aplicação: 2 Workers vivos |
| `strict-unique-deadlock` | dois Claims, ambas recusam, 0 Workers, 0 Attempts |
| `abandonment-does-not-transfer` | A morre, Worker fica; varreduras repetidas de B (nenhum fato do tracker depende do relógio) → `unavailable`; após a morte do Worker, ainda `unavailable`; B nunca lança |
| `manual-release-precondition` | liberação recusada com Worker vivo; só após o fim confirmado o Claim sai e B adquire |
| `local-recovery` | A restaura e relança a **mesma** Attempt 1; B segue `unavailable` |
| `legacy-claim` | label antigo sem registro: B `unavailable`, 0 escritas; após liberação manual, B adquire |
| `claim-for-another-ticket` | marcador de outro Ticket: incerto, 0 lançamento |

Comandos:

```bash
cd experiments/issue-168
npm install
npm test
npm run run   # matriz + cenários + runs/evidence.json
```

Os testes do harness **não** integram o quality gateway da fábrica: são a
demonstração desta investigação, não um check de prontidão da produção. A
issue #170 decidirá, na futura implementação, quais viram checks obrigatórios
do gateway (e com que orçamento).

## 7. O que ficou fora e o que não foi provado

- **Nenhuma chamada real ao GitHub** (seção 1): não há mutação, corrida real,
  medição de latência ou confirmação empírica dos `id`. As fontes são a
  documentação oficial; a lacuna de P1/P2 é justamente o que falta confirmar.
- **Não é prova de impossibilidade** de todo protocolo tracker-only. O escopo
  examinou os candidatos mínimos com as operações documentadas; outro desenho
  (não identificado) poderia depender de outra garantia do provedor.
- **Modelo de staleness amostrado** (até duas omissões por leitura de
  verificação, mais prefixos e leituras frescas; a observação inicial é fresca
  por premissa de cenário), não o conjunto potência completo. A conclusão
  de insegurança usa contraexemplos admitidos; a de segurança usa P1/P2
  declaradas. Um modelo mais adversarial só reforçaria a necessidade de uma
  garantia documentada.
- **Participantes** — fábricas antigas/não participantes, Workers hostis,
  marcadores forjados, contas compartilhadas e factory ids duplicados não são
  cobertos. A conta compartilhada permite que qualquer portador apague Claims
  alheios; o protocolo depende de participação.
- **Exactly-once de External effect** não é prometido nem investigado; o
  requisito aqui é exclusividade de execução por Ticket.
- **Liberação manual** pressupõe o fim confirmado do Worker anterior; uma edição
  no tracker não é interrupção remota. O harness testemunha o fim via registry;
  a confirmação real é operacional.
- **Jira** é a investigação #169, independente. A exigência cross-provider da
  #122 só pode ser avaliada com as duas conclusões.
- **Vocabulário** — `Factory id`, `claim record` e `nonce` são termos desta
  investigação, ainda não no `GLOSSARY.md`; a #170 deve levá-los ao
  `/domain-modeling` antes de fixar o contrato.

## 8. Pendências do provedor e próximos passos

Perguntas que precisam de confirmação oficial do GitHub (documentação ou
suporte), não de experimento informal:

1. Os `id` de comentários de issue são atribuídos em uma ordem total
   consistente com a ordem de aplicação das requisições concorrentes? (P1)
2. Uma listagem de comentários pode devolver uma projeção que omite um
   comentário já aplicado antes da leitura? Isto é, há garantia de prefixo ou
   de leitura linearizável para o listing? (P2)
3. Existe — ou virá a existir — uma escrita condicional/idempotente documentada
   para comentário, label ou atualização de issue (por exemplo `If-Match` ou
   chave de idempotência) que dispense P1/P2?
4. Quais são as garantias em retry/timeout de `POST` de comentário (duplicação,
   resposta perdida, janela de aplicação)?

Enquanto 1–3 não forem respondidas, o resultado permanece **inconclusivo**. O
operador decide:

- **Se P1/P2 forem confirmadas**: aprovar C5 e decompor a #170 — factory id na
  configuração, formato do Claim, contrato de aquisição com
  `authorized`/`unavailable`/`uncertain`, leitura de verificação (e uso de
  `ETag` para baratear), exclusão do pool, migração de Claims antigos, testes
  determinísticos no gateway e documentação operacional.
- **Se não forem confirmadas**: decidir explicitamente entre aceitar as
  premissas como risco operacional (não é garantia) ou autorizar outro
  mecanismo de coordenação — nenhum dos dois silenciosamente. Melhor esforço,
  lease, expiração, particionamento ou alocação manual prévia continuam fora do
  que foi aprovado.
- **Em qualquer caso**: a investigação concluída **não** autoriza a
  implementação em produção; a #170 continua `needs-info` e a decisão volta ao
  operador.

## 9. Evidências recuperáveis

- Código e cenários: `experiments/issue-168/src` (este diretório).
- Protocolos: `src/protocols.ts`; modelo do tracker: `src/tracker.ts`;
  explorador: `src/explorer.ts`; operador: `src/operator.ts`.
- Testes: `npm test` (a matriz é recomputada em memória).
- Relatório de execução: `npm run run` imprime a tabela e os cenários e grava
  `runs/evidence.json` (ignorado pelo git; o relatório acima fixa os números da
  execução).
- Fontes primárias: os links da seção 2, consultados em 2026-10-24, API
  `2026-03-10`.
