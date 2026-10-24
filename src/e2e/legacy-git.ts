import type { GitWork, LocalWorkFacts, PreparedWork } from "../git/port.js";
import { workKeyOf } from "../pool/work-key.js";
import type { IssueRef } from "../tracker/port.js";
import type { WorkIdentity } from "../tracker/identity.js";

/**
 * TEST SUPPORT: the expanded {@link GitWork} over the e2e git doubles, which
 * are GitHub-only by construction. It is not a production bridge: the real git
 * host implements the Work-addressed interface directly. The double's ref is
 * exact only for the composition the GitHub e2e suites exercise (the ticket's
 * repository IS the destination); anything else is refused rather than routed
 * to a guessed repository.
 */
export interface LegacyGitWork {
  prepareWork(ref: IssueRef): Promise<PreparedWork>;
  cleanupDoneWork(ref: IssueRef): Promise<void>;
  diffWork(ref: IssueRef): Promise<string>;
  observeRemoteHead(ref: IssueRef): Promise<string | null>;
  inspectLocalWork(ref: IssueRef): Promise<LocalWorkFacts>;
}

export function expandedGitWorkOf(legacy: LegacyGitWork): GitWork {
  /** The ref of the Work's ticket, refused unless it names the same repository
   *  the double must operate on: a silent misroute would test the wrong repo. */
  const refOf = (work: WorkIdentity): IssueRef => {
    const { ticket, destination } = work;
    if (ticket.provider !== "github" || ticket.repo !== destination.repo) {
      throw new Error(
        `the test git double cannot carry ${workKeyOf(work)}: it is GitHub-only and must name its own destination`,
      );
    }
    return { repo: ticket.repo, number: ticket.number };
  };

  return {
    prepareWorkFor: (work) => legacy.prepareWork(refOf(work)),
    cleanupDoneWorkFor: (work) => legacy.cleanupDoneWork(refOf(work)),
    diffWorkFor: (work) => legacy.diffWork(refOf(work)),
    observeRemoteHeadFor: (work) => legacy.observeRemoteHead(refOf(work)),
    inspectLocalWorkFor: (work) => legacy.inspectLocalWork(refOf(work)),
  };
}
