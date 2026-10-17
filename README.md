# my-software-factory (msf-v2)

The minimal software factory: one headless orchestrator (`msf`) that drains a
pool of works (issues) from target repos and turns each into a PR from a
dedicated bot account. The human is the gate — the factory never merges.

## Requirements

- Node 22+
- Config in `msf.yaml` in the working directory (or `--config <path>`):

```yaml
# msf.yaml — only two fields are required; every optional field defaults
worker-gh-account: bot-do-samuca
repos:
  - Sanmoo/my-tasks

# opcionais (defaults na fábrica):
# concurrency: 2                  # the `y` — worker slots in process
# workspace: ~/.local/share/msf   # repos/, trabalhos/, arquivo/ live under it
# labels:
#   ready: ready-for-agent
#   claimed: agent-claimed
#   blocked: agent-blocked
```

## Usage

```sh
npm install
npm run build
node dist/cli.js run --once   # one sweep; exits 0 when the pool is empty
node dist/cli.js status
```

## Layout

```
src/
├── cli.ts              # `msf run [--once] [--config <path>]` · `msf status`
├── config.ts           # loads msf.yaml + defaults; a missing optional field is never an error
├── layout.ts           # workspace: repos/ · trabalhos/ · arquivo/
├── loop.ts             # the thin loop: owner of time, the --once boundary, waking by event
├── tracker/
│   ├── port.ts         # TrackerPort: the 9 operations + rank (honest null)
│   └── fake-adapter.ts # in-memory fake: deterministic scenarios, no network
├── state/
│   ├── derive.ts       # stateless re-read → pool of eligibles, ordered by createdAt
│   └── outcome.ts      # the ruler: classifies desfecho.json — structured facts only
├── pool/
│   └── slots.ts        # the y slots in memory; nothing here survives a restart
└── runtime/
    ├── port.ts         # WorkerRuntime: how a session is born
    └── fake-runtime.ts # scripted worker outcomes — the ruler's test seam
```

Two rulers, one contract: the worker's obligations live in its prompt; the
factory's classification lives in code and reads only structured facts
(`desfecho.json` schema, labels, PR existence) — never LLM prose.

## Tests

```sh
npm test
```

Fast and deterministic: the tracker and the worker runtime are fakes; the
workspace uses a real temp dir — the disk is never mocked.
