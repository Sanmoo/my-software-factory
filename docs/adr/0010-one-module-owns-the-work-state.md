# One module owns the Work state

"What happened to this Work, and what may the factory do now?" is answered
twice, from the same facts, in vocabularies that never meet: once before a
launch (`state/derive.ts`) and once after an Attempt ends (`state/outcome.ts`).
The loop carries the map between them by hand, through three state tables
maintained by hand and an execution switch, so a new condition of a Work
touches five places that never meet — and a forgotten one does not break the
typecheck in all of them, only in the first.

The bifurcation already has a body: a PR closed without merge is `rejected` in
the read before a launch and has no name at all in the read after an Attempt,
which knows only an open PR and a merged PR. At collection that fact falls into
interruption, release or a block-by-failure — never into the Block the
`GLOSSARY.md` defines — and the work returns to the pool as if nothing had
happened.

We decided one module owns the Work state, with two reads and **one**
vocabulary:

- **Before a launch**: given the Work, in what state is it, and what may the
  factory do now — the ticket closed, the PR merged, the PR closed without
  merge, the PR open, Repair running or exhausted, a claim with no worker, a
  continuity pause, an unconfirmed stop, the model provider awaited.
- **After an Attempt**: what happened to the Attempt that just ended, and what
  follows from it — archived, reserved, blocked with the comment, released,
  interrupted, recovered, paused, rejected.

Both reads return states of the same vocabulary, each carrying the payload its
action needs (the PR, the comment, the trigger, the Attempt), because the
policy over the text and the fact belongs to this domain. The vocabulary is
one because a fact means the same thing at both moments — an open PR, a PR
closed without merge, a spent budget — and a second vocabulary is a
translation the loop must keep correct by hand, which is exactly how one fact
(a closed PR) ended up without a name in one of the readings. The facts a
verdict needs stay behind the interface: the caller hands the Work — its
identity and its dir — not a list of facts assembled by hand, so the fact list
can change without touching a caller. Unknown and absent are told apart in
one place, inside this module, instead of by every stage that consults the
tracker, and neither ever becomes an invented verdict. A pure decision core
inside the module holds the decision tables; it is the module's own internal
seam. What the three hand-maintained tables said ("terminal for consent",
"which operational class the action announces", "waits for liveness") is
declared next to each state, so the compiler demands the three declarations of
every new state. The execution switch stays a switch, exhaustive over the one
vocabulary, and still does the I/O: archive, block, comment, release, launch.
`msf status` renders the same states, so status and loop cannot disagree about
one Work.

Two names that lie are corrected in the new vocabulary: `idle` becomes
`parked` — waiting for the human, nothing to decide — and `unknown` becomes
`unreadable`, the issue could not be read. The other fifteen states already say
what they are.

One consequence of the second correction is worth naming, because it is the one
place the count of states moves: the old `unknown` carried **two** causes under
one name — `because: "issue-not-found"`, when the ticket read failed, and
`because: "not-planned"`, when the issue was read fine and closed as not-planned
(not done). The first becomes `unreadable`; the second becomes its own state,
**`not-planned`**, because calling a readable, deliberately closed issue
"unreadable" would be the same lie in a new place. The vocabulary therefore has
eighteen states, not seventeen. This is **form only**: neither state is ever
acted on, so no verdict changes and no operator-visible behaviour moves — the
only thing that changes is which word names which fact.

The epic's only behaviour delta — the only **new verdict** — is named here so
that no difference enters underneath: a PR closed without merge, seen at collection, becomes a **Block with the PR pointed at**, in place
of the release or block-by-failure that happens today. Where the two verdicts of
today diverge, the read before a launch wins, because it is the one that matches
the Glossary's definition of Block; it gets a test of its own. No other delta:
the Requested stop protocol (ADR 0008), the continuity rules (ADR 0005), the
Recovery budget, the model-provider budget and the Repair rules stay identical —
the existing suite passes with no test edited, and a test that has to be
rewritten is a policy regression.

A second consequence is a *written* fact rather than a rule, and it is named here
so that it stops being an accident: the reset of the consecutive-fall count
after a human answers is now **persisted** in the recovery ledger
(`resetFallCount`), where before it lived in one launch's memory. The count is
the Work record's fact — `lastFallAttempt` in `recuperacoes.jsonl` — and an
in-memory reset cannot survive the next sweep or a restart. Leaving it unwritten
made the two readings disagree about the same Work: the derivation said release
(the answered block forgot its count) while the collection, reading the ledger,
could say block (the count was still there). The two readings now agree, on
release. This **removes a contradiction; it does not add a rule** — the fall
ruler is unchanged, and the reset is the decision already made. A test
pins it at the seam where the launch writes and the collection reads.

Supersedes, in [ADR 0009](0009-one-module-owns-the-work-record.md), only its
enumeration of separately-owned policy modules: the outcome ruler is no longer
a policy module of its own, because its vocabulary, the reading of its facts
and the collection verdict are now the Work state's one domain. Everything else
in 0009 stands word for word: the Work record has one owner, `read`/`write` is
its interface, and a cross-reference is refused before the disk is touched. The
recovery, model-provider and Repair decisions keep their own modules and are
consulted through their interfaces; ADRs 0002, 0005 and 0008 remain satisfied
without change.

Rejected: **keeping the two vocabularies and translating between them**, which
is the state before this decision and let the closed-PR fact go unnamed.
Rejected: **one state type per reading**, because the same Work in the same
situation would still have two names, and `msf status` could describe a world
the loop does not act on. Rejected: **reading the facts in the caller**, which
hides the dependency without giving the fact policy an owner — every caller
still needs the list. Rejected: **renaming the fifteen remaining states** to
Glossary words, decided but not worth crossing every suite.
