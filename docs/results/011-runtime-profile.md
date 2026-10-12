# 011 — Perfil de runtime resolvido no host (issue #43, ADR 0002)

Verificação manual com Docker, perfil `pessoal` (o `~/.pi/agent` do operador, que chega ao dotfiles por links em
vários níveis). A imagem é a `msf-docker-runner:local` existente (Pi 1.1.0); os scripts vêm do repositório pelo
mount `/msf-runtime`. O percurso foi o do runner, menos a chamada de modelo: `planSnapshot` e `writeSnapshot`
sobre o perfil real, depois `docker run` com os mounts de `sandboxMounts` (só o retrato, os scripts e as sessões)
e o comando de `profileSetupCommand`.

Declaração usada (a lista inicial da issue): arquivos `settings.json` e `auth.json`; pacote `npm:pi-subagents`;
skills `implement`, `tdd`, `code-review`, `gh-address-comments`; agents `implementer`, `code-reviewer`,
`spec-reviewer`; exclusão `npm:pi-lens`. Raízes permitidas: `~/.pi/agent`, `~/.agents`,
`~/dev/github.com/Sanmoo/dotfiles`.

## Resultado

| Critério | Resultado |
| --- | --- |
| Obrigatórios resolvem no host | Sem bloqueio: 43 itens, 96 arquivos no retrato |
| `pi list` no container mostra `pi-subagents` | Sim, instalado (`/home/agent/.pi/agent/npm/node_modules/pi-subagents`) |
| `settings.json`, `AGENTS.md` e `agents/` no container | Sim: `settings.json`, `AGENTS.md`, `agents/{implementer,code-reviewer,spec-reviewer}.md` |
| Link cíclico `gh-address-comments/gh-address-comments` não interrompe | Item pulado e listado (`link cíclico: ... volta a ..., já percorrido`); a skill entrou |
| `npm:pi-lens` | Retirado do `settings.json` do container, listado no plano; não instalado no container |
| Container sem `~/.pi/agent`, `~/.agents` ou raízes de link | Sim: `/Users` e `~/.agents` não existem no container; só `/msf-profile` (retrato, `ro`), `/msf-runtime` (`ro`) e as sessões |
| Pacote obrigatório não instalado | Falha com `profile-check: required package not installed: npm:nao-existe-xyz-123` e código 1 |

Fora do retrato, com o motivo no log detalhado (links do trabalho, fora das raízes do `pessoal`):

- `skills/pr-driver` e `skills/technical-refiner` → `~/dev/github.com/samuel-santos_bjd/bjd-skills/...`;
- `extensions/bifrost-dynamic-models.ts` → `~/dev/github.com/samuel-santos_bjd/my-bjd-dot-files/...`.

Custo: a instalação dos pacotes do `settings.json` levou cerca de 84 s no container (cold start, como previsto no
ADR). O limite do hook de setup foi para 10 minutos (o padrão do Sandcastle é 60 s).

## Limites

- A ferramenta `subagent` não é confirmada no container: o Pi 1.1.0 não lista ferramentas sem chamar o modelo.
  A evidência é o pacote `pi-subagents` instalado.
- A invocação completa com modelo (Sandcastle, hook, agente) não foi repetida nesta verificação; os testes
  automatizados cobrem o runner com o boundary falso, e os scripts rodam contra um `pi` de mentira em
  `test/profile-scripts.test.ts`.
- No macOS com Docker Desktop, o diretório de estado precisa estar num caminho compartilhado com o Docker
  (`/Users/...`); `$TMPDIR` (`/var/folders/...`) monta vazio. O padrão (`.msf/state` no repositório) já cumpre.
