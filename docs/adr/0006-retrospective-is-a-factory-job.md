# The retrospective is a factory job on its own lane

Retrospectives over the factory's finished works (issue 141) are factory jobs
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
(the report's process record) rather than by the `msf run` lock — the manual
trigger must work while the factory is sweeping.

## Considered options

- An operator-invoked skill on the host reading the workspace: rejected — the
  factory improves itself without waiting for operator attention; the manual
  `msf retro` trigger survives for forced rounds and single-work windows.
- Sharing the worker concurrency slots: rejected — the retro runs no builds
  and no quality gateway; competing with real work would add cost without
  value.
- Inheriting the worker model with no key of its own: rejected — retro work
  is strategic analysis, not execution, so it gets its own model key instead
  of a fixed inheritance.
