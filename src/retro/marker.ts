import { mkdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { WorkspaceLayout } from "../layout.js";
import { reportFileName } from "./window.js";

/**
 * The retrospective marker (issue 141): the report artifacts in the retros
 * directory ARE the marker — a round's state advances only when its report
 * exists — and the small state file here indexes the last report so the next
 * window's boundary needs no prose parsing and no separate scheduler. Rounds
 * therefore never overlap and none is skipped.
 */

export const RETRO_STATE_FILENAME = "estado.json";
export const RETRO_IN_FLIGHT_FILENAME = "rodada-em-andamento.json";

export interface RetroState {
  /** File name of the last report that moved the marker; null before any. */
  lastReport: string | null;
  /** Finish time (epoch ms) of the newest work the last report covered. */
  boundaryAt: number | null;
  /** Works a forced single-work round analyzed without moving the boundary. */
  analyzed: string[];
  /** Items filed by the last round — `status` names the triage queue's growth. */
  lastFiled: number;
}

export const EMPTY_RETRO_STATE: RetroState = {
  lastReport: null,
  boundaryAt: null,
  analyzed: [],
  lastFiled: 0,
};

/** The round in flight, for `msf status` (the lane is outside the slots). */
export interface RetroInFlight {
  round: string;
  startedAt: number;
  window: string[];
  manual: boolean;
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
    const analyzed = Array.isArray(record["analyzed"])
      ? record["analyzed"].filter((entry): entry is string => typeof entry === "string")
      : [];
    const lastFiled = typeof record["lastFiled"] === "number" ? record["lastFiled"] : 0;
    return {
      lastReport,
      boundaryAt,
      analyzed,
      lastFiled: Math.max(0, Math.floor(lastFiled)),
    };
  } catch {
    return { ...EMPTY_RETRO_STATE };
  }
}

export async function writeRetroState(layout: WorkspaceLayout, state: RetroState): Promise<void> {
  mkdirSync(layout.retros, { recursive: true });
  await writeFile(join(layout.retros, RETRO_STATE_FILENAME), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** The round in flight, or null when none is recorded. */
export async function readRetroInFlight(layout: WorkspaceLayout): Promise<RetroInFlight | null> {
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

/** Remove the in-flight record. A run start clears what a dead run left:
 *  the workspace lock proves no other run owns it. */
export function clearRetroInFlight(layout: WorkspaceLayout): void {
  try {
    rm(join(layout.retros, RETRO_IN_FLIGHT_FILENAME), { force: true });
  } catch {
    // The marker is visibility only: an unremovable file never blocks a round.
  }
}
