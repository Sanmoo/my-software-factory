import { cloneJson, type JsonValue } from "./json.js";

export type { JsonValue };

/**
 * A minimal model of the Jira Cloud surfaces the candidate protocols use.
 *
 * The model carries ONLY what the primary sources document (see sources.ts)
 * plus explicit, named knobs for the facts Jira does not document. The default
 * knobs are the weakest semantics the documentation allows — never a hidden
 * lock, queue, lease or winner oracle:
 *
 *  - `eligibilityAt` — the docs say the bulk-property filter identifies
 *    "issues eligible for update", but not WHEN the filter is evaluated. At
 *    `enqueue` the eligible set is fixed when the 303 is returned; at `apply`
 *    it is read when the job runs. Both are admitted by the text.
 *  - `isolation` — the docs call the operation transactional (all eligible
 *    issues or none). They do not state isolation between concurrent jobs.
 *    `none` lets two jobs observe the pre-state and both commit
 *    (last write wins, exactly the entity-properties warning); `serialized`
 *    is the undocumented compare-and-set PREMISE: the eligibility test and the
 *    write are one indivisible step per issue.
 *  - `readModel` — `fresh` returns the stored value; `prefix` may omit recent
 *    writes, the monotonic staleness the search API explicitly admits
 *    ("Recent updates might not be immediately visible").
 *  - `taskResult` — the task's `result` content is operation-specific and the
 *    bulk-property operation documents none. `counts` models an undocumented
 *    result that would report how many issues were updated.
 *
 * Asynchronous tasks are not guaranteed to run in order (documented), so job
 * application order is the caller's choice, independent of submission order.
 */

export type EligibilityMoment = "enqueue" | "apply";
export type JobIsolation = "none" | "serialized";
export type ReadModel = "fresh" | "prefix";
export type TaskResult = "undocumented" | "counts";

export interface JiraModel {
  eligibilityAt: EligibilityMoment;
  isolation: JobIsolation;
  /** Freshness of a DIRECT property GET. */
  readModel: ReadModel;
  taskResult: TaskResult;
  /** The JQL search that feeds pool discovery is eventually consistent. */
  searchStale: boolean;
}

export const DOCUMENTED_MODEL: JiraModel = {
  eligibilityAt: "apply",
  isolation: "none",
  readModel: "fresh",
  taskResult: "undocumented",
  searchStale: false,
};

export const CAS_PREMISE_MODEL: JiraModel = {
  eligibilityAt: "apply",
  isolation: "serialized",
  readModel: "fresh",
  taskResult: "undocumented",
  searchStale: false,
};

export function modelLabel(model: JiraModel): string {
  return `${model.eligibilityAt}-${model.isolation}-${model.readModel}-${model.taskResult}-${model.searchStale ? "stale-search" : "direct-search"}`;
}

export type JobStatus = "ENQUEUED" | "RUNNING" | "COMPLETE" | "FAILED";

export interface TaskSnapshot {
  taskId: string;
  status: JobStatus;
  result: JsonValue | null;
}

export type ReadResult = { kind: "present"; value: JsonValue } | { kind: "absent" };

export interface IssueView {
  issueId: number;
  key: string;
  assignee: string | null;
  labels: string[];
  status: string;
}

export type RequestOutcome =
  | "scheduled"
  | "applied"
  | "skipped"
  | "absent"
  | "present"
  | "failed"
  | "lost"
  | "refused"
  | "deleted";

export interface RequestRecord {
  seq: number;
  at: number;
  site: string;
  factory: string;
  op: string;
  issueId: number | null;
  outcome: RequestOutcome;
  detail: string;
}

export class JiraRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "JiraRequestError";
  }
}

/** The write was applied (or the job scheduled) and the response was lost. */
export class JiraNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraNetworkError";
  }
}

interface IssueState {
  site: string;
  issueId: number;
  key: string;
  properties: Map<string, JsonValue>;
  /** One entry per write; a deletion appends `undefined`. Index 0 is "never set". */
  history: Map<string, Array<JsonValue | undefined>>;
  assignee: string | null;
  labels: Set<string>;
  status: string;
}

type JobKind = "conditional-property" | "list-property";

interface Job {
  taskId: string;
  kind: JobKind;
  site: string;
  issueId: number;
  propertyKey: string;
  value: JsonValue;
  factory: string;
  submittedSeq: number;
  status: JobStatus;
  enqueuedEligible: boolean;
  eligible: boolean | null;
  result: JsonValue | undefined;
}

export interface SubmitOutcome {
  kind: "scheduled";
  taskId: string;
}

export interface SubmitFaults {
  /** The connection failed before the request reached Jira: no job exists. */
  failBeforeScheduling?: boolean;
  /** Jira scheduled the job and the 303 response was lost on the way back. */
  loseResponseAfterScheduling?: boolean;
}

function issueKeyOf(site: string, issueId: number): string {
  return `${site}\u0000${issueId}`;
}

export class JiraCloud {
  private readonly issues = new Map<string, IssueState>();
  private readonly keys = new Map<string, Map<string, number>>();
  private readonly jobs = new Map<string, Job>();
  private readonly requests: RequestRecord[] = [];
  private taskSeq = 0;
  private requestSeq = 0;
  private clock = Date.UTC(2026, 9, 24, 12, 0, 0);
  private nextReadFailure: string | null = null;

  constructor(readonly model: JiraModel) {}

  now(): number {
    return this.clock;
  }

  advance(ms: number): void {
    this.clock += ms;
  }

  nowIso(): string {
    return new Date(this.clock).toISOString();
  }

  seedIssue(input: {
    site: string;
    stableId: string;
    key: string;
    properties?: Record<string, JsonValue>;
    assignee?: string | null;
    labels?: string[];
    status?: string;
  }): void {
    const issueId = Number(input.stableId);
    if (!Number.isInteger(issueId) || issueId <= 0) {
      throw new Error(`a Jira issue id is a positive integer, got ${input.stableId}`);
    }
    const state: IssueState = {
      site: input.site,
      issueId,
      key: input.key,
      properties: new Map(Object.entries(input.properties ?? {})),
      history: new Map(),
      assignee: input.assignee ?? null,
      labels: new Set(input.labels ?? []),
      status: input.status ?? "To Do",
    };
    for (const [propertyKey, value] of state.properties) {
      state.history.set(propertyKey, [undefined, cloneJson(value)]);
    }
    this.issues.set(issueKeyOf(input.site, issueId), state);
    const siteKeys = this.keys.get(input.site) ?? new Map<string, number>();
    siteKeys.set(input.key, issueId);
    this.keys.set(input.site, siteKeys);
  }

  resolveIssue(site: string, keyOrId: string | number): { issueId: number; key: string } | null {
    if (typeof keyOrId === "number") {
      const state = this.issues.get(issueKeyOf(site, keyOrId));
      return state ? { issueId: state.issueId, key: state.key } : null;
    }
    const issueId = this.keys.get(site)?.get(keyOrId);
    if (issueId === undefined) return null;
    const state = this.issues.get(issueKeyOf(site, issueId));
    return state ? { issueId: state.issueId, key: state.key } : null;
  }

  issueView(site: string, issueId: number): IssueView {
    const state = this.requireIssue(site, issueId);
    return {
      issueId: state.issueId,
      key: state.key,
      assignee: state.assignee,
      labels: [...state.labels].sort(),
      status: state.status,
    };
  }

  /** The stored value, bypassing the read model — the harness's own observation. */
  storedProperty(site: string, issueId: number, propertyKey: string): ReadResult {
    const value = this.requireIssue(site, issueId).properties.get(propertyKey);
    return value === undefined ? { kind: "absent" } : { kind: "present", value: cloneJson(value) };
  }

  /** The next property read fails: a transient read error, not an answer. */
  failNextRead(reason: string): void {
    this.nextReadFailure = reason;
  }

  readProperty(input: {
    site: string;
    issueId: number;
    propertyKey: string;
    factory: string;
    via: "direct" | "search";
  }): ReadResult {
    if (this.nextReadFailure !== null) {
      const reason = this.nextReadFailure;
      this.nextReadFailure = null;
      this.record(input.site, input.factory, "GET issue property", input.issueId, "failed", reason);
      throw new JiraRequestError(503, reason);
    }
    const state = this.requireIssue(input.site, input.issueId);
    const history = state.history.get(input.propertyKey) ?? [undefined];
    const stale =
      input.via === "search" ? this.model.searchStale : this.model.readModel === "prefix";
    const index = stale ? history.length - 2 : history.length - 1;
    const value = index >= 0 ? history[index] : undefined;
    const result: ReadResult =
      value === undefined ? { kind: "absent" } : { kind: "present", value: cloneJson(value) };
    this.record(
      input.site,
      input.factory,
      input.via === "search" ? "GET issue property (search)" : "GET issue property",
      input.issueId,
      result.kind,
      "",
    );
    return result;
  }

  /** `PUT /rest/api/3/issue/{issueIdOrKey}/properties/{propertyKey}` — blind, last write wins. */
  setPropertyBlind(input: {
    site: string;
    issueId: number;
    propertyKey: string;
    value: JsonValue;
    factory: string;
    fault?: "fail-before-write" | "lose-response-after-write";
  }): void {
    const state = this.requireIssue(input.site, input.issueId);
    if (input.fault === "fail-before-write") {
      this.record(input.site, input.factory, "PUT single issue property", input.issueId, "failed", "request rejected before the write");
      throw new JiraRequestError(400, "request rejected before the write");
    }
    this.writeProperty(state, input.propertyKey, input.value);
    if (input.fault === "lose-response-after-write") {
      this.record(input.site, input.factory, "PUT single issue property", input.issueId, "lost", "applied; response lost");
      throw new JiraNetworkError("the property was written and the response was lost");
    }
    this.record(input.site, input.factory, "PUT single issue property", input.issueId, "applied", "written");
  }

  /**
   * `PUT /rest/api/3/issue/properties/{propertyKey}` with
   * `filter: {entityIds, hasProperty: false}` — asynchronous, transactional.
   * "No eligible issue" is still a 303: the endpoint does not report it.
   */
  submitConditional(input: {
    site: string;
    issueId: number;
    propertyKey: string;
    value: JsonValue;
    factory: string;
    faults?: SubmitFaults;
  }): SubmitOutcome {
    const state = this.requireIssue(input.site, input.issueId);
    if (input.faults?.failBeforeScheduling) {
      this.record(input.site, input.factory, "PUT bulk issue property", input.issueId, "failed", "connection failed before the job existed");
      throw new JiraRequestError(0, "connection failed before the job existed");
    }
    const job = this.scheduleJob("conditional-property", state, input.propertyKey, input.value, input.factory);
    this.record(input.site, input.factory, "PUT bulk issue property", input.issueId, "scheduled", job.taskId);
    if (input.faults?.loseResponseAfterScheduling) {
      this.record(input.site, input.factory, "PUT bulk issue property", input.issueId, "lost", `${job.taskId} scheduled; response lost`);
      throw new JiraNetworkError("the job was scheduled and the response was lost");
    }
    return { kind: "scheduled", taskId: job.taskId };
  }

  /**
   * `POST /rest/api/3/issue/properties` — the list form: no filter, so every
   * listed issue is written when the job runs. The documented all-or-nothing
   * transaction protects the set against errors, never against a concurrent
   * job writing the same issue.
   */
  submitListSet(input: {
    site: string;
    issueId: number;
    propertyKey: string;
    value: JsonValue;
    factory: string;
    faults?: SubmitFaults;
  }): SubmitOutcome {
    const state = this.requireIssue(input.site, input.issueId);
    if (input.faults?.failBeforeScheduling) {
      this.record(input.site, input.factory, "POST bulk issue properties", input.issueId, "failed", "connection failed before the job existed");
      throw new JiraRequestError(0, "connection failed before the job existed");
    }
    const job = this.scheduleJob("list-property", state, input.propertyKey, input.value, input.factory);
    this.record(input.site, input.factory, "POST bulk issue properties", input.issueId, "scheduled", job.taskId);
    if (input.faults?.loseResponseAfterScheduling) {
      this.record(input.site, input.factory, "POST bulk issue properties", input.issueId, "lost", `${job.taskId} scheduled; response lost`);
      throw new JiraNetworkError("the job was scheduled and the response was lost");
    }
    return { kind: "scheduled", taskId: job.taskId };
  }

  /** First half of a NON-isolated job: read eligibility, write nothing. */
  beginJob(taskId: string): boolean {
    const job = this.requireJob(taskId);
    const state = this.requireIssue(job.site, job.issueId);
    job.status = "RUNNING";
    job.eligible =
      job.kind === "list-property"
        ? true
        : this.model.eligibilityAt === "enqueue"
          ? job.enqueuedEligible
          : this.absentToday(state, job.propertyKey);
    return job.eligible;
  }

  /** Second half: commit the decision `beginJob` recorded, last write wins. */
  commitJob(taskId: string): void {
    const job = this.requireJob(taskId);
    if (job.eligible === null) throw new Error(`job ${taskId} was never begun`);
    this.finishJob(job);
  }

  /** The CAS premise: eligibility and write in ONE indivisible step. */
  applyJob(taskId: string): void {
    const job = this.requireJob(taskId);
    const state = this.requireIssue(job.site, job.issueId);
    job.status = "RUNNING";
    job.eligible =
      job.kind === "list-property"
        ? true
        : this.model.eligibilityAt === "enqueue"
          ? job.enqueuedEligible
          : this.absentToday(state, job.propertyKey);
    this.finishJob(job);
  }

  /** A job that fails transactionally: "when errors occur, none are updated". */
  failJob(taskId: string, reason: string): void {
    const job = this.requireJob(taskId);
    job.status = "FAILED";
    job.result = { error: reason };
    this.record(job.site, job.factory, "bulk job", job.issueId, "failed", reason);
  }

  pollTask(taskId: string, factory: string): TaskSnapshot {
    const job = this.requireJob(taskId);
    this.record(job.site, factory, "GET task", job.issueId, job.status === "COMPLETE" ? "present" : "skipped", job.status);
    return {
      taskId,
      status: job.status,
      result: job.result === undefined ? null : cloneJson(job.result),
    };
  }

  setAssigneeBlind(input: { site: string; issueId: number; accountId: string; factory: string; fault?: boolean }): void {
    const state = this.requireIssue(input.site, input.issueId);
    if (input.fault) {
      this.record(input.site, input.factory, "PUT assignee", input.issueId, "failed", "rejected");
      throw new JiraRequestError(403, "not permitted");
    }
    state.assignee = input.accountId;
    this.record(input.site, input.factory, "PUT assignee", input.issueId, "applied", input.accountId);
  }

  clearAssignee(input: { site: string; issueId: number; factory: string }): void {
    const state = this.requireIssue(input.site, input.issueId);
    state.assignee = null;
    this.record(input.site, input.factory, "PUT assignee", input.issueId, "deleted", "unassigned");
  }

  removeLabel(input: { site: string; issueId: number; label: string; factory: string }): void {
    const state = this.requireIssue(input.site, input.issueId);
    state.labels.delete(input.label);
    this.record(input.site, input.factory, "PUT issue labels", input.issueId, "deleted", input.label);
  }

  addLabelBlind(input: { site: string; issueId: number; label: string; factory: string; fault?: boolean }): void {
    const state = this.requireIssue(input.site, input.issueId);
    if (input.fault) {
      this.record(input.site, input.factory, "PUT issue labels", input.issueId, "failed", "rejected");
      throw new JiraRequestError(400, "not permitted");
    }
    state.labels.add(input.label);
    this.record(input.site, input.factory, "PUT issue labels", input.issueId, "applied", input.label);
  }

  transitionBlind(input: { site: string; issueId: number; status: string; factory: string; fault?: boolean }): void {
    const state = this.requireIssue(input.site, input.issueId);
    if (input.fault) {
      this.record(input.site, input.factory, "POST transition", input.issueId, "failed", "rejected");
      throw new JiraRequestError(400, "not permitted");
    }
    state.status = input.status;
    this.record(input.site, input.factory, "POST transition", input.issueId, "applied", input.status);
  }

  /** Manual release/transfer outside the acquisition protocol (confirm end first). */
  deleteProperty(input: { site: string; issueId: number; propertyKey: string; actor: string }): void {
    const state = this.requireIssue(input.site, input.issueId);
    this.writeProperty(state, input.propertyKey, undefined);
    this.record(input.site, input.actor, "DELETE issue property", input.issueId, "deleted", input.propertyKey);
  }

  scheduledTaskIds(): string[] {
    return [...this.jobs.keys()];
  }

  requestLog(): readonly RequestRecord[] {
    return this.requests;
  }

  appliedWrites(): number {
    return this.requests.filter((entry) => entry.outcome === "applied").length;
  }

  private scheduleJob(
    kind: JobKind,
    state: IssueState,
    propertyKey: string,
    value: JsonValue,
    factory: string,
  ): Job {
    this.taskSeq += 1;
    const at = this.requests.length + 1;
    const job: Job = {
      taskId: `task-${this.taskSeq}`,
      kind,
      site: state.site,
      issueId: state.issueId,
      propertyKey,
      value: cloneJson(value),
      factory,
      submittedSeq: at,
      status: "ENQUEUED",
      enqueuedEligible: this.absentToday(state, propertyKey),
      eligible: null,
      result: undefined,
    };
    this.jobs.set(job.taskId, job);
    return job;
  }

  private finishJob(job: Job): void {
    const state = this.requireIssue(job.site, job.issueId);
    const written = job.eligible === true;
    if (written) this.writeProperty(state, job.propertyKey, job.value);
    job.status = "COMPLETE";
    job.result = this.model.taskResult === "counts" ? { updated: written ? 1 : 0 } : undefined;
    this.record(job.site, job.factory, "bulk job", job.issueId, written ? "applied" : "skipped", job.taskId);
  }

  private absentToday(state: IssueState, propertyKey: string): boolean {
    return state.properties.get(propertyKey) === undefined;
  }

  private writeProperty(state: IssueState, propertyKey: string, value: JsonValue | undefined): void {
    if (value === undefined) {
      state.properties.delete(propertyKey);
    } else {
      state.properties.set(propertyKey, cloneJson(value));
    }
    const history = state.history.get(propertyKey) ?? [undefined];
    history.push(value === undefined ? undefined : cloneJson(value));
    state.history.set(propertyKey, history);
  }

  private requireIssue(site: string, issueId: number): IssueState {
    const state = this.issues.get(issueKeyOf(site, issueId));
    if (state === undefined) throw new JiraRequestError(404, `issue ${issueId} not found on ${site}`);
    return state;
  }

  private requireJob(taskId: string): Job {
    const job = this.jobs.get(taskId);
    if (job === undefined) throw new JiraRequestError(404, `task ${taskId} not found`);
    return job;
  }

  private record(
    site: string,
    factory: string,
    op: string,
    issueId: number | null,
    outcome: RequestOutcome,
    detail: string,
  ): void {
    this.requestSeq += 1;
    this.requests.push({
      seq: this.requestSeq,
      at: this.clock,
      site,
      factory,
      op,
      issueId,
      outcome,
      detail,
    });
  }
}
