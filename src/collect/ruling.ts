import type { AfterAttemptReading } from "../work-state/state.js";

/**
 * The decided transition as the collection REPORTS it (ticket 13).
 *
 * A PROJECTION of the Work state the module answered with, and nothing else
 * (D5/epic #198): the module decides in one vocabulary — the state, with the
 * payload its action needs — and this is the operator's, and the suites', word
 * for what it decided. It is computed once, where the decision is made, and
 * read by nobody on the decision path: no verdict, no action and no notice is
 * taken from the ruling. It is not a second vocabulary to decide in (the
 * deleted `OutcomeRuling` was), so it declares the report's words only.
 */
export interface CollectedRulingReport {
  decision: "reserve" | "record-only" | "release" | "block" | "interrupt" | "done";
  because: string;
}

/**
 * The report's word for a decided state.
 *
 * Total over what the read AFTER an Attempt can answer ({@link
 * AfterAttemptReading}) and NOT over the module's whole vocabulary: the states
 * of the read before a launch — `feedback`, `resumable`, the repairs, a
 * continuity pause, an unconfirmed stop, `unreadable`, `not-planned` — are
 * facts a collection never answers, and projecting them here as an interruption
 * was an invented verdict (`facts.ts`: neither a failed read nor a not-planned
 * issue ever becomes one; GLOSSARY: an *Interruption* is an attempt with no
 * outcome record). The compiler now refuses the question instead.
 */
export function projectCollectedRuling(reading: AfterAttemptReading): CollectedRulingReport {
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
      // No attempt was consumed and the fall ruler never applies (issue 123):
      // the end is an interruption, whatever ended the turn or who ordered it.
      return { decision: "interrupt", because: "no-outcome" };
    case "rejected":
      // A PR closed without merge is the Block the state declares (epic #198's
      // one delta): the report names the fact itself, never a fall.
      return { decision: "block", because: "pr-closed-unmerged" };
  }
}
