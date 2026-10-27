import { describeError } from "../format.js";
import { readReservation } from "../pool/reservation.js";
import { readSessionLinks } from "../work-record/continuity.js";
import {
  JIRA_MEDIATION_VERSION,
  appendMediationIntent,
  appendMediationResult,
  ensureMediationDirs,
  pendingMediationRequests,
  readMediationLedger,
  writeMediationContract,
  writeMediationResponse,
  type JiraMediatedComment,
  type JiraMediatedContext,
  type JiraMediatedTicket,
  type JiraMediationContract,
  type JiraMediationRejected,
  type JiraMediationRequest,
  type JiraMediationResponse,
  type JiraOperationLine,
  type JiraPublishOk,
  type JiraPublishRequest,
  type JiraPublishResponse,
  type JiraPublishUnknown,
  type JiraReadResponse,
  type JiraReadUnknown,
  type JiraUnknownFact,
} from "../work-record/jira-mediation.js";
import type { TicketSnapshot, TicketSelection } from "./expanded-port.js";
import {
  repositoryIdentityKey,
  sourceKey,
  workIdentity,
  workIdentityKey,
  type TicketIdentity,
  type WorkIdentity,
} from "./identity.js";
import {
  JiraPublishUnknownError,
  type FactoryCommentPublication,
  type JiraPublishedComment,
} from "./jira-adapter.js";
import type { IssueComment, Known } from "./port.js";

/**
 * The factory side of the mediated Jira interaction: the only party that talks
 * to Jira, as the configured Acting account, on behalf of a launched session.
 * The authority boundary, the answer vocabulary and the correlation that makes
 * a publication attributable are decided in
 * [ADR 0011](../../docs/adr/0011-the-factory-mediates-ticket-access.md).
 *
 * What this module owns is the decision per request: correlation with the Work,
 * its reservation and the recorded session before a single call, the closed set
 * of operations, and the settling of an ambiguous write — never assuming
 * success, never writing twice for one request.
 */

/** The Jira surface the mediator needs; the real adapter implements it. */
export interface JiraMediationTracker {
  readTicket(ticket: TicketIdentity): Promise<Known<TicketSnapshot>>;
  readTicketComments(ticket: TicketIdentity): Promise<Known<IssueComment[]>>;
  publishFactoryComment(
    ticket: TicketIdentity,
    publication: FactoryCommentPublication,
  ): Promise<JiraPublishedComment>;
}

export interface JiraMediationEntry {
  selection: TicketSelection;
  tickets: JiraMediationTracker;
}

export interface JiraMediationOpenInput {
  work: WorkIdentity;
  workDir: string;
  attempt: number;
  sessionId: string;
}

export interface JiraMediationHandle {
  contract: JiraMediationContract;
  close(): void;
}

/** The composition the launch path asks for a handler. */
export interface JiraMediationComposition {
  open(input: JiraMediationOpenInput): JiraMediationHandle | null;
}

export interface JiraMediatorOptions extends JiraMediationOpenInput {
  selection: TicketSelection;
  tickets: JiraMediationTracker;
  /** Poll interval of the request directory; production is a short tick. */
  pollMs?: number;
  /** The clock, injectable for deterministic tests. */
  now?: () => Date;
}

const DEFAULT_POLL_MS = 25;

/** The ticket this handler may read and answer, and the surface it does it
 *  through. Both are fixed before the session starts: a request never chooses
 *  a target. */
interface JiraTarget {
  tickets: JiraMediationTracker;
  ticket: Extract<TicketIdentity, { provider: "jira" }>;
}

export class JiraMediator {
  readonly contract: JiraMediationContract;
  private readonly options: JiraMediatorOptions;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(options: JiraMediatorOptions) {
    if (options.work.ticket.provider !== "jira") {
      throw new Error("the Jira mediator only serves a Jira ticket");
    }
    this.options = options;
    this.contract = { version: JIRA_MEDIATION_VERSION, work: options.work, sessionId: options.sessionId };
  }

  /** Write the contract and begin serving; refuses a launch that cannot be
   *  correlated with the reservation and the session on disk. */
  start(): JiraMediationHandle {
    const problem = this.mismatchProblem({ work: this.options.work, sessionId: this.options.sessionId });
    if (problem !== null) throw new Error(problem);
    ensureMediationDirs(this.options.workDir);
    writeMediationContract(this.options.workDir, this.contract);
    // A failed tick (a transient disk read, a response write) is retried on
    // the next one; it must never become an unhandled rejection in the factory.
    const timer = setInterval(() => void this.tick().catch(() => {}), this.options.pollMs ?? DEFAULT_POLL_MS);
    timer.unref();
    this.timer = timer;
    void this.tick().catch(() => {});
    return {
      contract: this.contract,
      close: () => this.close(),
    };
  }

  close(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Process every pending request once (the tick and the tests share it). */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const { id, request } of pendingMediationRequests(this.options.workDir)) {
        // A request that cannot be trusted as this schema is answered with the
        // rejection it deserves; it is never acted on.
        let response: JiraMediationResponse;
        if (request.state !== "ready") {
          response = this.rejected(id, "unknown", request.state === "invalid" ? request.reason : "the request vanished");
        } else {
          try {
            response = await this.handle(request.value, id);
          } catch (error) {
            // The handler itself failed: the request is answered as unknown, not
            // left to the worker's timeout, and one broken request does not keep
            // the rest of the session's requests from being served.
            response = this.unanswered(id, request.value.operation, describeError(error));
          }
        }
        writeMediationResponse(this.options.workDir, response);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** The whole decision for one request occurrence. */
  async handle(request: JiraMediationRequest, id: string): Promise<JiraMediationResponse> {
    const problem = this.mismatchProblem({ work: request.work, sessionId: request.sessionId });
    if (problem !== null) return this.rejected(id, request.operation, problem);
    const target = this.target();
    if (request.operation === "read") return this.read(target, id);
    return this.publish(target, request);
  }

  /** The handler could not produce an answer at all: `unknown` is the fact, for
   *  a read and for a publication alike — an interrupted publication may have
   *  landed. */
  private unanswered(
    id: string,
    operation: JiraMediationRequest["operation"],
    reason: string,
  ): JiraMediationResponse {
    const boundedReason = bounded(reason);
    if (operation === "read") return this.readUnknown(id, ["ticket", "comments"], boundedReason);
    return { version: JIRA_MEDIATION_VERSION, id, operation: "publish", status: "unknown", reason: boundedReason, at: this.nowIso() };
  }

  private readUnknown(id: string, unknown: JiraUnknownFact[], reason: string): JiraReadUnknown {
    return this.readUnknown(id, unknown, reason);
  }

  private rejected(
    id: string,
    operation: JiraMediationRejected["operation"],
    reason: string,
  ): JiraMediationRejected {
    return { version: JIRA_MEDIATION_VERSION, id, operation, status: "rejected", reason, at: this.nowIso() };
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private target(): JiraTarget {
    const ticket = this.options.work.ticket;
    if (ticket.provider !== "jira") throw new Error("the Jira mediator only serves a Jira ticket");
    return { tickets: this.options.tickets, ticket };
  }

  /**
   * One correlation check for both moments: the launcher asks it before a
   * session starts (a Work whose mediated access cannot be correlated is never
   * launched), and every request is asked against its OWN claims. The facts are
   * read from disk both times — a reservation or a session link that changed
   * mid-session is caught at the request, never assumed from the launch.
   */
  private mismatchProblem(candidate: { work: WorkIdentity; sessionId: string }): string | null {
    const work = this.options.work;
    if (candidate.work.ticket.provider !== "jira") {
      return "the request does not name a Jira ticket";
    }
    if (workIdentityKey(candidate.work) !== workIdentityKey(work)) {
      return "the request names another Work";
    }
    if (sourceKey(candidate.work.ticket) !== sourceKey(this.options.selection.source)) {
      return `the Work's source is not the configured selection's source (${this.options.selection.source.site})`;
    }
    if (repositoryIdentityKey(candidate.work.destination) !== repositoryIdentityKey(this.options.selection.destination)) {
      return "the Work's destination is not the configured selection's destination";
    }
    if (candidate.sessionId !== this.options.sessionId) {
      return "the request names another session; only the launched session may speak";
    }
    const reservation = readReservation(this.options.workDir);
    if (reservation.state !== "persisted") {
      return reservation.state === "absent"
        ? "the Work has no reservation record; a mediated request requires the reservation it belongs to"
        : `the Work's reservation is unreadable (${reservation.reason})`;
    }
    const reserved = workIdentity(reservation.record.ticket, reservation.record.destination);
    if (workIdentityKey(reserved) !== workIdentityKey(work)) {
      return "the Work's reservation names a different Work";
    }
    const links = readSessionLinks(this.options.workDir);
    if (!links.intact) return "the recorded sessions of this Work cannot be read";
    const recorded = links.links.some(
      (link) =>
        link.attempt === this.options.attempt &&
        link.sessionId === this.options.sessionId &&
        workIdentityKey(link.work) === workIdentityKey(work),
    );
    if (!recorded) {
      return "the session is not the one recorded for this Work and attempt; the request is not correlated with the launched session";
    }
    return null;
  }

  private async read(target: JiraTarget, id: string): Promise<JiraReadResponse> {
    const [ticket, comments] = await Promise.allSettled([
      target.tickets.readTicket(target.ticket),
      target.tickets.readTicketComments(target.ticket),
    ]);
    const context: JiraMediatedContext = {};
    const unknown: JiraUnknownFact[] = [];
    const reasons: string[] = [];

    if (ticket.status === "fulfilled" && ticket.value.known) {
      context.ticket = mediatedTicket(target.ticket, ticket.value.value);
    } else {
      unknown.push("ticket");
      reasons.push(unavailableReason("ticket", ticket));
    }
    if (comments.status === "fulfilled" && comments.value.known) {
      context.comments = comments.value.value.map(mediatedComment);
    } else {
      unknown.push("comments");
      reasons.push(unavailableReason("comments", comments));
    }

    const reason = bounded(reasons.join("; ") || "the source did not answer");
    if (unknown.length === 0) {
      return { version: JIRA_MEDIATION_VERSION, id, operation: "read", status: "ok", context, at: this.nowIso() };
    }
    if (Object.keys(context).length > 0) {
      return { version: JIRA_MEDIATION_VERSION, id, operation: "read", status: "partial", context, unknown, reason, at: this.nowIso() };
    }
    return this.readUnknown(id, unknown, reason);
  }

  private async publish(target: JiraTarget, request: JiraPublishRequest): Promise<JiraPublishResponse> {
    const ledger = readMediationLedger(this.options.workDir);
    // The ledger entry belongs to the Work, attempt and session that wrote it —
    // the identity the request itself carries. The record refuses the same id
    // with different content, so a request can never be relabelled into another
    // session's publication.
    const own = (entry: JiraOperationLine): boolean =>
      entry.id === request.id &&
      entry.work === workIdentityKey(this.options.work) &&
      entry.sessionId === request.sessionId &&
      entry.attempt === this.options.attempt;
    const published = ledger.results.find(own);
    if (published !== undefined) {
      return this.publishOk(request.id, published.commentId, published.url ?? null, true);
    }

    // An intent (or a ledger that cannot be trusted) means this request may
    // already have reached Jira: the conversation is read for the correlation
    // before anything is published. An intact ledger with no intent is the one
    // case where a publish is the first attempt.
    const mayHaveLanded = !ledger.intact || ledger.intents.some(own);
    if (mayHaveLanded) {
      const settled = await this.settle(target, request.id);
      if (settled !== null) return settled;
    }
    if (!ledger.intents.some(own)) {
      appendMediationIntent(this.options.workDir, {
        type: "intent",
        at: this.nowIso(),
        id: request.id,
        work: workIdentityKey(this.options.work),
        sessionId: request.sessionId,
        attempt: this.options.attempt,
        kind: request.publication.kind,
      });
    }

    try {
      const result = await target.tickets.publishFactoryComment(target.ticket, {
        kind: request.publication.kind,
        text: request.publication.text,
        correlationId: request.id,
        work: this.options.work,
        sessionId: request.sessionId,
        attempt: this.options.attempt,
      });
      this.recordPublished(request.id, result.commentId, result.url);
      return this.publishOk(request.id, result.commentId, result.url, false);
    } catch (error) {
      const reason = bounded(describeError(error));
      if (!(error instanceof JiraPublishUnknownError)) return this.publishFailed(request.id, reason);
      // Ambiguous: the conversation settles it. A second write from here would
      // be a guess about what the site stored — the retry is the SAME request,
      // issued with its own correlation, reconciled before it publishes.
      const settled = await this.settle(target, request.id);
      return (
        settled ??
        this.publishUnknown(
          request.id,
          `${reason}; the publication may or may not have landed — repeating request ${request.id} settles it`,
        )
      );
    }
  }

  /**
   * The conversation read that settles one request: an answer when the site's
   * evidence settles it, null when the site proves the publication is NOT there
   * — the one state in which the request may publish.
   */
  private async settle(target: JiraTarget, id: string): Promise<JiraPublishOk | JiraPublishUnknown | null> {
    const reconciled = await this.reconcile(target, id);
    if (reconciled.state === "found") {
      this.recordPublished(id, reconciled.commentId, null);
      return this.publishOk(id, reconciled.commentId, null, true);
    }
    if (reconciled.state === "unknown") return this.publishUnknown(id, reconciled.reason);
    return null;
  }

  /**
   * The correlation read behind `settle`. `found` is the publication itself (a
   * comment property carrying the request id); `absent` is the site answering
   * that no such comment exists; `unknown` is an answer that cannot settle the
   * question — an unreadable conversation, or factory speech whose own evidence
   * cannot be read, which might be this very publication.
   */
  private async reconcile(
    target: JiraTarget,
    id: string,
  ): Promise<{ state: "found"; commentId: string } | { state: "absent" } | { state: "unknown"; reason: string }> {
    try {
      const comments = await target.tickets.readTicketComments(target.ticket);
      if (!comments.known) {
        return { state: "unknown", reason: "the ticket conversation could not be read to reconcile the publication" };
      }
      const found = comments.value.find(
        (comment) => comment.agentSpeech === true && comment.agentCorrelation === id,
      );
      if (found !== undefined) return { state: "found", commentId: found.id };
      const unreadable = comments.value.filter(
        (comment) => comment.agentSpeech === true && (comment.agentCorrelation ?? "") === "",
      );
      if (unreadable.length > 0) {
        return {
          state: "unknown",
          reason:
            `the conversation carries ${unreadable.length} factory comment(s) whose correlation cannot be read ` +
            `(ids ${unreadable.map((comment) => comment.id).join(", ")}); one of them may be this publication`,
        };
      }
      return { state: "absent" };
    } catch (error) {
      return { state: "unknown", reason: bounded(describeError(error)) };
    }
  }

  private recordPublished(id: string, commentId: string, url: string | null): void {
    appendMediationResult(this.options.workDir, {
      type: "result",
      at: this.nowIso(),
      id,
      work: workIdentityKey(this.options.work),
      sessionId: this.options.sessionId,
      attempt: this.options.attempt,
      status: "published",
      commentId,
      ...(url === null ? {} : { url }),
    });
  }

  private publishOk(id: string, commentId: string, url: string | null, reconciled: boolean): JiraPublishOk {
    return {
      version: JIRA_MEDIATION_VERSION,
      id,
      operation: "publish",
      status: "ok",
      commentId,
      url,
      reconciled,
      at: this.nowIso(),
    };
  }

  private publishFailed(id: string, reason: string): JiraPublishResponse {
    return { version: JIRA_MEDIATION_VERSION, id, operation: "publish", status: "failed", reason, at: this.nowIso() };
  }

  private publishUnknown(id: string, reason: string): JiraPublishUnknown {
    return { version: JIRA_MEDIATION_VERSION, id, operation: "publish", status: "unknown", reason, at: this.nowIso() };
  }
}

/** The configured selections as a composition: the launch path asks it for a
 *  handler and gets null when no selection serves the Work. */
export class ConfiguredJiraMediation implements JiraMediationComposition {
  constructor(
    private readonly entries: readonly JiraMediationEntry[],
    private readonly options: { pollMs?: number; now?: () => Date } = {},
  ) {}

  open(input: JiraMediationOpenInput): JiraMediationHandle | null {
    const matching = this.entries.filter(
      (entry) =>
        sourceKey(entry.selection.source) === sourceKey(input.work.ticket) &&
        repositoryIdentityKey(entry.selection.destination) ===
          repositoryIdentityKey(input.work.destination),
    );
    if (matching.length === 0) return null;
    if (matching.length > 1) {
      throw new Error(
        `more than one configured Jira selection serves ${workIdentityKey(input.work)}; ` +
          "the mediated access needs exactly one source and destination",
      );
    }
    const entry = matching[0]!;
    return new JiraMediator({
      ...input,
      selection: entry.selection,
      tickets: entry.tickets,
      ...(this.options.pollMs === undefined ? {} : { pollMs: this.options.pollMs }),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    }).start();
  }
}

function mediatedTicket(
  identity: Extract<TicketIdentity, { provider: "jira" }>,
  snapshot: TicketSnapshot,
): JiraMediatedTicket {
  const current = snapshot.ticket.provider === "jira" ? snapshot.ticket : identity;
  return {
    key: current.key,
    url: current.url ?? null,
    title: snapshot.title,
    body: snapshot.body,
    labels: snapshot.labels,
    assignees: snapshot.assignees,
    createdAt: snapshot.createdAt,
  };
}

function mediatedComment(comment: IssueComment): JiraMediatedComment {
  return {
    id: comment.id,
    author: comment.author,
    body: comment.body,
    createdAt: comment.createdAt,
    factory: comment.agentSpeech === true,
    correlationId: comment.agentSpeech === true ? (comment.agentCorrelation ?? null) : null,
  };
}

/** Why one fact of a read is unknown, said with the fact's own name: a source
 *  that answered `unknown` is not the same thing as a source that threw. */
function unavailableReason(fact: JiraUnknownFact, result: PromiseSettledResult<unknown>): string {
  if (result.status === "rejected") return `${fact}: ${bounded(describeError(result.reason))}`;
  return `${fact}: the source did not answer`;
}

function bounded(reason: string): string {
  const oneLine = reason.replace(/\s+/g, " ").trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 297)}...` : oneLine;
}

