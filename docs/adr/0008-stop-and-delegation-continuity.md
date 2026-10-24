# Stop Pi before tearing down its container; guard delegated effects

Stopping Sandcastle immediately can kill Pi before it persists a tool's terminal
result. A real deterministic Pi/subagent/Docker reproduction left the same
attempt permanently paused after a requested stop; a separate operational-cycle
reproduction showed an already-open PR hiding that stop and a never-launched
Repair spending a round. The stop now asks Pi to abort its owned tools before
sandbox teardown, without extending the shared ten-second deadline or weakening
Docker confirmation. An open PR does not complete the stopped attempt; its own
written outcome and confirmed Delivery still prevail. Repair is charged only
after continuity permits launch, and a requested stop preserves its attempt and
round instead of becoming a Repair fall.

Revisit ADR 0005's delegation requirement using the existing native subagent
runtime rather than adding pi-durable: the pinned extension already has a
required-child-extension interface and persisted sessions/artifacts. The factory
requires its guardrail in local native children, binds their session identities
to the owning Work session, and journals their effects in the same durable
journal. A shared reconciliation generation serializes dispatch and shares an
absence allowance across parent and children. Only declarative, synchronous
launches of image-owned reviewers receive a guarded dispatch receipt; arbitrary
workflow scripts and other opaque calls remain unknown. A missing parent result
therefore does not by itself block a guarded delegation, but every unresolved
child effect still must be reconciled. No successful child or parent result is
fabricated. Existing unguarded records are never retroactively declared safe.

Extend ADR 0007's exception to the exact JSON input of an interrupted delegation,
not just bash. A guarded child's unclassifiable command can be replayed by its
owning Work session, with original and executor identities recorded separately;
the child outcome stays unknown. Consent remains single-use, snapshot-bound and
fsynced before dispatch. An active run receives a durable Recovery request scoped
to its real configuration path, then rechecks liveness, in-flight admissions and
the review token under its own lock. A queued request is not authorization;
stale evidence is rejected, and a crash after consent but before the receipt
cannot issue consent twice. No lock bypass or global factory stop is needed.

Rejected: deleting pauses, treating every dead container as effect-free, or
silently starting new sessions. Those alternatives lose the duplicate-effect
protection that motivated ADRs 0005 and 0007. The gateway's deterministic real
container proofs cover requested stop and forced death during a native reviewer,
including a child push reconciled once and blocked when the parent repeats it.
They do not prove arbitrary workflow recovery, power-loss durability, or real-LLM
behavior. Opaque or ambiguous effects can still require explicit human consent.
