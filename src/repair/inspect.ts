import type { GitWork, LocalWorkFacts } from "../git/port.js";
import type { WorkIdentity } from "../tracker/identity.js";
import type { RemoteObservation } from "../pool/repair.js";

/**
 * The two git reads the Repair reconciliation needs, and the honest answer when
 * git cannot give one — the module's whole dependence on the git host.
 *
 * Both are read-only: the reconciliation never publishes, resets or discards
 * anything, which is why a local work it cannot inspect is `null` ("unknown",
 * never "nothing there") and a remote it cannot read is uncertainty, never an
 * empty branch. The verdicts built on these two answers live in
 * `pool/repair-round.ts`; this file only asks git.
 */

/** The local work of a Work, or null when git cannot answer. */
export async function inspectLocalWork(git: GitWork, work: WorkIdentity): Promise<LocalWorkFacts | null> {
  try {
    return await git.inspectLocalWorkFor(work);
  } catch {
    return null;
  }
}

/** The remote head now, or the honest uncertainty (an unreadable remote is
 *  not an empty branch). */
export async function observeRemote(git: GitWork, work: WorkIdentity): Promise<RemoteObservation> {
  try {
    return { known: true, headSha: await git.observeRemoteHeadFor(work) };
  } catch {
    return { known: false };
  }
}
