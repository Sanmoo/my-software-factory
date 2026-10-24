# An operator may authorize one exact retry without inventing an outcome

[ADR 0008](0008-stop-and-delegation-continuity.md) extends this decision to
exact delegation input, guarded child calls and requests processed by the active
lock-owning run; the bash-only and stopped-run restrictions below are historical.

An interrupted command with no terminal result can leave continuity permanently
paused even after its worker is gone. The operator may explicitly accept the
risk of duplicated effects for that exact bash command, working directory,
session and attempt; the default remains the pause required by ADR 0005.

Consent is an append-only audit record bound to a reviewed snapshot and pause,
never a fabricated success, failure or proof of absence in the effect journal.
The retry's own fsynced intent consumes permission before dispatch. A crash
there may spend permission without executing anything, but never renews it:
another interrupted retry needs another inspection and operator decision.

Approval shares run's exclusivity and refuses live or unobservable workers.
Continuation retains the original attempt and session, and the existing
recovery budget, stop, validation and publication rules still apply. A generic
issue reply and a new session remain insufficient. This is a deliberate
risk-acceptance exception, not exactly-once execution: equivalent rewritten
commands and mutable scripts cannot be proven identical by matching shell text.
