# RUNBOOK — the live proof of v0.1

The factory is wired end to end with only real components: the real GitHub
adapter (`gh` keyring token at boot), the real Sandcastle runtime (Pi
headless in a container, agent resources provisioned by the image), the real
git host. This is the exact script of the live proof: a real issue → worker →
PR opened by the configured account → human feedback → merge. In v0.1 that
account is the operator's: GitHub hides `bot-do-samuca`, and the accepted risk
is the operator PAT inside the unrestricted container — as is the host's
Docker socket riding inside it (ADR 0003). Factory speech is the
`<!-- msf:agent -->` marker, not a different login.

## Before the first run (once)

```sh
# 1. the worker image (npm run build:image) — rebuild after upgrading: the
#    boot also refuses an image without the continuity guardrail (a resumed
#    session could repeat an external effect)
npm run build:image

# 2. model credentials, separate from the image and from any personal profile:
#    export OPENCODE_API_KEY=...        # or another supported provider key
#    # or worker-auth-file: /path/to/auth.json in msf.yaml
#    msf run (including --once) checks credentials offline before any sweep,
#    tracker access or workspace changes; failure exits 1, naming the model and
#    provider. This checks configuration, not whether the provider accepts the
#    key: a wrong key surfaces at the model call. It never prints the value or
#    inherits ~/.pi/agent. Only Pi's documented provider variables are forwarded
#    — keep the factory's environment to the one your model needs.

# 3. the bot credential in the gh keyring (the boot check reads it;
#    the SAME token is injected as GH_TOKEN inside the worker container;
#    the image ships the `gh auth git-credential` helper that `git push`
#    uses to read that token — the boot refuses an image without it, so a
#    stale image fails with `npm run build:image` instead of a blocked round)
gh auth token --user Sanmoo   # must print a token; v0.1 uses the operator account

# 4. the config — a working directory with msf.yaml, e.g.:
cat > msf.yaml <<'EOF'
worker-gh-account: Sanmoo
worker-model: opencode-go/glm-5.3-flash
repos:
  - Sanmoo/my-tasks        # the target repo(s) — this account must have write
concurrency: 2
workspace: ~/.local/share/msf
# worker-auth-file: ~/.secrets/msf-auth.json   # optional; else a provider env key
EOF
```

## The worker's agent environment

`agent-resources.yaml` is the single declaration of the environment: Pi, the
selected upstream skills at an immutable commit, the delegation extension with
its operating guidance, and the reviewer agents. `npm run build:image` fetches
and verifies all of it, records the result in `/opt/msf/agent-inventory.json`,
and moves the tag (`workerImage` in `package.json`) only on success.

- **Update a resource**: change `agent-resources.yaml` in a reviewed commit and
  rebuild. Never edit a running image.
- **Upgrading from the profile snapshot**: delete `profile-allowed-roots` and
  `profile-skip-dangling-links` from `msf.yaml`.
- **Diagnose**: `docker run --rm --network none --entrypoint cat msf-v2-worker:local /opt/msf/agent-inventory.json`
  (the default tag; a launch whose image differs from this checkout's
  declaration refuses to start the worker and names the rebuild command).
- **Concurrent checkouts**: give each checkout its own tag by exporting
  `MSF_WORKER_IMAGE` before `build:image` and `gateway`, so two checkouts on one
  Docker host do not overwrite each other's image.
- **Clean host check**: with no `~/.pi/agent` and no Pi installed, rebuild, run
  the gateway, then `node dist/cli.js run --once`.

## Real proof (operator credentials, not automatic)

```sh
MSF_REAL_PROOF_MODEL=provider/model-id npm run proof:real
# or MSF_REAL_PROOF_AUTH_FILE=/path/to/auth.json
```

This starts the built image on an empty cache, implements a local spec and
requires two distinct reviewer subagents plus the outcome record. ADR 0001's
GitHub-delivery half (an actual PR in an authorized disposable repo) remains an
operator-gated run: no credentials or disposable repo are assumed here, so it is
recorded as outstanding rather than claimed.

## Toolchains — the convergence layer

The worker image ships the `mise` binary (its apt repo, mise.jdx.dev/deb) and
the agent's PATH starts with `/home/agent/.local/share/mise/shims`. The
runtime binds the workspace dir read-write into every container:

```sh
<workspace>/toolchains/mise → /home/agent/.local/share/mise (RW)
```

The writable volume is deliberately outside the image-provisioned agent
resources: no cache or mount can hide or replace them.

The container is recreated per work; these volumes survive. Convergence
happens INSIDE the volume across launches — the runtime and the worker
prompt NEVER pre-install a toolchain:

- **First launch of a new toolchain pays the install**: the worker runs
  `mise install go` (or `mise use go@<version>` in the repo) and the
  toolchain, its shims and its cache land in the bind-mounted volume.
- **Every later launch reuses it**: a fresh container over the same volume
  resolves `go`, `node`, `python`… through the persisted shims — no install,
  no download, steady start. The empty `shims/` on a first launch is
  harmless on PATH (nothing resolves there until the first `mise install`).

This is the live-proof lesson the binds fix: the work needed Go and the
worker burned its run hunting a toolchain (`go: command not found`). With
the layer in place, one launch installs; the factory's remaining launches
inherit.

The orchestrator converges BEFORE the prompt: a second sandbox-ready hook
runs `mise install -y` (30 min ceiling) against the active configs — the
toolchain volume's global config and the repo's `mise.toml`, when it declares
one. The session NEVER hunts a declared tool: it is there or the launch
fails fast. The worker still may run `mise install` for tools a work adds
declarations for mid-flight — that is the exception, not the design.

## Docker inside the worker (ADR 0003)

A worker container inherits the HOST's Docker daemon, so `docker` works inside it
— it builds the worker image (`npm run build:image`) and runs the repo's real
Docker tests.

- A **socket-based** daemon is required: the default `/var/run/docker.sock`, or
  the path `DOCKER_HOST=unix://…` names. Anything else is refused at launch
  with the reason.
- Socket access is root on this host. That is the accepted risk, like the
  operator PAT riding inside the container.
- Containers a worker starts are the host's siblings: a bind path resolves on
  the HOST. The worktree and the workspace are mirrored at their host paths;
  container-only paths (`/msf-work`, the container's `/tmp`) are not — the
  real-model proof (`npm run proof:real`) is therefore an operator-machine run,
  never a worker one.

## (a) One-shot: claim + launch a real worker

Label a real issue with `ready-for-agent` on the target repo, then:

```sh
msf run --once
```

The sweep derives the pool from the tracker and claims the issue
(`ready-for-agent` → `agent-claimed`) BEFORE any launch, clones the repo,
creates the work branch `agent-issue-<n>` and launches ONE real worker (Pi,
container, using the configured `worker-model`). When the worker opens the PR
from the bot account and writes `desfecho.json`, the sweep collects it and
exits.

## (b) Continuous: the feedback rounds

```sh
msf run
```

The factory sweeps on the fixed 60 s tick and wakes by event when a worker
ends. Comment your feedback on the PR — the next derivation relaunches a
worker that addresses it on the SAME branch and the SAME PR (as many rounds
as you want; each round ends with the worker commenting what it addressed).

You end the factory with Ctrl-C or SIGTERM (exit 0): Pi first cancels its owned
tools so their results can persist; a second signal skips the cooperative window. A stop the factory cannot confirm says so and
exits nonzero, leaving the affected works on record for the next run to check.
**Requested stop** and **Unconfirmed stop** in GLOSSARY.md are the contract.
The next `msf run` loads the current `msf.yaml` and the compiled code and
resumes the SAME attempts — there is no hot reload, so compiling and
`npm run build:image` stay explicit steps between runs.

Restarting after a crash loses nothing either: the next boot re-derives every
reserved work from disk + tracker alone (a crashed round is an interruption:
the SAME attempt is recovered after the configured backoff by reopening its own
session — or, when that session cannot be proven safe to continue, pauses and
asks for help, re-evaluating the pause every cycle. A
written failure still releases the work to the pool, its 2nd consecutive one
blocks it, and an exhausted recovery budget pauses it and asks for help; a PR
waiting for you stays parked; a merge you already did becomes
done → archive). A model provider outage during an interruption recovery
retries on its own `model-provider` budget; exhausted, the work is **awaiting
model provider** (GLOSSARY) — answer on the issue to resume, or raise
`model-provider.max-retries`; the awaiting state is never a block. A repair
round keeps its own ruler, and a repair fall resumes on the same branch and PR
(see GLOSSARY.md).

A surviving worker keeps its work and its slot; when it ends, the factory
reconciles the result on its own, even if the image tag moved after it was
launched. A stop ends every container binding the work's dir, whatever image
it runs. If Docker stops answering, launches pause and resume without
intervention; one notice appears after `liveness.unavailable-warn-ms` (60 s by
default), and every worker and reservation is preserved meanwhile.

A sweep that cannot read the tracker says `sweep failed: … — retrying on the
next tick` and the factory keeps sweeping: it acts on nothing, spends no
attempt, and the next tick derives from disk + tracker again. Only `--once` and
`msf status` fail out loud, since a single sweep has no next tick.

### Interrupted command: explicit exact retry

Continuity logs report a pause once per change (and once after a restart), never
print the script, and point to pausa.json for the full diagnosis. Rechecks keep
running on every tick even when the log stays silent.

For an effect-unsupported pause, inspect the exact tool input/command and working
directory, including effects already produced, before accepting repetition:

    msf recover '<work-key from msf status>'   # read-only; prints a review token
    msf recover '<work-key>' --retry '<review token>' --accept-duplicate-risk --reason '<why repeating is acceptable>'
    msf recover '<work-key>'                  # request decision and audit history

Use the same --config throughout. An active run rechecks the queued request on
its next sweep; do not stop unrelated Works. Without an active run, approval is
immediate and the next `msf run` consumes it. A queued request is not permission:
stale evidence, a live worker or unknown liveness prevents approval. Inspect
again if rejected. The guardrail permits one exact repetition; the original
outcome stays unknown, no budget is reset and validation still applies. A
child's command is replayed by its owning Work session, not recorded as a child
outcome. Consent and consumption remain in `recuperacoes.jsonl`; a crash never
renews spent permission. This does not prove rewritten commands or mutable
scripts equivalent. Old unguarded delegations still need this explicit consent.

## (c) Status — the trail, factory stopped

```sh
msf status        # the short report: 10 entries per list, then "… and N more"
msf status --all  # every entry, no cap
```

Derives on demand from the tracker, the workspace disk and a read-only Docker
probe: live workers (**running**), the attempts interrupted with no worker
alive (**orphaned**), the reservations, the **recovery** ledger (was the last
stop the operator's requested stop, still unconfirmed, an interruption absorbed
by its budget, or a failure that consumed the attempt), the **model provider**
ledger (its retries, the provider's message, and whether the work is
**awaiting model provider**), the works **continuity paused** (the attempt that
cannot be continued safely, with its reason, the attempt it waits for — its own
planned number beside the ledger's last evidenced one when they differ — and
its session when known), the **repair** cycles, last outcomes, the pool,
archived dones — and the two reconciliation
leftovers when tracker and workspace disagree:

- an **unbacked claim** carries the copyable `gh issue edit …` that returns a
  GitHub issue to the pool (a non-GitHub ticket offers no command: none is
  invented); its report warns that another factory or workspace may be the one
  holding the claim, so confirm before releasing;
- an **unmarked reservation** is a fact for a human decision — the report
  offers no command.

Each entry names the work by its ticket source and the destination repository;
a GitHub Issues work keeps the `owner/repo#n` spelling. The report never
deletes, moves or archives anything; a released work (reservation + pool label)
is normal and is never reported. Without Docker the
two liveness lines read `liveness unknown (docker not reachable)`; the works
carrying attempt evidence are still listed, unclassified, and the rest of the
report is unchanged. A work carried by more than one container lists each
container and a **duplicate workers** line — the decision is yours.

## (d) Local desktop notifications (issue 93)

`msf run` (continuous and `--once`) shows a Linux desktop notice when a new
occurrence needs you: an open PR to review, a help request or a block, an
intervention on a work (duplicate workers, a silent survivor), or the factory's
own Docker warning, which names no work. One notice per occurrence — never a
reminder — and `msf status` never notifies. A work notice names its ticket as
status does, the reason, and the PR (review) or ticket (help, intervention)
address when the source exposes one.

On by default; disable with `notifications: false` in `msf.yaml`. Needs a
Linux desktop session with a notification daemon, and the factory running
inside it. If delivery is unavailable the sweep warns in the terminal and
carries on: outcome, state and exit code unchanged.

Smoke: a review notice after the initial PR and after a PR comment, a help
notice for a help request or a block, an intervention notice for a duplicated
or silent worker, the factory's Docker warning after the configured threshold,
silence after a restart — and every work notice carrying the work and its
address, with no window opened and no focus taken.

## (e) Retrospective (issue 141)

The retrospective is a factory job on its own lane (ADR 0006): with the
`retro:` block enabled, the orchestrator starts a round at a sweep once
`retro.threshold` works were archived since the last report, and the round
writes its dated report under `<workspace>/retros/`. Manual triggers are in
README (Usage) and never wait for the threshold.

Live proof: let the archived works reach the threshold, run one sweep — the log
names the round, `<workspace>/retros/<instant>-retro.md` exists, the filed
issues carry `needs-triage` and reference the report, a retro-items notice
points at each destination, `msf status` shows the round in flight and then the
window boundary its report advanced, and the next round's window starts after
that boundary.

## What the human does in the proof

1. **Review the PR** the bot account opened.
2. **Comment your feedback on the PR** (plain PR comment or review) — the
   running factory picks it up on the next tick and relaunches the worker.
3. **Merge** the PR when satisfied — the `Closes #N` linkage closes the
   issue; if you merge without the linkage, the next sweep closes the issue
   itself (the fallback) with a short comment. On done, the factory archives
   the work's artifacts (`trabalhos/` → `arquivo/`, nothing is deleted) and
   cleans the work branches.

## Notes

- **One `run` per configuration**: `msf run` (continuous or `--once`) is
  exclusive per real path of the config file (symlinks resolved). A second run
  for the same file fails immediately, nonzero, before any operational
  activity, and leaves the active run untouched. There is no `--force`, no
  waiting and no expiry; process death (`kill -9` included) releases it, so a
  restart needs no cleanup, and `msf status` stays available. Two names for the
  same file (a hard link) count as one configuration. If the protection cannot
  be established, the run refuses to start rather than run unprotected.
- **Ctrl-C/SIGTERM do not wait for a whole Work**: the stop of (b) also ends
  the workers a previous run left, and the exclusivity above holds through
  it.
- **REST budget**: the bot account's REST budget is 60/h **shared with the
  whole machine** (the same IP/account budget as everything else that runs
  `gh` here). One sweep consumes only a FEW calls: one listing per target
  repo + a handful of per-work reads/writes — a feedback round is cheaper
  still (no listing). The adapter is REST-only (no GraphQL). Don't run the
  smoke and the proof back to back without checking the remaining budget
  (`gh api rate_limit`).
- The fake seams (`--runtime fake`, the injected fake adapter) exist ONLY
  for tests — the default wiring of `msf run` is all real; nothing on the
  binary's path can reach the fake adapter.
- Every restart reconciles from disk + tracker: the registry
  (`trabalhos/<repo>#<n>/`) holds the attempts, logs, outcome records and the
  requested-stop evidence; the tracker holds the labels and the PR. No factory
  state lives in the process, so an updated config or a rebuilt binary takes
  effect on the next invocation.
- **`Could not fetch from origin` on a retomada is expected, not a broken
  remote**: the work branch reaches the origin only when the worker
  publishes it (push + PR). A work that fell before publishing (blocked
  self-report, abrupt death) keeps its branch only in the workspace clone
  (`repos/<owner>#<name>`), so the relaunch has nothing to fast-forward —
  the launch line right above it says `branch agent-issue-<n> is not on
  origin yet`. When the branch WAS published the note is absent, and a
  fetch failure there is real: check the bot credential in the gh keyring
  and the egress.
