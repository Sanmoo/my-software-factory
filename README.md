# my-software-factory (msf-v2)

The minimal software factory: one headless orchestrator (`msf`) that drains a
pool of works (issues) from target repos and turns each into a PR from a
dedicated bot account. The human is the gate — the factory never merges.

## Requirements

- Node 22+
- Docker whose daemon answers on a unix socket: the workers are containers and
  each one inherits that daemon (ADR 0003)
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
# notifications: true
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
(`desfecho.json` schema, labels, PR existence, PR mergeability and required
check results) — never LLM prose.

## Tests

```sh
npm run gateway
```

`npm run gateway` is the canonical quality gateway — the complete deterministic
validation of this repository, under one 240-second wall-clock ceiling:

- it starts by deleting `dist/`, then compiles (tsc type-checks as it emits, so
  no separate `typecheck` pass is repeated), then runs the whole
  `dist/**/*.test.js` suite, including the real local Docker integration test;
- Docker and the worker image are mandatory prerequisites checked before any
  check runs: `npm run build:image` once after installing/starting Docker;
  dependency installation and image builds are prepared before the measured
  run and are outside the budget;
- LLM reviews, `npm run proof:real` and `npm run smoke:github` depend on live
  systems and stay outside this deterministic contract;
- at the deadline the running check and its subprocesses are killed and the
  interrupted check is named; exceeding the budget fails the gateway even if
  the checks would pass;
- exit status: `0` all checks passed within the ceiling, `2` a prerequisite
  is missing, `124` the budget was exhausted, otherwise the failed check's
  own status.

Focused runs (`npm test`, a single test file) stay available during
development, but only the gateway validates a Work as ready. A new
deterministic check required for readiness joins the gateway and shares the
same budget; an overrun is fixed with performance work, never by removing,
skipping or optionalizing a required check.

Deterministic and hermetic: the tracker and the worker runtime are fakes; the
workspace uses a real temp dir — the disk is never mocked, and the git host
side is exercised with local bare remotes as fixtures. No GitHub, no
credentials, no network.

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
immediate) and the open-issues listing is re-checked once, non-blocking,
after the cycle's last operation. Every
operation is executed, verified and **reverted** — comments deleted, labels
and assignees removed, blockers unlinked, PR closed, branches deleted,
issues closed. Without the bot token in the gh keyring
(`gh auth token --user bot-do-samuca`) the smoke is skipped with the reason,
and `msf run` fails at boot with a clear message.
