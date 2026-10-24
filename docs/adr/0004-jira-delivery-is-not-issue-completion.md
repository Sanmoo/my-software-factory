# Jira delivery is not issue completion

Accepted. For Jira-backed work, a confirmed GitHub PR merge establishes delivery and leaves a persistent delivery record, without transitioning the Jira issue; conversely, the Jira issue's Done status category alone satisfies dependencies, even if no PR has merged. We reject treating merge as Jira completion or as sufficient evidence to satisfy a Jira dependency: teams may retain post-merge QA in their existing workflows, and the operator chose the tracker as the authority for dependencies.

Consequently, a delivered work can still block its dependents, and an issue in Done can satisfy them without factory delivery. Entering Done or leaving the selection query does not cancel an existing reservation; cancellation remains explicit. Reexecution of delivered or cancelled work requires an operator command and preserves history, rather than following comments, status changes or removal of a mark.

This decision applies to Jira-backed work, not a rewrite of the existing GitHub Issues completion policy. It records the agreed lifecycle, not already shipped behavior.
