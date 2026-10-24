import {
  GITHUB_SITE,
  githubRepository,
  githubTicket,
  githubTicketAt,
  jiraTicket,
  type RepositoryIdentity,
  type TicketProvider,
  type WorkIdentity,
} from "../tracker/identity.js";

/**
 * The on-disk key of a Work — the registry's identity anchor, i.e. the name of
 * its dir under <workspace>/trabalhos/.
 *
 * GitHub on github.com keeps its legacy "<repo>#<n>" key: those reservations
 * exist on disk today, stay readable and are never relocated. Every other
 * source — another provider, or another GitHub site — encodes provider, site,
 * stable ticket id and destination repo in ONE segment
 * ("jira@<site>@<stableId>@<repo>", each component URI-encoded). The encoding
 * is injective — a component can never produce the "@" separator, a "/" or a
 * "#" — so no slug or sanitization silently merges two Works.
 *
 * The human-readable ticket key (a Jira "ABC-123") is deliberately absent:
 * Jira lets it change, and a rename must not move a reservation. It is
 * presentation, persisted in the reservation record.
 */

/**
 * What a key encodes: provider + site + stable ticket id + destination repo.
 *
 * A GitHub ticket is taken to live in its destination repo — the only shape the
 * factory produces today (a legacy `IssueRef` names one repo for both). A
 * GitHub site other than github.com whose ticket repo differs from the
 * destination would collapse two tickets of the same number onto one key; that
 * shape has no producer yet, and admitting it means widening this anchor.
 */
export interface WorkAnchor {
  provider: TicketProvider;
  site: string;
  /** The provider's immutable ticket id (a GitHub issue's number, as text). */
  stableId: string;
  /** The destination repository name (code host identity). */
  repo: string;
}

const LEGACY_GITHUB_KEY = /^(.+)#(\d+)$/;
const RECORD_KEY = /^([a-z]+)@([^@]+)@([^@]+)@([^@]+)$/;

export function anchorOfWork(work: WorkIdentity): WorkAnchor {
  const { ticket, destination } = work;
  return {
    provider: ticket.provider,
    site: ticket.site,
    stableId: ticket.stableId,
    repo: destination.repo,
  };
}

/** The comparable identity of an anchor — presentation never enters. */
export function keyOfAnchor(anchor: WorkAnchor): string {
  if (anchor.provider === "github" && anchor.site === GITHUB_SITE) {
    return `${anchor.repo}#${anchor.stableId}`;
  }
  return [
    anchor.provider,
    encodeComponent(anchor.site),
    encodeComponent(anchor.stableId),
    encodeComponent(anchor.repo),
  ].join("@");
}

/** The registry key of a Work: where its reservation lives in this workspace. */
export function workKeyOf(work: WorkIdentity): string {
  return keyOfAnchor(anchorOfWork(work));
}

/**
 * The Work a key anchors, with the readable ticket key the key cannot carry
 * (ignored for GitHub, whose readable key is the issue number).
 */
export function workOfAnchor(anchor: WorkAnchor, readableKey: string): WorkIdentity {
  const destination: RepositoryIdentity = githubRepository(anchor.repo);
  if (anchor.provider === "github") {
    return { ticket: githubTicketAt(anchor.site, anchor.repo, Number(anchor.stableId)), destination };
  }
  return { ticket: jiraTicket({ site: anchor.site, stableId: anchor.stableId, key: readableKey }), destination };
}

export function anchorOfKey(key: string): WorkAnchor | null {
  const legacy = LEGACY_GITHUB_KEY.exec(key);
  if (legacy !== null) {
    const number = Number(legacy[2]);
    return {
      provider: "github",
      site: GITHUB_SITE,
      stableId: String(number),
      repo: legacy[1]!,
    };
  }

  const record = RECORD_KEY.exec(key);
  if (record === null) return null;
  const provider = record[1]!;
  // Only providers with a decided key shape parse: an unknown provider's dir
  // is not guessed into an identity.
  if (provider !== "jira" && provider !== "github") return null;
  try {
    const site = decodeURIComponent(record[2]!);
    const stableId = decodeURIComponent(record[3]!);
    // github.com has ONE key, the legacy one: an encoded spelling of it would
    // name the same Work twice instead of being a Work of its own.
    if (provider === "github" && site === GITHUB_SITE) return null;
    if (provider === "github" && (!Number.isInteger(Number(stableId)) || Number(stableId) < 1)) return null;
    return {
      provider,
      site,
      stableId,
      repo: decodeURIComponent(record[4]!),
    };
  } catch {
    return null;
  }
}

/** The Work a registry key anchors, with the readable key the key cannot
 *  carry. The GitHub key keeps its historical spelling; another provider's
 *  stable id stands in until a reservation supplies the presentation data. */
export function workOfKey(key: string): WorkIdentity | null {
  const anchor = anchorOfKey(key);
  if (anchor === null) return null;
  return workOfAnchor(anchor, anchor.provider === "github" ? `#${anchor.stableId}` : anchor.stableId);
}

/** URI-encoding: injective, and no component ever yields "@", "/" or "#". */
function encodeComponent(value: string): string {
  const encoded = encodeURIComponent(value);
  if (encoded === "") throw new Error("a work identity component cannot be empty");
  return encoded;
}
