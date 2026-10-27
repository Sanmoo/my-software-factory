import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

import { describeError } from "../format.js";
import { readReservation } from "../pool/reservation.js";
import { readSessionLinks } from "../work-record/continuity.js";
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
import {
  JIRA_CONTRACT_FILENAME,
  JIRA_MEDIATION_DIRNAME,
  JIRA_MEDIATION_VERSION,
  JIRA_OPERATIONS_FILENAME,
  JIRA_REQUESTS_DIRNAME,
  JIRA_RESPONSES_DIRNAME,
  isJiraRequestId,
  parseJiraMediationRequest,
  type JiraMediatedComment,
  type JiraMediatedContext,
  type JiraMediatedTicket,
  type JiraMediationContract,
  type JiraMediationRejected,
  type JiraMediationRequest,
  type JiraMediationResponse,
  type JiraPublishOk,
  type JiraPublishRequest,
  type JiraPublishResponse,
  type JiraReadResponse,
  type JiraUnknownFact,
} from "./jira-mediation-protocol.js";
import type { IssueComment, Known } from "./port.js";

/**
 * The factory side of the mediated Jira interaction.
 *
 * The worker writes requests into the Work's own directory; this handler is
 * the only party that talks to Jira, using the configured Acting account. Each
 * request is validated against the launched Work, the persisted reservation,
 * the recorded session, the configured source/destination and the operation
 * whitelist BEFORE any Jira call. A request for another Work/site or an
 * operation outside the contract is rejected without a single HTTP request.
 *
 * Publications carry a comment property with the request id: an ambiguous
 * write is reconciled by reading the conversation for that id, never by
 * assuming success or by publishing a second copy.
 *
 * This is credential handling, not isolation: the worker shares the work dir
 * and, per the accepted Docker-daemon decision, is root-equivalent on the
 * host. The token stays in the factory process and never enters the launch
 * artifacts; that is the promise this module keeps.
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

interface OperationIntent {
  type: "intent";
  at: string;
  id: string;
  work: string;
  sessionId: string;
  attempt: number;
  kind: string;
}

interface OperationResult {
  type: "result";
  at: string;
  id: string;
  work: string;
  sessionId: string;
  attempt: number;
  status: "published";
  commentId: string;
  url: string;
}

type OperationLine = OperationIntent | OperationResult;

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
  private readonly directory: string;
  private readonly requestsDir: string;
  private readonly responsesDir: string;
  private readonly operationsFile: string;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(options: JiraMediatorOptions) {
    if (options.work.ticket.provider !== "jira") {
      throw new Error("the Jira mediator only serves a Jira ticket");
    }
    this.options = options;
    this.directory = join(options.workDir, JIRA_MEDIATION_DIRNAME);
    this.requestsDir = join(this.directory, JIRA_REQUESTS_DIRNAME);
    this.responsesDir = join(this.directory, JIRA_RESPONSES_DIRNAME);
    this.operationsFile = join(this.directory, JIRA_OPERATIONS_FILENAME);
    this.contract = { version: JIRA_MEDIATION_VERSION, work: options.work, sessionId: options.sessionId };
  }

  /** Write the contract and begin serving; refuses a launch that cannot be
   *  correlated with the reservation and the session on disk. */
  start(): JiraMediationHandle {
    const problem = this.preflightProblem();
    if (problem !== null) throw new Error(problem);
    mkdirSync(this.requestsDir, { recursive: true });
    mkdirSync(this.responsesDir, { recursive: true });
    writeJsonAtomic(join(this.directory, JIRA_CONTRACT_FILENAME), this.contract);
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
      for (const name of readdirSync(this.requestsDir).sort()) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -".json".length);
        if (!isJiraRequestId(id)) continue;
        const requestFile = join(this.requestsDir, name);
        const responseFile = join(this.responsesDir, name);
        // A retry re-writes the request with the SAME id: a response older than
        // the request is the previous occurrence, not the answer to this one.
        if (existsSync(responseFile) && statSync(responseFile).mtimeMs >= statSync(requestFile).mtimeMs) continue;
        await this.handleFile(requestFile, id);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** One request file: read, validate, answer, write the answer atomically. */
  async handleFile(file: string, id: string): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(file, "utf8")) as unknown;
    } catch {
      value = null;
    }
    const response = await this.handle(value, id);
    writeJsonAtomic(join(this.responsesDir, `${id}.json`), response);
  }

  /** The whole decision for one request occurrence. */
  async handle(value: unknown, id: string): Promise<JiraMediationResponse> {
    const parsed = parseJiraMediationRequest(value, id);
    if (!parsed.ok) return this.rejected(id, "unknown", parsed.reason);
    const problem = this.correlationProblem(parsed.request);
    if (problem !== null) return this.rejected(id, parsed.request.operation, problem);
    const target = this.target();
    if (parsed.request.operation === "read") return this.read(target, id);
    return this.publish(target, parsed.request);
  }

  private rejected(
    id: string,
    operation: JiraMediationRejected["operation"],
    reason: string,
  ): JiraMediationRejected {
    return { version: 1, id, operation, status: "rejected", reason, at: this.nowIso() };
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private target(): JiraTarget {
    const ticket = this.options.work.ticket;
    if (ticket.provider !== "jira") throw new Error("the Jira mediator only serves a Jira ticket");
    return { tickets: this.options.tickets, ticket };
  }

  /** The correlation every request must satisfy, independent of the request. */
  private preflightProblem(): string | null {
    const work = this.options.work;
    if (work.ticket.provider !== "jira") return "the Work's ticket is not a Jira ticket";
    if (sourceKey(work.ticket) !== sourceKey(this.options.selection.source)) {
      return `the Work's source is not the configured selection's source (${this.options.selection.source.site})`;
    }
    if (repositoryIdentityKey(work.destination) !== repositoryIdentityKey(this.options.selection.destination)) {
      return "the Work's destination is not the configured selection's destination";
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

  /** The same facts again, plus the request's own Work/session claims. */
  private correlationProblem(request: JiraMediationRequest): string | null {
    const work = this.options.work;
    if (request.work.ticket.provider !== "jira") {
      return "the request does not name a Jira ticket";
    }
    if (sourceKey(request.work.ticket) !== sourceKey(this.options.selection.source)) {
      return `the request names site "${request.work.ticket.site}", not this Work's configured source "${this.options.selection.source.site}"`;
    }
    if (repositoryIdentityKey(request.work.destination) !== repositoryIdentityKey(this.options.selection.destination)) {
      return "the request names a destination that is not this Work's configured destination";
    }
    if (workIdentityKey(request.work) !== workIdentityKey(work)) {
      return "the request names another Work";
    }
    if (request.sessionId !== this.options.sessionId) {
      return "the request names another session; only the launched session may speak";
    }
    return this.preflightProblem();
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
      reasons.push(ticketReason(ticket));
    }
    if (comments.status === "fulfilled" && comments.value.known) {
      context.comments = comments.value.value.map(mediatedComment);
    } else {
      unknown.push("comments");
      reasons.push(commentsReason(comments));
    }

    const reason = bounded(reasons.join("; ") || "the source did not answer");
    if (unknown.length === 0) {
      return { version: 1, id, operation: "read", status: "ok", context, at: this.nowIso() };
    }
    if (Object.keys(context).length > 0) {
      return { version: 1, id, operation: "read", status: "partial", context, unknown, reason, at: this.nowIso() };
    }
    return { version: 1, id, operation: "read", status: "unknown", unknown, reason, at: this.nowIso() };
  }

  private async publish(target: JiraTarget, request: JiraPublishRequest): Promise<JiraPublishResponse> {
    const operations = readOperations(this.operationsFile);
    // The ledger entry belongs to the Work, attempt and session that wrote it:
    // a reused request id from another session is not this publication.
    const own = (entry: OperationLine): boolean =>
      entry.id === request.id &&
      entry.work === workIdentityKey(this.options.work) &&
      entry.sessionId === request.sessionId &&
      entry.attempt === this.options.attempt;
    const published = operations.find(
      (entry): entry is OperationResult => entry.type === "result" && own(entry),
    );
    if (published !== undefined) {
      return this.publishOk(request.id, published.commentId, published.url, true);
    }

    const hadIntent = operations.some((entry) => entry.type === "intent" && own(entry));
    if (hadIntent) {
      const reconciled = await this.reconcile(target, request.id);
      if (reconciled.state === "found") {
        this.recordPublished(request.id, reconciled.commentId, null);
        return this.publishOk(request.id, reconciled.commentId, null, true);
      }
      if (reconciled.state === "unknown") {
        return this.publishUnknown(request.id, reconciled.reason);
      }
    } else {
      appendOperation(this.operationsFile, {
        type: "intent",
        at: this.nowIso(),
        id: request.id,
        work: workIdentityKey(this.options.work),
        sessionId: request.sessionId,
        attempt: this.options.attempt,
        kind: request.publication.kind,
      });
    }

    let lastReason = "";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
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
        lastReason = bounded(describeError(error));
        if (!(error instanceof JiraPublishUnknownError)) {
          return this.publishFailed(request.id, lastReason);
        }
        const reconciled = await this.reconcile(target, request.id);
        if (reconciled.state === "found") {
          this.recordPublished(request.id, reconciled.commentId, null);
          return this.publishOk(request.id, reconciled.commentId, null, true);
        }
        if (reconciled.state === "unknown") {
          return this.publishUnknown(request.id, `${lastReason}; reconciliation is unknown too: ${reconciled.reason}`);
        }
        // Known absent: the write did not land, so one retry is safe.
      }
    }
    return this.publishUnknown(request.id, lastReason || "the publication stayed ambiguous after a retry");
  }

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
      return found === undefined ? { state: "absent" } : { state: "found", commentId: found.id };
    } catch (error) {
      return { state: "unknown", reason: bounded(describeError(error)) };
    }
  }

  private recordPublished(id: string, commentId: string, url: string | null): void {
    appendOperation(this.operationsFile, {
      type: "result",
      at: this.nowIso(),
      id,
      work: workIdentityKey(this.options.work),
      sessionId: this.options.sessionId,
      attempt: this.options.attempt,
      status: "published",
      commentId,
      url: url ?? "",
    });
  }

  private publishOk(id: string, commentId: string, url: string | null, reconciled: boolean): JiraPublishOk {
    return {
      version: 1,
      id,
      operation: "publish",
      status: "ok",
      commentId,
      url: url === "" ? null : url,
      reconciled,
      at: this.nowIso(),
    };
  }

  private publishFailed(id: string, reason: string): JiraPublishResponse {
    return { version: 1, id, operation: "publish", status: "failed", reason, at: this.nowIso() };
  }

  private publishUnknown(id: string, reason: string): JiraPublishResponse {
    return { version: 1, id, operation: "publish", status: "unknown", reason, at: this.nowIso() };
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

function ticketReason(result: PromiseSettledResult<Known<TicketSnapshot>>): string {
  if (result.status === "rejected") return `ticket: ${bounded(describeError(result.reason))}`;
  return "ticket: the source did not answer";
}

function commentsReason(result: PromiseSettledResult<Known<IssueComment[]>>): string {
  if (result.status === "rejected") return `comments: ${bounded(describeError(result.reason))}`;
  return "comments: the source did not answer";
}

function bounded(reason: string): string {
  const oneLine = reason.replace(/\s+/g, " ").trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 297)}...` : oneLine;
}

/** One JSON file, written so a reader never sees a partial answer. */
function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
}

/** The append-only operation ledger: an intent is on disk before the write, so
 *  an interruption leaves the correlation the next request reconciles with. */
function readOperations(file: string): OperationLine[] {
  if (!existsSync(file)) return [];
  const entries: OperationLine[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isOperationLine(parsed)) entries.push(parsed);
    } catch {
      // A corrupt line is history that cannot authorize anything; the comment
      // property remains the authoritative evidence for reconciliation.
    }
  }
  return entries;
}

function appendOperation(file: string, entry: OperationLine): void {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, "a", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(entry)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function isOperationLine(value: unknown): value is OperationLine {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry["at"] !== "string" || typeof entry["id"] !== "string" || !isJiraRequestId(entry["id"])) return false;
  if (entry["type"] === "intent") {
    return (
      typeof entry["work"] === "string" &&
      typeof entry["sessionId"] === "string" &&
      typeof entry["attempt"] === "number" &&
      typeof entry["kind"] === "string"
    );
  }
  if (entry["type"] === "result") {
    return (
      typeof entry["work"] === "string" &&
      typeof entry["sessionId"] === "string" &&
      typeof entry["attempt"] === "number" &&
      entry["status"] === "published" &&
      typeof entry["commentId"] === "string" &&
      typeof entry["url"] === "string"
    );
  }
  return false;
}
