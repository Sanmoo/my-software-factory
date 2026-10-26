import { randomUUID } from "node:crypto";

import type { WorkIdentity } from "../tracker/identity.js";
import type { PauseRecord } from "../work-record/continuity.js";

/**
 * The pure core of the Continuity pause: the identity
 * of one occurrence and the asking-once rule over the persisted record, decided
 * without I/O.
 *
 * This is the module's INTERNAL seam — imported by `continuity-pause.ts` and by
 * the module's own tests, by nobody else. The module's interface is
 * `non-failures.ts`; a caller asks that for a verdict, never this for a record.
 */

/** The pause persisted with the Work and attempt the factory knows. An
 *  unreadable record carries neither: every other reason keeps its own, so the
 *  attempt the launch planned is not rewritten into one the disk evidences. */
function persistedPause(pause: PauseRecord, work: WorkIdentity, attempt: number): PauseRecord {
  if (pause.reason !== "record-unreadable") return pause;
  // `readPause` fabricates no attempt for an unreadable record, so the caller's
  // is the only one there is.
  return { ...pause, work, attempt };
}

/**
 * The record one occurrence is persisted as. The identity is generated once,
 * when the pause is first written, and kept through rechecks, re-announcements
 * and a changed reason; a record that already has one keeps it, and a
 * previous record of the same occurrence hands its own over. A record of the
 * SAME occurrence keeps the moment it started; a new one starts now (the pause
 * itself carries the time it was created). A previous record with no identity is
 * that same occurrence still waiting — written before occurrences existed — so
 * the request the operator already answered keeps its own start time instead of
 * being dated by this sweep. A record with no time at all (unreadable) has none
 * to keep.
 */
export function pauseOccurrence(
  pending: PauseRecord,
  work: WorkIdentity,
  attempt: number,
  previous: PauseRecord | null,
): PauseRecord & { id: string } {
  const pause = persistedPause(pending, work, attempt);
  const id = pause.id ?? previous?.id ?? randomUUID();
  const sameOccurrence = previous !== null && (previous.id === undefined || previous.id === id);
  const at = sameOccurrence && previous.at !== "" ? previous.at : pause.at;
  return { ...pause, id, at };
}

/**
 * The record of a pause whose request already landed (the block and the comment
 * are being re-asserted, never repeated). A legacy occurrence — one announced
 * before identities existed — stays WITHOUT one: the identity generated for it
 * now has no comment carrying it, and a record with no identity is the one case
 * where the factory still binds the answers by the generic last-comment rule, so
 * stamping it would orphan the answer already given. The occurrence
 * gains its identity with the first factory comment that can carry one: a
 * diagnostic for a changed cause.
 */
export function reassertedPause(pause: PauseRecord & { id: string }, previous: PauseRecord): PauseRecord {
  if (previous.id !== undefined) return { ...pause, announced: true };
  const { id: _generated, ...occurrence } = pause;
  return { ...occurrence, announced: true };
}

/**
 * Whether the persisted record already announced THIS question: the request
 * landed, the cause is the same (a changed reason is a new fact the operator must
 * see) and it belongs to the same occurrence — a record without an identity was
 * announced before occurrences existed and is that same occurrence still
 * waiting. Anything else is a question never asked.
 */
export function sameOccurrenceAnnounced(previous: PauseRecord | null, pause: PauseRecord): boolean {
  if (previous === null) return false;
  if (previous.announced !== true) return false;
  if (previous.reason !== pause.reason) return false;
  return previous.id === undefined || previous.id === pause.id;
}
