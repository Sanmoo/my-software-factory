import { renderWorkIdentity } from "../tracker/identity.js";
import type { Launchable } from "../launch/launch.js";
import type { WorkIdentity } from "../tracker/identity.js";
import { workPullRequest } from "../state/derive.js";
import { humanCommentsForPause } from "../tracker/speech.js";
import { continuityPausedCommentBody } from "../state/outcome.js";
import { workKeyOf } from "../pool/work-key.js";
import { readAttemptLedger } from "../work-record/attempts.js";
import {
  clearPause,
  knownAttempt,
  readPause,
  recheckablePause,
  writePause,
  type PauseRecord,
} from "../work-record/continuity.js";
import { ContinuityDiagnostics } from "../continuity-diagnostics.js";
import { pauseOccurrence, reassertedPause, sameOccurrenceAnnounced } from "./core.js";
import type { NonFailureDeps, PauseVerdict } from "./non-failures.js";

/**
 * The Continuity pause: an Attempt that
 * cannot safely continue — its session is missing, unreadable or of the wrong
 * identity, or an external effect stayed ambiguous — is held instead of being
 * relaunched into a fresh session that would not be a continuation.
 *
 * The pause survives a restart, marks the ticket blocked and asks the operator
 * ONCE. Every sweep re-reads the doubt it names (the attempt's own session, its
 * journal and the real state); when reliable evidence settles it, the record is
 * closed and the CORRECT continuation is handed back — a human answer orients a
 * NEW round, no answer continues the SAME attempt — without another human
 * answer. A pause whose cause never changes is said once; a changed cause is a
 * new fact and keeps the occurrence's identity, so the answers already on the
 * issue stay bound to their request.
 *
 * Nothing here is inferred from an mtime, and a record this factory cannot read
 * is never read as the absence of a pause: its doubt IS the record, so it waits
 * (and asks) instead of falling back to a recovery. A pause spends neither an
 * Attempt nor a recovery.
 */

/** The part of the module that owns the Continuity pause. */
export interface ContinuityPause {
  /**
   * Re-read a persisted pause and decide: reliable evidence resolved it (a
   * continuation is returned) or the Work still waits for the operator (the
   * ticket keeps its block and the question is asked once). `planned` is the
   * attempt the reading knew about; the record's own attempt wins when it names
   * one, and the caller's fills a record that could not name any.
   */
  recheckPause(
    work: WorkIdentity,
    dir: string,
    pause: PauseRecord,
    planned: number,
  ): Promise<PauseVerdict>;
  /**
   * Persist a pause and ask the operator once: the launch path and the sweep
   * both come here when a continuation could not be opened. A pause already
   * announced is never asked again — only a changed reason is a new fact.
   */
  askForContinuity(work: WorkIdentity, dir: string, pending: PauseRecord, attempt: number): Promise<void>;
}

export function openContinuityPause(deps: NonFailureDeps): ContinuityPause {
  // Only diagnostic memory: the evidence is always rechecked. A restart reports
  // each current pause once; steady sweeps stay silent.
  const diagnostics = new ContinuityDiagnostics();
  return {
    recheckPause: (work, dir, pause, planned) => recheckPause(deps, diagnostics, work, dir, pause, planned),
    askForContinuity: (work, dir, pending, attempt) => askForContinuity(deps, diagnostics, work, dir, pending, attempt),
  };
}

async function recheckPause(
  deps: NonFailureDeps,
  diagnostics: ContinuityDiagnostics,
  work: WorkIdentity,
  dir: string,
  paused: PauseRecord,
  planned: number,
): Promise<PauseVerdict> {
  const attempt = knownAttempt(paused.attempt) ?? planned;
  // A worker of this work may still be alive — one this process launched, or one
  // a reliable probe carried. Its journal is never written and no substitute is
  // launched over it.
  if (deps.cycle.workerMayBeAlive(work)) {
    deps.log(
      `continuity of ${renderWorkIdentity(work)} is not re-evaluated: a worker of this work ` +
        "may still be alive — nothing is written and nothing is relaunched",
    );
    return { kind: "waiting" };
  }
  // The one cause never re-read is a record it cannot read: that doubt IS the
  // record.
  const verdict = recheckablePause(paused.reason)
    ? await deps.recheckEvidence(work, dir, attempt, paused)
    : null;
  if (verdict !== null && verdict.resolved) {
    return { kind: "continue", launch: await resolved(deps, diagnostics, work, dir, paused, attempt) };
  }
  const current = verdict?.pause ?? paused;
  // A real change of cause is a new fact the operator must see, told once by the
  // same occurrence; a pause whose request never landed is announced now. A
  // steady cause is said once — `msf status` keeps it visible — so a persistent
  // doubt never becomes a line per cycle.
  if (paused.announced !== true || current.reason !== paused.reason) {
    await askForContinuity(deps, diagnostics, work, dir, current, attempt);
  } else if (verdict !== null) {
    // The cause did not change, but the evidence behind it may have: the fresher
    // diagnosis is kept on the SAME occurrence (its id, its moment and its
    // announcement) and said in the diagnostic line. No comment and no notice —
    // the operator was asked once, and the request has not changed.
    if (current.detail !== paused.detail) writePause(dir, { ...paused, detail: current.detail });
    reportContinuityPause(deps, diagnostics, work, dir, { ...paused, detail: current.detail });
  } else {
    reportContinuityPause(deps, diagnostics, work, dir, paused);
  }
  return { kind: "waiting" };
}

/**
 * A pause whose doubt the attempt's session and the real state now settle (issue
 * 173): the record is closed and the CORRECT continuation is handed back — never
 * launched from here, so every existing gate applies again. A human answer bound
 * to the pause orients a NEW round; without one the SAME attempt continues.
 * Resolving a pause spends neither an attempt nor a recovery.
 */
async function resolved(
  deps: NonFailureDeps,
  diagnostics: ContinuityDiagnostics,
  work: WorkIdentity,
  dir: string,
  pause: PauseRecord,
  attempt: number,
): Promise<Launchable> {
  const { tickets, pullRequests } = deps;
  diagnostics.resolved(workKeyOf(work));
  const comments = await tickets.readTicketComments(work.ticket);
  const answers = comments.known ? humanCommentsForPause(comments.value, pause) : [];
  const feedback = await pullRequests.readPullRequestFeedback(workPullRequest(work));
  const pr = feedback.known ? feedback.value.pr : null;
  if (answers.length > 0) {
    // The clear lands first because the answer self-heals a death on either side
    // of it: with the record still there the answer is read again, and with it
    // cleared the resume launch swaps the block off.
    clearPause(dir);
    deps.log(
      `continuity of ${renderWorkIdentity(work)} is resolved by its own evidence — ` +
        "the human answer orients a NEW round (no recovery is spent)",
    );
    // The resume launch swaps blocked→claimed itself.
    return { work, dir, kind: "resume", createdAt: pause.at, pr, issueReplies: answers };
  }
  // The block leaves with the pause: the recover launch continues the SAME
  // attempt and the existing recovery ruler decides whether it may relaunch.
  // The unblock lands BEFORE the record is cleared, and both are idempotent — a
  // death in between leaves the pause for the next recheck to resolve again,
  // while a death after the clear leaves an unblocked interrupted attempt, which
  // derives to a recovery on its own.
  await deps.cycle.unblock(work);
  clearPause(dir);
  deps.log(
    `continuity of ${renderWorkIdentity(work)} is resolved by its own evidence — ` +
      `attempt ${attempt} continues (the recovery ruler applies)`,
  );
  return { work, dir, kind: "recover", createdAt: null, pr, attempt };
}

/**
 * A continuity pause: the interrupted attempt cannot be reopened
 * safely, so the work stops and asks for help instead of pretending a fresh
 * session is a continuation. The record is written FIRST and survives a restart;
 * the issue comment, the blocked label and the notice happen only once per
 * occurrence — a recheck that learned nothing new, a later sweep and a restart
 * never re-ask, and neither does the first sweep after an upgrade for
 * a pause announced before occurrences had identities. Only a changed REASON is a
 * new fact worth a diagnostic, and it keeps the occurrence's identity, so the
 * answers already on the issue stay bound to it.
 */
async function askForContinuity(
  deps: NonFailureDeps,
  diagnostics: ContinuityDiagnostics,
  work: WorkIdentity,
  dir: string,
  pending: PauseRecord,
  attempt: number,
): Promise<void> {
  const previous = readPause(dir);
  // By now the factory knows which work and attempt it is pausing, whatever the
  // record could say: an unreadable record's unknown work/attempt is replaced
  // here, so the persisted pause and the operator's comment name the real
  // attempt instead of a fabricated zero. The occurrence keeps its id and its
  // start time for as long as the record lives; only a resolved pause (its
  // record cleared) makes the next one a different occurrence.
  const pause = pauseOccurrence(pending, work, attempt, previous);
  if (sameOccurrenceAnnounced(previous, pause)) {
    // The same pause was already announced: re-assert the blocked label without
    // repeating the request (a failed retomada swapped it), so the work stays
    // out of every launch and the human sees one request. Only the detail may
    // carry fresher evidence. The record is not marked unannounced on the way:
    // the request DID land.
    await deps.cycle.reassertBlock(work);
    writePause(dir, reassertedPause(pause, previous!));
    reportContinuityPause(deps, diagnostics, work, dir, pause);
    return;
  }
  // The record lands FIRST (a restart must know the work waits), marked
  // unannounced until the block and the request really landed: a death in
  // between leaves the fact that the operator was never told.
  writePause(dir, { ...pause, announced: false });
  reportContinuityPause(deps, diagnostics, work, dir, pause);
  await deps.cycle.blockAndAsk(
    work,
    await continuityPausedCommentBody({
      attempt: pause.attempt,
      evidencedAttempt: (await readAttemptLedger(dir)).lastAttempt,
      reason: pause.reason,
      id: pause.id,
      detail: pause.detail,
      workDir: dir,
      workspace: deps.workspace,
      ...(pause.sessionId === undefined ? {} : { sessionId: pause.sessionId }),
    }),
  );
  writePause(dir, { ...pause, announced: true });
}

function reportContinuityPause(
  deps: NonFailureDeps,
  diagnostics: ContinuityDiagnostics,
  work: WorkIdentity,
  dir: string,
  pause: PauseRecord,
): void {
  const message = diagnostics.paused(workKeyOf(work), dir, pause);
  if (message !== null) deps.log(message);
}
