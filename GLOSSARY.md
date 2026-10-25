# Factory

The factory turns eligible requested changes into reviewed changes for the operator. This vocabulary distinguishes factory activity from the issue tracker's own lifecycle.

## Language

**Factory**:
The service that turns eligible work into reviewed changes for the operator.

**Work**:
A piece of requested change the operator wants completed.

**Ticket**:
The issue-tracker item that requests a Work: a GitHub Issue or a Jira issue.

**Ticket identity**:
Provider + site + the provider's stable ticket id (plus the repository for a GitHub issue). A readable key or number is presentation only: it never stands in for the stable identity.

**Source**:
The ticket provider and site a Work comes from.

**Jira site**:
The Jira Cloud installation a Source names.

**Destination**:
The GitHub repository that receives a Work's code and PR.

**Selection**:
One configured read from a Source for one Destination: the site, the JQL that selects its tickets and the destination their Work delivers to — one `jira:` entry. Several selections may read one Source, each with its own JQL and Destination.
_Avoid_: Source, when the selection (a Source plus its JQL and Destination) is meant.

**Repository identity**:
Provider + site + the destination repository name; the code-host identity, never the ticket identity. Its components name case-insensitive things — a provider literal, a hostname and a GitHub repository name — so two spellings of one repository are one destination, and the operator's spelling stays presentation.

**PR identity**:
The destination repository plus the PR number; always distinct from the ticket identity.

**PR association**:
The registry's record of the PR that currently delivers a Work, with the attempt that opened it; earlier associations remain as history.

**Work identity**:
The ticket identity plus the destination repository — what keeps Works from different providers, sites or destinations distinct even when keys/numbers coincide.

**Work anchor**:
The provider, site, stable ticket id and destination repository a registry key encodes: the Work's identity without its presentation data. A readable ticket key never enters it.

**Worker**:
The agent carrying out a work item on behalf of the operator.

**Worker model**:
The configured AI model the worker uses to do its work.

**Factory agent resources**:
The Pi version, selected upstream skills at an immutable revision, delegation extension with its operating guidance, and reviewer agents declared in `agent-resources.yaml` and provisioned into the worker image.

**Agent inventory**:
The image's own record of the agent resources it provisioned; a launch compares it with the installed factory declaration before starting the worker.

**Acting account**:
The account authenticated by the factory on an issue tracker, receiving claim assignment and authoring the factory's comments there.
_Avoid_: Current user, when it could mean either the operator or the authenticated account.

**Pool**:
The set of work currently available for the factory to pick up.

**Jira candidate**:
A ticket the configured JQL selects for an explicit destination, presented by `msf status` in the site's native Rank order; it carries no Claim and no Reservation, so it is never available Work by itself.
_Avoid_: Pool, when the ticket is only selected.

**Ambiguous Jira ticket**:
A ticket more than one configured selection promises to a different destination; `msf status` holds it with the reason instead of presenting it as a candidate for either destination.
_Avoid_: Candidate, when the destination is not explicit.

**Claim**:
The factory's mark on a Ticket, together with assignment to its acting account, reserving that Ticket for exclusive factory activity. It covers the whole Ticket regardless of Destination; sub-issues are distinct Tickets.

**Padlock**:
The claim mark identifying a Ticket as already reserved and unavailable for another pickup.

**Reservation**:
The registry's record of a Work: its source and destination facts and the attempt the registry numbers. It is not the whole on-disk record — the Work record owns that.
_Avoid_: Work record, when the whole on-disk record is meant.

**Unbacked claim**:
A factory claim mark on the tracker with no reservation in this workspace. It does not establish abandonment or the absence of an owner elsewhere.

**Unmarked reservation**:
A reservation whose work carries no factory mark at all.

**Reserved without attempt**:
A reservation with no attempt evidence yet: the claim landed, but the worker has not.

**Work record**:
The complete on-disk record of a Work: its files, their schemas and the cross-references that bind them — the outcome, the continuity pause, the effect journal, the session links, the guardrail state, the recovery and model-provider ledgers, the Repair cycle, the attempt logs and sessions, and the evidence locations. One module owns it; the policy that reads it (the outcome ruler, the recovery, model-provider and Repair decisions) stays in its own domain.
_Avoid_: Reservation, when the whole record is meant; a Reservation names only the registry facts of a Work.

**Attempt**:
One logical try by a worker to carry out a work, counted per work. It survives infrastructure interruptions: recovering an interrupted attempt does not start or consume another.

**Outcome**:
The verdict of how an attempt ended.

**Work state**:
The answer to "what happened to this Work, and what may the factory do now?": the Work's one current state, in one vocabulary. The factory reads it at two moments — before a launch and after an Attempt ends — and both reads return states of the same vocabulary, carrying the payload the action needs. It is neither the Outcome (the verdict of one attempt's end) nor the Reservation (the registry's facts); the policy over the facts that produce it has one owner.
_Avoid_: Outcome, when the Work's current state is meant; Reservation, when the state is meant, since the registry names only its own facts.

**Parked**:
The Work state of waiting for the human with nothing to decide: an open PR the human owns, or a work the pool owns after a release. The factory holds the claim and acts on nothing — it is neither an Interruption nor a Block.
_Avoid_: idle, the name this state carried before [ADR 0010](docs/adr/0010-one-module-owns-the-work-state.md), which read as the factory being idle.

**Unreadable**:
The Work state of a Work whose ticket could not be read. The same word names any read the factory reports as failed: a Jira site whose selections could not be read reads `unreadable` too. The factory acts on nothing and never calls the issue "not found": a failed read is not a verdict.
_Avoid_: unknown (it named this and not-planned at once), and "not found", which the factory cannot know.

**Not-planned**:
The Work state of an issue that was read fine and is closed as not-planned: a terminal fact the factory never acts on. Distinct from Done, which is the human's merge.
_Avoid_: unknown, and unreadable, which is the failed read.

**Interruption**:
An attempt that ended without an outcome record: a SIGKILLed worker, a dead factory process, a dead container. It is not a failure: it consumes no attempt and never enters the fall ruler.

**Recovery**:
The automatic relaunch of an interrupted attempt, after the configured backoff, with the SAME attempt number and the branch preserved.

**Launch refusal**:
The runtime refusing a launch before any worker existed: a precondition of the environment — Docker, the image and its inventory, the git credential helper, the model credential — rejected it before the attempt's footprint was written. Only the refusal that proves itself (see `LaunchPreconditionError`) is one: a failure after the footprint may have left a worker behind.

**Recovery budget**:
The finite, per-work and persisted allowance of recoveries for one attempt. Exhausting it pauses the work and asks for help; it is separate from the attempt count. A recovery granted to a relaunch that ended in a Launch refusal is refunded to the budget; an ambiguous failure may have left a worker behind and keeps it consumed.

**Requested stop**:
The operator ending the factory with Ctrl-C or SIGTERM: admissions close, the running workers are asked to stop and then forced if needed, and the factory calls the stop safe only once no worker survives. The cooperative window bounds that request phase — ten seconds for the whole run, never per worker — and a second signal escalates it, forcing what remains at once; neither shortcut skips the confirmation of the workers' end. It preserves the attempt, branch, history and artifacts; it is neither a Failure nor an Interruption — the stop is persisted as itself — and the resume after it spends no Recovery budget, whatever ended the attempt.
_Avoid_: shutdown, for the operator's act (the signal handling is the mechanism, not the term).

**Unconfirmed stop**:
A requested stop whose end the factory could not prove: a worker that survived the forced stop, or a Docker that stopped answering. The work is held with the reason and is never relaunched over a previous worker; the next invocation asks again, and only a proof that the worker is gone turns it into the requested stop that resumes.

**Failed sweep**:
A sweep that could not read the tracker or complete its derivation: it acts on nothing, spends no attempt, and the factory repeats it on the next tick. It is not an Interruption of any work.

**Model provider**:
The external service that serves the worker model's inference. Distinct from the ticket provider of a Work's Source.
_Avoid_: Provider, alone, when the ticket provider may be meant.

**Model provider failure**:
An attempt whose turn ended in the model provider's own error (`stopReason: error` with the provider's `errorMessage` in the session stream), not in an interruption of the agent. Within the interruption recovery it is not a failure of the work and never enters the fall ruler; a Repair round ending in it is settled by the repair ruler.
_Avoid_: Provider failure, when the ticket provider could be read as the cause.

**Model provider budget**:
The finite, per-work and persisted allowance of retries for an attempt ended by a model provider failure, with its own backoff. It is separate from the recovery budget: a model provider outage never spends an interruption's allowance.
_Avoid_: Provider budget, when the ticket provider could be read as the subject.

**Awaiting model provider**:
A work whose model provider budget is exhausted: it holds its claim, is not blocked, and asks the operator for help naming the model provider's last message. `msf status` names it and a human answer resumes it.
_Avoid_: Awaiting provider, when the ticket provider could be read as the one awaited.

**Session**:
The Pi conversation an attempt runs in, persisted as a file under the work's sessions dir. It is the progress a continuation reuses.

**Session association**:
The persisted record binding a session id to its work, attempt and launch round. It is written BEFORE the worker starts, so a recovery selects the session of ITS attempt instead of the newest file or a guess.

**Continuation**:
Reopening the interrupted attempt's own session to keep its confirmed progress. It is neither a new execution nor a new orientation round, and it keeps the attempt number and the branch. The code calls the session choice `resume`, and the claim swap that follows a human answer shares the word — the attempt number and the session are what tell them apart.

**External effect**:
A mutation of state outside the worktree that a worker's tool call produces: a pushed branch, an opened PR, a comment, a label change.
_Avoid_: Side effect, when the point is that the world was changed.

**Effect intent**:
The recorded intention to perform a tool call that may produce an external effect, before that call is allowed to run. An intent without a recorded result leaves completion unestablished; it proves neither execution nor absence of effects. The result may be recovered from the attempt's own session transcript — which records how the call ended even when the guardrail's result callback never ran — and is then marked as session-derived.

**Reconciliation**:
Reading the real state (the remote branch, the PR, the conversation, the labels) to decide whether an interrupted effect happened: realized (do not repeat), absent (may run once), or unknown (pause and ask).
_Avoid_: Verification, when no external state is read.

**Retry authorization**:
The operator's explicit acceptance of duplicate-effect risk for one exact interrupted tool call whose outcome remains unknown. It permits at most one repetition, preserves the original uncertainty, and is neither Reconciliation nor evidence that an effect was absent.

**Recovery request**:
An operator's request for the active factory to validate a proposed Retry authorization. It is not permission until the factory accepts it against the current evidence and worker liveness.

**Guarded delegation**:
A delegation whose children's external effects remain subject to the factory's tracking and replay protection. Its dispatch is not a child outcome or proof that those effects succeeded.

**Continuity pause**:
The persisted hold on a work whose attempt cannot safely continue because its session or an external effect remains unresolved; it survives restarts, marks the ticket blocked and asks for help once. It spends no attempt or recovery and clears when reliable evidence resolves the cause, without requiring another human answer.
_Avoid_: Fall, when no attempt was consumed; Liveness unknown, when the session or the effect is the doubt; Docker-unavailability suspension, which is not a continuity pause.

**Guardrail**:
The factory-owned extension loaded inside the worker container that journals effect intents before they run and blocks a repeat at the tool boundary — an effect the host proved already realized, an effect proven absent already run once in the round, one a previous round already attempted, or any effect while it cannot read its own state. It is code at the boundary, never prompt obedience.

**Delivery**:
The factory's completion of a requested change through a confirmed merged PR, distinct from issue completion.
_Avoid_: Issue completion, when referring only to the factory's delivery.

**Issue completion**:
The issue tracker's declaration that a request is complete, distinct from whether the factory has delivered its change.
_Avoid_: Delivery, when referring only to the issue tracker's lifecycle.

**Cancellation**:
The operator's explicit withdrawal of work from factory activity, without declaring delivery or requiring an existing PR to be closed.

**Reexecution**:
A new execution of previously delivered or cancelled work, explicitly authorized by the operator and retaining the earlier history.
_Avoid_: Attempt, when referring to starting again after delivery or cancellation rather than another try within the current execution.

**Running**:
A work whose attempt is being carried out by a live worker right now.

**Orphaned**:
A work whose current attempt was interrupted (no outcome record of its own) and with no worker running: awaiting the factory's next reconciliation. An older attempt's record on disk is history, never this attempt's outcome.

**Surviving worker**:
A worker whose container is still alive after the factory process that launched it ended. The factory recognises it from Docker, keeps its work reserved, counts its slot and reconciles its end from the artifacts and the tracker — it never launches a substitute over it, and recognising it spends no attempt and no recovery.
_Avoid_: Orphan, when the worker is alive.

**Liveness unknown**:
Docker did not answer — a failure, a timeout, an invalid answer, or a container carrying a work this workspace cannot name. The factory cannot tell a live worker from a dead one, so new launches are suspended and no attempt, recovery or block is spent until a reliable answer returns.
_Avoid_: No workers, when the answer is missing; decided zero, when Docker listed the daemon's running containers.

**Decided zero**:
Docker listed the daemon's running containers and none carries a work of this workspace: the factory acts on the zero instead of suspending.
_Avoid_: Liveness unknown, when Docker answered.

**Duplicate workers**:
More than one live container carrying the same work. Each occupies a slot and the work is not launched again; the factory chooses no owner and ends nothing, and asks the operator to decide.

**Intervention notice**:
The operator's notice that a live worker needs a decision the factory will not make alone: duplicate containers of one work, or a survivor silent past the idle limit. It says nothing was ended, replaced or chosen.
_Avoid_: Help notice, when the work is not blocked.

**Factory notice**:
The operator's notice about the factory itself, naming no work: Docker has not answered long enough for launches to stop, or a retrospective round filed improvement items at a destination. It is never posted on an issue.
_Avoid_: Work notice, when no work is involved.

**Archived work**:
A work that reached done, whose artifacts were moved to the archive.

**Abrupt death**:
The runtime's structured fact for a session that ended with no outcome record: at collection, the fingerprint of an interruption.

**Fall**:
A WRITTEN failure or abandon of an attempt, ruled by the 1st/2nd-fall rule (1st releases, 2nd consecutive blocks). An interruption is never a fall.

**Block**:
A work the factory stopped driving (2nd consecutive failed attempt, exhausted recovery budget, 2nd consecutive Repair fall, PR closed without merge, or a continuity pause) until a human answers on its issue.

**Occurrence**:
A new act that needs human continuity, such as a PR awaiting attention, a help request or a block; never an ordinary sweep.

**Notification**:
A passive local desktop notice about a new occurrence: the work, a brief reason and the relevant issue or PR address.

**Notice**:
The short form of Notification, used in code and docs.

**Review notice**:
A notification that a confirmed-open PR waits for the operator; it points at the PR.

**Repair**:
An automatic reactivation of reserved work to address confirmed PR conflicts or required-check failures.

**Verified activity**:
What the agents themselves write under the dirs the session binds (the session transcripts, the work artifacts): the only input of the idle limit, so a worker waiting on its reviewer subagents is not idle and an unconditional heartbeat is not work.

**Repair fall**:
A repair attempt that ended without publishing (abruptly or by a normal end), whose impediment still exists, and without a concurrent change on the remote: its round is returned to the budget and it counts against a separate limit, so two consecutive falls block the work; the open PR never hides the fall. A Requested stop or a round that never started is not a Repair fall.

**Repair premise**:
The PR facts that opened a Repair round: the conflict with the base and the required checks that failed. The round re-reads them before spending work and before asking for help; a premise that cannot be re-read is never taken for a confirmed absence.

**Obsolete premise**:
A Repair premise that no longer exists when the round is rechecked — the PR is mergeable and its required set is known, with no required check failing: the round returns with no fall counted and the work stays as delivered.
_Avoid_: Repair fall, when the round was returned because there was nothing left to fix.

**Pending reconciliation**:
A repair attempt whose publication cannot be verified yet (the remote, the local work or the round's premise could not be read): no new worker and no budget returned until a later sweep gets an answer.

**Concurrent change**:
A remote head the repair attempt did not produce (a collaborator's push) while the round's premise still exists: the factory never publishes over it, preserves the local work, keeps the round charged and asks the human to reconcile both sides; with the premise gone the round returns instead, and with it unreadable the attempt waits unresolved.

**Help notice**:
A notification that work needs the operator on its issue, such as a help request, block or rejection; it points at the issue.

**Retrospective**:
The factory's analysis over a window of finished works, reading their records to propose improvement items; it reviews what already ended, never a live incident.
_Avoid_: Help request, when the work still waits for the operator on its issue.

**Improvement item**:
A candidate change to the factory or a target repo, proposed by a retrospective; it becomes ordinary work only when the operator approves it on the tracker.
_Avoid_: Work, before that approval.

**Retrospective round**:
One execution of the retrospective over a window of finished works, from its trigger to its report. It is a factory job on its own lane — never a Work, never a claim, never a worker slot.
_Avoid_: Work, when the analysis job is meant.

**Retrospective window**:
The finished works one retrospective round analyzes: those finished after the last window report's boundary that no round has analyzed yet, or the last ten when no window report exists yet.
_Avoid_: Pool, when the finished works are meant.

**Retrospective report**:
The dated Markdown artifact a round writes in the workspace; it records every candidate with its outcome, and the last one that covered a window is the marker that defines the next window's boundary.
_Avoid_: Work artifact, when the round's own report is meant.

**Retrospective result record**:
The JSON artifact a round writes beside its report: the machine contract with the factory — which improvement items it filed and where, and which candidates it discarded.
_Avoid_: Outcome record, which is a Work's.
