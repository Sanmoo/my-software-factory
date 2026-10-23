# my-software-factory (msf-v2)

The minimal software factory: one headless orchestrator (`msf`) that drains a
pool of works (issues) from target repos and turns each into a PR from a
dedicated bot account. The human is the gate — the factory never merges.

## Requirements

- Node 22+
- Docker whose daemon answers on a unix socket: the workers are containers and
  each one inherits that daemon (ADR 0003)
- Docker, for the real local integration test (see Tests)
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
# recovery:                       # an interruption is not a failure (issue 123)
#   max: 3                        # recoveries per attempt; 0 pauses on the first
#   waits-ms: [1000, 4000, 16000] # the backoff before each recovery relaunch
# model-provider:                 # the worker model provider's own budget (issue 144)
#   max-retries: 4                # retries per attempt after model provider failures
#   waits-ms: [15000, 30000, 60000, 120000]  # the backoff before each retry
# liveness:                       # Docker silence suspends launches (issue 118)
#   unavailable-warn-ms: 60000    # one notice after this long; resumes by itself
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
npm run build:image   # provisioning; see RUNBOOK (rebuild after upgrading)
npm run gateway
```

`npm run gateway` is this repository's canonical, mandatory validation:
compilation (tsc's whole-project typecheck — the emitting build fails on type
errors), the whole test suite and the real local Docker integration test, all
under one 240-second wall-clock ceiling. Docker and the worker image are
mandatory prerequisites — a missing one fails the run, it never becomes a
skip. Provisioning and image builds happen before the measured run; LLM
reviews, `npm run proof:real` and `npm run smoke:github` stay outside it. At the deadline the running check and
its subprocesses are killed and the interrupted check is named.

Exit status: `0` passed, `2` missing prerequisite, `124` budget exhausted;
otherwise the failing check's status (`1` when it reported none, `127` when it
could not start).

`npm test` remains a focused run during development and never substitutes for
the gateway.

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
