# Teste 005 — spike Docker: filho async, ajuda e retomada no Sandcastle

Data: 2026-10-11. Modelo **github-copilot/gpt-6-luna** para pai e filho (reviewers
não foram executados). Runtime: Sandcastle 0.12.0 com `docker()`, sem noSandbox.
**Resultado: aprovado no recorte do spike** (pai, filho async, pedido de ajuda,
resposta e retomada da mesma sessão em containers diferentes; área Git e sessão
sobreviveram). Não altera o MVP, não usa tracker real, não usa PR nem N>1.

## Versões

- Host: macOS arm64, Node 22.23.2, Pi 1.1.0 (`@earendil-works/pi-coding-agent`),
  pi-subagents 0.77.0 (perfil pessoal), Sandcastle 0.12.0.
- Docker: Engine 29.2.1 (client 29.5.2), daemon em VM Linux aarch64 (colima).
  `docker info` executado antes da prova; o script também o verifica no preflight.
- Imagem `msf-docker-spike:local`: base `node:22-bookworm-slim` (dentro: Node
  22.23.3, Debian 12, git 2.39.5), Pi 1.1.0, usuário com UID/GID 502/20 do host.
- Dentro do container: pi-subagents 0.77.0, instalado pelo próprio Pi no primeiro
  start (~100 s por container, pois o npm não é persistido). Pacotes do perfil
  resolvidos no install (ex.: rpiv-todo com faixa diferente da do host).

## Setup necessário

1. Build com UID/GID do host:
   `docker build --build-arg AGENT_UID=$(id -u) --build-arg AGENT_GID=$(id -g) -t msf-docker-spike:local src/experiments/docker-spike`
2. Token: `gh auth token --user Sanmoo` lido no host e passado somente como env
   `GH_TOKEN` do container. Nunca escrito em repo/log. `gh auth status` antes e
   depois da prova idêntico (`activeGhUnchanged: true`); nenhum `gh auth switch`.
3. Perfil: `~/.pi/agent`, `~/.agents` e o dotfiles pessoal montados **somente
   leitura** nos mesmos caminhos do host. `prepare-profile.sh`, no container,
   copia para um `~/.pi/agent` local descartável. O `auth.json` do host não foi
   alterado (mtime anterior às execuções).
4. Execução em duas invocações, como no 004:
   `SMOKE_MODEL=github-copilot/gpt-6-luna npm run smoke:docker` (ajuda) e depois
   `SMOKE_MODEL=... SMOKE_RUN=<área> SMOKE_REPLY='...' npm run smoke:docker` (retomada).

## Observado dentro do Docker

Área `.smoke/docker-spike/4ff36694-…` (execução que passou; as duas anteriores
estão descritas abaixo). Evidências brutas ignoradas pelo Git.

- **Falha de Docker visível:** imagem inexistente foi recusada pelo Sandcastle
  antes de qualquer container (`Image ... not found locally`); o script registrou
  `fallbackUsed: false`.
- **Fase de ajuda** (container `36db20179086`): o pai lançou exatamente um filho
  `spike-child`, `async: true`, `model: github-copilot/gpt-6-luna`. A meta do filho
  confirma `requestedModel` igual e `exitCode` 0. O marcador oculto do filho
  apareceu na pergunta final do pai, portanto o resultado do filho chegou ao pai.
  O pai criou um commit de checkpoint (`c76ecc3`) com a pergunta, emitiu
  `needs_help` e `<promise>HELP</promise>`. Sessão `01a12c30-…` persistida no
  host. Nenhum erro de ferramenta.
- **Retomada** (container `d5f96304d8f4`, diferente do primeiro): mesmo `sessionId`
  (`sameSession: true`). Sandcastle registrou `Resuming session` e reinjetou a
  sessão do host no container. O marcador `~/.msf-layer-marker`, escrito no
  container da fase de ajuda, estava ausente. O commit de checkpoint estava no
  workspace. O pai implementou `slugify` com testes e commitou (`006a9cc`), com
  `status: complete`. No host, `node --test` passou 4/4 e a árvore ficou limpa.
- **Skill:** `/skill:implement` expandiu a skill copiada para o container (bloco
  `<skill name="implement">` no prompt inicial). A skill TDD foi lida na retomada.
- **Descarte:** nenhum container `sandcastle-*` restou após cada fase.

Duas tentativas anteriores, também reais e mantidas como evidência:

1. Área `2bb4d1eb-…`: sem `ENTRYPOINT` na imagem, o container base (REPL do Node)
   encerrou e o setup do Sandcastle falhou com `container ... is not running`.
   Nenhum modelo foi chamado. Corrigido com `ENTRYPOINT ["sleep", "infinity"]`,
   igual ao template Pi do Sandcastle.
2. Área `689b9554-…`: o filho e a pergunta foram executados, mas o Pi-lens iniciou
   um servidor LSP (`marksman`) que travou e gravou um core de 65 MB no workspace.
   A asserção de árvore limpa falhou corretamente. Corrigido excluindo `npm:pi-lens`
   apenas da cópia de `settings.json` do container.

## Observado vs apenas documental

Observado ao vivo: tudo que está na seção anterior, incluindo a falha de imagem
ausente, a sessão persistida no host, a troca de container (IDs distintos),
o filho async com modelo explícito e o commit persistido entre containers.

Apenas documental (não exercitado ao vivo):
- falha de perfil incompleto e ausência de token (caminhos de erro do preflight);
- daemon Docker indisponível;
- recriação após falha abrupta (só houve remoção normal);
- queda de um filho no meio da execução;
- reviewers, trackers Jira/GitHub, concorrência N e PR.

## Diferenças em relação aos smokes noSandbox (003/004)

- **Runtime:** Pi roda no container; no 003/004 roda no host. Um repositório
  local com node_modules darwin não serve ao container, então o teste usa
  `node --test` nativo da fixture.
- **Persistência de sessão:** `~/.pi/agent/sessions` do container é um bind
  mount rw do sessions da área, com `captureSessions: false`. Assim sessões de
  filhos também ficam fora do container. Nos smokes não havia cópia nem mount.
- **Perfil:** o container recebe um subconjunto do perfil pessoal. Links para
  raízes de conta de trabalho (`bifrost-dynamic-models.ts`, `pr-driver`,
  `technical-refiner`) foram pulados por não estarem montados. Nos smokes o
  perfil inteiro era usado no host.
- **pi-lens excluído do container:** o crash de LSP foi observado somente
  aqui, porque nos smokes o perfil inteiro roda em macOS com binários nativos.
- **Cold start:** cada container reinstala os pacotes do perfil (~100 s).
  No host isso já está instalado.
- **Segredo:** `GH_TOKEN` aparece em `docker inspect` enquanto o container existe
  e em argumentos de `docker run` por instantes. É limite do env do Sandcastle,
  não usado aqui por arquivo montado.
- **Versões:** Node 22.23.3 no container, 22.23.2 no host.
- **Saída de teste compactada:** a saída de `npm test` foi compactada pelo
  `pi-rtk-optimizer`, que mostrou `FAIL: 1` com o TAP todo passando. Esse é o
  mesmo problema de contagem ambígua registrado no 004. Não é específico do
  Docker, mas foi visto no container. A asserção final foi feita pelo host.
- **Atestado de subagente:** o pi-subagents marcou o filho como
  `acceptance: rejected` (sem evidência entregue), com `exitCode` 0. Não bloqueou.

## Custo dentro do envelope

Somente gpt-6-luna. Valores são estimativas de custo reportadas pelo próprio Pi
para as chamadas; não são fatura do Copilot.

- Fase de ajuda (área final): 43.690 tokens, US$ 0,00158; filho: US$ 0,00013.
- Retomada (área final): 154.062 tokens, US$ 0,00340.
- Tentativa 2 (área `689b…`, fase de ajuda com o core): US$ 0,00187.
- Sonda manual `PONG` antes do spike: US$ 0,00118. Sonda de versão do pacote: não capturada.
- Total registrado: cerca de US$ 0,008. Tempo: ajuda 116 s e retomada 147 s, mais
  ~100 s de cold start do pacote por container.

Veredito: ficou dentro do envelope de modelo barato observado. O ticket não fixa
número; o operador confirma se o valor serve.

## Limites e riscos residuais

- **Reviewers não foram executados.** O brief citava reviewers; os modelos deles
  seriam explícitos pela mesma regra, mas não há prova ao vivo.
- **A resposta da retomada foi roteirizada pelo implementer** (`SMOKE_REPLY`) para
  uma fixture descartável. Não é decisão humana real.
- **Filho sem evidência:** o `acceptance: rejected` do pi-subagents é do atestado
  padrão do filho, não da prova do spike.
- **Token de conta:** o `auth.json` copiado mantém o refresh dentro do container.
  O host não foi alterado, mas o refresh não foi observado diretamente.
- **Sem tracker, PR, N>1 nem deploy.**

## Reprodução

```sh
docker info
docker build --build-arg AGENT_UID=$(id -u) --build-arg AGENT_GID=$(id -g) \
  -t msf-docker-spike:local src/experiments/docker-spike
npm ci --ignore-scripts
npm test
npm run typecheck
SMOKE_MODEL=github-copilot/gpt-6-luna npm run smoke:docker
# após a pergunta, resposta real ou roteirizada explícita:
SMOKE_MODEL=github-copilot/gpt-6-luna SMOKE_RUN=CAMINHO_DA_AREA \
  SMOKE_REPLY='resposta' npm run smoke:docker
```

Requer Docker, Copilot autenticado no perfil e `gh` com a conta `Sanmoo`. Faz
chamadas ao modelo; nunca roda nos testes unitários.
