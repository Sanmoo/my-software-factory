# my-software-factory (msf-v2)

The minimal software factory: one headless orchestrator (`msf`) that drains a
pool of works (issues) from target repos and turns each into a PR from a
dedicated bot account. The human is the gate — the factory never merges.

## Requirements

- Node 22+
- Config in `msf.yaml` in the working directory (or `--config <path>`):

```yaml
# msf.yaml — three required fields; every optional field defaults
worker-gh-account: bot-do-samuca
worker-model: opencode-go/glm-5.3-flash
repos:
  - Sanmoo/my-tasks

# opcionais (defaults na fábrica):
# concurrency: 2                  # the `y` — worker slots in process
# workspace: ~/.local/share/msf   # repos/, trabalhos/, arquivo/ live under it
# labels:
#   ready: ready-for-agent
#   claimed: agent-claimed
#   blocked: agent-blocked
# profile-allowed-roots:          # roots the Pi profile reaches through links
#   - ~/dev/github.com/Sanmoo/dotfiles
#   - ~/.agents
#   - ~/.local/share/omarchy
# profile-skip-dangling-links: false  # stale profile links: fail closed
# notifications: true             # local Linux desktop notices: see the RUNBOOK
```

## Usage

```sh
npm install
npm run build
# all real components: GitHub adapter (keyring boot check) + Sandcastle
# runtime (a real worker per launch, needs the worker image built)
node dist/cli.js run --once  # one sweep
node dist/cli.js run         # sweeps forever
node dist/cli.js status      # the trail, read-only
```

The worker model is required in `msf.yaml`; invocations do not select it.
Move any model previously selected on the command line into `worker-model`.
The live proof's exact script — commands, what the human does, the REST
budget — lives in the [RUNBOOK](docs/RUNBOOK.md) (ticket 18).

## Design

Two rulers, one contract: the worker's obligations live in its prompt; the
factory's classification lives in code and reads only structured facts
(`desfecho.json` schema, labels, PR existence) — never LLM prose.

## Tests

```sh
npm test
```

Fast and deterministic: the tracker and the worker runtime are fakes; the
workspace uses a real temp dir — the disk is never mocked. The git host side
is exercised with local bare remotes as fixtures — no GitHub, no network.

## Real smoke (credential-gated)

The GitHub adapter's behavior against the real thing:

```sh
npm run smoke:github
```

Runs the full cycle of one issue against the repo of the config example
(`Sanmoo/my-tasks`, override with `MSF_SMOKE_REPO`) as the bot account
(`MSF_SMOKE_ACCOUNT`) — the same contract suite the fake satisfies runs
OFFLINE in `npm test`, over the in-memory REST sim; the full cycle alone is
the real thing's empirical proof. Eligibility is proven via DIRECT reads
right after seeding (listings converge late on GitHub; direct GETs are
immediate) and `candidates()` is re-checked once, non-blocking, after the
cycle's last operation. Every
operation is executed, verified and **reverted** — comments deleted, labels
and assignees removed, blockers unlinked, PR closed, branches deleted,
issues closed. Without the bot token in the gh keyring
(`gh auth token --user bot-do-samuca`) the smoke is skipped with the reason,
and `msf run` fails at boot with a clear message.
