import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { Config } from "../config.js";
import type { Notifier } from "../notify/port.js";
import { retroItemsNotice } from "../notify/port.js";
import { RETRO_MOUNT_PATHS, type WorkspaceLayout } from "../layout.js";
import type { RetroRequest, RetroWorkInput, WorkerRuntime } from "../runtime/port.js";
import { RETRO_INSTRUCTIONS, RETRO_INSTRUCTIONS_VERSION } from "./instructions.js";
import {
  clearRetroInFlight,
  liveRoundInFlight,
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
 * The retrospective round: the factory job in the Repair mold — no
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

/** The round's log when the caller wired none: silence, never a crash. */
const NOOP_LOG = (): void => {};

export interface RetroDeps {
  config: Config;
  runtime: WorkerRuntime;
  workspace: WorkspaceLayout;
  log?: (message: string) => void;
  notifier?: Notifier;
  now?: () => number;
}

/**
 * The automatic trigger: checked at each sweep, it fires once
 * `threshold` ARCHIVED works no report has covered yet have accumulated. A
 * work a post-mortem already analyzed is covered, so it never counts again —
 * the lane waits for real material instead of announcing an empty window on
 * every sweep.
 */
export async function planAutomaticRound(
  config: Config,
  layout: WorkspaceLayout,
  finished: readonly FinishedWork[],
  now: () => number = Date.now,
): Promise<RetroPlan | null> {
  const state = await readRetroState(layout);
  const uncovered = uncoveredWorks(finished, state);
  if (uncovered.filter((work) => work.archived).length < config.retro.threshold) return null;

  return {
    ...plannedRound(config, finished, {
      works: windowFor(uncovered, state),
      singleWork: false,
      language: config.retro.language,
      now,
    }),
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

  const window = windowFor(uncoveredWorks(finished, state), state);
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

/** What a trigger decides about the round; the rest is the factory's. */
interface RoundShape {
  works: readonly FinishedWork[];
  singleWork: boolean;
  language: string;
  now: () => number;
}

/** The facts every plan shares: the round id, the window, the boundary it may
 *  advance, the one language and the model. */
function plannedRound(
  config: Config,
  finished: readonly FinishedWork[],
  round: RoundShape,
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
 * The finished works a report does not cover yet: after the last report's
 * boundary, and never one a post-mortem already analyzed — in the first window
 * of ten either, since that post-mortem's report covered it too.
 */
function uncoveredWorks(finished: readonly FinishedWork[], state: RetroState): FinishedWork[] {
  return finished.filter((work) => isUnseen(work, state) && !state.analyzed.includes(work.key));
}

/**
 * The glossary's Retrospective window, one rule for every trigger: the
 * uncovered finished works, or the last ten of them when no report has covered
 * a window yet.
 */
function windowFor(uncovered: readonly FinishedWork[], state: RetroState): FinishedWork[] {
  return state.boundaryAt === null ? uncovered.slice(-FIRST_WINDOW_SIZE) : [...uncovered];
}

function newestFinish(works: readonly FinishedWork[]): number | null {
  return works.reduce<number | null>(
    (newest, work) => (newest === null || work.completedAt > newest ? work.completedAt : newest),
    null,
  );
}

/** A round asked to start while another one still owns the lane. */
export class RetroBusyError extends RetroError {
  constructor(readonly inFlight: string) {
    super(
      `a retrospective round is already in flight (${inFlight}) — the lane runs one round at a time, ` +
        "and the next one starts after the marker the last report writes",
    );
    this.name = "RetroBusyError";
  }
}

/**
 * Run one planned round: the lane's in-flight marker (its exclusivity and its
 * visibility in `status`), the launch through the runtime port, and the two
 * artifacts read back. The report's existence is the marker — a round that
 * produced no report advances nothing, so the same window is retried by the
 * next sweep.
 */
export async function runRetroRound(deps: RetroDeps, plan: RetroPlan): Promise<RetroRoundFacts> {
  const { workspace: layout } = deps;
  const log = deps.log ?? NOOP_LOG;
  const running = await liveRoundInFlight(layout);
  if (running !== null) throw new RetroBusyError(running.round);

  const reportPath = retroReportPath(layout, plan.round);
  const resultPath = join(layout.retros, resultFileName(plan.round));
  const windowKeys = plan.works.map((work) => work.key);

  await writeRetroInFlight(layout, {
    round: plan.round,
    startedAt: deps.now === undefined ? Date.now() : deps.now(),
    window: windowKeys,
    manual: plan.manual,
    pid: process.pid,
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

    await deps.runtime.launchRetro(request);
    return await settleRound(deps, plan, request);
  } finally {
    clearRetroInFlight(layout);
  }
}

/** Read the artifacts back: the report moves the marker, the result record says what was filed. */
async function settleRound(
  deps: RetroDeps,
  plan: RetroPlan,
  request: RetroRequest,
): Promise<RetroRoundFacts> {
  const log = deps.log ?? NOOP_LOG;
  const { workspace: layout } = deps;
  const record = await readResultRecord(request.resultPath);
  const filed = readFiledItems(record);
  const discarded = readDiscarded(record);
  const window = plan.works.map((work) => work.key);

  if (!existsSync(request.reportPath)) {
    log(
      `retro round ${plan.round}: the round ended and no report was written — the marker does not move ` +
        "and the next sweep retries the same window",
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
      : state.boundaryAt === null
        ? plan.observedThrough
        : Math.max(state.boundaryAt, plan.observedThrough);
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
  const log = deps.log ?? NOOP_LOG;
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

/** The entries of one list in the result record; an unreadable record is an
 *  honest empty list, and a malformed entry is dropped, never guessed. */
function recordList(record: Record<string, unknown> | null, key: string): Array<Record<string, unknown>> {
  if (record === null || !Array.isArray(record[key])) return [];
  return (record[key] as unknown[]).filter(
    (entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object",
  );
}

/** The result record's filed list: only entries the factory can act on. */
function readFiledItems(record: Record<string, unknown> | null): FiledImprovementItem[] {
  return recordList(record, "filed").flatMap((item) => {
    const repo = item["repo"];
    const number = item["number"];
    const title = item["title"];
    if (typeof repo !== "string" || typeof number !== "number" || !Number.isInteger(number)) return [];
    return [{ repo, number, title: typeof title === "string" ? title : "" }];
  });
}

/** The candidates the round discarded, each with the reason it recorded. */
function readDiscarded(record: Record<string, unknown> | null): DiscardedCandidate[] {
  return recordList(record, "discarded").flatMap((item) => {
    const title = item["title"];
    const reason = item["reason"];
    if (typeof title !== "string" || typeof reason !== "string") return [];
    return [{ title, reason }];
  });
}

async function readResultRecord(resultPath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(resultPath, "utf8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
