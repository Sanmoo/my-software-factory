import type { ExpandedGitWork, GitWork } from "../git/port.js";
import { issueRefOf, type WorkIdentity } from "../tracker/identity.js";
import type { IssueRef } from "../tracker/port.js";
import { workKeyOf } from "../pool/work-key.js";

/**
 * TEST SUPPORT (issue 126): the expanded {@link ExpandedGitWork} over the e2e
 * git doubles, which still speak the legacy `IssueRef` shape. GitHub-only, and
 * exact for the composition this slice serves: there the ticket's repository
 * IS the destination. A Work outside that — another source, or a GitHub ticket
 * whose destination is another repository — has no exact ref, so it throws
 * rather than route the double to a guessed repository. Every call forwards
 * dynamically, so a double's overridden legacy method stays the seam the test
 * controls. The production git host implements the expanded port natively and
 * never uses this bridge.
 */
export function expandedGitWorkOf(legacy: GitWork): ExpandedGitWork {
  /** The ref of the Work's ticket, refused unless it names the same repository
   *  the double must operate on: a silent misroute would test the wrong repo. */
  const refOf = (work: WorkIdentity): IssueRef => {
    const ref = issueRefOf(work.ticket);
    if (ref.repo !== work.destination.repo) {
      throw new Error(
        `the test git double cannot carry ${workKeyOf(work)}: its ticket is ${ref.repo}, its destination ${work.destination.repo}`,
      );
    }
    return ref;
  };

  return {
    prepareWork: (ref) => legacy.prepareWork(ref),
    prepareWorkFor: (work) => legacy.prepareWork(refOf(work)),
    cleanupDoneWork: (ref) => legacy.cleanupDoneWork(ref),
    cleanupDoneWorkFor: (work) => legacy.cleanupDoneWork(refOf(work)),
    diffWork: (ref) => legacy.diffWork(ref),
    diffWorkFor: (work) => legacy.diffWork(refOf(work)),
    observeRemoteHead: (ref) => legacy.observeRemoteHead(ref),
    observeRemoteHeadFor: (work) => legacy.observeRemoteHead(refOf(work)),
    inspectLocalWork: (ref) => legacy.inspectLocalWork(ref),
    inspectLocalWorkFor: (work) => legacy.inspectLocalWork(refOf(work)),
  };
}
