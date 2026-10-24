# Continuity resumes the Pi session, not pi durable

Accepted, on the evidence of `experiments/continuity`: the launch of
a recovery reopens the attempt's OWN session, selected from the association the
launch recorded before the worker started (`runtime/continuity.ts`,
`runtime/sandcastle.ts`), and the effect guardrail that makes that safe rides in
the worker image (`runtime/guardrail/extension.ts`).

An infrastructure interruption — factory crash, worker crash, machine restart
with the disk intact — ends no attempt and consumes none. The operator's own
stop is a persisted condition of its own: it keeps every guarantee here and,
unlike a crash, the resume after it does not draw on the recovery budget. Only
a written failure/abandonment outcome, or an explicit operator close, spends an
attempt.
A resumed attempt keeps its identity (same attempt number, branch preserved) and
the relaunch reopens the Pi session of that attempt instead of starting a new
session with reconstructed context.
Automatic recoveries draw on a separate, finite budget with explicit backoff;
exhausting it pauses the work and asks the human. `@earendil-works/pi-durable`
is not adopted.

The consequence, stated so nobody rediscovers it as a bug:
`src/state/outcome.ts` keeps a missing outcome as absence, never as a written
failure class ("its fact IS the absence"), and `src/state/derive.ts`
applies *first fall frees the work, a second consecutive one blocks it* to
falls alone — factory or container death spends no attempt, and `Orphaned`
describes the interrupted attempt awaiting reconciliation.

Rejected: pi durable (alternative C). In 186 runs across the scenario matrix it
tied with the native session on every measured axis — same confirmed progress
reused, same attempt, no duplicated effect with guardrails on, same recovery
budget behaviour — and this repository's tie rule prefers the smaller change.
C adds a runtime dependency, a storage to operate and one process per storage,
and its exclusive benefits (a recorded interruption fact, a live-task signal,
per-tool replay policy) only pay off once the factory has durable work of its
own: recoverable delegations/subagents and effects internal to a run, none of
which the experiment exercised. Revisit C only if such a requirement appears,
and then the experiment to run is the delegation one, not this one.
[ADR 0008](0008-stop-and-delegation-continuity.md) records that narrower native
delegation experiment and the required child guardrail, without adopting durable.

Consequences, stated so nobody rediscovers them as bugs:

- **Session resume is not safe on its own.** Without a reconciliation layer it
  repeats the external effect that landed in the interrupted window (measured:
  three duplicated mutations in three runs) and, facing ambiguous evidence,
  continues blind instead of asking. Guarding every mutating action — push, PR,
  comment, label — by consulting real state is a requirement of the resume, not
  an optional nicety. [ADR 0007](0007-operator-authorized-exact-retry.md)
  adds an explicit, scoped acceptance of duplication risk; it changes neither
  automatic reconciliation nor the rule that consent is not evidence.
- **Neither candidate supplies ownership.** Durable's storage assumes one
  process at a time; a Pi session has no notion of an owner. Exclusive launch
  comes from the factory's own design, and recognising a surviving worker
  before relaunching is a precondition of the same kind.
- **What the experiment did not prove stays unproven**: nothing on power loss,
  host reboot, disk loss or machine migration (the kill was a process
  `SIGKILL`), nothing on Sandcastle container isolation, and no real-LLM
  token or cost gain — the model was deterministic, so the measured saving is
  tool work, not reasoning.
