import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
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
import { readPersistedRecord, writePersistedRecord, type PersistedFacts, type PersistedFile } from "./persisted.js";
import {
  anchorOfKey,
  workOfAnchor,
  workKeyOf,
  type WorkAnchor,
} from "./work-key.js";

/**
 * The reservation record (issue 125): the Work's own facts, persisted inside
 * its registry dir as reserva.json — the ticket source (provider + site +
 * stable id) and the destination repository, side by side, plus the readable
 * presentation data. A restart reads the Work from here instead of
 * reconstructing it from whatever configuration happens to be current.
 *
 * The dir key itself is the identity anchor (pool/work-key.ts); this record
 * adds the facts a key cannot carry (the readable ticket key and the link).
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
  /** What the key names — always known, even when the record is not. */
  anchor: WorkAnchor;
  /**
   * The Work as the disk names it: the persisted record, or the legacy GitHub
   * key. Null when only the anchor is known — a non-GitHub dir whose record is
   * missing or unreadable has no authoritative readable key, and none is
   * invented from the stable id or the current configuration.
   */
  work: WorkIdentity | null;
  reservation: ReservationFacts;
}

/** What reserving a Work did on disk; an unknown record is reported, never replaced. */
export interface ReservationResult {
  key: string;
  dir: string;
  /** True only when this call wrote the record. */
  created: boolean;
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
 * SAME Work is kept untouched (its first reservedAt is history). A record that
 * cannot be trusted — unreadable, or naming another Work — is reported and
 * never overwritten: an unknown record must not block the Work it describes,
 * and the evidence must survive for a human. A disk write failure still
 * propagates to the caller.
 */
export function reserveWork(
  workspace: WorkspaceLayout | string,
  record: ReservationRecord,
): ReservationResult {
  if (!isReservationRecord(record)) {
    throw new ReservationError("invalid reservation record: not the reserva.json schema");
  }

  const works = worksRoot(workspace);
  const work = workIdentity(record.ticket, record.destination);
  const key = workKeyOf(work);
  const dir = join(works, key);

  // Synchronous on purpose: the launch path reserves the dir, persists its
  // facts and claims without yielding, so concurrent launches keep their age
  // order (issue 98).
  const existing = readPersistedRecord(dir, RESERVATION_FILE);
  if (existing.state === "persisted") {
    const mismatch = mismatchReason(existing.record, key);
    if (mismatch !== null) {
      return { key, dir, created: false, reservation: { state: "unreadable", reason: mismatch } };
    }
    return { key, dir, created: false, reservation: existing };
  }
  if (existing.state === "unreadable") return { key, dir, created: false, reservation: existing };

  writePersistedRecord(dir, RESERVATION_FILENAME, record);
  return { key, dir, created: true, reservation: { state: "persisted", record } };
}

/** The persisted facts of a work dir; `absent` when the dir predates the record. */
export function readReservation(dir: string): ReservationFacts {
  return readPersistedRecord(dir, RESERVATION_FILE);
}

/**
 * Every reserved Work of the workspace, read from the real disk: the legacy
 * GitHub dirs (key "<repo>#<n>", no record) and the record-carrying ones,
 * whose identity comes from the persisted facts. A dir whose record does not
 * match its key, or cannot be read, is still listed — with the unknown
 * surfaced — because an unreadable reservation is never an absent one.
 */
export async function scanReservations(workspace: WorkspaceLayout | string): Promise<ReservationEntry[]> {
  const works = worksRoot(workspace);
  if (!existsSync(works)) return [];

  const entries: ReservationEntry[] = [];
  for (const dir of await workDirCandidates(works, (name) => anchorOfKey(name) !== null)) {
    const key = relative(works, dir).split(sep).join("/");
    const anchor = anchorOfKey(key);
    if (anchor === null) continue;
    const reservation = readReservation(dir);

    if (reservation.state === "persisted") {
      const mismatch = mismatchReason(reservation.record, key);
      if (mismatch === null) {
        const work = workIdentity(reservation.record.ticket, reservation.record.destination);
        entries.push({ key, dir, anchor, work, reservation });
      } else {
        // The record and the dir disagree: keep the Work visible by its key,
        // and never present the mismatched facts as its own.
        entries.push({
          key,
          dir,
          anchor,
          work: legacyWorkOf(anchor),
          reservation: { state: "unreadable", reason: mismatch },
        });
      }
      continue;
    }
    entries.push({ key, dir, anchor, work: legacyWorkOf(anchor), reservation });
  }

  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Why a persisted record may not be read as the Work of `key` — null when it
 * may. The dir key is the anchor: a record naming another Work is unknown, and
 * an unknown record is never presented as this Work's facts.
 */
function mismatchReason(record: ReservationRecord, key: string): string | null {
  const persistedWork = workIdentity(record.ticket, record.destination);
  if (workKeyOf(persistedWork) === key) return null;
  return `${RESERVATION_FILENAME} names ${workIdentityKey(persistedWork)}, not the Work of ${key}`;
}

function worksRoot(workspace: WorkspaceLayout | string): string {
  return typeof workspace === "string" ? join(workspace, WORKSPACE_SUBPATHS.works) : workspace.works;
}

/**
 * The candidate work dirs of a registry root, at the layout's own depth only:
 * `<root>/<name>` and `<root>/<owner>/<name>`. A top-level dir named like a
 * whole Work (`isWholeWorkDirName`) is never descended into — a proof's
 * disposable workspace or a session artifact inside it can carry a work-like
 * name, and it is never a reservation of THIS workspace. Each caller decides
 * which of the candidates its own key shape actually names.
 */
export async function workDirCandidates(
  root: string,
  isWholeWorkDirName: (name: string) => boolean,
): Promise<string[]> {
  if (!existsSync(root)) return [];
  const dirs: string[] = [];
  for (const top of await readdir(root, { withFileTypes: true })) {
    if (!top.isDirectory()) continue;
    const topDir = join(root, top.name);
    dirs.push(topDir);
    if (isWholeWorkDirName(top.name)) continue;
    for (const nested of await readdir(topDir, { withFileTypes: true })) {
      if (nested.isDirectory()) dirs.push(join(topDir, nested.name));
    }
  }
  return dirs;
}

/** A GitHub dir is the issue of its destination repo itself: the legacy key is
 *  an authoritative identity — the one rule both the scan and any other
 *  anchor-to-Work read share. Any other provider's key carries no readable
 *  ticket key, so no Work is invented without the persisted record. */
export function legacyWorkOf(anchor: WorkAnchor): WorkIdentity | null {
  return anchor.provider === "github" ? workOfAnchor(anchor, `#${anchor.stableId}`) : null;
}

/** A reservation whose Work the disk names: the scan above, narrowed. */
export type IdentifiedReservation = ReservationEntry & { work: WorkIdentity };

const RESERVATION_FILE: PersistedFile<ReservationRecord> = {
  filename: RESERVATION_FILENAME,
  what: "a reservation record",
  isRecord: isReservationRecord,
};

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
