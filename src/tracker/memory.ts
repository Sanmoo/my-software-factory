import type {
  BlockerRef,
  ClaimMark,
  ClaimOutcome,
  Comment,
  DoneOutcome,
  IssueChange,
  IssueRef,
  IssueSnapshot,
  Known,
  ReleaseOutcome,
  StatusCategory,
  TrackerPort,
  TrackerScope,
} from "./port.js";
import { PartialWriteError, refKey } from "./port.js";
import { isObject, type Obj } from "../core/values.js";

// In-memory tracker adapter for tests and the status fixture. It implements the
// normalized port over records loaded from a JSON fixture. Any metadata field may
// be written as {"unknown": "reason"} to model metadata the adapter could not read.
//
// Besides the happy path it carries a failure plan: a test names the operation and the way it
// should fail (`memory.failNext(operação, cenário)`) instead of hand-rolling a wrapper port.

interface StoredIssue {
  ref: IssueRef;
  title: string;
  labels: Known<string[]>;
  assignees: Known<string[]>;
  claimed: Known<boolean>;
  blockers: Known<IssueRef[]>;
  statusCategory: Known<StatusCategory>;
  priority: Known<number | null>;
  body?: Known<string>;
  openSprint?: Known<boolean>;
  assignee?: Known<string | null>;
  comments: Comment[];
}

export class MemoryFixtureError extends Error {}

// The port operations a test can make fail.
export type TrackerOperation = "claim" | "releaseClaim" | "markDone" | "readIssue";

// Named ways a tracker call can fail. The names say what the tracker did, not how the test
// forces it: `falha-antes` writes nothing, `resposta-perdida` writes and loses the answer,
// `parcial` stops after the first step of a composite write with a PartialWriteError,
// `invisível` accepts the write but none of it is visible on the reread, `ultima-invisivel`
// accepts the write but only its last step is not visible, `sem-confirmacao` writes and reports
// attempts without an error, `recusa` refuses the write, and `releitura-falha` makes the next
// read fail.
export type FailureScenario =
  | "falha-antes"
  | "resposta-perdida"
  | "parcial"
  | "invisível"
  | "ultima-invisivel"
  | "sem-confirmacao"
  | "recusa"
  | "releitura-falha";

interface PlannedFailure {
  scenario: FailureScenario;
  message?: string;
}

// One concrete write of a composite operation: the change it reports and the mutation it makes.
interface WriteStep {
  change: IssueChange;
  apply: () => void;
}

export interface MemoryTrackerOptions {
  // The mark the factory's own claim leaves on the issue. It defaults to the `claim` label,
  // matching the fixture convention; a test may model a tracker that also assigns an account.
  claimMark?: ClaimMark;
}

const DEFAULT_CLAIM_MARK: ClaimMark = { labels: ["claim"], assignees: [] };

const isString = (value: unknown): value is string => typeof value === "string";
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isStatus = (value: unknown): value is StatusCategory =>
  value === "to-do" || value === "in-progress" || value === "done";
const isNullableString = (value: unknown): value is string | null => value === null || isString(value);
const isPriority = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isFinite(value));
const isIssueIdentity = (value: unknown): value is { project: string; id: string } =>
  isObject(value) && isString(value.project) && isString(value.id);
const isComment = (value: unknown): value is Comment =>
  isObject(value) && isString(value.id) && isString(value.author) && isBoolean(value.isBot)
  && isString(value.body) && isString(value.createdAt);

function readKnown<T>(raw: Obj, key: string, path: string, check: (value: unknown) => value is T): Known<T> {
  const value = raw[key];
  if (isObject(value) && isString(value.unknown)) return { known: false, reason: value.unknown };
  if (check(value)) return { known: true, value };
  throw new MemoryFixtureError(`fixture inválido em ${path}.${key}`);
}

// Comments are optional in a fixture: they model what the issue already had before a test starts.
function parseComments(raw: Obj, path: string): Comment[] {
  if (raw.comments === undefined) return [];
  if (!Array.isArray(raw.comments) || !raw.comments.every(isComment)) {
    throw new MemoryFixtureError(`fixture inválido em ${path}.comments`);
  }
  return raw.comments.map((comment) => ({ ...comment }));
}

function parseIssue(raw: unknown, index: number): StoredIssue {
  const path = `issues[${index}]`;
  if (!isObject(raw) || !isString(raw.project) || !isString(raw.id) || !isString(raw.title)) {
    throw new MemoryFixtureError(`fixture inválido em ${path}: project, id e title são obrigatórios`);
  }
  const blockers = readKnown(raw, "blockers", path, (value): value is { project: string; id: string }[] =>
    Array.isArray(value) && value.every(isIssueIdentity));
  const issue: StoredIssue = {
    ref: { tracker: "memory", project: raw.project, id: raw.id },
    title: raw.title,
    labels: readKnown(raw, "labels", path, isStringArray),
    assignees: readKnown(raw, "assignees", path, isStringArray),
    claimed: readKnown(raw, "claimed", path, isBoolean),
    blockers: blockers.known
      ? { known: true, value: blockers.value.map((b) => ({ tracker: "memory", project: b.project, id: b.id })) }
      : blockers,
    statusCategory: readKnown(raw, "statusCategory", path, isStatus),
    priority: readKnown(raw, "priority", path, isPriority),
    comments: parseComments(raw, path),
  };
  // The body is optional in a fixture; without one the body is not read.
  if (raw.body !== undefined) issue.body = readKnown(raw, "body", path, isString);
  if (raw.openSprint !== undefined) issue.openSprint = readKnown(raw, "openSprint", path, isBoolean);
  if (raw.assignee !== undefined) issue.assignee = readKnown(raw, "assignee", path, isNullableString);
  return issue;
}

function parseClaimMark(raw: unknown): ClaimMark {
  if (!isObject(raw) || !isStringArray(raw.labels) || !isStringArray(raw.assignees)) {
    throw new MemoryFixtureError("fixture inválido em claimMark: esperado labels e assignees");
  }
  return { labels: [...raw.labels], assignees: [...raw.assignees] };
}

export class MemoryTracker implements TrackerPort {
  private readonly issues = new Map<string, StoredIssue>();
  private readonly mark: ClaimMark;
  private readonly failures = new Map<TrackerOperation, PlannedFailure>();
  private readonly callCounts = new Map<TrackerOperation, number>();

  constructor(issues: StoredIssue[], options: MemoryTrackerOptions = {}) {
    this.mark = options.claimMark ?? DEFAULT_CLAIM_MARK;
    for (const issue of issues) {
      const key = refKey(issue.ref);
      if (this.issues.has(key)) throw new MemoryFixtureError(`issue duplicada no fixture: ${key}`);
      this.issues.set(key, issue);
    }
  }

  claimMarkOf(_ref: IssueRef): ClaimMark {
    return { labels: [...this.mark.labels], assignees: [...this.mark.assignees] };
  }

  // Test control: the next call to `operation` fails the named way. Setting another plan for the
  // same operation replaces the pending one.
  failNext(operation: TrackerOperation, scenario: FailureScenario, message?: string): void {
    this.failures.set(operation, message === undefined ? { scenario } : { scenario, message });
  }

  // Test observation: how many times the operation was called, independent of its outcome.
  calls(operation: TrackerOperation): number {
    return this.callCounts.get(operation) ?? 0;
  }

  async discoverCandidates(scope: TrackerScope): Promise<IssueRef[]> {
    // Issues whose labels cannot be read are still returned: the eligibility
    // rules then reject them with a visible reason instead of hiding them.
    return [...this.issues.values()]
      .filter((issue) => issue.ref.project === scope.project)
      .filter((issue) => !issue.labels.known || issue.labels.value.includes(scope.readyLabel))
      .map((issue) => issue.ref);
  }

  async readIssue(ref: IssueRef): Promise<IssueSnapshot> {
    this.count("readIssue");
    const failure = this.takeFailure("readIssue");
    if (failure?.scenario === "releitura-falha") throw new Error(failure.message ?? "releitura indisponível");
    const issue = this.require(ref);
    const blockers: Known<BlockerRef[]> = issue.blockers.known
      ? { known: true, value: issue.blockers.value.map((blocker) => ({ ref: blocker, terminal: this.terminalOf(blocker) })) }
      : issue.blockers;
    const snapshot: IssueSnapshot = {
      ref: issue.ref,
      title: issue.title,
      labels: issue.labels,
      assignees: issue.assignees,
      claimed: this.claimedOf(issue),
      blockers,
      statusCategory: issue.statusCategory,
      priority: issue.priority,
    };
    if (issue.body) snapshot.body = issue.body;
    if (issue.openSprint) snapshot.openSprint = issue.openSprint;
    if (issue.assignee) snapshot.assignee = issue.assignee;
    return snapshot;
  }

  async claim(ref: IssueRef): Promise<ClaimOutcome> {
    this.count("claim");
    const issue = this.require(ref);
    const failure = this.takeFailure("claim");
    if (failure?.scenario === "recusa") {
      return { status: "rejected", reason: failure.message ?? "claim recusado pelo fornecedor" };
    }
    const claimed = this.claimedOf(issue);
    if (claimed.known && claimed.value) return { status: "rejected", reason: "issue já claimed" };
    if (!issue.labels.known) return { status: "rejected", reason: `labels não lidas: ${issue.labels.reason}` };
    return { status: "accepted", changes: this.executeWrite(this.claimPlan(issue), failure) };
  }

  async releaseClaim(ref: IssueRef): Promise<ReleaseOutcome> {
    this.count("releaseClaim");
    const issue = this.require(ref);
    return { changes: this.executeWrite(this.releasePlan(issue), this.takeFailure("releaseClaim")) };
  }

  // Fixture control: someone else's claim (not the factory's mark) appears or goes away.
  setClaimedElsewhere(ref: IssueRef, claimed: boolean): void {
    this.require(ref).claimed = { known: true, value: claimed };
  }

  // Claimed by the factory's mark or, as the fixture says, by someone else.
  private claimedOf(issue: StoredIssue): Known<boolean> {
    const labels = issue.labels;
    const assignees = issue.assignees;
    const labelMarked = labels.known && this.mark.labels.some((label) => labels.value.includes(label));
    const assigneeMarked = assignees.known && this.mark.assignees.some((account) => assignees.value.includes(account));
    if (labelMarked || assigneeMarked) return { known: true, value: true };
    return issue.claimed;
  }

  async readComments(ref: IssueRef): Promise<Comment[]> {
    return [...this.require(ref).comments];
  }

  async postComment(ref: IssueRef, body: string): Promise<string> {
    const issue = this.require(ref);
    const id = `${ref.id}-comment-${issue.comments.length + 1}`;
    issue.comments.push({
      id,
      author: "memory",
      isBot: false,
      body,
      createdAt: new Date(Date.UTC(2026, 0, 1) + issue.comments.length * 1000).toISOString(),
    });
    return id;
  }

  async markDone(ref: IssueRef): Promise<DoneOutcome> {
    this.count("markDone");
    const issue = this.require(ref);
    const failure = this.takeFailure("markDone");
    if (issue.statusCategory.known && issue.statusCategory.value === "done") {
      return { status: "already-done", changes: [{ operation: "fechar", before: "done", after: "done", result: "unchanged" }] };
    }
    const before = issue.statusCategory.known ? issue.statusCategory.value : undefined;
    const steps: WriteStep[] = [{
      change: { operation: "fechar", ...(before === undefined ? {} : { before }), after: "done", result: "confirmed" },
      apply: () => { issue.statusCategory = { known: true, value: "done" }; },
    }];
    return { status: "done", changes: this.executeWrite(steps, failure) };
  }

  // The mark the factory leaves on the issue: add every label and account of the mark and move
  // a To Do issue to In Progress, each as its own step of the composite write.
  private claimPlan(issue: StoredIssue): WriteStep[] {
    const steps: WriteStep[] = [];
    for (const label of this.mark.labels) {
      steps.push({
        change: { operation: "adicionar-label", target: label, before: "ausente", after: "presente", result: "confirmed" },
        apply: () => {
          const labels = issue.labels;
          if (!labels.known || labels.value.includes(label)) return;
          issue.labels = { known: true, value: [...labels.value, label] };
        },
      });
    }
    for (const account of this.mark.assignees) {
      steps.push({
        change: { operation: "atribuir", target: account, before: "ausente", after: "presente", result: "confirmed" },
        apply: () => {
          const assignees = issue.assignees;
          if (!assignees.known || assignees.value.includes(account)) return;
          issue.assignees = { known: true, value: [...assignees.value, account] };
        },
      });
    }
    if (issue.statusCategory.known && issue.statusCategory.value === "to-do") {
      steps.push({
        change: { operation: "transição", target: "doing", before: "to-do", after: "in-progress", result: "confirmed" },
        apply: () => { issue.statusCategory = { known: true, value: "in-progress" }; },
      });
    }
    return steps;
  }

  // Remove every label and account of the mark. A part already absent is an `unchanged` change.
  private releasePlan(issue: StoredIssue): WriteStep[] {
    const steps: WriteStep[] = [];
    for (const label of this.mark.labels) {
      const had = issue.labels.known && issue.labels.value.includes(label);
      steps.push({
        change: had
          ? { operation: "remover-label", target: label, before: "presente", after: "ausente", result: "confirmed" }
          : { operation: "remover-label", target: label, before: "ausente", after: "ausente", result: "unchanged" },
        apply: () => {
          const labels = issue.labels;
          if (!labels.known) return;
          issue.labels = { known: true, value: labels.value.filter((item) => item !== label) };
        },
      });
    }
    for (const account of this.mark.assignees) {
      const had = issue.assignees.known && issue.assignees.value.includes(account);
      steps.push({
        change: had
          ? { operation: "remover-atribuição", target: account, before: "presente", after: "ausente", result: "confirmed" }
          : { operation: "remover-atribuição", target: account, before: "ausente", after: "ausente", result: "unchanged" },
        apply: () => {
          const assignees = issue.assignees;
          if (!assignees.known) return;
          issue.assignees = { known: true, value: assignees.value.filter((item) => item !== account) };
        },
      });
    }
    return steps;
  }

  // Runs the steps under the queued plan, if any, and reports the changes the call produced.
  // A failure plan is consumed by the next call, never repeated by itself.
  private executeWrite(steps: WriteStep[], failure: PlannedFailure | undefined): IssueChange[] {
    const scenario = failure?.scenario;
    if (scenario === "falha-antes") throw new Error(failure?.message ?? "falha de escrita antes de tocar o fornecedor");
    const applied = scenario === "invisível" ? 0
      : scenario === "ultima-invisivel" ? Math.max(steps.length - 1, 0)
      : scenario === "parcial" ? Math.min(1, steps.length)
      : steps.length;
    for (let index = 0; index < applied; index += 1) steps[index]!.apply();
    if (scenario === "parcial") {
      const made = steps.slice(0, applied).map((step) => ({ ...step.change, result: "attempted" as const }));
      throw new PartialWriteError(failure?.message ?? "escrita parcial", made);
    }
    if (scenario === "resposta-perdida") throw new Error(failure?.message ?? "resposta da escrita perdida");
    if (scenario === "invisível" || scenario === "ultima-invisivel" || scenario === "sem-confirmacao") {
      return steps.map((step) => ({ ...step.change, result: "attempted" as const }));
    }
    return steps.map((step) => ({ ...step.change }));
  }

  private takeFailure(operation: TrackerOperation): PlannedFailure | undefined {
    const failure = this.failures.get(operation);
    if (failure === undefined) return undefined;
    this.failures.delete(operation);
    return failure;
  }

  private count(operation: TrackerOperation): void {
    this.callCounts.set(operation, this.calls(operation) + 1);
  }

  private require(ref: IssueRef): StoredIssue {
    const issue = this.issues.get(refKey(ref));
    if (!issue) throw new Error(`issue não encontrada no tracker de teste: ${refKey(ref)}`);
    return issue;
  }

  // A blocker terminal flag is known only when the blocker itself can be read.
  private terminalOf(blocker: IssueRef): Known<boolean> {
    const issue = this.issues.get(refKey(blocker));
    if (!issue) return { known: false, reason: `bloqueador ${blocker.project}#${blocker.id} não encontrado` };
    if (!issue.statusCategory.known) return { known: false, reason: issue.statusCategory.reason };
    return { known: true, value: issue.statusCategory.value === "done" };
  }
}

// Loads a memory tracker from fixture data; malformed fixtures throw MemoryFixtureError.
export function loadMemoryTracker(raw: unknown): MemoryTracker {
  if (!isObject(raw) || !Array.isArray(raw.issues)) {
    throw new MemoryFixtureError("fixture inválido: esperado objeto com lista issues");
  }
  const options = raw.claimMark === undefined ? {} : { claimMark: parseClaimMark(raw.claimMark) };
  return new MemoryTracker(raw.issues.map((issue, index) => parseIssue(issue, index)), options);
}
