import type { ExpandedGitWork, GitWork } from "../git/port.js";
import { issueRefOf } from "../tracker/identity.js";

/**
 * TEST SUPPORT (issue 126): the expanded {@link ExpandedGitWork} over a test
 * double that still speaks the legacy `IssueRef` shape. The migrated
 * orchestration calls the expanded methods; the existing e2e fakes keep their
 * legacy seams. Every call forwards dynamically, so a fake's overridden legacy
 * method stays the seam the test controls. The production git host implements
 * the expanded port natively and never uses this bridge.
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
