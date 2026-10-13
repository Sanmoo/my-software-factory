# O claim é mantido até a conclusão ou a liberação explícita

O trabalho reserva a issue com a marca de claim da factory antes de iniciar qualquer
agente. Essa reserva é **mantida até a conclusão** (merge externo do PR vinculado e done
confirmado no tracker) ou até uma **liberação explícita do operador** (`release`),
inclusive durante espera e interrupção. Não existe reclaim automático por timeout.

Espera externa (CI, review do PR, resposta humana) libera a vaga, mas não o claim: o
trabalho continua acompanhado e retomável. Interrupção por falha, queda do orquestrador ou
parada declarada pelo agente também não libera. Ao abrir, o orquestrador marca como
interrompido todo trabalho que segurava vaga e **não** o reexecuta automaticamente.

Motivo: a reserva não deve ser tomada automaticamente por outro atendimento. Perder a
execução não equivale a liberar — um agente que caiu ainda pode ser retomado da mesma
sessão e da área preservada, e o operador é quem decide quando o acompanhamento acabou.
Sem essa regra, um timeout transformaria uma falha recuperável em perda silenciosa do
trabalho e do claim.

A marca de claim da factory é distinta de claims de terceiros: no Jira, a issue pode
seguir atribuída ao operador ou em status de andamento sem estar claimed pela factory; no
GitHub, qualquer assignee conta como claim, então a marca própria (label mais a conta do
projeto) é o que a liberação remove. A liberação só vale quando a releitura do tracker não
mostra mais nenhuma parte dessa marca; status da issue e atribuições de outras pessoas
ficam como estão.

## Considered Options

- **Reclaim automático por timeout de espera**: rejeitado. Espera por CI, review ou humano
  não é abandono; liberar sozinho reabriria a issue a um segundo atendimento enquanto o
  primeiro ainda tem sessão, área e PR.
- **Reexecutar automaticamente o trabalho interrompido**: rejeitado. Falha ambígua ou queda
  não provam que a implementação deve recomeçar; a retomada da mesma sessão é uma decisão
  do operador.
- **Tratar a perda da sessão como liberação**: rejeitado. Falta de continuidade vira pedido
  de ajuda, não liberação do claim.

## Consequences

- `release` é o único caminho que devolve a issue à elegibilidade, e ele é confirmado por
  releitura; enquanto a marca estiver visível, o trabalho mantém o estado.
- Um trabalho esperando vaga ou aguardando o operador conserva o motivo original e o claim
  durante toda a espera.
- A factory não promete recuperação automática nem lock distribuído; a continuidade
  incerta é devolvida ao operador.
