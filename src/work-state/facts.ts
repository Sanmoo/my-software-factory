import type {
  ExpandedPrFeedback,
  PullRequestRecord,
  PullRequestTracker,
  TicketSnapshot,
  TicketTracker,
} from "../tracker/expanded-port.js";
import type { IssueComment, PrRepairFacts } from "../tracker/port.js";
import { type WorkspaceLayout } from "../layout.js";
import { peekRecovery, type RecoveryDecision } from "../pool/recovery.js";
import { blockedCommentBody, repairFallComment, type RepairFallCommentInput } from "../state/outcome.js";
import {
  openWorkRecord,
  type ModelProviderFailure,
  type WorkRecord,
  type WorkRecordSnapshot,
} from "../work-record/record.js";
import type { OutcomeRecord } from "../work-record/outcome.js";
import type { RecoveryBudget } from "../config.js";
import type { WorkRef } from "./state.js";

/**
 * The facts the Work state's verdict reads — the module's only door to the
 * outside world (ADR-0010: "the facts a verdict needs stay behind the
 * interface").
 *
 * The rule this file owns, in one place: a read that FAILS is not a fact that
 * is ABSENT. `{ reading: "unreadable" }` says the factory could not read;
 * absence says itself (no PR: `no-pull-request`; nothing on disk: an empty
 * record snapshot; no comment: an empty list). Neither ever becomes an invented
 * verdict: the core decides what each means, and says so where it decides.
 *
 * What lives here beyond plain reads — the two block texts — is here because
 * those texts are built from the attempt's evidence on disk: keeping them
 * behind this seam is what leaves the decision core free of I/O.
 */

/** What a read of one fact came back as. */
export type Fact<T> =
  | { reading: "known"; value: T }
  | { reading: "unreadable"; because: string };

/** The PR of a Work, or the honest reason there is none to speak of. */
export type PullRequestFact =
  | { reading: "with-pull-request"; pr: PullRequestRecord; feedback: ExpandedPrFeedback }
  /** The read succeeded and this Work has no PR yet. */
  | { reading: "no-pull-request" }
  /** The read failed: this says NOTHING about whether a PR exists. */
  | { reading: "unreadable"; because: string };

/** The block text of an unpublished repair attempt, without the work dir. */
export type UnpublishedRepairComment = Omit<RepairFallCommentInput, "workDir" | "workspace">;

export interface WorkFacts {
  /** The ticket, as the tracker states it. */
  ticket(): Promise<Fact<TicketSnapshot>>;
  /** The ticket's comments — the blocked channel's answer. */
  comments(): Promise<Fact<IssueComment[]>>;
  /** The PR and its feedback (conversation + reviews), or none, or a doubt. */
  pullRequest(): Promise<PullRequestFact>;
  /** The PR's structured merge/CI facts (the Repair trigger). */
  repairFacts(): Promise<Fact<PrRepairFacts>>;
  /** The Work record, in one read. */
  record(): Promise<Fact<WorkRecordSnapshot>>;
  /** The model provider failure that ended an attempt's own turn. */
  modelProviderFailure(attempt: number): Promise<ModelProviderFailure | null>;
  /** What the next recovery of this attempt would cost — read, not consumed. */
  recovery(attempt: number): Promise<RecoveryDecision>;
  /** The block text of a written failure, with the attempt's evidence. */
  fallenAttemptComment(record: OutcomeRecord | null, attempt: number): Promise<string>;
  /** The block text of a repair attempt that stopped without publishing. */
  unpublishedRepairComment(input: UnpublishedRepairComment): Promise<string>;
}

/** The ports and budgets the facts are read through: injected once, per module. */
export interface WorkFactsDeps {
  tickets: TicketTracker;
  pullRequests: PullRequestTracker;
  workspace: WorkspaceLayout;
  recovery: RecoveryBudget;
}

/** The reason a port cannot word for itself: it answered `known: false`. */
const TRACKER_SILENT = "the tracker did not answer for it";

export function workFacts(deps: WorkFactsDeps, ref: WorkRef): WorkFacts {
  /** Each read happens once per reading, however many arms ask for it. */
  const once = <T>(read: () => Promise<T>): (() => Promise<T>) => {
    let pending: Promise<T> | null = null;
    return () => (pending ??= read());
  };

  /**
   * The PR read target: the Work alone, letting the code host answer from its
   * own linkage. The persisted association is never preferred over the host's
   * linkage — a stale or unreadable record would silently retarget the read.
   */
  const target = () => ({ work: ref.work, pullRequest: null });

  const record = once((): Promise<WorkRecord> => Promise.resolve(openWorkRecord(ref.dir)));

  const snapshot = once(async (): Promise<Fact<WorkRecordSnapshot>> => {
    try {
      return { reading: "known", value: await (await record()).read() };
    } catch (error) {
      return { reading: "unreadable", because: `the Work record could not be read (${message(error)})` };
    }
  });

  const ticket = once(async (): Promise<Fact<TicketSnapshot>> => {
    const read = await deps.tickets.readTicket(ref.work.ticket);
    return read.known
      ? { reading: "known", value: read.value }
      : { reading: "unreadable", because: TRACKER_SILENT };
  });

  const comments = once(async (): Promise<Fact<IssueComment[]>> => {
    const read = await deps.tickets.readTicketComments(ref.work.ticket);
    return read.known
      ? { reading: "known", value: read.value }
      : { reading: "unreadable", because: TRACKER_SILENT };
  });

  const pullRequest = once(async (): Promise<PullRequestFact> => {
    const read = await deps.pullRequests.readPullRequestFeedback(target());
    if (!read.known) return { reading: "unreadable", because: TRACKER_SILENT };
    return read.value.pr === null
      ? { reading: "no-pull-request" }
      : { reading: "with-pull-request", pr: read.value.pr, feedback: read.value };
  });

  const repairFacts = once(async (): Promise<Fact<PrRepairFacts>> => {
    const read = await deps.pullRequests.readPullRequestRepairFacts(target());
    return read.known
      ? { reading: "known", value: read.value }
      : { reading: "unreadable", because: TRACKER_SILENT };
  });

  return {
    ticket,
    comments,
    pullRequest,
    repairFacts,
    record: snapshot,
    modelProviderFailure: async (attempt) => (await record()).readModelProviderFailure(attempt),
    recovery: (attempt) => peekRecovery(ref.dir, deps.recovery, attempt),
    fallenAttemptComment: (outcomeRecord, attempt) =>
      blockedCommentBody({ attempt, record: outcomeRecord, workDir: ref.dir, workspace: deps.workspace }),
    unpublishedRepairComment: (input) =>
      repairFallComment({ ...input, workDir: ref.dir, workspace: deps.workspace }),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
