import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  isPullRequestIdentity,
  isRepositoryIdentity,
  isTicketIdentity,
  pullRequestIdentityKey,
  repositoryIdentityKey,
  workIdentityKey,
  type PullRequestIdentity,
  type RepositoryIdentity,
  type TicketIdentity,
  type WorkIdentity,
} from "../tracker/identity.js";

/**
 * The persisted PR association (issue 125): which PRs a Work has had, kept in
 * its registry dir as associacoes-pr.json. A PR number is only meaningful with
 * its repository, and the Work it delivers is fixed by its ticket identity —
 * so a restart correlates evidence instead of asking the current
 * configuration. A later execution appends its PR; earlier associations are
 * never removed (a replaced PR stays inspectable).
 */

/** Disk name stays PT-BR with the rest of the registry. */
export const PR_ASSOCIATIONS_FILENAME = "associacoes-pr.json";

/** The one factory-conducted PR is active; replaced ones stay as history. */
export type PrAssociationState = "active" | "historical";

export interface PrAssociationEntry {
  pullRequest: PullRequestIdentity;
  /** The execution (attempt) that opened it — the association's own fact. */
  attempt: number;
  openedAt: string;
  state: PrAssociationState;
}

export interface PrAssociationsRecord {
  version: 1;
  ticket: TicketIdentity;
  destination: RepositoryIdentity;
  associations: PrAssociationEntry[];
}

/** Absent is the honest empty state: a Work that never had a PR. */
export type PrAssociationsFacts =
  | { state: "persisted"; record: PrAssociationsRecord }
  | { state: "absent" }
  | { state: "unreadable"; reason: string };

export class PrAssociationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrAssociationError";
  }
}

/** The Work's one factory-conducted PR, or null when none is associated yet. */
export function activePullRequest(record: PrAssociationsRecord): PullRequestIdentity | null {
  const active = record.associations.find((entry) => entry.state === "active");
  return active?.pullRequest ?? null;
}

export async function readPrAssociations(dir: string): Promise<PrAssociationsFacts> {
  let raw: string;
  try {
    raw = await readFile(join(dir, PR_ASSOCIATIONS_FILENAME), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" };
    return { state: "unreadable", reason: `cannot read ${PR_ASSOCIATIONS_FILENAME}: ${describe(error)}` };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPrAssociationsRecord(parsed)) {
      return { state: "unreadable", reason: `${PR_ASSOCIATIONS_FILENAME} is not a PR association record` };
    }
    return { state: "persisted", record: parsed };
  } catch (error) {
    return { state: "unreadable", reason: `${PR_ASSOCIATIONS_FILENAME} is not valid JSON: ${describe(error)}` };
  }
}

/**
 * Record the PR of an execution. Idempotent for the same Work and PR (a
 * feedback/repair round adds nothing); a new PR becomes the active one and the
 * previous one stays as history. An unreadable file or a file of another Work
 * is refused: history is never overwritten.
 */
export async function recordPrAssociation(
  dir: string,
  input: {
    work: WorkIdentity;
    pullRequest: PullRequestIdentity;
    /** The execution that opened the PR. */
    attempt: number;
    openedAt?: string;
  },
): Promise<PrAssociationsRecord> {
  const { work, pullRequest, attempt } = input;
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new PrAssociationError(`invalid attempt ${attempt}: an association belongs to a numbered execution`);
  }
  if (!isPullRequestIdentity(pullRequest)) {
    throw new PrAssociationError("invalid pull request identity");
  }
  if (repositoryIdentityKey(pullRequest.repository) !== repositoryIdentityKey(work.destination)) {
    throw new PrAssociationError(
      `PR ${pullRequest.number} belongs to ${repositoryIdentityKey(pullRequest.repository)}, ` +
        `not to this Work's destination (${repositoryIdentityKey(work.destination)})`,
    );
  }

  const facts = await readPrAssociations(dir);
  if (facts.state === "unreadable") {
    throw new PrAssociationError(`PR associations of ${dir} are unreadable (${facts.reason}); refusing to overwrite them`);
  }
  const existing =
    facts.state === "persisted"
      ? facts.record
      : { version: 1 as const, ticket: work.ticket, destination: work.destination, associations: [] };
  if (facts.state === "persisted" && workIdentityKey(workOf(existing)) !== workIdentityKey(work)) {
    throw new PrAssociationError(
      `PR associations of ${dir} belong to a different Work (${workIdentityKey(workOf(existing))})`,
    );
  }

  const already = existing.associations.some(
    (entry) => pullRequestIdentityKey(entry.pullRequest) === pullRequestIdentityKey(pullRequest),
  );
  if (already) return existing;

  const record: PrAssociationsRecord = {
    ...existing,
    associations: [
      ...existing.associations.map((entry) => ({ ...entry, state: "historical" as const })),
      {
        pullRequest,
        attempt,
        openedAt: input.openedAt ?? new Date().toISOString(),
        state: "active",
      },
    ],
  };
  mkdirSync(dir, { recursive: true });
  await writeFile(join(dir, PR_ASSOCIATIONS_FILENAME), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

function workOf(record: PrAssociationsRecord): WorkIdentity {
  return { ticket: record.ticket, destination: record.destination };
}

function isPrAssociationsRecord(value: unknown): value is PrAssociationsRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record["version"] !== 1) return false;
  if (!isTicketIdentity(record["ticket"])) return false;
  if (!isRepositoryIdentity(record["destination"])) return false;
  if (!Array.isArray(record["associations"])) return false;

  let active = 0;
  for (const entry of record["associations"]) {
    if (entry === null || typeof entry !== "object") return false;
    const association = entry as Record<string, unknown>;
    if (!isPullRequestIdentity(association["pullRequest"])) return false;
    if (
      repositoryIdentityKey(association["pullRequest"].repository) !==
      repositoryIdentityKey(record["destination"] as RepositoryIdentity)
    ) {
      return false;
    }
    if (typeof association["attempt"] !== "number" || !Number.isInteger(association["attempt"]) || association["attempt"] < 1) {
      return false;
    }
    if (typeof association["openedAt"] !== "string" || association["openedAt"] === "") return false;
    if (association["state"] === "active") active += 1;
    else if (association["state"] !== "historical") return false;
  }
  return active <= 1;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
