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

**Destination**:
The GitHub repository that receives a Work's code and PR.

**Repository identity**:
Provider + site + the destination repository name; the code-host identity, never the ticket identity.

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

**Acting account**:
The account authenticated by the factory on an issue tracker, receiving claim assignment and authoring the factory's comments there.
_Avoid_: Current user, when it could mean either the operator or the authenticated account.

**Pool**:
The set of work currently available for the factory to pick up.

**Claim**:
The factory's mark on the issue tracker that reserves work, together with assignment to its acting account.

**Padlock**:
The claim mark identifying work as already reserved and unavailable for another pickup.

**Reservation**:
The workspace record of a work: its source and destination facts, attempts, outcomes and PR associations.

**Unbacked claim**:
A factory claim mark on the tracker with no reservation in this workspace.

**Unmarked reservation**:
A reservation whose work carries no factory mark at all.

**Reserved without attempt**:
A reservation with no attempt evidence yet: the claim landed, but the worker has not.

**Attempt**:
One logical try by a worker to carry out a work, counted per work. It survives infrastructure interruptions: recovering an interrupted attempt does not start or consume another.

**Outcome**:
The verdict of how an attempt ended.

**Interruption**:
An attempt that ended without an outcome record: a SIGKILLed worker, a dead factory process, a dead container, a hard stop. It is not a failure: it consumes no attempt and never enters the fall ruler.

**Recovery**:
The automatic relaunch of an interrupted attempt, after the configured backoff, with the SAME attempt number and the branch preserved.

**Recovery budget**:
The finite, per-work and persisted allowance of recoveries for one attempt. Exhausting it pauses the work and asks for help; it is separate from the attempt count.

**Failed sweep**:
A sweep that could not read the tracker or complete its derivation: it acts on nothing, spends no attempt, and the factory repeats it on the next tick. It is not an Interruption of any work.

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
Docker did not answer — a failure, a timeout, an invalid answer, or a worker container whose work this workspace cannot name. The factory cannot tell a live worker from a dead one, so new launches are suspended and no attempt, recovery or block is spent until a reliable answer returns.
_Avoid_: No workers, when the answer is missing.

**Duplicate workers**:
More than one live container carrying the same work. Each occupies a slot and the work is not launched again; the factory chooses no owner and ends nothing, and asks the operator to decide.

**Intervention notice**:
The operator's notice that a live worker needs a decision the factory will not make alone: duplicate containers of one work, or a survivor silent past the idle limit. It says nothing was ended, replaced or chosen.
_Avoid_: Help notice, when the work is not blocked.

**Factory notice**:
The operator's notice about the factory itself, naming no work: Docker has not answered long enough for launches to stop. It is never posted on an issue.
_Avoid_: Work notice, when no work is involved.

**Archived work**:
A work that reached done, whose artifacts were moved to the archive.

**Abrupt death**:
The runtime's structured fact for a session that ended with no outcome record: at collection, the fingerprint of an interruption.

**Fall**:
A WRITTEN failure or abandon of an attempt, ruled by the 1st/2nd-fall rule (1st releases, 2nd consecutive blocks). An interruption is never a fall.

**Block**:
A work the factory stopped driving (2nd consecutive failed attempt, exhausted recovery budget, 2nd consecutive Repair fall, or PR closed without merge) until a human answers on its issue.

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
A repair attempt that ended without publishing (abruptly or by a normal end), whose impediment still exists, and without a concurrent change on the remote: its round is returned to the budget and it counts against a separate limit, so two consecutive falls block the work; the open PR never hides the fall.

**Obsolete premise**:
The impediment that opened a Repair no longer exists when the round ends (the PR is mergeable and no required check is failing): the round returns with no fall counted and the work stays as delivered.
_Avoid_: Repair fall, when the round was returned because there was nothing left to fix.

**Pending reconciliation**:
A repair attempt whose publication cannot be verified yet (the remote or the local work could not be read): no new worker and no budget returned until a later sweep gets an answer.

**Concurrent change**:
A remote head the repair attempt did not produce (a collaborator's push): the factory never publishes over it, preserves the local work, keeps the round charged and asks the human to reconcile both sides.

**Help notice**:
A notification that work needs the operator on its issue, such as a help request, block or rejection; it points at the issue.

**Retrospective**:
The operator-invoked analysis over a window of finished works, reading their records to propose improvement items; it reviews what already ended, never a live incident.
_Avoid_: Help request, when the work still waits for the operator on its issue.

**Improvement item**:
A candidate change to the factory or a target repo, proposed by a retrospective; it becomes ordinary work only when the operator approves it on the tracker.
_Avoid_: Work, before that approval.
