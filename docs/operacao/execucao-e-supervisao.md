# Execução e supervisão

Runtime, modelo, resultado, acompanhamento de PR e supervisão do operador. Linguagem:
[GLOSSARY](../../GLOSSARY.md). Admissão e prioridade:
[admissão e prioridade](admissao-e-prioridade.md). Trackers:
[trackers](trackers.md).

O comportamento vive em `src/runtime/`, `src/core/` e `src/cli/`, com testes. Esta página
descreve o que está implementado; uma mudança de regra exige mudança de código, testes e
esta página.

## Runtime

O runtime do trabalho é **Docker**; o agente roda só dentro do sandbox. Falha do Docker, da
imagem ou do perfil **não autoriza execução no host**: não há fallback silencioso para
`noSandbox`, para outro modelo, para outra autenticação ou para outro perfil. Qualquer
falha antes ou durante a execução vira interrupção com o motivo.

Cada trabalho tem sua própria **área Git** e **sessão Pi** no host. O container:
monta só o **retrato** do perfil de runtime, somente leitura; monta a sessão Pi em
leitura/escrita; e recebe o token GitHub apenas no ambiente do trabalho. A área é um clone
da branch de destino; o container empurra para `https://github.com/<repo>.git` com o
`GH_TOKEN` do container, sem gravar o token.

### Perfil de runtime

O perfil Pi do operador é resolvido **no host** e o container recebe um retrato só com
arquivos reais (ver [ADR 0002](../adr/0002-perfil-de-runtime-resolvido-no-host.md)):

- `config.json`, `runtimeProfiles.<perfil>`: itens obrigatórios (`files`, `packages`,
  `skills`, `agents`, `tools`) e `excludePackages` (por exemplo `npm:pi-lens`, retirado só da cópia
  do container, nunca do perfil do operador).
- `local.json`, `allowedRoots.<perfil>`: de onde os links podem vir, além do próprio
  diretório do perfil.
- `local.json`, `mise.<perfil>`: a declaração de mise do operador no host, levada pelo retrato
  e lida dentro do container; sem ela, um perfil com `tools` obrigatórias não é admitido.

Link com destino fora das raízes, quebrado ou cíclico é pulado e listado no log detalhado.
Se for **obrigatório**, a issue não é claimed: o motivo aparece no log principal como
`issue elegível não admitida`. Numa retomada ou correção, o mesmo bloqueio vira pedido de
ajuda e **nenhum container é criado**. Um projeto habilitado cujo perfil não tem declaração
nos dois arquivos é erro de configuração ao iniciar a instância, sem fallback.

Dentro do container, antes do prompt, o setup copia o retrato, **converge** a toolchain uma vez
e confirma os pacotes e ferramentas obrigatórios; se faltar algum, a invocação é interrompida
com o motivo (ver [ADR 0004](../adr/0004-convergencia-de-perfil-fora-do-container.md)). A
convergência é estrita: não há modo fail-open. O retrato também
carrega o lock do Pi e a declaração de mise do operador, e a primeira invocação de um perfil
instala dentro do container; as seguintes não instalam nada e não precisam de rede. Os dois
diretórios persistentes têm tempos de vida diferentes: a árvore de pacotes do Pi é **por
perfil** (`<home>/toolchains/<perfil>/npm`) e o diretório de dados do mise é **compartilhado
por todos os perfis** (`<home>/toolchains/mise`), com a mesma trava serializando a convergência
de todos.

## Papéis, modelos e autenticação

Modelos são **explícitos** por `provider/model`, configurados por projeto:

- `implementer` (agente principal);
- `reviewer-standards` e `reviewer-spec`;
- `default`, obrigatório para todo outro subagente criado pelo `/implement`.

Um subagente lançado sem modelo explícito, ou com modelo que não corresponde a nenhum
papel configurado, é interrupção — **não há fallback**. O papel `default`, quando usado, é
registrado no log.

A autenticação do modelo pertence à instância (`modelAuth`, uma referência `pi-auth`) e o
perfil de runtime do projeto precisa ser o mesmo diretório de autenticação da instância:
um container nunca roda com credenciais de outra conta. Configuração inválida é erro
visível (`RunnerConfigError`), não uma tentativa silenciosa com outro valor.

## Invocação e resultado

- **Invocação nova** roda até `maxIterations` (o template do piloto usa 5; é configurável e
  deve ser lido como padrão, não como invariante).
- **Retomada e correção** rodam **1 iteração**, continuando a mesma sessão Pi; Sandcastle
  0.12.0 exige uma iteração com `resumeSession`. Não há contador acumulado por trabalho.
- Cada iteração é uma invocação completa do Pi, não um turn/tool call.

O resultado é **estruturado** e é a única forma de desfecho: pedido de ajuda
(`needs_help` com pergunta/contexto), PR pronto (`pr_ready` com referência) ou
interrupção/falha (`interrupted` com motivo). Saída ausente, inválida ou ambígua **não é
sucesso**; sinal presente no prompt/stdout bruto não comprova entrega. Atingir o limite de
iterações sem resultado válido gera pedido de intervenção, não execução ilimitada.

Antes de declarar o fim do parent, os **filhos relevantes são reconciliados**: um filho
lançado sem desfecho registrado (notificação de conclusão para assíncrono, resultado da
ferramenta para síncrono) torna a invocação interrompida. O agente não observa a atividade
interna dos filhos; o log do filho mostra apenas lançamento, atualizações recebidas e
desfecho.

## PR e conclusão

O acompanhamento do PR é do módulo `PrTracking` (`src/core/pr-tracking.ts`): valida
PR pronto, observa o PR, captura feedback e conflitos e pede a conclusão ao
`IssueWrites`, que a confirma por releitura. O `Admission` só delega esse ciclo;
a pausa segura o início de invocações, não esse acompanhamento.

- Um resultado `pr_ready` só é aceito depois de a factory **confirmar no adapter de PR
  (github.com)** que o PR existe, está aberto, tem como base a branch de destino e como
  head a branch do trabalho (`msf/<tracker>/<projeto>/<id>`), no repositório do trabalho.
  Caso contrário é recusado como pedido de ajuda ou exige intervenção.
- O review dos dois eixos (Standards e Spec) roda **dentro** do `/implement`, na mesma
  invocação, com base, diff exato, issue e padrões. A factory entrega o material e a regra,
  mas **não verifica** o review: isso é demonstrado por log/sessão no piloto.
- Depois de publicar o PR, a factory acompanha CI, review e merge pela integração do
  repositório, sem manter o Pi vivo esperando. Novas correções reativam o mesmo trabalho
  com vaga quando disponível.
- **O agente/script não faz merge.** Após confirmação externa do merge do PR vinculado, a
  issue vai para done, confirmado por releitura do tracker. PR aberto, CI verde, fechamento
  sem merge ou afirmação do modelo não bastam. PR fechado sem merge interrompe o trabalho,
  avisa o humano e mantém a issue fora de done; não é reaberto nem reimplementado sozinho.

## Feedback e triagem

Regras de leitura de feedback estão em [trackers](trackers.md). A entrada dirigida ao
trabalho pertence a `src/core/operator-input.ts`: fila de comandos, resposta no terminal,
resposta `agent:` na issue e liberação. O módulo usa o registro e o anunciador, confirma a
liberação por `IssueWrites` e pede retomada pela função pública `Admission.requestContinuation`
já ligada. `pause`/`unpause` continuam endereçando a instância via `InstanceControl`.
O `Admission` mantém a ordem: comandos → respostas dirigidas da issue → PRs em espera →
continuações → trabalho novo por prioridade. O efeito:

- Resposta dirigida (`agent:` na issue ou `reply` no terminal) reativa o trabalho que
  espera ajuda ou continua o interrompido; em trabalho ativo ou interrompido, fica pendente
  para a próxima invocação.
- Comentário humano novo no PR **não vira correção direta**: a correção invoca a triagem
  (`/skill:gh-address-comments`), que numera threads e comentários com resumo e proposta e
  termina como pedido de ajuda, **sem mudar código nem fazer push**. Enquanto a triagem não
  termina, a fase fica explícita: **listando** enquanto a listagem não chega ao pedido de ajuda
  (uma invocação interrompida ou sem desfecho válido não conclui a triagem, e a retomada refaz a
  listagem) e **aguardando escolha** depois dela. Só o que o operador escolher é aplicado, na
  retomada, junto com os demais itens do mesmo lote (**itens retidos**: checks com falha, conflito
  e respostas dirigidas), que não passam pela escolha. Item não citado fica sem ação e com a
  thread aberta.
- Resposta dirigida no lote de uma triagem chega à listagem como orientação do operador e fica
  retida para a retomada que aplica a escolha.
- Lote sem comentário humano do PR — só checks com falha, conflito e/ou respostas dirigidas —
  vai direto para a retomada ou correção, sem triagem.
- Se a skill de triagem não estiver no perfil autorizado, a issue não é admitida e
  comentário humano vira pedido de ajuda visível, nunca correção sem triagem.
- A triagem exige `python3` na imagem do runner; o perfil precisa de `mise`, `ripgrep` e `fd`
  na imagem e da declaração de mise do operador em `local.json` (`mise.<perfil>`) quando
  declarar `required.tools`. `./msf <instância> run --check` relata o que falta e o estado da
  toolchain persistente, e nunca repara.

Feedback nunca amplia escopo, não autoriza merge nem deploy produtivo, e consumir um
comentário não é declará-lo resolvido.

## Supervisão

Os comandos são sempre dirigidos a uma instância, na forma
`./msf [--home DIR] <instância> <comando> [trabalho] [opções]`:

- `run` (`--check`, `--once`), `status`, `logs <trabalho>`, `reply <trabalho> --message
  TEXTO`, `resume <trabalho>`, `release <trabalho>`, `pause`, `unpause`.
- `status` lê os trackers reais e o estado gravado, e **não escreve**: se um tracker não
  responde, o estado local continua na saída e o código de saída é 1. Ele descreve o
  estado gravado; não afirma que o orquestrador está rodando.
- Os comandos de supervisão **enfileiram** a intenção no estado local; a instância aplica
  a fila no próximo ciclo, em ordem. "Enfileirado" não é "aplicado" nem "entregue ao
  agente".
- `pause` impede novas admissões e não encerra trabalhos ativos nem o acompanhamento de
  PRs em espera. `unpause` volta a admitir.
- `resume` pede continuidade sem informação nova; `reply` transmite resposta dirigida;
  ambos têm o mesmo efeito de uma resposta `agent:`, **exceto** enquanto a triagem do
  feedback do PR aguarda a escolha do operador: aí `resume` é **recusado** com uma mensagem
  copiável que orienta responder com `reply … nenhum` (ou com a escolha), pois a triagem
  termina só com essa resposta. Sem sessão/área/perfil necessário, a retomada **não** inicia
  conversa nova: vira pedido de ajuda visível e preserva os artefatos.
- `release` remove a marca de claim e encerra o acompanhamento, preservando área, sessão e
  PR; não move a issue para done nem fecha o PR.

O operador acompanha por tail de logs. O **log principal** mostra transições, falhas e
ações humanas necessárias, com comandos prontos para copiar. O **log detalhado** acompanha
uma invocação. O **log do filho** registra o que o principal observou de cada subagente. O
histórico local continua completo.

## Limites de autonomia

- O agente **nunca faz merge** e **não aciona produção**, nem por ação indireta embutida em
  script.
- Falha do runtime não autoriza execução no host; não há fallback silencioso entre
  autenticações.
- Não há recuperação/replay automático, lock distribuído, promessa de `fsync`/durabilidade
  nem isolamento reforçado contra exfiltração. O estado local é JSON com gravação
  substitutiva; a deduplicação local não é um lock contra outros operadores.
- Reabrir a sessão principal não retoma automaticamente todos os filhos; a continuidade
  incerta volta ao operador.
