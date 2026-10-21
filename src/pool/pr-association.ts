
import {
  isPullRequestIdentity,
  isRepositoryIdentity,
  isTicketIdentity,
  pullRequestIdentityKey,
  repositoryIdentityKey,
  workIdentity,
  workIdentityKey,
  type PullRequestIdentity,
  type RepositoryIdentity,
  type TicketIdentity,
  type WorkIdentity,
} from "../tracker/identity.js";
import {
  readPersistedRecord,
  writePersistedRecord,
  type PersistedFacts,
  type PersistedFile,
} from "./persisted.js";

/**
 * The persisted PR association (issue 125): which PRs a Work has had, kept in
 * its registry dir as associacoes-pr.json. A PR number is only meaningful with
 * its repository, and the Work it delivers is fixed by its ticket identity —
 * so a restart correlates evidence instead of asking the current
 * configuration. A later attempt appends its PR; earlier associations are
 * never removed (a replaced PR stays inspectable).
 */

/** Disk name stays PT-BR with the rest of the registry. */
export const PR_ASSOCIATIONS_FILENAME = "associacoes-pr.json";

/** The PR the Work currently has; replaced ones stay as history. */
export type PrAssociationState = "active" | "historical";

export interface PrAssociationEntry {
  pullRequest: PullRequestIdentity;
  /** The attempt that opened it — the association's own fact. */
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
export type PrAssociationsFacts = PersistedFacts<PrAssociationsRecord>;

export class PrAssociationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrAssociationError";
  }
}

/** The PR the Work currently has (the last one recorded), or null before any. */
export function activePullRequest(record: PrAssociationsRecord): PullRequestIdentity | null {
  for (let index = record.associations.length - 1; index >= 0; index -= 1) {
    const entry = record.associations[index]!;
    if (entry.state === "active") return entry.pullRequest;
  }
  return null;
}

export function readPrAssociations(dir: string): PrAssociationsFacts {
  return readPersistedRecord(dir, PR_ASSOCIATIONS_FILE);
}

/**
 * Record the PR of an attempt. Idempotent for the same Work and PR (a
 * feedback/repair round adds nothing); a new PR becomes the active one and the
 * previous one stays as history. An unreadable file or a file of another Work
 * is refused: history is never overwritten.
 */
export function recordPrAssociation(
  dir: string,
  input: {
    work: WorkIdentity;
    pullRequest: PullRequestIdentity;
    /** The attempt that opened the PR. */
    attempt: number;
    openedAt?: string;
  },
): PrAssociationsRecord {
  const { work, pullRequest, attempt } = input;
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new PrAssociationError(`invalid attempt ${attempt}: an association belongs to a numbered attempt`);
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

  const facts = readPrAssociations(dir);
  if (facts.state === "unreadable") {
    throw new PrAssociationError(`PR associations of ${dir} are unreadable (${facts.reason}); refusing to overwrite them`);
  }
  const existing =
    facts.state === "persisted"
      ? facts.record
      : { version: 1 as const, ticket: work.ticket, destination: work.destination, associations: [] };
  if (
    facts.state === "persisted" &&
    workIdentityKey(workIdentity(existing.ticket, existing.destination)) !== workIdentityKey(work)
  ) {
    throw new PrAssociationError(
      `PR associations of ${dir} belong to a different Work ` +
        `(${workIdentityKey(workIdentity(existing.ticket, existing.destination))})`,
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
  writePersistedRecord(dir, PR_ASSOCIATIONS_FILENAME, record);
  return record;
}

function isPrAssociationsRecord(value: unknown): value is PrAssociationsRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record["version"] !== 1) return false;
  if (!isTicketIdentity(record["ticket"])) return false;
  if (!isRepositoryIdentity(record["destination"])) return false;
  if (!Array.isArray(record["associations"])) return false;

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
    if (association["state"] !== "active" && association["state"] !== "historical") return false;
  }
  // No single-active cap: earlier associations stay readable, so a later
  // execution's records are never called unreadable.
  return true;
}

const PR_ASSOCIATIONS_FILE: PersistedFile<PrAssociationsRecord> = {
  filename: PR_ASSOCIATIONS_FILENAME,
  what: "a PR association record",
  isRecord: isPrAssociationsRecord,
};
