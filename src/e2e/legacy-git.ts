import type { ExpandedGitWork, GitWork } from "../git/port.js";
import { issueRefOf } from "../tracker/identity.js";

/**
 * TEST SUPPORT (issue 126): the expanded {@link ExpandedGitWork} over the e2e
 * git doubles, which still speak the legacy `IssueRef` shape. GitHub-only, and
 * exact for the composition this slice serves: there the ticket's repository
 * IS the destination, so the ref the double receives names the same Work. A
 * Work of another source has no `IssueRef` and throws here — never routed to a
 * guessed repository. Every call forwards dynamically, so a double's overridden
 * legacy method stays the seam the test controls. The production git host
 * implements the expanded port natively and never uses this bridge.
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
