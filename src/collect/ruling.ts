import type { WorkStateReading } from "../work-state/state.js";

/**
 * The decided transition as the collection REPORTS it (ticket 13).
 *
 * A PROJECTION of the Work state the module answered with, and nothing else
 * (D5/epic #198): the module decides in one vocabulary — the state, with the
 * payload its action needs — and this is the operator's, and the suites', word
 * for what it decided. It is computed once, where the decision is made, and
 * read by nobody on the decision path: no verdict, no action and no notice is
 * taken from the ruling.
 */
export interface AppliedRuling {
  decision: "reserve" | "record-only" | "release" | "block" | "interrupt" | "done";
  because: string;
}

/**
 * The report's word for a decided state. Total over the one vocabulary: the
 * states the read AFTER an Attempt never answers still project — they belong to
 * the read before a launch — because the report must name a decision for
 * whatever the module answered rather than carry a hole.
 */
export function projectCollectedRuling(reading: WorkStateReading): AppliedRuling {
  switch (reading.state) {
    case "done":
      return { decision: "done", because: "issue-closed" };
    case "done-fallback":
      return { decision: "done", because: "pr-merged" };
    case "parked": {
      // Two facts park a work at collection: the human owns the PR, or the
      // worker reported itself blocked.
      return reading.because === "blocked-self-report"
        ? { decision: "record-only", because: "blocked-self-report" }
        : { decision: "reserve", because: "pr-open" };
    }
    case "fall":
      return reading.decision === "release"
        ? { decision: "release", because: "fall-first" }
        : { decision: "block", because: "fall-second" };
    case "interrupted":
    case "model-provider-failure":
    case "stop-resume":
    case "stop-unconfirmed":
      // No attempt was consumed and the fall ruler never applies (issue 123):
      // the end is an interruption, whatever ended the turn or who ordered it.
      return { decision: "interrupt", because: "no-outcome" };
    case "rejected":
      // A PR closed without merge is the Block the state declares (epic #198's
      // one delta): the report names the fact itself, never a fall.
      return { decision: "block", because: "pr-closed-unmerged" };
    // The states the read AFTER an attempt never answers — they belong to the
    // read before a launch. Named so the projection is total over the one
    // vocabulary; the collection's own "no verdict was written" is what an end
    // reaches when no other word applies.
    case "feedback":
    case "resumable":
    case "repair":
    case "repair-recovered":
    case "repair-blocked":
    case "repair-fall-blocked":
    case "continuity-paused":
    case "unreadable":
    case "not-planned":
      return { decision: "interrupt", because: "no-outcome" };
  }
}
