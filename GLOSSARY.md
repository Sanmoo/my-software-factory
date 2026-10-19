# Glossary

| Term | Meaning |
|---|---|
| Factory | The service that turns eligible work into reviewed changes for the operator. |
| Work | A piece of requested change the operator wants completed. |
| Worker | The agent carrying out a work item on behalf of the operator. |
| Worker model | The configured AI model the worker uses to do its work. |
| Pool | The set of work currently available for the factory to pick up. |
| Claim | The factory mark on the tracker that reserves a work: the claim label plus the worker assignee. |
| Reservation | The workspace registry dir of a work (`<workspace>/trabalhos/<repo>#<n>/`) — where its attempts and outcome records live. |
| Unbacked claim | A factory claim mark on the tracker with no reservation in this workspace. |
| Unmarked reservation | A reservation whose work carries no factory mark at all. |
| Attempt | One try by a worker to carry out a work, counted per work. |
| Outcome | The verdict of how an attempt ended. |
| Running | A work whose attempt is being carried out by a live worker right now. |
| Orphaned | A work whose attempt ended without a recorded outcome and with no worker running — an abrupt fall awaiting the factory's next reconciliation. |
| Archived work | A work that reached done, whose artifacts were moved to the archive. |
| Block | A work the factory stopped driving (2nd consecutive fall or PR closed without merge) until a human answers on the issue. |
| Occurrence | A new act that needs human continuity (initial execution or feedback round leaving a PR open, a help request, a block) — never an ordinary sweep. |
| Notification | A passive local desktop notice about a new occurrence: the work, a brief reason and the relevant GitHub address. |
| Notice | The short form of Notification, used in code and docs. |
| Review notice | A notification that a confirmed-open PR waits for the operator; it points at the PR. |
| Repair | An automatic reactivation of a reserved work whose open PR has confirmed conflicts with its base or required checks concluded with failure/timeout; at most two rounds without recovery. |
| Help notice | A notification that a work needs the operator on the issue (help request, block, rejection); it points at the issue. |
