# Design confirmado — My Software Factory

## Escopo

Script TypeScript local usando Sandcastle, não motor durável ou substituto do
projeto definitivo com microVM. Máxima autonomia supervisionada no laptop,
para projetos pessoais e corporativos, com limite de investimento inicial de
uma ou duas sessões de configuração e uma tarefa real.

Registro da entrevista: [PKM, commit f651e75](https://github.com/Sanmoo/pkm/blob/f651e75/.scratch/sandcastle-laptop/spec.md).

## Contratos a implementar após compatibilidade

- **Issue tracker por porta e adapters**. Jira corporativo e GitHub Issues pessoal;
  o núcleo lida com trabalhos elegíveis, contexto e transições, não com JQL/sprint.
  A interface concreta será refinada quando os dois adapters forem implementados.
- No adapter Jira: projetos habilitados, sprint atual, atribuída ao operador,
  label ready-for-agent. Doing na admissão; done após merge externo.
  Critérios equivalentes de GitHub Issues ainda não foram definidos.
- N limita agentes principais ativos. Esperar CI, review ou humano libera vaga;
  trabalho continua acompanhado e não pode ser admitido duplicado.
- Inicialmente uma implementação ativa por repo; N=1 no primeiro fluxo, depois N=2.
  Retomadas/correções antes de novas tarefas, depois prioridade e desempate estável.
- Pi `/implement`: máximo 5 invocações Sandcastle configurável, normalmente uma.
  Pedido de ajuda ou entrega pronta interrompem o loop antes do máximo.
- Resultado estruturado: ajuda com contexto, PR pronto ou interrupção/falha.
  Ausência/formato inválido não é sucesso. Logs permanecem livres.
- Script acompanha PR/CI/review e gere vagas; **nenhum merge pelo agente**.
  PR fechado sem merge pausa o trabalho e procura o humano; não reabre sozinho.
- Supervisão por tail de logs e CLI: status, logs, reply, resume, pause.
  Feedback durante execução fica para próxima invocação, sem steering ao vivo.
- Jira: comentários com agent:. PR: feedback humano novo e checks relevantes
  falhos. Consumir uma vez, sem reagir aos relatos do próprio agente.
- Recuperação manual via sessão Pi anterior, mantendo issue/área/PR/sessão.
  Reabrir parent não retoma filhos automaticamente: consultar estado/resultados.
- Permitidos comandos, dependências, commits, push, PR e deploy não produção.
  **Deploy em produção proibido**. Efeitos indiretos exigem refinamento antes
  da tarefa real, não foram testados pelo experimento inicial.

## Primeiro experimento

Somente Sandcastle → Pi JSON → filho async sem ferramentas → resultado do parent
→ retomada do mesmo parent. Fixture isolada, noSandbox e sem tracker/PR/deploy.
Usa marcador conhecido somente pelo filho; conferir delegação e resposta final
por eventos, não apenas pelo sinal de conclusão Sandcastle.

A biblioteca é fixada em 0.12.0, revisão e99f832f26dc9d245c019a9ddd19fa5dee792427;
a pesquisa inicial examinou 7a4e7f7d93056600d979d79a090256feddf653ea. Referências
antigas não são prova da versão instalada. O experimento usa a API publicada.
