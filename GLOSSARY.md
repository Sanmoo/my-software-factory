# Glossary

| Term | Meaning |
|---|---|
| Factory | The service that turns eligible work into reviewed changes for the operator. |
| Work | A piece of requested change the operator wants completed. |
| Worker | The agent carrying out a work item on behalf of the operator. |
| Worker model | The configured AI model the worker uses to do its work. |
| Pool | The set of work currently available for the factory to pick up. |
| Reservation | A claimed work whose session left an open PR; the claim is held while the human reviews. |
| Block | A work the factory stopped driving (2nd consecutive fall or PR closed without merge) until a human answers on the issue. |
| Occurrence | A new act that needs human continuity (initial execution or feedback round leaving a PR open, a help request, a block) — never an ordinary sweep. |
| Notification | A passive local desktop notice about a new occurrence: the work, a brief reason and the relevant GitHub address. |
