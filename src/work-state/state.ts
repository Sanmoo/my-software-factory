import type { Labels, ModelProviderBudget, RecoveryBudget } from "../config.js";
import type { WorkspaceLayout } from "../layout.js";
import type { PullRequestRecord, PullRequestTracker, TicketTracker } from "../tracker/expanded-port.js";
import type { WorkIdentity } from "../tracker/identity.js";
import type { IssueComment } from "../tracker/port.js";
import type { ModelProviderDecision } from "../pool/model-provider.js";
import type { RepairTrigger } from "../pool/repair-trigger.js";
import type { RecoveryDecision } from "../pool/recovery.js";
import type { PauseRecord } from "../work-record/continuity.js";
import type { ModelProviderFailure } from "../work-record/record.js";
import type { RepairAttempt } from "../work-record/repair.js";
import { deriveAfterAttempt, deriveBeforeLaunch } from "./core.js";
import { workFacts } from "./facts.js";

/**
 * The Work state (ADR-0010; GLOSSARY: *Work state*): the one answer to "what
 * happened to this Work, and what may the factory do now?", in one vocabulary,
 * read at two moments — before a launch and after an Attempt ends.
 *
 * This module owns both readings. The caller hands the Work — its identity and
 * the reservation's dir — and, after an Attempt, the attempt's number and
 * whether this factory is stopping; it receives the state with the payload its
 * action needs. The ticket read, the PR read and the Work record read stay
 * behind the seam, so the list of facts a verdict needs can change without
 * touching a caller, and "unreadable" and "absent" are told apart in one place
 * (facts.ts) instead of by every stage that consults the tracker.
 *
 * The loop executes this vocabulary: it asks for the state at
 * both moments and does what the state asks — archive, close with the fallback
 * comment, block with a comment, comment, release, launch, recover — with no
 * map between two vocabularies left in the engine. The remaining reading of the
 * domain (`state/status.ts`) is the last one to migrate.
 */

/** The repair trigger has ONE owner (`pool/repair-trigger.ts`): the state carries
 *  it as the payload a repair action needs, and the derivation, the launch's
 *  durable signature and the round's premise all ask that one definition — so the
 *  copy that decides and the copy that hashes cannot drift. Re-exported here
 *  because it is part of this interface: the states below carry it. */
export type { RepairTrigger };

/** The Work as the state addresses it: the identity on disk plus its dir. */
export interface WorkRef {
  work: WorkIdentity;
  /** The reservation's registry dir — never reconstructed from current config. */
  dir: string;
}

/**
 * The Attempt that just ended: the Work it belongs to and its number, plus the
 * ONE process-wide condition that is not a fact about the Work — this factory
 * is winding down on a requested stop, so it cannot relaunch anything itself.
 * Everything else the second reading needs is a fact about the Work, and is
 * read behind the seam.
 */
export interface EndedAttempt extends WorkRef {
  /** The attempt being collected, as the launch numbered it. It owns the
   *  outcome record: a record of another attempt is absent here. */
  attempt: number;
  /** The requested stop is in progress in THIS process: the attempt's relaunch
   *  is the next run's business, and the stop spends no recovery anywhere. */
  stopping: boolean;
}

/**
 * The PR the reading saw, handed over only when the moment has an action to
 * spend it on: the collection persists the association beside the Work, carries
 * the PR to the next launch and names it in the notice. The read before a
 * launch leaves it out — it has no write to make with it — and the states whose
 * PR IS their payload (`done-fallback`, `rejected`, `feedback`, the repairs)
 * carry it under their own name instead.
 */
type PrSeen = { pr?: PullRequestRecord | null };

/**
 * The Work state itself: the state string with the payload its action needs.
 * `fall` is two members under one state — the written failure releases or
 * blocks — so the action discriminates on `decision`.
 */
export type WorkStateReading = WorkRef &
  (
    /** The terminal state: the ticket is closed (done). */
    | ({ state: "done" } & PrSeen)
    /** PR merged but issue open: close the issue with a short comment first —
     *  done must always be reflected on the tracker. */
    | { state: "done-fallback"; pr: PullRequestRecord; comment: string }
    /** PR closed without merge: block with a comment pointing at the PR. The
     *  same state from both readings — before a launch and after an Attempt
     *   — so the work never returns to the
     *  pool carrying a closed PR. */
    | { state: "rejected"; pr: PullRequestRecord; comment: string }
    /** New human comment on the PR: a feedback round on the same branch and PR. */
    | { state: "feedback"; pr: PullRequestRecord; createdAt: string }
    /** A confirmed impediment of the open PR reactivates the worker in one
     *  round. `resuming` is the unpublished attempt the round takes
     *  over, never redone from scratch. */
    | {
        state: "repair";
        pr: PullRequestRecord;
        createdAt: string;
        trigger: RepairTrigger;
        resuming: RepairAttempt | null;
      }
    /** The PR is confirmed clean (no conflicts, every required check approved):
     *  the repair budget resets. */
    | { state: "repair-recovered"; pr: PullRequestRecord }
    /** A confirmed trigger after the automatic rounds: block and ask help. */
    | {
        state: "repair-blocked";
        pr: PullRequestRecord;
        trigger: RepairTrigger;
        usedRounds: number;
        comment: string;
      }
    /** Repair stopped without publishing: the block holds even with
     *  the PR open — the fall is never hidden by the PR's state. */
    | { state: "repair-fall-blocked"; pr: PullRequestRecord; comment: string; attempt: number }
    /** Human answer on the issue after the marker: the retomada continues from
     *  the existing branch. Only replies after the last agent marker are context. */
    | {
        state: "resumable";
        pr: PullRequestRecord | null;
        createdAt: string;
        issueReplies: IssueComment[];
      }
    /** Nothing to decide: waiting for the human, or a released work the pool owns.
     *  `because` names the fact that parked it when the Work's own record has a
     *  word for it — "the human has the PR" is not "the worker blocked
     *  itself", and both wait the same way. */
    | ({
        state: "parked";
        because?: "pr-open" | "blocked-self-report";
        /** Help was asked for — the ticket carries the blocked label, or this
         *  attempt wrote the self-report. The reading that parks a work keeps
         *  the fact even when the PR wins the precedence, because the collection
         *  notifies it: help outranks the review of an open PR. */
        helpRequested?: boolean;
      } & PrSeen)
    /** A written failure the factory did not rule yet (it died between the
     *  record and the transition): release, or block on the 2nd consecutive
     *  failure — the ruler applies as at collection. */
    | ({ state: "fall"; decision: "release"; attempt: number } & PrSeen)
    | ({ state: "fall"; decision: "block"; comment: string; attempt: number } & PrSeen)
    /** An INTERRUPTION: the attempt ended without an outcome record.
     *  It is not a failure: the same attempt is recovered within its budget, or
     *  the exhausted budget pauses the work and asks the operator for help. */
    | ({ state: "interrupted"; attempt: number; recovery: RecoveryDecision } & PrSeen)
    /** The operator's REQUESTED stop: the same attempt resumes on
     *  the next run, spending no recovery. `because` names which of the two
     *  readings of the stop spoke: the one this process is carrying out (its
     *  last cycle cannot relaunch anything) or the evidence a previous one left
     *  on the attempt. */
    | ({
        state: "stop-resume";
        attempt: number;
        because?: "stop-in-progress" | "stop-recorded";
      } & PrSeen)
    /** The requested stop could not be confirmed: a previous worker may still be
     *  alive, so the work is held with the reason until a probe proves it gone. */
    | { state: "stop-unconfirmed"; attempt: number; because: string }
    /** A MODEL PROVIDER FAILURE: the attempt's stream ended in a
     *  model provider error, so it retries on its own budget — or awaits the
     *  operator when that budget is exhausted (never a block). */
    | ({
        state: "model-provider-failure";
        attempt: number;
        failure: ModelProviderFailure;
        modelProvider: ModelProviderDecision;
      } & PrSeen)
    /** The interrupted attempt cannot be continued safely: the
     *  pause is persisted, so no cycle re-attempts the recovery. */
    | { state: "continuity-paused"; attempt: number; pause: PauseRecord }
    /** The ticket could not be read: never acted on, and never called "not
     *  found" — a failed read is not a verdict (ADR-0010). */
    | { state: "unreadable"; because: string }
    /** Never acted on: the issue was read fine and is closed as not-planned
     *  (not done). Its own state, so "unreadable" never means this. */
    | { state: "not-planned" }
  );

/**
 * What the read AFTER an Attempt can answer — and nothing more. An attempt that
 * ended cannot be `feedback`, `resumable`, a repair round, a continuity pause,
 * an unconfirmed stop, `unreadable` or `not-planned`: those are facts of the
 * read BEFORE a launch, and the collection never asks for them. Declaring the
 * subset here is what keeps a consumer from inventing a verdict for them (the
 * collection report used to project them all as interruptions, which the
 * Glossary's *Interruption* never meant).
 */
export type AfterAttemptReading = Extract<
  WorkStateReading,
  {
    state:
      | "done"
      | "done-fallback"
      | "rejected"
      | "parked"
      | "fall"
      | "interrupted"
      | "model-provider-failure"
      | "stop-resume";
  }
>;

/** The class a Work state contributes to the observed operational state. */
export type OperationalClass = "eligible" | "reserved" | "feedback" | "resumable";

/** The three properties every state declares, next to the union. */
export interface StateDeclaration {
  /** Consent never reopens this state: the work already reached a terminal
   *  verdict, or a worker may still carry it. */
  terminalForConsent: boolean;
  /** The operational class the state contributes to the observed state;
   *  `null` means the work leaves it (a done work is archived by the same
   *  tick). An action may announce another class — a released fall lands
   *  eligible — and says so where it acts. */
  announces: OperationalClass | null;
  /** The state presumes a worker stopped: while liveness cannot be read,
   *  nothing that would archive, spend or block is done. */
  holdsWhileLivenessUnknown: boolean;
}

/**
 * The declarations the loop kept in three hand-maintained tables (and only
 * checked for one of them). `satisfies` makes a new state fail to compile
 * until all three properties are declared.
 */
export const STATE_DECLARATIONS = {
  done: { terminalForConsent: true, announces: null, holdsWhileLivenessUnknown: true },
  "done-fallback": { terminalForConsent: true, announces: null, holdsWhileLivenessUnknown: true },
  rejected: { terminalForConsent: true, announces: "reserved", holdsWhileLivenessUnknown: true },
  feedback: { terminalForConsent: false, announces: "feedback", holdsWhileLivenessUnknown: false },
  repair: { terminalForConsent: false, announces: "reserved", holdsWhileLivenessUnknown: false },
  "repair-recovered": { terminalForConsent: false, announces: "reserved", holdsWhileLivenessUnknown: false },
  "repair-blocked": { terminalForConsent: false, announces: "reserved", holdsWhileLivenessUnknown: true },
  "repair-fall-blocked": { terminalForConsent: false, announces: "reserved", holdsWhileLivenessUnknown: true },
  resumable: { terminalForConsent: false, announces: "resumable", holdsWhileLivenessUnknown: false },
  parked: { terminalForConsent: false, announces: "reserved", holdsWhileLivenessUnknown: false },
  fall: { terminalForConsent: false, announces: "reserved", holdsWhileLivenessUnknown: true },
  interrupted: { terminalForConsent: false, announces: "reserved", holdsWhileLivenessUnknown: true },
  "stop-resume": { terminalForConsent: false, announces: "reserved", holdsWhileLivenessUnknown: false },
  "stop-unconfirmed": { terminalForConsent: true, announces: "reserved", holdsWhileLivenessUnknown: false },
  "model-provider-failure": { terminalForConsent: false, announces: "reserved", holdsWhileLivenessUnknown: true },
  "continuity-paused": { terminalForConsent: false, announces: "reserved", holdsWhileLivenessUnknown: true },
  unreadable: { terminalForConsent: false, announces: "reserved", holdsWhileLivenessUnknown: false },
  "not-planned": { terminalForConsent: false, announces: "reserved", holdsWhileLivenessUnknown: false },
} satisfies Record<WorkStateReading["state"], StateDeclaration>;

/** Whether a human authorization written over this state still applies. */
export function consentAppliesTo(state: WorkStateReading["state"]): boolean {
  return !STATE_DECLARATIONS[state].terminalForConsent;
}

/** What the module is given once, not per call: the ports and the policy. */
export interface WorkStateDeps {
  tickets: TicketTracker;
  pullRequests: PullRequestTracker;
  /** The workspace the Work's dir lives in (the fall comment names paths). */
  workspace: WorkspaceLayout;
  labels: Labels;
  /** The worker's tracker account. The PR channels never read it: a comment is
   *  the factory's by its marker, not by its login ("speech, not login"). */
  workerAccount: string;
  recovery: RecoveryBudget;
  modelProvider: ModelProviderBudget;
  /** The works this process holds a launch for, by registry key. */
  inFlight: ReadonlySet<string>;
}

/** The Work state module as a caller receives it. */
export interface WorkState {
  /** The read before a launch: in what state is this Work, and what may the
   *  factory do now. */
  beforeLaunch(work: WorkRef): Promise<WorkStateReading>;
  /** The read after an Attempt ended: what happened to it, and what may the
   *  factory do now. Same interface, same vocabulary — the caller hands the
   *  Work and the attempt, never the facts the verdict is built from. The
   *  answer is honest about which states this moment can reach. */
  afterAttempt(end: EndedAttempt): Promise<AfterAttemptReading>;
}

export function openWorkState(deps: WorkStateDeps): WorkState {
  return {
    async beforeLaunch(work: WorkRef): Promise<WorkStateReading> {
      return deriveBeforeLaunch(work, workFacts(deps, work), deps);
    },
    async afterAttempt(end: EndedAttempt): Promise<AfterAttemptReading> {
      const ref: WorkRef = { work: end.work, dir: end.dir };
      return deriveAfterAttempt(ref, end, workFacts(deps, ref), deps);
    },
  };
}
