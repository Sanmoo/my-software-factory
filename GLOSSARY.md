# Glossary

| Term | Meaning |
|---|---|
| Factory | The service that turns eligible work into reviewed changes for the operator. |
| Work | A piece of requested change the operator wants completed. |
| Worker | The agent carrying out a work item on behalf of the operator. |
| Worker model | The configured AI model the worker uses to do its work. |
| Pool | The set of work currently available for the factory to pick up. |
| Claim | The factory mark on the tracker that reserves a work: the claim label plus the worker assignee. |
| Padlock | The claim label (`agent-claimed`). It lands before the pool label (`ready-for-agent`) leaves, so the claim label's presence — never the pool label's absence — is the exclusion guarantee. |
| Reservation | The workspace registry dir of a work (`<workspace>/trabalhos/<repo>#<n>/`) — where its attempts and outcome records live. |
| Unbacked claim | A factory claim mark on the tracker with no reservation in this workspace. |
| Unmarked reservation | A reservation whose work carries no factory mark at all. |
| Reserved without attempt | A reservation whose dir carries no attempt evidence yet — the claim landed, the worker has not. |
| Attempt | One try by a worker to carry out a work, counted per work. |
| Outcome | The verdict of how an attempt ended. |
| Running | A work whose attempt is being carried out by a live worker right now. |
| Orphaned | A work whose current attempt ended without an outcome record of its own and with no worker running — an abrupt fall awaiting the factory's next reconciliation. An older attempt's record on disk is history, never this attempt's outcome. |
| Archived work | A work that reached done, whose artifacts were moved to the archive. |
| Block | A work the factory stopped driving (2nd consecutive worker fall, 2nd consecutive Repair fall, or PR closed without merge) until a human answers on the issue. |
| Occurrence | A new act that needs human continuity (initial execution or feedback round leaving a PR open, a help request, a block) — never an ordinary sweep. |
| Notification | A passive local desktop notice about a new occurrence: the work, a brief reason and the relevant GitHub address. |
| Notice | The short form of Notification, used in code and docs. |
| Review notice | A notification that a confirmed-open PR waits for the operator; it points at the PR. |
| Repair | An automatic reactivation of a reserved work whose open PR has confirmed conflicts with its base or required checks concluded with failure/timeout; at most two rounds without recovery. |
| Verified activity | What the agents themselves write under the dirs the session binds (the session transcripts, the work artifacts) — the only input of the idle limit, so a worker waiting on its reviewer subagents is not idle and an unconditional heartbeat is not work. |
| Repair fall | A repair attempt that ended without publishing (abruptly or by a normal end) and without a concurrent change on the remote: its round is returned to the budget and it counts against a separate limit, so two consecutive falls block the work — the open PR never hides the fall. |
| Pending reconciliation | A repair attempt whose publication cannot be verified yet (the remote or the local work could not be read): no new worker and no budget returned until a later sweep gets an answer. |
| Concurrent change | A remote head the repair attempt did not produce (a collaborator's push): the factory never publishes over it, preserves the local work, keeps the round charged and asks the human to reconcile both sides. |
| Help notice | A notification that a work needs the operator on the issue (help request, block, rejection); it points at the issue. |
