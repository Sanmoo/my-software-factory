# Plano aprovado — observabilidade do runner e do agente

Status: entendimento confirmado pelo operador em 2026-10-11; implementação pendente.
Spec de implementação: [issue #15](https://github.com/Sanmoo/my-software-factory/issues/15),
label `ready-for-agent`; a issue é a referência canônica para execução.
Origem: [piloto #10](https://github.com/Sanmoo/my-software-factory/issues/10).
Evidência: [diagnóstico 010](../results/010-agent-observability.md).

## Objetivo e escopo

Permitir ao operador acompanhar atividade e intervenções sem precisar interpretar
silêncio como falha. O incidente do trabalho #13 terminou corretamente em
`waiting-for-pr`, PR #14. **Não há correção de retomada a implementar neste escopo.**
A observabilidade se divide em duas entregas complementares: resumo operacional
no log principal e detalhamento do agente. O contrato existente de reply/retomada
permanece protegido por teste; não mudar agendamento, vagas, resultado estruturado,
merge externo, timeout ou política de recuperação.

## 1. Log principal e histórico operacional

Publicar as transições relevantes conforme acontecem, inclusive as produzidas
por invocações em background, sem depender do próximo polling:

- início, espera por vaga/impedimento, retomada e fim de invocação;
- pedido de ajuda com pergunta, contexto e comando de `reply` copiável;
- resposta enfileirada, aplicada ao trabalho, incluída na retomada e entregue ao
  agente, distinguindo aceitação na fila de entrega efetivamente observada;
- avisos de ausência de saída, volta de atividade, timeout e interrupção;
- PR aceito para acompanhamento e mudanças operacionais de acompanhamento;
- perda de observabilidade ou falha de persistência.

Cada evento identifica instância, trabalho, invocação quando aplicável,
timestamp e motivo. Correlacionar respostas com ID de comando. Não declarar
entrega ao agente apenas porque a CLI enfileirou o comando ou o runner começou:
usar evidência disponível; uma etapa não observada não vira confirmação.

Os comandos sugeridos preservam configuração, instância e diretório de estado
usados pelo runner, escapando argumentos para o shell. Indicar também como
acessar o log detalhado. Uma nova mensagem de ajuda não exige que o operador
adivinhe o ID completo do trabalho nem reconstruir o comando.

Persistir uma linha do tempo operacional estruturada, consultável pelo comando
`logs`, além do snapshot exibido por `status`. Preservar pergunta/contexto,
respostas e motivos no histórico mesmo quando o trabalho muda para `running`.
Não confundir um JSON de histórico local com event sourcing ou recuperação
integral de processos; permanecem os limites do MVP.

## 2. Log detalhado do agente

Fornecer um arquivo legível, acompanhado por `tail -f`, com eventos escritos
**durante** a execução, não somente depois do resultado final:

- mensagens públicas do agente;
- início/fim de todas as chamadas de ferramenta, nome, ID, argumentos,
  resultados e erros, sem whitelist que descarte ferramentas Pi;
- timestamps e correlação de chamada, invocação e origem;
- lifecycle e avisos operacionais pertinentes.

Não incluir raciocínio interno privado do modelo. Não despejar o stream bruto
sem filtragem como substituto permanente de um log legível. Preservar os eventos
necessários ao diagnóstico sem alterar sua interpretação no contrato de resultado.

Saídas grandes podem ficar em artefatos, com resumo e caminho no log; nunca
truncar silenciosamente. Ocultar credenciais conhecidas antes de persistir,
inclusive em artefatos, erros e referências. Isso não promete eliminar todo
conteúdo sensível: logs podem conter conteúdo de projeto, perguntas e respostas.
Logs e transcrições permanecem locais e fora do Git; não publicar o conteúdo
bruto em issues ou PRs. Fixtures e resumos redigidos podem ser versionados.

## 3. Subagentes

O log detalhado do principal identifica início, atividade resumida, pedido de
ajuda e desfecho dos filhos, com referência ao log completo próprio de cada um.
Não misturar todas as transcrições num único arquivo nem considerar silêncio do
principal como prova de que um filho parou.

Verificar o suporte real de eventos/artefatos da versão instalada. Se a atividade
ou log de um filho não puder ser observado, mostrar a limitação explicitamente;
não fabricar heartbeat ou considerar lançamento/reconciliação final como prova
de progresso contínuo. Se o runtime impedir cumprir o contrato, devolver a
lacuna ao operador antes de ampliar escopo ou substituir o protocolo.

## 4. Semântica de idle e falha de logging

`idle` é aviso técnico de ausência de saída recebida. Não é estado do trabalho,
pedido de ajuda, timeout nem diagnóstico de travamento. Mostrar duração, última
atividade observada e limite efetivo de timeout. Quando a saída voltar, registrar
atividade retomada. Só timeout/encerramento reais geram a transição correspondente.

Se o log não puder ser gravado, tornar a perda visível no principal e em `status`,
preservar a execução e os artefatos disponíveis. Não iniciar nova invocação nem
repetir implementação por falha de logging. Se nem o estado puder ser persistido,
expor a falha pelo canal disponível; não prometer atualização de status impossível.

## Seams de teste aprovadas

1. **Runtime/log real:** eventos Pi sintéticos passam pela seam pública de
   execução e o teste lê o arquivo real. Verificar mensagem, início/fim de
   ferramenta, argumentos, resultado e erro **antes** do fim da invocação,
   inclusive sem texto intermediário e para ferramentas fora da tabela atual.
   Não substituir o parser/logger por mock nem verificar somente arrays internos.
2. **Supervisão:** `reply` pela CLI → fila → orquestrador → runner. Mesma
   sessão/área, resposta entregue à invocação e nenhuma duplicação em polling
   seguinte; espera por vaga não é recebimento perdido.

Na primeira seam, cobrir ainda: avisos/volta de saída com relógio controlado;
transições e ajuda com comando copiável no principal; história correlacionada;
filhos/logs referenciados; saídas grandes sem perda silenciosa; ocultação de
segredo sintético; falha de escrita sinalizada sem duplicar trabalho.
Ajustes da seam necessários para testar o runtime MSF devem ficar explícitos:
o probe diagnóstico atual exercita Sandcastle, não `sandcastleBoundary` inteiro.

Testes determinísticos não acionam modelo, Docker, credenciais ou tracker real.
Uma prova real adicional que lance trabalho ou filhos depende de autorização
específica; não reutilizar o trabalho do PR #14 como fixture.

## Critérios de aceite

- CA-OBS01: ajuda produz pergunta/contexto e comando copiável correto no log
  principal durante a execução do runner, mesmo entre ciclos de polling.
- CA-OBS02: detalhado mostra atividade pública e cada chamada/resultado/erro
  enquanto a invocação está ativa, incluindo `read`, `bash` e `subagent`.
- CA-OBS03: ausência de saída e retorno ficam visíveis; aviso não muda estado
  nem dispara retry; timeout efetivo e última atividade são informados.
- CA-OBS04: `logs` expõe histórico timestampado e correlacionado do reply até
  desfecho, sem chamar enqueue de entrega confirmada.
- CA-OBS05: filhos têm identificação, lifecycle/atividade/ajuda/desfecho e
  referências aos logs próprios; limitações do runtime não ficam silenciosas.
- CA-OBS06: saída extensa é preservada em artefato referenciado e segredos
  conhecidos sintéticos não aparecem em nenhum destino de logging.
- CA-OBS07: falha de gravação fica visível no principal/status quando disponíveis,
  sem duplicar nem reiniciar a invocação.
- CA-OBS08: reply continua na sessão/área anterior uma só vez; não alterar regras
  de resultado, vagas, PR, conclusão, timeout ou retomada manual.

## Fora do escopo

Correção/retry de retomada, auto-restart por idle, steering ao vivo, merge do
PR #14, deploy, serviço remoto de notificações, dashboard, observabilidade
centralizada e armazenamento durável/event sourcing. Não elevar `verbose:true`
a solução final sem atender legibilidade, sigilo e falhas.
