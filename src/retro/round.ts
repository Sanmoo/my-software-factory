import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { Config } from "../config.js";
import type { Notifier } from "../notify/port.js";
import { retroItemsNotice } from "../notify/port.js";
import { RETRO_MOUNT_PATHS, type WorkspaceLayout } from "../layout.js";
import type { RetroRequest, RetroResult, RetroWorkInput, WorkerRuntime } from "../runtime/port.js";
import { RETRO_INSTRUCTIONS, RETRO_INSTRUCTIONS_VERSION } from "./instructions.js";
import {
  clearRetroInFlight,
  readRetroState,
  retroReportPath,
  writeRetroInFlight,
  writeRetroState,
  type RetroState,
} from "./marker.js";
import {
  FIRST_WINDOW_SIZE,
  renderWindowSummary,
  reportFileName,
  resultFileName,
  roundId,
  type FinishedWork,
} from "./window.js";

/**
 * The retrospective round (issue 141): the factory job in the Repair mold — no
 * claim, no reservation, no tracker issue, not a Work. The orchestrator plans
 * a window from the finished works and the last report, launches it on the
 * worker runtime with a retro-specific shape (dedicated model, read-only
 * archive mounts, read-write retros mount, the window, the language and the
 * factory-owned instructions), then reads back the two artifacts: the report
 * (the marker) and the result record (what was filed and discarded).
 */

export class RetroError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetroError";
  }
}

/** Why a plan asks for no round: the caller turns it into a notice. */
export type RetroEmptyWindow = "no-finished-works" | "nothing-new";

/** The line the operator reads when there is nothing to launch. */
export function emptyWindowNotice(reason: RetroEmptyWindow): string {
  return reason === "no-finished-works"
    ? "retro: the workspace has no finished work to analyze — nothing was launched and no report was written"
    : "retro: nothing new since the last report — nothing was launched and no report was written";
}

export interface RetroPlan {
  round: string;
  manual: boolean;
  works: FinishedWork[];
  /** The newest finish time seen at planning — the boundary a full report advances. */
  observedThrough: number | null;
  /** A forced single-work round never moves the boundary. */
  singleWork: boolean;
  language: string;
  model: string;
}

/** One improvement item the round filed, as the result record reports it. */
export interface FiledImprovementItem {
  repo: string;
  number: number;
  title: string;
}

export interface DiscardedCandidate {
  title: string;
  reason: string;
}

/** What the factory read back from a round: the report's existence, the items
 *  it filed and the candidates it discarded. Not the Retrospective report. */
export interface RetroRoundFacts {
  round: string;
  window: string[];
  reportPath: string | null;
  filed: FiledImprovementItem[];
  discarded: DiscardedCandidate[];
}

export interface RetroDeps {
  config: Config;
  runtime: WorkerRuntime;
  workspace: WorkspaceLayout;
  log?: (message: string) => void;
  notifier?: Notifier;
  now?: () => number;
}

/**
 * The automatic trigger (issue 141): checked at each sweep, it fires once
 * `threshold` ARCHIVED works exist since the last report.
 */
export async function planAutomaticRound(
  config: Config,
  layout: WorkspaceLayout,
  finished: readonly FinishedWork[],
  now: () => number = Date.now,
): Promise<RetroPlan | { empty: RetroEmptyWindow } | null> {
  const state = await readRetroState(layout);
  const unseen = finished.filter((work) => isUnseen(work, state));
  const archivedSince = unseen.filter((work) => work.archived);
  if (archivedSince.length < config.retro.threshold) return null;

  const window = windowFor(finished, state);
  if (window.length === 0) return { empty: "nothing-new" };

  return {
    ...plannedRound(config, finished, { works: window, singleWork: false, language: config.retro.language, now }),
    manual: false,
  };
}

/**
 * The manual trigger (`msf retro`): a full window since the last report
 * ignores the threshold; `msf retro <work>` analyzes exactly one finished
 * work (a dedicated post-mortem) and never moves the boundary. A per-invocation
 * language overrides the configured one for this round only.
 */
export async function planManualRound(
  config: Config,
  layout: WorkspaceLayout,
  finished: readonly FinishedWork[],
  options: { work?: string; language?: string } = {},
  now: () => number = Date.now,
): Promise<RetroPlan | { empty: RetroEmptyWindow }> {
  const state = await readRetroState(layout);

  if (options.work !== undefined) {
    const key = options.work;
    const work = finished.find((entry) => entry.key === key);
    if (work === undefined) {
      throw new RetroError(
        `${key} is not a finished work of this workspace (finished works only: pr-open, clean-without-pr ` +
          "or blocked-self-report, with an outcome record and no live worker)",
      );
    }
    return {
      ...plannedRound(config, finished, {
        works: [work],
        singleWork: true,
        language: options.language ?? config.retro.language,
        now,
      }),
      manual: true,
    };
  }

  const window = windowFor(finished, state);
  if (window.length === 0) return { empty: finished.length === 0 ? "no-finished-works" : "nothing-new" };
  return {
    ...plannedRound(config, finished, {
      works: window,
      singleWork: false,
      language: options.language ?? config.retro.language,
      now,
    }),
    manual: true,
  };
}

/** The facts every plan shares: the round id, the window, the boundary it may
 *  advance, the one language and the model. */
function plannedRound(
  config: Config,
  finished: readonly FinishedWork[],
  round: { works: readonly FinishedWork[]; singleWork: boolean; language: string; now: () => number },
): Omit<RetroPlan, "manual"> {
  return {
    round: roundId(new Date(round.now())),
    works: [...round.works],
    observedThrough: newestFinish(finished),
    singleWork: round.singleWork,
    language: round.language,
    model: config.retro.model ?? config.workerModel,
  };
}

function isUnseen(work: FinishedWork, state: RetroState): boolean {
  return state.boundaryAt === null || work.completedAt > state.boundaryAt;
}

/**
 * The glossary's Retrospective window, one rule for every trigger: the finished
 * works after the last report's boundary and not yet analyzed, or the last ten
 * finished works when no report has covered a window yet.
 */
function windowFor(finished: readonly FinishedWork[], state: RetroState): FinishedWork[] {
  // A work a post-mortem already analyzed is never analyzed twice, in the
  // first window of ten either: its report covers it, and the boundary the
  // full round advances leaves it behind.
  const pending = (work: FinishedWork): boolean => !state.analyzed.includes(work.key);
  if (state.boundaryAt === null) return finished.filter(pending).slice(-FIRST_WINDOW_SIZE);
  return finished.filter((work) => isUnseen(work, state) && pending(work));
}

function newestFinish(works: readonly FinishedWork[]): number | null {
  return works.reduce<number | null>(
    (newest, work) => (newest === null || work.completedAt > newest ? work.completedAt : newest),
    null,
  );
}

/**
 * Run one planned round: the in-flight marker (status visibility), the launch
 * through the runtime port, and the two artifacts read back. The report's
 * existence is the marker — a round that produced no report advances nothing,
 * so the same window is retried by the next sweep.
 */
export async function runRetroRound(deps: RetroDeps, plan: RetroPlan): Promise<RetroRoundFacts> {
  const { workspace: layout } = deps;
  const log = deps.log ?? (() => {});
  const reportPath = retroReportPath(layout, plan.round);
  const resultPath = join(layout.retros, resultFileName(plan.round));
  const windowKeys = plan.works.map((work) => work.key);

  await writeRetroInFlight(layout, {
    round: plan.round,
    startedAt: deps.now === undefined ? Date.now() : deps.now(),
    window: windowKeys,
    manual: plan.manual,
  });

  try {
    log(
      `retro round ${plan.round}: ${plan.manual ? "forced" : "automatic"} window of ${plan.works.length} ` +
        `finished work(s) in ${plan.language} — launching on model ${plan.model}, outside the worker slots`,
    );
    const destination = deps.config.retro.factoryItemsDestination;
    if (destination === null) {
      throw new RetroError(
        "retro.factory-items-destination is required for a round — the factory-axis items need their destination",
      );
    }
    const request: RetroRequest = {
      round: plan.round,
      model: plan.model,
      language: plan.language,
      account: deps.config.workerGhAccount,
      factoryItemsDestination: destination,
      works: plan.works.map(retroWorkInput),
      reportPath,
      resultPath,
      reportContainerPath: `${RETRO_MOUNT_PATHS.retros}/${basename(reportPath)}`,
      resultContainerPath: `${RETRO_MOUNT_PATHS.retros}/${basename(resultPath)}`,
      summary: await renderWindowSummary(deps.workspace, plan.works),
      instructions: RETRO_INSTRUCTIONS,
      instructionsVersion: RETRO_INSTRUCTIONS_VERSION,
    };

    const result = await deps.runtime.launchRetro(request);
    return await settleRound(deps, plan, request, result);
  } finally {
    clearRetroInFlight(layout);
  }
}

/** Read the artifacts back: the report moves the marker, the result record says what was filed. */
async function settleRound(
  deps: RetroDeps,
  plan: RetroPlan,
  request: RetroRequest,
  result: RetroResult,
): Promise<RetroRoundFacts> {
  const log = deps.log ?? (() => {});
  const { workspace: layout } = deps;
  const record = await readResultRecord(request.resultPath);
  const filed = readFiledItems(record);
  const discarded = readDiscarded(record);
  const window = plan.works.map((work) => work.key);

  if (!existsSync(request.reportPath)) {
    log(
      `retro round ${plan.round}: the runtime reported "${result.outcome}" and no report was written — ` +
        "the marker does not move and the next sweep retries the same window",
    );
    return { round: plan.round, window, reportPath: null, filed: [], discarded: [] };
  }

  const state = await readRetroState(layout);
  await writeRetroState(layout, advanceState(state, plan, filed.length));

  log(
    `retro round ${plan.round}: report written at ${request.reportPath} — ${filed.length} item(s) filed as ` +
      `needs-triage, ${discarded.length} candidate(s) discarded and recorded in the report`,
  );
  if (filed.length > 0) await notifyFiled(deps, filed);
  return { round: plan.round, window, reportPath: request.reportPath, filed, discarded };
}

/** The boundary only advances on a full round whose report exists. */
function advanceState(state: RetroState, plan: RetroPlan, filedCount: number): RetroState {
  const reportName = reportFileName(plan.round);
  if (plan.singleWork) {
    const analyzed = new Set([...state.analyzed, ...plan.works.map((work) => work.key)]);
    return { ...state, lastReport: reportName, analyzed: [...analyzed].sort(), lastFiled: filedCount };
  }
  const boundaryAt =
    plan.observedThrough === null
      ? state.boundaryAt
      : Math.max(state.boundaryAt ?? plan.observedThrough, plan.observedThrough);
  return {
    lastReport: reportName,
    boundaryAt,
    // Everything at or before the boundary is covered by reports; only works
    // after it can ever enter a later window.
    analyzed: [],
    lastFiled: filedCount,
  };
}

/** One notice per destination: the operator learns the triage queue grew. */
async function notifyFiled(deps: RetroDeps, filed: readonly FiledImprovementItem[]): Promise<void> {
  const log = deps.log ?? (() => {});
  const notifier = deps.notifier;
  if (notifier === undefined) return;
  const counts = new Map<string, number>();
  for (const item of filed) counts.set(item.repo, (counts.get(item.repo) ?? 0) + 1);
  for (const [destination, count] of counts) {
    try {
      await notifier.notify(retroItemsNotice(destination, count));
    } catch (error) {
      log(`retro: the notice for ${destination} could not be delivered (${(error as Error).message})`);
    }
  }
}

function retroWorkInput(work: FinishedWork): RetroWorkInput {
  return {
    key: work.key,
    repo: work.repo,
    evidencePath: work.evidencePath,
    archived: work.archived,
    outcome: work.outcome,
    attempt: work.attempt,
    completedAt: new Date(work.completedAt).toISOString(),
  };
}

/** The result record's filed list; anything unreadable is an honest empty list. */
function readFiledItems(record: Record<string, unknown> | null): FiledImprovementItem[] {
  if (record === null || !Array.isArray(record["filed"])) return [];
  const items: FiledImprovementItem[] = [];
  for (const entry of record["filed"] as unknown[]) {
    if (entry === null || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const repo = item["repo"];
    const number = item["number"];
    const title = item["title"];
    if (typeof repo !== "string" || typeof number !== "number" || !Number.isInteger(number)) continue;
    items.push({ repo, number, title: typeof title === "string" ? title : "" });
  }
  return items;
}

function readDiscarded(record: Record<string, unknown> | null): DiscardedCandidate[] {
  if (record === null || !Array.isArray(record["discarded"])) return [];
  const discarded: DiscardedCandidate[] = [];
  for (const entry of record["discarded"] as unknown[]) {
    if (entry === null || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const title = item["title"];
    const reason = item["reason"];
    if (typeof title !== "string" || typeof reason !== "string") continue;
    discarded.push({ title, reason });
  }
  return discarded;
}

async function readResultRecord(resultPath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(resultPath, "utf8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
