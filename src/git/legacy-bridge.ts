import type { ExpandedGitWork, GitWork } from "./port.js";
import { issueRefOf } from "../tracker/identity.js";

/**
 * TRANSITIONAL bridge (issue 126): the expanded {@link ExpandedGitWork} over
 * a git host that still speaks the legacy `IssueRef` shape. The migrated
 * orchestration calls the expanded methods; existing test doubles (and any
 * consumer not migrated yet) keep implementing the legacy ones. Every call
 * forwards dynamically, so an overridden legacy method stays the seam the
 * test controls. A non-GitHub Work has no legacy ref and is refused here —
 * the production git host implements the expanded port natively.
 */
export function expandedGitWorkOf(legacy: GitWork): ExpandedGitWork {
  return {
    prepareWork: (ref) => legacy.prepareWork(ref),
    prepareWorkFor: (work) => legacy.prepareWork(issueRefOf(work.ticket)),
    cleanupDoneWork: (ref) => legacy.cleanupDoneWork(ref),
    cleanupDoneWorkFor: (work) => legacy.cleanupDoneWork(issueRefOf(work.ticket)),
    diffWork: (ref) => legacy.diffWork(ref),
    diffWorkFor: (work) => legacy.diffWork(issueRefOf(work.ticket)),
    observeRemoteHead: (ref) => legacy.observeRemoteHead(ref),
    observeRemoteHeadFor: (work) => legacy.observeRemoteHead(issueRefOf(work.ticket)),
    inspectLocalWork: (ref) => legacy.inspectLocalWork(ref),
    inspectLocalWorkFor: (work) => legacy.inspectLocalWork(issueRefOf(work.ticket)),
  };
}
