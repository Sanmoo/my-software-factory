import type {
  BlockerRef,
  ClaimOutcome,
  Comment,
  DoneOutcome,
  IssueRef,
  IssueSnapshot,
  Known,
  StatusCategory,
  TrackerPort,
  TrackerScope,
} from "./port.js";
import { refKey } from "./port.js";

// In-memory tracker adapter for tests and the status fixture. It implements the
// normalized port over records loaded from a JSON fixture. Any metadata field may
// be written as {"unknown": "reason"} to model metadata the adapter could not read.

interface StoredIssue {
  ref: IssueRef;
  title: string;
  labels: Known<string[]>;
  assignees: Known<string[]>;
  claimed: Known<boolean>;
  blockers: Known<IssueRef[]>;
  statusCategory: Known<StatusCategory>;
  priority: Known<number | null>;
  openSprint?: Known<boolean>;
  assignee?: Known<string | null>;
  comments: Comment[];
}

export class MemoryFixtureError extends Error {}

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
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
  if (raw.openSprint !== undefined) issue.openSprint = readKnown(raw, "openSprint", path, isBoolean);
  if (raw.assignee !== undefined) issue.assignee = readKnown(raw, "assignee", path, isNullableString);
  return issue;
}

export class MemoryTracker implements TrackerPort {
  private readonly issues = new Map<string, StoredIssue>();

  constructor(issues: StoredIssue[]) {
    for (const issue of issues) {
      const key = refKey(issue.ref);
      if (this.issues.has(key)) throw new MemoryFixtureError(`issue duplicada no fixture: ${key}`);
      this.issues.set(key, issue);
    }
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
    const issue = this.require(ref);
    const blockers: Known<BlockerRef[]> = issue.blockers.known
      ? { known: true, value: issue.blockers.value.map((blocker) => ({ ref: blocker, terminal: this.terminalOf(blocker) })) }
      : issue.blockers;
    const snapshot: IssueSnapshot = {
      ref: issue.ref,
      title: issue.title,
      labels: issue.labels,
      assignees: issue.assignees,
      claimed: issue.claimed,
      blockers,
      statusCategory: issue.statusCategory,
      priority: issue.priority,
    };
    if (issue.openSprint) snapshot.openSprint = issue.openSprint;
    if (issue.assignee) snapshot.assignee = issue.assignee;
    return snapshot;
  }

  async claim(ref: IssueRef): Promise<ClaimOutcome> {
    const issue = this.require(ref);
    if (issue.claimed.known && issue.claimed.value) {
      return { status: "rejected", reason: "issue já claimed" };
    }
    issue.claimed = { known: true, value: true };
    if (issue.statusCategory.known && issue.statusCategory.value === "to-do") {
      issue.statusCategory = { known: true, value: "in-progress" };
    }
    return { status: "accepted" };
  }

  async releaseClaim(ref: IssueRef): Promise<void> {
    this.require(ref).claimed = { known: true, value: false };
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
    const issue = this.require(ref);
    if (issue.statusCategory.known && issue.statusCategory.value === "done") {
      return { status: "already-done" };
    }
    issue.statusCategory = { known: true, value: "done" };
    return { status: "done" };
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
  return new MemoryTracker(raw.issues.map((issue, index) => parseIssue(issue, index)));
}
