# The factory mediates the ticket access

A worker never holds an issue-tracker credential. The factory performs every
ticket call as the Acting account, and the worker obtains additional reads and
authorized publications through the Work record's mediated channel: it writes a
structured request naming the Work and the session that issued it, and the
factory validates it against the launch's own facts — the Work, its reservation,
the recorded session, the configured source and destination, and the closed set
of authorized operations — before a single HTTP call. An operation outside that
contract, or a request for another Work or site, is answered as rejected and
never reaches the tracker.

An answer is a fact, never prose: `ok`, `partial`, `rejected`, `failed` or
`unknown`. Only `ok` says a publication landed, an unknown or partial answer
names what is unknown, and no model interprets an answer into authorization or
state. The ticket's rich text keeps its meaning in both directions: ADF is
rendered into the text the worker reads, and the worker's text is published as
ADF — never parsed as HTML or Markdown.

Factory speech is evidence the provider owns: a comment property carrying the
request's correlation id, not a body marker and not the author's login. A human
and the factory can therefore share one account, a factory comment never resumes
work by being "the bot's", and a publication whose response was lost is settled
by reading the conversation for that correlation. Nothing is written twice for
one request: an ambiguous write is either proved published by that read or
answered as `unknown`, and the request repeats — correlating before it
publishes — to settle it. The operation ledger records the intent before the
write and the result after it; when the ledger cannot be trusted, the factory
reads the conversation for the correlation before publishing instead of
assuming a first attempt. A factory comment whose own property cannot be read is
factory speech with an unknown correlation, never a human answer and never proof
that the publication is absent.

The launch path serves the channel: a Jira Work goes out through the factory's
handler and a Work whose mediated access cannot be correlated is refused before
a session starts. The channel is not an operator-reachable entry point: `msf run`
refuses a configured Jira selection, so bringing a Jira selection into a sweep —
claiming, selecting, following a reserved Jira Work — is the authority the rest
of the Jira work builds on, not a path this decision opens.

A publication's retry identity is the request, which names the session that
issued it: the record refuses the same id with different content, so a later
session cannot relabel an earlier publication, and a reconciled answer always
belongs to the request that produced it. A publication a later session issues
afresh is a new request with its own correlation, and the ledger keeps the
earlier one beside it.

The token stays in the factory process. It is never in the worker's environment,
files, image, prompt or routine artifacts, and the test suite puts it in the
host environment to prove it does not ride along. The GitHub credential is a
separate, unchanged decision: PRs, review and merge stay on the code host.

Residual limit: the correlation reconciles an ambiguity only when the same
request is repeated. Two writes remain possible — a factory that dies after a
write landed and republishes under a NEW request on relaunch, and a request
repeated before the site exposes the comment it already stored. Each duplicate
is attributable and visible through its own correlation property, and the ledger
keeps both; no sweep settles a pending intent on its own.

Accepted limit: this is credential handling, not isolation. The worker shares
the work dir and, by [ADR 0003](0003-worker-inherits-the-host-docker-daemon.md),
is root-equivalent on the host, so the channel is not a security boundary
against a hostile worker; it keeps the tracker authority and the credential with
the factory and makes every mediated publication attributable.
