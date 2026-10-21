import { existsSync, mkdirSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { WORKSPACE_SUBPATHS, type WorkspaceLayout } from "../layout.js";
import {
  isRepositoryIdentity,
  isTicketIdentity,
  workIdentity,
  workIdentityKey,
  type RepositoryIdentity,
  type TicketIdentity,
  type WorkIdentity,
} from "../tracker/identity.js";
import { readPersistedRecord, type PersistedFacts } from "./persisted.js";
import { anchorOfKey, anchorOfWork, keyOfAnchor, readableKeyOf, workOfAnchor, workKeyOf } from "./work-key.js";

/**
 * The reservation record (issue 125): the Work's own facts, persisted inside
 * its registry dir as reserva.json — the ticket source (provider + site +
 * stable id) and the destination repository, side by side, plus the readable
 * presentation data. A restart reads the Work from here instead of
 * reconstructing it from whatever configuration happens to be current.
 *
 * The dir key itself is the identity anchor (pool/work-key.ts); this record
 * adds the facts a key cannot carry (the Jira key/URL as it read when
 * reserved) and the ones a future tracker may present differently.
 */

/** Disk name stays PT-BR with the rest of the registry. */
export const RESERVATION_FILENAME = "reserva.json";

/** Legible data for the operator — never identity. */
export interface ReservationPresentation {
  /** Ticket title as read when the reservation landed. */
  title?: string;
  /** Link to the ticket (Jira browse URL or the GitHub issue). */
  url?: string;
}

export interface ReservationRecord {
  version: 1;
  ticket: TicketIdentity;
  destination: RepositoryIdentity;
  presentation: ReservationPresentation;
  /** When the reservation first landed (ISO); re-reserving never changes it. */
  reservedAt: string;
}

/**
 * What the disk says about a work dir's reservation: `absent` is the legacy
 * GitHub dir (no record yet, readable and usable where it is); `unreadable` is
 * a record that cannot be trusted and must never be silently replaced.
 */
export type ReservationFacts = PersistedFacts<ReservationRecord>;

/** One reserved Work as the registry reads it after a restart. */
export interface ReservationEntry {
  /** The dir key under <workspace>/trabalhos/ — the identity anchor. */
  key: string;
  dir: string;
  work: WorkIdentity;
  reservation: ReservationFacts;
}

export class ReservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReservationError";
  }
}

/** The record of a Work about to be reserved; the caller supplies only presentation. */
export function reservationRecordOf(
  work: WorkIdentity,
  presentation: ReservationPresentation = {},
  reservedAt: string = new Date().toISOString(),
): ReservationRecord {
  return { version: 1, ticket: work.ticket, destination: work.destination, presentation, reservedAt };
}

/**
 * Persist the reservation of a Work. Idempotent: an existing record of the
 * SAME Work is kept untouched (its first reservedAt is history), a record of a
 * different Work or an unreadable one is refused — evidence is never
 * overwritten. Returns the dir so the caller launches in the same place.
 */
export async function reserveWork(
  workspace: WorkspaceLayout | string,
  record: ReservationRecord,
): Promise<{ key: string; dir: string; created: boolean }> {
  if (!isReservationRecord(record)) {
    throw new ReservationError("invalid reservation record: not the reserva.json schema");
  }

  const works = typeof workspace === "string" ? join(workspace, WORKSPACE_SUBPATHS.works) : workspace.works;
  const work = workIdentity(record.ticket, record.destination);
  const key = workKeyOf(work);
  const dir = join(works, key);
  mkdirSync(dir, { recursive: true });

  const existing = await readReservation(dir);
  if (existing.state === "persisted") {
    const existingWork = workIdentity(existing.record.ticket, existing.record.destination);
    if (keyOfAnchor(anchorOfWork(existingWork)) !== keyOfAnchor(anchorOfWork(work))) {
      throw new ReservationError(
        `reservation ${dir} already holds a different Work (${workIdentityKey(existingWork)})`,
      );
    }
    return { key, dir, created: false };
  }
  if (existing.state === "unreadable") {
    throw new ReservationError(`reservation ${dir} is unreadable (${existing.reason}); refusing to overwrite it`);
  }

  await writeFile(join(dir, RESERVATION_FILENAME), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return { key, dir, created: true };
}

/** The persisted facts of a work dir; `absent` when the dir predates the record. */
export function readReservation(dir: string): Promise<ReservationFacts> {
  return readPersistedRecord(dir, RESERVATION_FILENAME, "a reservation record", isReservationRecord);
}

/**
 * Every reserved Work of the workspace, read from the real disk: the legacy
 * GitHub dirs (key "<repo>#<n>", no record) and the record-carrying ones,
 * whose identity comes from the persisted facts. A dir whose record does not
 * match its key, or cannot be read, is still listed — with the unknown
 * surfaced — because an unreadable reservation is never an absent one.
 */
export async function scanReservations(workspace: WorkspaceLayout | string): Promise<ReservationEntry[]> {
  const works = typeof workspace === "string" ? join(workspace, WORKSPACE_SUBPATHS.works) : workspace.works;
  if (!existsSync(works)) return [];

  const entries: ReservationEntry[] = [];
  for (const dir of await workDirs(works)) {
    const key = relative(works, dir).split(sep).join("/");
    const anchor = anchorOfKey(key);
    if (anchor === null) continue;
    const reservation = await readReservation(dir);

    if (reservation.state === "persisted") {
      const persistedWork = workIdentity(reservation.record.ticket, reservation.record.destination);
      if (keyOfAnchor(anchorOfWork(persistedWork)) === keyOfAnchor(anchor)) {
        entries.push({ key, dir, work: persistedWork, reservation });
      } else {
        // The record and the dir disagree: keep the Work visible by its key,
        // and never present the mismatched facts as its own.
        entries.push({
          key,
          dir,
          work: workOfAnchor(anchor, readableKeyOf(anchor)),
          reservation: {
            state: "unreadable",
            reason: `${RESERVATION_FILENAME} names ${workIdentityKey(persistedWork)}, not the Work of this dir key`,
          },
        });
      }
      continue;
    }
    entries.push({ key, dir, work: workOfAnchor(anchor, readableKeyOf(anchor)), reservation });
  }

  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

/** Every dir under the registry root whose relative path is a Work key — a
 *  nested dir of a work (sessao/, the worker's files) is never a work. */
async function workDirs(root: string): Promise<string[]> {
  const listed = await readdir(root, { recursive: true, withFileTypes: true });
  const dirs: string[] = [];
  for (const entry of listed) {
    if (!entry.isDirectory()) continue;
    const dir = join(entry.parentPath, entry.name);
    const key = relative(root, dir).split(sep).join("/");
    if (anchorOfKey(key) === null) continue;
    // An ancestor that is already a Work key means this is that work's nested
    // dir, not a Work of its own.
    if (hasWorkAncestor(key)) continue;
    dirs.push(dir);
  }
  return dirs.sort();
}

function hasWorkAncestor(key: string): boolean {
  const parts = key.split("/");
  for (let end = 1; end < parts.length; end += 1) {
    if (anchorOfKey(parts.slice(0, end).join("/")) !== null) return true;
  }
  return false;
}

function isReservationRecord(value: unknown): value is ReservationRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record["version"] !== 1) return false;
  if (!isTicketIdentity(record["ticket"])) return false;
  if (!isRepositoryIdentity(record["destination"])) return false;
  if (typeof record["reservedAt"] !== "string" || record["reservedAt"] === "") return false;
  const presentation = record["presentation"];
  if (presentation === null || typeof presentation !== "object") return false;
  const facts = presentation as Record<string, unknown>;
  return (
    (facts["title"] === undefined || typeof facts["title"] === "string") &&
    (facts["url"] === undefined || typeof facts["url"] === "string")
  );
}
