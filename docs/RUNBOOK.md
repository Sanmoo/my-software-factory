# RUNBOOK — the live proof of v0.1 (ticket 18)

The factory is wired end to end with only real components: the real GitHub
adapter (`gh` keyring token at boot), the real Sandcastle runtime (Pi
headless in a container, profile snapshot), the real git host. This is the
exact script of the live proof: a real issue → worker → PR opened by the
configured account → human feedback → merge. In v0.1 that account is the
operator's: GitHub hides `bot-do-samuca`, and the accepted risk is the
operator PAT inside the unrestricted container. Factory speech is the
`<!-- msf:agent -->` marker, not a different login.

## Before the first run (once)

```sh
# 1. the worker image (msf-v2-worker:local) — one build, reused forever
npm run build:image

# 2. the bot credential in the gh keyring (the boot check reads it;
#    the SAME token is injected as GH_TOKEN inside the worker container)
gh auth token --user Sanmoo   # must print a token; v0.1 uses the operator account

# 3. the config — a working directory with msf.yaml, e.g.:
cat > msf.yaml <<'EOF'
worker-gh-account: Sanmoo
repos:
  - Sanmoo/my-tasks        # the target repo(s) — this account must have write
concurrency: 2
workspace: ~/.local/share/msf
# profile-snapshot wiring (ticket 18; the defaults are the ticket-17 proof's):
# profile-allowed-roots: [~/dev/github.com/Sanmoo/dotfiles, ~/.agents, ~/.local/share/omarchy]
# profile-skip-dangling-links: true   # set if a stale profile link blocks a launch
EOF
```

If a launch fails naming a profile link (`ProfileSnapshotError`), declare the
link's real target as a `profile-allowed-roots` entry, or set
`profile-skip-dangling-links: true` for stale links — the same fail-closed
snapshot behavior of the ticket-17 proof, configurable.

## Toolchains — the convergence layer (ticket 18)

The worker image ships the `mise` binary (its apt repo, mise.jdx.dev/deb) and
the agent's PATH starts with `/home/agent/.local/share/mise/shims`. The
runtime binds two workspace dirs read-write into every container:

```sh
<workspace>/toolchains/mise      → /home/agent/.local/share/mise    (RW)
<workspace>/toolchains/agent/npm → /home/agent/.pi/agent/npm        (RW)
```

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

## (a) One-shot: claim + launch a real worker

Label a real issue with `ready-for-agent` on the target repo, then:

```sh
msf run --once --model <provider/model-id>
```

The sweep derives the pool from the tracker, claims the issue
(`ready-for-agent` → `agent-claimed` BEFORE any launch), clones the repo,
creates the work branch `agent-issue-<n>` and launches ONE real worker (Pi,
container, the model given). When the worker opens the PR from the bot
account and writes `desfecho.json`, the sweep collects it and exits.

## (b) Continuous: the feedback rounds

```sh
msf run --model <provider/model-id>
```

The factory sweeps on the fixed 60 s tick and wakes by event when a worker
ends. Comment your feedback on the PR — the next derivation relaunches a
worker that addresses it on the SAME branch and the SAME PR (as many rounds
as you want; each round ends with the worker commenting what it addressed).

You end the factory with Ctrl-C (exit 0). Restarting loses nothing: the next
boot re-derives every reserved work from disk + tracker alone (a crashed
round becomes a fall → release or blocked; a PR waiting for you stays
parked; a merge you already did becomes done → archive).

## (c) Status — the trail, factory stopped

```sh
msf status
```

Derives on demand from the tracker + the workspace disk (read-only): works
in flight, last outcomes, archived dones. Works with the factory stopped.

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
  (`trabalhos/<repo>#<n>/`) holds the attempts, logs and outcome records;
  the tracker holds the labels and the PR. No factory state lives in the
  process.
