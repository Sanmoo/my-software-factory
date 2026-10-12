# O adapter do tracker só escreve; o núcleo confirma por releitura

As escritas da factory na issue (claim, liberação, done) são confirmadas num único
módulo do núcleo, que lê a issue antes, pede a escrita ao adapter, relê, gradua cada
mudança comparando os dois snapshots normalizados e decide o desfecho. O adapter só
informa o que escreveu (ou o que é impossível no fornecedor) e nunca diz que uma
mudança foi confirmada. A marca de claim da factory é exposta pela porta já
normalizada, para que o núcleo julgue a liberação por ela mesmo quando a escrita falha.

Motivo: a regra "escrever → reler → graduar" estava copiada nos adapters e refeita no
núcleo, com releituras duplicadas e com o adapter em memória respondendo `confirmed`
direto, o que escondia diferenças entre trackers (a liberação no Jira nunca era
confirmada). Com um dono único, a mesma regra cobre o caminho normal e a reconciliação
após erro de escrita, e os três adapters passam a ter o mesmo contrato, verificado por
um teste de contrato.

## Considered Options

- **Helper comum dentro de `src/tracker/`**, com cada adapter relendo e graduando:
  rejeitado porque a reconciliação após erro continuaria no núcleo, mantendo dois donos.
- **Decorator em volta de qualquer `TrackerPort`**: rejeitado porque separa a graduação
  da decisão de desfecho e dos eventos, que continuariam no `Admission`.

## Consequences

- `ClaimOutcome`, `DoneOutcome` e `ReleaseOutcome` deixam de ser tipos da porta e
  passam a ser decisões do núcleo; os valores de antes/depois no log vêm das leituras.
- Pré-condições normalizadas (já claimed, já done, estado desconhecido) são decididas
  pelo núcleo a partir da leitura anterior; o adapter só recusa o que o fornecedor não
  permite (por exemplo, transição indisponível).
- As escritas diretas do agente usam a mesma comparação por mudança (`gradeChange`,
  função pura do núcleo), sem decisão de desfecho; o diff de comentários fica só do
  lado do agente (#40).
