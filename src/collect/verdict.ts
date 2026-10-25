import type { Launchable } from "../launch/launch.js";
import { helpNotice, reviewNotice } from "../notify/port.js";
import { consumeStopRequest, confirmStopRequest } from "../pool/recovery.js";
import { operatorStopClaim } from "../pool/stop.js";
import { workKeyOf } from "../pool/work-key.js";
import type { PullRequestRecord } from "../tracker/expanded-port.js";
import type { WorkIdentity } from "../tracker/identity.js";
import { clearPause } from "../work-record/continuity.js";
import type { ModelProviderFailure } from "../work-record/model-provider-error.js";
import { readOutcomeRecord } from "../work-record/outcome.js";
import { readRecoveryLedger } from "../work-record/recovery.js";
import {
  STATE_DECLARATIONS,
  openWorkState,
  type OperationalClass,
  type WorkStateReading,
} from "../work-state/state.js";
import type { AttemptEnd, CollectCycle, CollectDeps, CollectedEnd } from "./collect.js";
import { projectCollectedRuling } from "./ruling.js";
import type { WorkWrites } from "./writes.js";

/**
 * Applying the verdict of one ended Attempt (ticket 13, extended by 14/123;
 * survivor ends by issue 118; epic #198, ticket #208).
 *
 * The end is read as ONE Work state: the module is asked what happened to the
 * Attempt and what may the factory do now, and exactly that is executed — the
 * tracker and disk verbs it triggers are {@link WorkWrites}. An interruption
 * returns the SAME attempt as the next launch (issue 123). `origin` only names
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
   * The operator's requested stop whose confirmation failed (issue #146) is
   * PROMOTED once the end of its attempt is read: a reading reports the fact, so
   * settling it is a write.
   */
  async function confirmRequestedStop(dir: string, attempt: number): Promise<void> {
    const claim = operatorStopClaim(await readRecoveryLedger(dir), { lastAttempt: attempt });
    if (claim.kind === "unconfirmed") await confirmStopRequest(dir, attempt);
  }

  /**
   * The launch of an attempt that ended without publishing a record: the SAME
   * number continues, with the material of the interrupted launch preserved. A
   * model provider failure retries on its own budget (issue 144); an
   * interruption of the agent keeps issue 123's recovery.
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
   *  reconciliation (issue 112): nothing is relaunched over it. */
  function logRepairEnded(origin: string, key: string): void {
    log(
      `${origin} ${key}: the repair attempt wrote no outcome record — the repair reconciliation ` +
        "settles its publication before another round (issue 112)",
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
    // The attempt's own artifact: settling it is a WRITE (see the writes), so it
    // is read here — never to decide anything.
    const record = await readOutcomeRecord(dir);

    // A settled attempt makes any continuity pause of its own history (issue
    // 119): the new record (or block) is the current fact, and a stale pause
    // must not keep the work out of later rounds. An interruption keeps it.
    if (!wroteNoVerdict(reading)) clearPause(dir);

    // A known PR — open, merged or closed — is persisted beside the Work
    // (issue 125): the facts survive a restart, and a later attempt appends
    // its own. Persistence never changes the reading above.
    if (pr !== null) await writes.persistPrAssociation(work, dir, pr, attempt);

    // A confirmed Outcome prevails over the interpretation of the stop (issue
    // #146): the attempt ended with a verdict, so the suspended-stop evidence
    // has done its job and is cleared (a fall replaces it with its own stop).
    if (!wroteNoVerdict(reading)) await consumeStopRequest(dir, attempt);

    let resulting: OperationalClass | null;
    let next: Launchable | null = null;
    // Whether landing in this state is an occurrence the operator must see: a
    // work held for them (the PR is theirs, or they were asked for help) and a
    // released fall (ticket 13). A block and the done already notify; an
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
        // Delivery, whatever the attempt wrote (issue 149): a merge that did not
        // close the issue is closed here first — done must always be reflected
        // on the tracker (ticket 04 Q11), including a merge that landed mid-round.
        log(
          `${origin} ${key}: PR merged while the attempt ran — done; the factory closes the issue ` +
            "(fallback of the linkage), then archives",
        );
        await writes.closeIssueAndArchive(work, reading.comment);
        resulting = STATE_DECLARATIONS[reading.state].announces;
        break;
      }
      case "parked": {
        // Nothing is consumed, no fall is recorded and the claim is held: the PR
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
        // A written failure/abandon without a PR: the attempt is consumed and the
        // ruler applies — the 1st releases, the 2nd blocks (ticket 05 Q3).
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
        // No attempt is consumed and the fall ruler never applies (issue 123). A
        // repair round is settled by its own reconciliation (issue 112) instead.
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
        // 144): the SAME attempt retries on its own budget, and the retry launch
        // says what it consumed.
        resulting = STATE_DECLARATIONS[reading.state].announces;
        if (launchable.kind === "repair") logRepairEnded(origin, key);
        else next = continuation(launchable, attempt, reading.failure, pr);
        break;
      }
      case "stop-resume": {
        // The operator's requested stop (#146): the attempt is left for the next
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
          // reports the fact and the collection settles it (issue #146).
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
        // A PR closed without merge, SEEN AT COLLECTION (epic #198's one
        // delta): the Block the state already declares — the ticket is blocked
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
      // The states only the read BEFORE a launch answers: an attempt that ended
      // cannot be one of them. Named here so the switch speaks the whole
      // vocabulary — with no `default` that could hide a state a later change
      // adds — and they leave the work in the class their declaration states.
      case "feedback":
      case "resumable":
      case "repair":
      case "repair-recovered":
      case "repair-blocked":
      case "repair-fall-blocked":
      case "continuity-paused":
      case "stop-unconfirmed":
      case "unreadable":
      case "not-planned": {
        resulting = STATE_DECLARATIONS[reading.state].announces;
        break;
      }
    }
    cycle.announce(work, resulting);

    // One notice per new occurrence: an applied block already notified help
    // (blockWithComment), so here only what the ruler did not block. Help
    // wins over review; the state decision is untouched. The self-report is the
    // fact the reading kept (the blocked label, or this attempt's own record) and
    // it counts only for THIS attempt — desfecho.json survives between attempts.
    // A survivor's end is a review occurrence too: its open PR reaches the
    // operator even though this process never launched it (issue 118).
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
function prOf(reading: WorkStateReading): PullRequestRecord | null {
  return "pr" in reading ? reading.pr ?? null : null;
}

/**
 * Whether this end wrote a verdict of its own. An INTERRUPTION has none — the
 * agent's (issue 123), a model provider failure's (issue 144) or the operator's
 * requested stop (#146) — so the pause that keeps a work out of later rounds
 * (issue 119) and the stop evidence that owns the end both survive it.
 */
function wroteNoVerdict(reading: WorkStateReading): boolean {
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
    case "feedback":
    case "repair":
    case "repair-recovered":
    case "repair-blocked":
    case "repair-fall-blocked":
    case "resumable":
    case "continuity-paused":
    case "stop-unconfirmed":
    case "unreadable":
    case "not-planned":
      return false;
  }
}
