# The retrospective is an operator skill, not a factory capability

Retrospectives over the factory's finished works (issue 141) are run by an
operator-invoked skill on the host, reading the workspace records — the
archive, the session transcripts and the operational log — directly; the
orchestrator neither schedules nor launches them.

## Considered options

- `msf retro` as an orchestrator command launching a retro agent like a
  worker: rejected — a retrospective is analysis over work that already
  ended, so it needs no sandbox, acting account or claim; the runtime would
  add cost without value. Automating later is an evolution of the skill, not
  a reversal of this decision.
- Automatic retrospectives on a cadence or after each delivery: rejected —
  the operator decides when a window is worth reviewing.
