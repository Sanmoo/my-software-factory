# my-software-factory (msf-v2)

The minimal software factory: one headless orchestrator (`msf`) that drains a
pool of works (tickets) from target repos and turns each into a PR from a
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
# workspace: ~/.local/share/msf   # repos/, trabalhos/, arquivo/, retros/ live under it
# labels:
#   ready: ready-for-agent
#   claimed: agent-claimed
#   blocked: agent-blocked
# worker-auth-file: ~/.secrets/msf-auth.json  # optional Pi auth.json; otherwise
#                                               # a supported provider API-key
#                                               # env var is forwarded
# recovery:                       # an interruption is not a failure (issue 123)
#   max: 3                        # recoveries per attempt; 0 pauses on the first
#   waits-ms: [1000, 4000, 16000] # the backoff before each recovery relaunch
# model-provider:                 # the worker model provider's own budget (issue 144)
#   max-retries: 4                # retries per attempt after model provider failures
#   waits-ms: [15000, 30000, 60000, 120000]  # the backoff before each retry
# liveness:                       # Docker silence suspends launches (issue 118)
#   unavailable-warn-ms: 60000    # one notice after this long; resumes by itself
# notifications: true
# retro:                          # the retrospective job (issue 141, ADR 0006)
#   enabled: false                # automatic rounds at sweep time
#   threshold: 5                  # archived works since the last report
#   model: anthropic/claude-opus-4.5  # dedicated model; defaults to worker-model
#   language: en                  # the report and every filed item, one per round
#   factory-items-destination: Sanmoo/my-software-factory  # required when enabled
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
node dist/cli.js retro       # force a retrospective round (full window)
node dist/cli.js retro <owner>/<name>#<n>  # a post-mortem of one finished work
```

The worker model is required in `msf.yaml`; invocations do not select it.
Move any model previously selected on the command line into `worker-model`.
`npm run build:image` provisions every declared skill, extension and reviewer
agent into the image. The operator's exact script — build, model credentials,
clean-host verification and the real proof — lives in the
[RUNBOOK](docs/RUNBOOK.md).

The retrospective files `needs-triage` issues and never labels anything
`ready-for-agent`: the operator's triage is the only gate between an
improvement item and the pool.

## Design

Two rulers, one contract: the worker's obligations live in its prompt; the
factory's classification lives in code and reads only structured facts
(`desfecho.json` schema, labels, PR existence, PR mergeability and required
check results) — never LLM prose.

The worker's agent environment is factory-owned and needs nothing of Pi on the
host: only the resources declared in `agent-resources.yaml` load, target-project
and host skills/packages are ignored, and model credentials are supplied
separately (ADR 0001; build and verification in the [RUNBOOK](docs/RUNBOOK.md)).

## Tests

```sh
npm run build:image   # provisioning (RUNBOOK)
npm run gateway
```

`npm run gateway` is this repository's canonical, mandatory validation:
compilation (tsc's whole-project typecheck — the emitting build fails on type
errors), the whole test suite and the real local Docker integration test, all
under one 240-second wall-clock ceiling. Docker and the worker image are
mandatory prerequisites — a missing one fails the run, it never becomes a
skip. Provisioning and image builds happen before the measured run; the suite
includes a real container check of what the provisioned image actually loads
(declared skills only, no package cache, no host profile). LLM reviews,
`npm run proof:real` and `npm run smoke:github` stay outside it. At the deadline
the running check and its subprocesses are killed and the interrupted check is
named.

Exit status: `0` passed, `2` missing prerequisite, `124` budget exhausted;
otherwise the failing check's status (`1` when it reported none, `127` when it
could not start).

`npm test` remains a focused run during development and never substitutes for
the gateway.

The fakes are hermetic: the tracker and the worker runtime are fake; the
workspace uses a real temp dir — the disk is never mocked, and the git host
side is exercised with local bare remotes as fixtures. No GitHub and no model
credentials; the checks that start real containers use the local daemon only,
with `--network none` where the assertion is about what the image contains.

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
