import { describeError } from "../format.js";
import type { PrerequisiteLink, PrerequisiteTracker, TicketPrerequisite } from "../tracker/expanded-port.js";
import { ticketIdentityKey, type TicketIdentity } from "../tracker/identity.js";

/**
 * Whether a Jira candidate may advance past the dependencies its own Selection
 * configures. Only the configured DIRECT links count, and Jira's
 * native Done status category is the sole completion criterion (ADR 0004) — a
 * status merely named Done, a resolution, a merged PR or a factory delivery
 * never satisfies one.
 */
export type PrerequisiteVerdict =
  | {
      state: "met";
      /** Whether the selection configures any prerequisite link at all — a
       *  configured rule that matched nothing is not the same answer. */
      configured: boolean;
      /** The direct prerequisites found, all of them in the Done category. */
      satisfied: TicketIdentity[];
    }
  /** The candidate waits: the reason names the prerequisites (or the read) that
   *  keep it from advancing. */
  | { state: "unmet"; reason: string };

/** A candidate the selection applies no rule to: nothing to wait for. */
export const NO_PREREQUISITES: PrerequisiteVerdict = { state: "met", configured: false, satisfied: [] };

/**
 * The verdict on one candidate. EVERY identified prerequisite must be in the
 * Done category; a prerequisite whose state could not be read is unknown, never
 * satisfied.
 */
export async function readPrerequisiteVerdict(
  tickets: PrerequisiteTracker,
  ticket: TicketIdentity,
  links: readonly PrerequisiteLink[],
): Promise<PrerequisiteVerdict> {
  if (links.length === 0) return NO_PREREQUISITES;

  let prerequisites: TicketPrerequisite[];
  try {
    const read = await tickets.readTicketPrerequisites(ticket, links);
    if (!read.known) {
      return { state: "unmet", reason: "the ticket's prerequisite links could not be read" };
    }
    prerequisites = read.value;
  } catch (error) {
    return { state: "unmet", reason: `the prerequisite links could not be read (${describeError(error)})` };
  }

  const unsatisfied = prerequisites.filter((entry) => entry.completion !== "done");
  if (unsatisfied.length > 0) return { state: "unmet", reason: describeUnsatisfied(unsatisfied) };
  return { state: "met", configured: true, satisfied: prerequisites.map((entry) => entry.ticket) };
}

/**
 * The stricter of two verdicts for one Work: a Work promised by several
 * selections obeys every one of their rules, so an unmet rule is never hidden
 * by a laxer selection that listed it first.
 */
export function stricterVerdict(a: PrerequisiteVerdict, b: PrerequisiteVerdict): PrerequisiteVerdict {
  if (a.state === "unmet") return a;
  if (b.state === "unmet") return b;
  return {
    state: "met",
    configured: a.configured || b.configured,
    satisfied: [
      ...a.satisfied,
      ...b.satisfied.filter(
        (ticket) => !a.satisfied.some((seen) => ticketIdentityKey(seen) === ticketIdentityKey(ticket)),
      ),
    ],
  };
}

/** The prerequisites that keep the candidate waiting, in the operator's words. */
function describeUnsatisfied(unsatisfied: readonly TicketPrerequisite[]): string {
  const named = unsatisfied.map((entry) => {
    if (entry.completion === null) {
      // The site may hide the status entirely, or show a status whose category
      // is not one Jira's completion model knows: name the fact that is missing.
      return entry.status === null
        ? `${entry.ticket.key} (its status could not be read)`
        : `${entry.ticket.key} ("${entry.status}", whose status category is unknown)`;
    }
    const status = entry.status === null ? "another status" : `"${entry.status}"`;
    return `${entry.ticket.key} (${status}, outside the Done status category)`;
  });
  return named.length === 1
    ? `prerequisite ${named[0]}`
    : `prerequisites ${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
}
