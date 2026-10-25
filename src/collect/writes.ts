import type { Config } from "../config.js";
import { describeError } from "../format.js";
import type { GitWork } from "../git/port.js";
import type { WorkspaceLayout } from "../layout.js";
import {
  describeNotification,
  helpNotice,
  type Notification,
  type Notifier,
} from "../notify/port.js";
import { recordPrAssociation } from "../pool/pr-association.js";
import { recordFailure } from "../pool/recovery.js";
import { archiveDoneWorkFor } from "../pool/registry.js";
import { workKeyOf } from "../pool/work-key.js";
import { isRecordedFailure, ownWrittenOutcome } from "../state/outcome.js";
import type { PullRequestRecord, TicketTracker } from "../tracker/expanded-port.js";
import type { WorkIdentity } from "../tracker/identity.js";
import type { OutcomeRecord } from "../work-record/outcome.js";

/**
 * The tracker and disk verbs the factory performs when a verdict is applied
 * (epic #198, ticket #208): archive the work, close the issue with the fallback
 * comment, comment, release the claim, block the claim, persist the written
 * failure, persist the PR association and deliver the occurrence notice.
 *
 * They are ONE set of writes, shared by the collection of an Attempt's end and
 * by the derivation that acts on a fact nobody collected (a work that reached a
 * terminal state while this factory was not running). Nothing here decides
 * anything: the caller hands the work and the words, and gets the write it
 * asked for — so the fall's release and the derivation's unreconciled release
 * cannot drift apart.
 */
export interface WorkWrites {
  /** The done duties on real disk and real git: archive the work's artifacts
   *  (trabalhos/ → arquivo/, nothing deleted) and clean the branches. */
  archiveDone(work: WorkIdentity): Promise<void>;
  /** The delivery a merge without closure implies: close the issue with the
   *  short fallback comment, then archive and clean — done must always be
   *  reflected on the tracker (ticket 04 Q11). */
  closeIssueAndArchive(work: WorkIdentity, comment: string): Promise<void>;
  /** The block every 2nd fall and every rejection shares: the claimed label
   *  swaps to blocked (the claim is held until the terminal state) and the
   *  diagnosis is commented on the issue — the human must SEE why it fell
   *  before deciding to resume. Applying a block IS the new occurrence, so the
   *  help notice is delivered here, once. */
  blockWithComment(work: WorkIdentity, comment: string): Promise<void>;
  /** The 1st-fall release (the ruler's mirrored swap): claimed→ready back, the
   *  assignee of the worker account released — the work re-enters the pool, the
   *  branch stays. */
  releaseClaim(work: WorkIdentity): Promise<void>;
  /** Persist the WRITTEN failure that ended the attempt (issue 123): the next
   *  attempt starts with a full interruption budget, and `msf status` says the
   *  attempt was consumed. A missing or other-attempt record, or a class that
   *  is not a failure (pr-open, self-report), settles nothing. The record is
   *  handed over already read: the caller reads the attempt's own artifact.
   */
  settleFailure(dir: string, attempt: number, record: OutcomeRecord | null): Promise<void>;
  /** A known PR — open, merged or closed — is persisted beside the Work (issue
   *  125): the facts survive a restart, and a later attempt appends its own.
   *  Persistence never changes a reading. */
  persistPrAssociation(
    work: WorkIdentity,
    dir: string,
    pullRequest: PullRequestRecord,
    attempt: number,
  ): Promise<void>;
  /** Best-effort delivery of one occurrence notice; a failure only logs. A
   *  delivery failure never turns unknown safety into permission to launch. */
  notify(notification: Notification): Promise<void>;
}

/** What the writes are given once: the ports, the layout and the operator's
 *  channel. */
export interface WriteDeps {
  config: Config;
  tickets: TicketTracker;
  git: GitWork;
  workspace: WorkspaceLayout;
  log: (message: string) => void;
  /** Host-side notice delivery; absent = silent. */
  notifier?: Notifier;
}

export function openWrites(deps: WriteDeps): WorkWrites {
  const { tickets, config, log } = deps;

  async function notify(notification: Notification): Promise<void> {
    if (!config.notifications) return;
    const notifier = deps.notifier;
    if (notifier === undefined) return;
    try {
      await notifier.notify(notification);
    } catch (error) {
      log(
        `local notification failed (${describeNotification(notification)}): ` +
          describeError(error),
      );
    }
  }

  async function archiveDone(work: WorkIdentity): Promise<void> {
    await archiveDoneWorkFor(deps.workspace, work);
    await deps.git.cleanupDoneWorkFor(work);
  }

  return {
    archiveDone,

    async closeIssueAndArchive(work, comment) {
      await tickets.markTicketDone(work.ticket);
      await tickets.commentOnTicket(work.ticket, comment);
      await archiveDone(work);
    },

    async blockWithComment(work, comment) {
      await tickets.blockTicketClaim(work.ticket, config.labels);
      await tickets.commentOnTicket(work.ticket, comment);
      await notify(helpNotice(work));
    },

    async releaseClaim(work) {
      await tickets.releaseTicketClaim(work.ticket, config.workerGhAccount, config.labels.ready);
    },

    async settleFailure(dir, attempt, record) {
      const own = ownWrittenOutcome(record, attempt);
      if (own !== null && isRecordedFailure(own)) await recordFailure(dir, attempt, own.class);
    },

    async persistPrAssociation(work, dir, pullRequest, attempt) {
      try {
        recordPrAssociation(dir, { work, pullRequest: pullRequest.identity, attempt });
      } catch (error) {
        log(
          `PR association of ${workKeyOf(work)} was not persisted (${describeError(error)}) — ` +
            "the ruling stands and the earlier evidence is untouched",
        );
      }
    },

    notify,
  };
}
