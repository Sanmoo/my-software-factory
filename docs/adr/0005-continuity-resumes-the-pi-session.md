# Continuity resumes the Pi session, not pi durable

Accepted for [issue #89](https://github.com/Sanmoo/my-software-factory/issues/89)
on the evidence of [experiment #111](https://github.com/Sanmoo/my-software-factory/issues/111#issuecomment-6265048132);
the recovery and its resume landed with
[#118](https://github.com/Sanmoo/my-software-factory/issues/118),
[#123](https://github.com/Sanmoo/my-software-factory/issues/123),
[#146](https://github.com/Sanmoo/my-software-factory/issues/146) and
[#119](https://github.com/Sanmoo/my-software-factory/issues/119) — the launch of
a recovery reopens the attempt's OWN session, selected from the association the
launch recorded before the worker started (`runtime/continuity.ts`,
`runtime/sandcastle.ts`), and the effect guardrail that makes that safe rides in
the worker image (`runtime/guardrail/extension.ts`).

An infrastructure interruption — factory crash, worker crash, machine restart
with the disk intact — ends no attempt and consumes none. The operator's own
stop is since [issue #146](https://github.com/Sanmoo/my-software-factory/issues/146)
its own persisted condition: it keeps every guarantee here and, unlike a crash,
the resume after it does not draw on the recovery budget. Only a written
failure/abandonment outcome, or an explicit operator close, spends an attempt.
A resumed attempt keeps its identity (same attempt number, branch preserved) and
the relaunch reopens the Pi session of that attempt instead of starting a new
session with reconstructed context.
Automatic recoveries draw on a separate, finite budget with explicit backoff;
exhausting it pauses the work and asks the human. `@earendil-works/pi-durable`
is not adopted.

When accepted, this inverted what the code did then: `src/state/outcome.ts`
treated a missing outcome as the `abrupt-fall` class ("its fact IS the absence")
and `src/state/derive.ts` applied *first fall frees the work, a second
consecutive one blocks it*, so factory or container death spent an attempt; the
`Orphaned` entry in `GLOSSARY.md` was defined as an abrupt fall. #123 and #146
landed both — an interruption now spends nothing, and `Orphaned` describes the
interrupted attempt awaiting reconciliation.

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

Consequences, stated so nobody rediscovers them as bugs:

- **Session resume is not safe on its own.** Without a reconciliation layer it
  repeats the external effect that landed in the interrupted window (measured:
  three duplicated mutations in three runs) and, facing ambiguous evidence,
  continues blind instead of asking. Guarding every mutating action — push, PR,
  comment, label — by consulting real state is a requirement of the resume, not
  an optional nicety.
- **Neither candidate supplies ownership.** Durable's storage assumes one
  process at a time; a Pi session has no notion of an owner. Exclusive launch
  comes from the factory's own design (#90), and recognising a surviving worker
  before relaunching is #118.
- **What the experiment did not prove stays unproven**: nothing on power loss,
  host reboot, disk loss or machine migration (the kill was a process
  `SIGKILL`), nothing on Sandcastle container isolation, and no real-LLM
  token or cost gain — the model was deterministic, so the measured saving is
  tool work, not reasoning.
