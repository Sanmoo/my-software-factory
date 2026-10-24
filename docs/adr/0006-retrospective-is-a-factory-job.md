# The retrospective is a factory job on its own lane

Retrospectives over the factory's finished works are factory jobs
in the Repair mold: the orchestrator triggers a round when the configured
number of works have been archived since the last report (retro.threshold,
default 5), runs it in the same Sandcastle runtime with a dedicated model
(retro.model, defaulting to worker-model), and the round files the candidates
its own judgment deems worth human attention as needs-triage issues — factory
items at retro.factory-items-destination, target-repo items at the repo
concerned. The operator stays the only gate between an item and the pool, at
triage. The job runs outside the worker concurrency slots: a round runs even
with every slot busy, because lightweight analysis neither queues behind nor
pauses real work. One round runs at a time, enforced by the lane's own marker
(the round's in-flight record, owned by its pid) rather than by the `msf run`
lock — the manual trigger must work while the factory is sweeping.

The report is the marker: a round advances the window's boundary only when its
dated report exists in the workspace, so a round that died advances nothing and
the next sweep retries the same window. The state file beside the reports only
indexes the last one (its boundary, the works a single-work post-mortem
analyzed, how many items it filed); a lost index degrades to the first round's
rule — the last ten finished works, re-analyzed — never to a skipped window.

## Consequences

- The analysis instructions are factory code, not an image resource: they live
  in `src/retro/instructions.ts`, carry their own version constant and credit
  the upstream skill at an immutable revision. `agent-resources.yaml` declares
  only what the image provisions, so it does not list them.
- The round launches without the continuity guardrail. A round owns no
  attempt, session association or effect journal for the guardrail to
  reconcile, and with it loaded every external effect — the `gh issue create`
  the round exists to run — would be refused.
- A failed round spends nothing: it is not a Work, so it consumes no attempt,
  no recovery and no worker slot; its own report is the only marker it can
  advance.

## Considered options

- An operator-invoked skill on the host reading the workspace: rejected — the
  factory improves itself without waiting for operator attention; the manual
  `msf retro` trigger survives for forced rounds and single-work windows.
- Sharing the worker concurrency slots: rejected — the retro runs no builds
  and no quality gateway; competing with real work would add cost without
  value.
- The `msf run` lock as the round's exclusivity: rejected — the factory holds
  it for the whole sweep, so a forced round could never run while the factory
  is working, which is when the operator wants one.
- Inheriting the worker model with no key of its own: rejected — retro work
  is strategic analysis, not execution, so it gets its own model key instead
  of a fixed inheritance.
