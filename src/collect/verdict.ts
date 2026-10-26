import type { Launchable } from "../launch/launch.js";
import { helpNotice, reviewNotice } from "../notify/port.js";
import { consumeStopRequest, confirmStopRequest } from "../pool/recovery.js";
import { operatorStopClaim } from "../pool/stop.js";
import { workKeyOf } from "../pool/work-key.js";
import type { PullRequestRecord } from "../tracker/expanded-port.js";
import { clearPause } from "../work-record/continuity.js";
import type { ModelProviderFailure } from "../work-record/model-provider-error.js";
import { readOutcomeRecord } from "../work-record/outcome.js";
import { readRecoveryLedger } from "../work-record/recovery.js";
import {
  STATE_DECLARATIONS,
  openWorkState,
  type AfterAttemptReading,
  type OperationalClass,
} from "../work-state/state.js";
import type { AttemptEnd, CollectCycle, CollectDeps, CollectedEnd } from "./collect.js";
import { projectCollectedRuling } from "./ruling.js";
import type { WorkWrites } from "./writes.js";

/**
 * Applying the verdict of one ended Attempt, survivor ends included.
 *
 * The end is read as ONE Work state: the module is asked what happened to the
 * Attempt and what may the factory do now, and exactly that is executed — the
 * tracker and disk verbs it triggers are {@link WorkWrites}. An interruption
 * returns the SAME attempt as the next launch. `origin` only names
 * the actor in the operator's log: a survivor's end is reconciled by these same
 * properties, never by the launch object this process never had.
 *
 * What the collection needs from the cycle comes through {@link CollectCycle}:
 * the operational class the verdict announces, whether this factory is stopping
 * and the works it holds right now.
 */
export interface Verdict {
  /** Collect one ended Attempt: the second reading, the verdict it asks for and
   *  every write that verdict implies. */
  attemptEnd(launchable: Launchable, end: AttemptEnd): Promise<CollectedEnd>;
}

export function openVerdict(deps: CollectDeps, writes: WorkWrites): Verdict {
  const { config, tickets, pullRequests, workspace } = deps;
  const { log } = deps;
  const { cycle } = deps;

  /** The Work state, opened for this moment with the works this process holds
   *  right now — so no reading ever answers for a world that moved. */
  function workState() {
    return openWorkState({
      tickets,
      pullRequests,
      workspace,
      labels: config.labels,
      workerAccount: config.workerGhAccount,
      recovery: config.recovery,
      modelProvider: config.modelProvider,
      inFlight: cycle.inFlight(),
    });
  }

  /**
   * The operator's requested stop whose confirmation failed is
   * PROMOTED once the end of its attempt is read: a reading reports the fact,
   * so
   * settling it is a write.
   */
  async function confirmRequestedStop(dir: string, attempt: number): Promise<void> {
    const claim = operatorStopClaim(await readRecoveryLedger(dir), { lastAttempt: attempt });
    if (claim.kind === "unconfirmed") await confirmStopRequest(dir, attempt);
  }

  /**
   * The launch of an attempt that ended without publishing a record: the SAME
   * number continues, with the material of the interrupted launch preserved. A
   * model provider failure retries on its own budget; an
   * interruption of the agent keeps its recovery.
   */
  function continuation(
    launchable: Launchable,
    attempt: number,
    failure: ModelProviderFailure | null,
    pr: PullRequestRecord | null,
  ): Launchable {
    return {
      work: launchable.work,
      dir: launchable.dir,
      kind: failure === null ? "recover" : "model-provider-retry",
      createdAt: null,
      pr,
      ...(launchable.issueReplies === undefined ? {} : { issueReplies: launchable.issueReplies }),
      attempt,
    };
  }

  /** A repair attempt that ended without publishing is settled by its own
   *  reconciliation: nothing is relaunched over it. */
  function logRepairEnded(origin: string, key: string): void {
    log(
      `${origin} ${key}: the repair attempt wrote no outcome record — the repair reconciliation ` +
        "settles its publication before another round ",
    );
  }

  async function attemptEnd(launchable: Launchable, end: AttemptEnd): Promise<CollectedEnd> {
    const { dir, attempt, origin } = end;
    const { work } = launchable;
    const key = workKeyOf(work);

    const reading = await workState().afterAttempt({
      work,
      dir,
      attempt,
      stopping: cycle.stopping(),
    });
    const pr = prOf(reading);
    const prConfirmed = pr !== null && pr.state === "open";
    // The attempt's own artifact: settling it is a WRITE (see the writes), so
    // it
    // is read here — never to decide anything.
    const record = await readOutcomeRecord(dir);

    // A settled attempt makes any continuity pause of its own history (issue
    // 119): the new record (or block) is the current fact, and a stale pause
    // must not keep the work out of later rounds. An interruption keeps it.
    if (!wroteNoVerdict(reading)) clearPause(dir);

    // A known PR — open, merged or closed — is persisted beside the Work: the
    // facts survive a restart, and a later attempt appends
    // its own. Persistence never changes the reading above.
    if (pr !== null) await writes.persistPrAssociation(work, dir, pr, attempt);

    // A confirmed Outcome prevails over the interpretation of the stop (issue
    // The attempt ended with a verdict, so the suspended-stop evidence
    // has done its job and is cleared (a fall replaces it with its own stop).
    if (!wroteNoVerdict(reading)) await consumeStopRequest(dir, attempt);

    let resulting: OperationalClass | null;
    let next: Launchable | null = null;
    // Whether landing in this state is an occurrence the operator must see: a
    // work held for them (the PR is theirs, or they were asked for help) and a
    // released fall. A block and the done already notify; an
    // interruption is absorbed by its budget.
    let occurrence = false;
    switch (reading.state) {
      case "done": {
        // The terminal state was reached while this claim was held: archive the
        // artifacts and clean the branches, nothing is released or recorded.
        log(`${origin} ${key}: issue closed — done; artifacts archived, branches cleaned`);
        await writes.archiveDone(work);
        resulting = STATE_DECLARATIONS[reading.state].announces;
        break;
      }
      case "done-fallback": {
        // Delivery, whatever the attempt wrote: a merge that did not
        // close the issue is closed here first — done must always be reflected
        // on the tracker, including a merge that landed mid-round.
        log(
          `${origin} ${key}: PR merged while the attempt ran — done; the factory closes the issue ` +
            "(fallback of the linkage), then archives",
        );
        await writes.closeIssueAndArchive(work, reading.comment);
        resulting = STATE_DECLARATIONS[reading.state].announces;
        break;
      }
      case "parked": {
        // Nothing is consumed, no fall is recorded and the claim is held: the
        // PR
        // is the human's, or the worker reported itself blocked.
        resulting = STATE_DECLARATIONS[reading.state].announces;
        occurrence = true;
        if (reading.because === "blocked-self-report") {
          log(`${origin} ${key}: blocked self-report — the factory only records the outcome`);
        } else {
          log(`${origin} ${key}: PR open — stays reserved, waiting for the human`);
        }
        break;
      }
      case "fall": {
        // A written failure/abandon without a PR: the attempt is consumed and
        // the
        // ruler applies — the 1st releases, the 2nd blocks.
        await writes.settleFailure(dir, attempt, record);
        if (reading.decision === "release") {
          log(
            `${origin} ${key}: fall without PR — release (claimed→ready back; ` +
              "the branch stays, the next sweep picks it up)",
          );
          await writes.releaseClaim(work);
          // The released fall lands ELIGIBLE, not the class its state declares:
          // the action says so here, where it acts (ADR-0010).
          resulting = "eligible";
          occurrence = true;
        } else {
          log(
            `${origin} ${key}: 2nd consecutive fall — blocked, the attempt's outcome goes to the issue`,
          );
          await writes.blockWithComment(work, reading.comment);
          resulting = STATE_DECLARATIONS[reading.state].announces;
        }
        break;
      }
      case "interrupted": {
        // No attempt is consumed and the fall ruler never applies. A
        // repair round is settled by its own reconciliation instead.
        resulting = STATE_DECLARATIONS[reading.state].announces;
        if (launchable.kind === "repair") {
          logRepairEnded(origin, key);
        } else {
          log(
            `${origin} ${key}: interrupted (no outcome record) — not a failure; attempt ${attempt} keeps its ` +
              "number and the recovery budget answers it",
          );
          next = continuation(launchable, attempt, null, pr);
        }
        break;
      }
      case "model-provider-failure": {
        // A model provider outage is not an interruption of the agent (issue
        // 144): the SAME attempt retries on its own budget, and the retry
        // launch
        // says what it consumed.
        resulting = STATE_DECLARATIONS[reading.state].announces;
        if (launchable.kind === "repair") logRepairEnded(origin, key);
        else next = continuation(launchable, attempt, reading.failure, pr);
        break;
      }
      case "stop-resume": {
        // The operator's requested stop: the attempt is left for the next
        // invocation to resume, never relaunched inside a requested stop.
        resulting = STATE_DECLARATIONS[reading.state].announces;
        if (launchable.kind === "repair") {
          logRepairEnded(origin, key);
        } else if (reading.because === "stop-in-progress") {
          log(
            `collected ${key}: attempt ${attempt} ended without an outcome record while the factory stops — ` +
              "no recovery is spent and the next run resumes the same attempt",
          );
        } else {
          // Promoting a stop whose confirmation failed is a WRITE: the module
          // reports the fact and the collection settles it.
          await confirmRequestedStop(dir, attempt);
          log(
            `${origin} ${key}: attempt ${attempt} ended without an outcome record, and the operator's requested ` +
              "stop owns that end — it resumes now, spending no recovery",
          );
          next = { work, dir, kind: "recover", createdAt: null, pr, attempt, requestedStop: true };
        }
        break;
      }
      case "rejected": {
        // A PR closed without merge, SEEN AT COLLECTION: the Block the state
        // already declares — the ticket is blocked
        // with the comment pointing at the PR and the claim is HELD, so the
        // work never returns to the pool carrying a closed PR. The attempt is
        // liquidated as ONE outcome: a closed PR is not a written failure, so
        // no fall is recorded and no recovery is spent.
        log(
          `${origin} ${key}: the PR was closed without merging (PR #${reading.pr.number}) — ` +
            "blocked with a comment pointing at the PR; the work stays reserved",
        );
        await writes.blockWithComment(work, reading.comment);
        resulting = STATE_DECLARATIONS[reading.state].announces;
        break;
      }
      // No other state is possible here: the reading this switch receives is
      // `AfterAttemptReading`, so a state only the read BEFORE a launch answers
      // cannot reach it — the compiler proves it instead of a `default`
      // inventing a class for it.
    }
    cycle.announce(work, resulting);

    // One notice per new occurrence: an applied block already notified help
    // (blockWithComment), so here only what the ruler did not block. Help
    // wins over review; the state decision is untouched. The self-report is the
    // fact the reading kept (the blocked label, or this attempt's own record)
    // and
    // it counts only for THIS attempt — desfecho.json survives between
    // attempts.
    // A survivor's end is a review occurrence too: its open PR reaches the
    // operator even though this process never launched it.
    if (occurrence) {
      const isReviewLaunch =
        origin === "survivor" || launchable.kind === "claim" || launchable.kind === "feedback";
      if (reading.state === "parked" && reading.helpRequested === true) {
        await writes.notify(helpNotice(work));
      } else if (isReviewLaunch && prConfirmed && pr !== null) {
        await writes.notify(reviewNotice(work, pr.number));
      }
    }
    return { next, prConfirmed, ruling: projectCollectedRuling(reading) };
  }

  return { attemptEnd };
}

/**
 * The PR the collection read saw, when the reading handed one over. The read
 * before a launch leaves it out (it has no association to persist), and the
 * states whose PR is their own payload carry it under that name.
 */
function prOf(reading: AfterAttemptReading): PullRequestRecord | null {
  return "pr" in reading ? reading.pr ?? null : null;
}

/**
 * Whether this end wrote a verdict of its own. An INTERRUPTION has none — the
 * agent's, a model provider failure's or the operator's requested stop — so the
 * pause that keeps a work out of later rounds and the stop evidence that owns
 * the end both survive it.
 */
function wroteNoVerdict(reading: AfterAttemptReading): boolean {
  switch (reading.state) {
    case "interrupted":
    case "model-provider-failure":
    case "stop-resume":
      return true;
    case "done":
    case "done-fallback":
    case "parked":
    case "fall":
    case "rejected": // a rejection WROTE a verdict: a closed PR is a Block, never an interruption
      return false;
  }
}
