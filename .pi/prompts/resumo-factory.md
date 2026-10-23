---
description: Resume o estado atual da factory em até seis linhas, somente leitura
---

Apresente um resumo operacional da factory em português nesta conversa: como ela
está e o que precisa da atenção do operador, sem listar cada Work.

## Coleta e limites

Leia `.pi/prompts/estado-factory.md` e siga integralmente suas seções **Limites**,
**Coleta** e **Tempos e evidências**. Substitua somente a seção **Relatório** pelo
formato abaixo: não produza o relatório detalhado antes nem depois do resumo.
Preserve as mesmas fontes, escopo, cobertura e distinções entre Ticket, Work e PR.
Se a configuração real for ambígua, peça apenas essa informação antes de coletar.

## Resumo

Responda em até **6 linhas curtas e 120 palavras no total**, sem tabelas,
introdução, conclusão ou seções adicionais. Use uma linha por item:

1. **Factory:** intervalo da coleta e fuso, configuração/workspace em forma
   compacta e execução do orquestrador verificada ou não verificada. Não deduza
   saúde ou parada apenas pela quantidade de workers.
2. **Fluxo:** totais de Works no Pool, reservados, Running e aguardando atenção;
   workers vivos/capacidade, se conhecidos. Não some categorias sobrepostas;
   sinalize sobreposições relevantes e contagens parciais ou desconhecidas.
3. **Atenção:** quantidade de bloqueios/anomalias e a pendência mais importante,
   com responsável, duração comprovada e referência curta quando disponíveis.
   Distinga Block formal, outras dependências e liveness desconhecida.
4. **PRs:** quantidade aguardando revisão/decisão e o principal PR com link;
   destaque conflitos ou required checks falhando quando exigirem atenção.
5. **Próxima ação:** uma única ação prioritária recomendada, de quem depende e
   referência necessária; não a execute nem proponha um plano de implementação.
   Sem pendência comprovada e com cobertura completa, diga “nenhuma ação necessária”.
6. **Dados:** sinalize “dados incompletos” e a principal lacuna ou divergência
   sempre que houver; só declare cobertura completa se comprovada.

Priorize o que impede a continuidade e depois o que depende do operador.
Indique quantas outras pendências ficaram fora do destaque, sem enumerá-las.
Compacte a apresentação, nunca a incerteza: fonte inacessível não significa zero,
hipótese não é fato e issue fechada não prova Delivery. Prefira links curtos nas
linhas acionáveis. Para detalhes, o operador dispõe de `/estado-factory`.
