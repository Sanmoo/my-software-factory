import { mkdirSync, rmSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { WorkspaceLayout } from "../layout.js";
import { reportFileName, RETRO_REPORT_SUFFIX } from "./window.js";

/**
 * The retrospective marker: the report artifacts in the retros
 * directory ARE the marker — a round's state advances only when its report
 * exists — and the small state file here indexes the last report so the next
 * window's boundary needs no prose parsing and no separate scheduler. Rounds
 * therefore never overlap and none is skipped.
 */

export const RETRO_STATE_FILENAME = "estado.json";
export const RETRO_IN_FLIGHT_FILENAME = "rodada-em-andamento.json";

export interface RetroState {
  /** File name of the last report any round wrote; null before any. */
  lastReport: string | null;
  /** Finish time (epoch ms) of the newest work a report has covered. */
  boundaryAt: number | null;
  /** Works a forced single-work round analyzed without moving the boundary. */
  analyzed: string[];
  /** Works the last full window covered: the tie-break at the boundary
   *  instant. */
  covered: string[];
  /** Items filed by the last round — `status` names the triage queue's
   *  growth. */
  lastFiled: number;
}

export const EMPTY_RETRO_STATE: RetroState = {
  lastReport: null,
  boundaryAt: null,
  analyzed: [],
  covered: [],
  lastFiled: 0,
};

/** The round in flight, for `msf status` (the lane is outside the slots). */
export interface RetroInFlight {
  round: string;
  startedAt: number;
  window: string[];
  manual: boolean;
  /** The process that owns the round: the lane's exclusivity is its
   *  liveness. */
  pid: number;
}

/** The absolute path of a round's report — the marker the factory checks. */
export function retroReportPath(layout: WorkspaceLayout, round: string): string {
  return join(layout.retros, reportFileName(round));
}

export async function readRetroState(layout: WorkspaceLayout): Promise<RetroState> {
  try {
    const raw = await readFile(join(layout.retros, RETRO_STATE_FILENAME), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return { ...EMPTY_RETRO_STATE };
    const record = parsed as Record<string, unknown>;
    const lastReport = typeof record["lastReport"] === "string" ? record["lastReport"] : null;
    const boundaryAt = typeof record["boundaryAt"] === "number" ? record["boundaryAt"] : null;
    const analyzed = stringList(record["analyzed"]);
    const covered = stringList(record["covered"]);
    const lastFiled = typeof record["lastFiled"] === "number" ? record["lastFiled"] : 0;
    return {
      lastReport,
      boundaryAt,
      analyzed,
      covered,
      lastFiled: Math.max(0, Math.floor(lastFiled)),
    };
  } catch {
    // A lost index never makes the factory skip work it does not know about:
    // the reports still name the last round, and the unknown boundary degrades
    // to the first round's rule (the last ten finished works) — re-analysis is
    // possible, a silent skip never is.
    return { ...EMPTY_RETRO_STATE, lastReport: await latestReport(layout) };
  }
}

/** The newest report file name, or null when the retros dir has none. */
async function latestReport(layout: WorkspaceLayout): Promise<string | null> {
  try {
    const reports = (await readdir(layout.retros))
      .filter((name) => name.endsWith(RETRO_REPORT_SUFFIX))
      .sort();
    return reports.at(-1) ?? null;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export async function writeRetroState(layout: WorkspaceLayout, state: RetroState): Promise<void> {
  mkdirSync(layout.retros, { recursive: true });
  await writeFile(join(layout.retros, RETRO_STATE_FILENAME), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * The round in flight, as `status` shows it: a record whose owner died is not
 * a round in flight (and status writes nothing, so it is never cleaned here).
 * The record names the process, so a factory of another config sharing this
 * workspace is respected instead of being wiped.
 */
export async function readRetroInFlight(layout: WorkspaceLayout): Promise<RetroInFlight | null> {
  const inFlight = await readInFlightRecord(layout);
  return inFlight !== null && isOwnerAlive(inFlight) ? inFlight : null;
}

/**
 * The lane's exclusivity: a round in flight by a live process, or
 * null after clearing the record a dead process left — the next round can only
 * start once the previous one is over.
 */
export async function liveRoundInFlight(layout: WorkspaceLayout): Promise<RetroInFlight | null> {
  const inFlight = await readInFlightRecord(layout);
  if (inFlight === null || isOwnerAlive(inFlight)) return inFlight;
  clearRetroInFlight(layout);
  return null;
}

function isOwnerAlive(inFlight: RetroInFlight): boolean {
  // pid 0 is the caller's own process group — `kill(0, 0)` always answers, so a
  // record that names no owner is stale by definition.
  if (inFlight.pid <= 0) return false;
  try {
    process.kill(inFlight.pid, 0);
    return true;
  } catch (error) {
    // A process of another user cannot be signalled but is there: only the
    // kernel's own "no such process" proves the owner died.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readInFlightRecord(layout: WorkspaceLayout): Promise<RetroInFlight | null> {
  try {
    const raw = await readFile(join(layout.retros, RETRO_IN_FLIGHT_FILENAME), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const round = record["round"];
    const startedAt = record["startedAt"];
    const window = record["window"];
    const pid = record["pid"];
    if (typeof round !== "string" || typeof startedAt !== "number" || !Array.isArray(window)) return null;
    return {
      round,
      startedAt,
      window: window.filter((entry): entry is string => typeof entry === "string"),
      manual: record["manual"] === true,
      pid: typeof pid === "number" ? pid : 0,
    };
  } catch {
    return null;
  }
}

export async function writeRetroInFlight(layout: WorkspaceLayout, inFlight: RetroInFlight): Promise<void> {
  mkdirSync(layout.retros, { recursive: true });
  await writeFile(
    join(layout.retros, RETRO_IN_FLIGHT_FILENAME),
    `${JSON.stringify(inFlight, null, 2)}\n`,
    "utf8",
  );
}

/** Remove the in-flight record — once its owner is proven gone. */
export function clearRetroInFlight(layout: WorkspaceLayout): void {
  try {
    rmSync(join(layout.retros, RETRO_IN_FLIGHT_FILENAME), { force: true });
  } catch {
    // The marker is visibility only: an unremovable file never blocks a round.
  }
}
