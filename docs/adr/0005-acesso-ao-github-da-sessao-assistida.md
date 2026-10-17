# A sessão assistida acessa o GitHub com a credencial da conta do projeto, entregue por arquivo de ambiente removido por evidência

O atendimento humano assistido (especificação #48) roda `pi` interativo **dentro** de um container,
no clone do operador, e o agente precisa trabalhar de verdade com o repositório e a issue: `gh issue
view`, leitura de PR e checks, escrita na própria issue sob condução do operador. Até aqui o fluxo
assistido cunhava o token da conta do projeto no preflight e **descartava o retorno**
(`src/core/assist-flow.ts`, `prepare`), então o container não tinha credencial nenhuma. O caminho
autônomo entrega a mesma credencial como `docker run -e GH_TOKEN=<valor>` (via o `env` do sandbox do
Sandcastle), o que **não** serve aqui: o valor entra no argv do cliente docker — visível no `ps` de
qualquer usuário do host e no texto que a aba digita.

A fronteira que este ADR fixa: **o que a sessão assistida recebe e por qual mecanismo**.

1. O núcleo cunha o token da conta do projeto do trabalho (`project.githubAccount`) no preflight,
   **antes do claim**, e o mantém só em memória (`PreparedOpening.token`): o registro da sessão
   nunca o carrega. Sem token utilizável, a abertura é **recusada** antes do claim, com o motivo
   visível nomeando a conta — **não há fallback** para a credencial ambiente do host nem para outra
   conta.
2. A entrega é por **arquivo de ambiente**: `GH_TOKEN=<token>` num arquivo 0600 dentro de diretório
   0700 no diretório de estado da execução (o mesmo `/msf-state` do canal de fim), nomeado no comando
   por `docker run --env-file <caminho>` — antes da imagem. O CLI do docker lê o arquivo
   **client-side**: só o caminho entra no argv, no texto da aba e no `ps`; o **valor** nunca é
   escrito em nenhum texto que a fábrica produz (aba, `ps`, log principal, log detalhado, registro
   da sessão). O valor também é registrado no observador (`registerSecret`), como defesa em
   profundidade de quem escreve os logs de verdade.
3. A remoção é por **evidência, nunca por relógio**: o `--env-file` é lido antes de o container ser
   criado, então a existência do container (`docker inspect` pelo nome, a mesma prova de identidade
   da supervisão, ticket #58) prova que o cliente docker já terminou de ler o arquivo, e ele sai
   ali. A espera é limitada (~30 s): um start que o probe não vê dentro do orçamento **mantém** o
   arquivo — um start lento não é morto pelo relógio — e os caminhos que provam o destino do exec
   removem a sobra: a recuperação de uma execução comprovadamente viva, a reconciliação pós-reinício
   (abertura nunca lançada e fim comprovado), o fim provado pela supervisão (registro de fim ou
   identidade) e a liberação do operador. Se o `paneRun` falhar, nada pode ter lido o arquivo e ele
   sai com a falha.
4. O preflight real passa a limpar `GH_TOKEN`/`GITHUB_TOKEN` do ambiente da chamada
   `gh auth token --user <conta>` (a mesma higiene do boundary do tracker,
   `src/tracker/github.ts`), mantendo a conta nomeada como fonte única; a mensagem de recusa nomeia a
   conta e a ausência de fallback.
5. O **prompt inicial assistido segue como está**: nenhum corpo de issue é injetado; o agente lê a
   issue com a credencial que agora tem.

## Considered Options

- **`docker run -e GH_TOKEN=<valor>` (o que o fluxo autônomo faz).** Rejeitado: o valor entra no argv
  do cliente docker, visível no `ps`, e no texto que a aba digita — exatamente o que o ticket
  proíbe. (No caminho autônomo o processo `docker run` é do próprio runner, não de uma aba do
  operador.)
- **Ler `GH_TOKEN` do ambiente do host e repassá-lo.** Rejeitado: a credencial seria a do operador e
  não a da conta do projeto do trabalho, e uma conta trocada no host passaria a decidir quem escreve
  na issue; sem a conta do projeto, a abertura tem de recusar, não improvisar.
- **Montar o arquivo e dar `source` num wrapper dentro do container.** Rejeitado: o valor termina no
  ambiente do processo do container do mesmo jeito, a receita fica mais invasiva (montagem extra e
  um passo de shell a mais no caminho estrito de convergência do ADR 0004) e o ticket pede
  explicitamente um arquivo de ambiente. A exposição residual em `docker inspect` é a mesma.
- **Injetar a credencial pelo prompt ou por um arquivo lido pelo agente.** Rejeitado: o prompt é
  texto da aba e vai para os logs do Pi; a credencial passaria a ser conteúdo de conversa.
- **Remover o arquivo por tempo (por exemplo, alguns segundos após o `paneRun`).** Rejeitado: o
  `paneRun` só digita o comando; quem cria o container é o cliente docker, e remover antes de o CLI
  ler faz o `docker run` falhar com ENOENT — a sessão ficaria aberta sem container e sem canal de
  fim. A remoção dispara pela prova de que o container existe.
- **Nunca remover o arquivo.** Rejeitado: seria uma credencial em repouso no diretório de estado,
  legível por qualquer processo do usuário, para sempre.

## Consequences

- A credencial da sessão assistida é a **conta do projeto do trabalho**, e somente ela: falta de
  token recusa a abertura antes do claim, com o motivo visível no log principal e no diagnóstico
  `msf assist`, sem fallback para outra conta nem para a credencial ambiente.
- O container recebe `GH_TOKEN` e `gh` funciona para a issue do trabalho; o `git` funciona no clone
  montado (o remoto do clone é do operador). **Push por HTTPS não é prometido** por este ADR: quem
  decide o que sai do container continua sendo a condução do operador, e a credencial habilita a
  escrita na issue, não um fluxo de PR.
- Exposição residual **aceita**: `docker inspect <container>` mostra `GH_TOKEN` no `Config.Env` de
  quem pode falar com o daemon (o grupo `docker`), e o arquivo existe dentro de `/msf-state` — o
  mesmo mount do container que recebe a credencial — pela janela curta entre a digitação do comando
  e a criação do container. Para a lista do ticket (aba, `ps`, log principal, log detalhado) a
  fronteira está fechada por teste.
- A sobra do arquivo em um start que o probe não viu é removida pela recuperação de uma execução
  comprovadamente viva, pela reconciliação, pelo fim provado pela supervisão e pela liberação;
  enquanto nenhum desses caminhos falar, o arquivo fica (credencial em repouso 0600 no diretório de
  estado do usuário) — nunca removido por tempo, porque um start lento não pode ser morto pelo
  relógio. O registro da sessão continua sem carregar a credencial, e o caminho do arquivo é
  derivado do diretório de estado que o registro já tem (nenhum campo novo de registro).
