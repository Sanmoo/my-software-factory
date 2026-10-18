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
#    the SAME token is injected as GH_TOKEN inside the worker container;
#    the image ships the `gh auth git-credential` helper that `git push`
#    uses to read that token — the boot refuses an image without it, so a
#    stale image fails with `npm run build:image` instead of a blocked round)
gh auth token --user Sanmoo   # must print a token; v0.1 uses the operator account

# 3. the config — a working directory with msf.yaml, e.g.:
cat > msf.yaml <<'EOF'
worker-gh-account: Sanmoo
worker-model: opencode-go/glm-5.3-flash
repos:
  - Sanmoo/my-tasks        # the target repo(s) — this account must have write
concurrency: 2
workspace: ~/.local/share/msf
# profile-snapshot wiring (ticket 18): the default is EMPTY — no root is
# pre-declared (no operator-personal path lives in the product). A profile
# WITH symlinks fails the snapshot fail-closed (ProfileSnapshotError naming
# the link) until you declare the roots YOUR profile legitimately reaches:
profile-allowed-roots:
  - ~/meus-dotfiles         # every root a profile link really points into
  - ~/.agents
# profile-skip-dangling-links: true   # set if a stale profile link blocks a launch
EOF
```

If a launch fails naming a profile link (`ProfileSnapshotError`), declare the
link's real target as a `profile-allowed-roots` entry, or set
`profile-skip-dangling-links: true` for stale links — the same fail-closed
snapshot behavior of the ticket-17 proof, configurable. A profile without
symlinks needs no `profile-allowed-roots` at all.

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

The orchestrator converges BEFORE the prompt: a second sandbox-ready hook
runs `mise install -y` (30 min ceiling) against the active configs — the
snapshot's global config and the repo's `mise.toml`, when the repo declares
one. The session NEVER hunts a declared tool: it is there or the launch
fails fast. The worker still may run `mise install` for tools a work adds
declarations for mid-flight — that is the exception, not the design.

## (a) One-shot: claim + launch a real worker

Label a real issue with `ready-for-agent` on the target repo, then:

```sh
msf run --once
```

The sweep derives the pool from the tracker, claims the issue
(`ready-for-agent` → `agent-claimed` BEFORE any launch), clones the repo,
creates the work branch `agent-issue-<n>` and launches ONE real worker (Pi,
container, using the configured `worker-model`). When the worker opens the PR from the bot
account and writes `desfecho.json`, the sweep collects it and exits.

## (b) Continuous: the feedback rounds

```sh
msf run
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

## (d) Local desktop notifications (issue 93)

`msf run` (continuous and `--once`) sends a passive Linux desktop notice
(`notify-send`) when a new occurrence needs you, once per occurrence: an open
PR after a session (review), a help request or a block (help). The notice
names `<repo>#<n>`, gives the brief reason and shows the PR (review) or issue
(help) address. It never steals focus, opens a window or repeats. `msf status`
never notifies.

On by default; disable with `notifications: false` in `msf.yaml`. It needs a
Linux desktop session with a notification daemon and `notify-send` (libnotify),
started from a terminal inside the graphical session. If delivery fails the
sweep prints `local notification failed (...)` and carries on; outcome, state
and exit code are unchanged.

Smoke test: run a work that opens a PR → one `review` notice with the PR URL;
comment the PR → a new notice; force a help/block → a `help` notice with the
issue URL; restart → existing PRs and blocks stay silent.

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
- **`Could not fetch from origin` on a retomada is expected, not a broken
  remote**: the work branch reaches the origin only when the worker
  publishes it (push + PR). A work that fell before publishing (blocked
  self-report, abrupt death) keeps its branch only in the workspace clone
  (`repos/<owner>#<name>`), so the relaunch has nothing to fast-forward —
  the launch line right above it says `branch agent-issue-<n> is not on
  origin yet`. When the branch WAS published the note is absent, and a
  fetch failure there is real: check the bot credential in the gh keyring
  and the egress.
