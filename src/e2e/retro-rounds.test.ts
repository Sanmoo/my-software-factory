import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runOnce, type LoopDeps } from "../loop.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime, type RetroScript } from "../runtime/fake-runtime.js";
import { FakeNotifier } from "../notify/fake-notifier.js";
import { type LocalWorkFacts, type PreparedWork, workBranchName } from "../git/port.js";
import type { IssueRef } from "../tracker/port.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import {
  DEFAULT_LABELS,
  DEFAULT_LIVENESS_POLICY,
  DEFAULT_MODEL_PROVIDER_BUDGET,
  DEFAULT_RECOVERY_BUDGET,
  DEFAULT_RETRO,
  type Config,
  type RetroConfig,
} from "../config.js";
import { expandedGitWorkOf, type LegacyGitWork } from "./legacy-git.js";
import { DESFECHO_FILENAME } from "../state/outcome.js";
import {
  planManualRound,
  runRetroRound,
  type RetroPlan,
} from "../retro/round.js";
import {
  readRetroState,
  retroReportPath,
  RETRO_IN_FLIGHT_FILENAME,
  RETRO_STATE_FILENAME,
} from "../retro/marker.js";
import { OPERATIONAL_LOG_FILENAME } from "../log.js";
import { collectFinishedWorks } from "../retro/window.js";
import { deriveStatus } from "../state/status.js";
import { renderStatus } from "../state/status-render.js";

/**
 * End-to-end of issue 141: the retrospective is a factory job in the Repair
 * mold — internally triggered at sweep time by the archived-works threshold,
 * on its own lane (never a worker slot), with a dedicated model, a window of
 * finished works, a dated report that IS the marker of the next window, and
 * improvement items filed as needs-triage issues. Driven only through the two
 * existing fake ports: the fake tracker and the fake worker runtime (whose
 * retro launch records the request and scripts the two artifacts).
 */

const REPO = "Sanmoo/my-tasks";
const OTHER_REPO = "Sanmoo/other";
const FACTORY = "Sanmoo/my-software-factory";
const NOW = "2026-01-01T00:00:00Z";
const WORKER_MODEL = "opencode-go/glm-5.3-flash";
const RETRO_MODEL = "anthropic/claude-opus-4.5";

class FakeGitWork implements LegacyGitWork {
  async prepareWork(ref: IssueRef): Promise<PreparedWork> {
    return {
      repoDir: `/clones/${ref.repo.replaceAll("/", "#")}`,
      branch: workBranchName(ref.number),
      baseBranch: "main",
      branchCreated: true,
      branchOnOrigin: false,
    };
  }

  async cleanupDoneWork(_ref: IssueRef): Promise<void> {}

  async diffWork(_ref: IssueRef): Promise<string> {
    return "";
  }

  async observeRemoteHead(_ref: IssueRef): Promise<string | null> {
    return null;
  }

  async inspectLocalWork(_ref: IssueRef): Promise<LocalWorkFacts> {
    return { headSha: null, commits: 0, uncommitted: false, operationInProgress: null };
  }
}

describe("e2e: the retrospective round — threshold, marker, window and filing (issue 141)", () => {
  let dir: string;
  let layout: WorkspaceLayout;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-retro-"));
    layout = ensureWorkspace(join(dir, "ws"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeConfig(overrides: Partial<RetroConfig> = {}, concurrency = 2): Config {
    return {
      workerGhAccount: "bot-do-samuca",
      workerModel: WORKER_MODEL,
      repos: [REPO, OTHER_REPO],
      concurrency,
      workspace: layout.root,
      labels: { ...DEFAULT_LABELS },
      workerAuthFile: null,
      recovery: { ...DEFAULT_RECOVERY_BUDGET },
      modelProvider: { ...DEFAULT_MODEL_PROVIDER_BUDGET },
      liveness: { ...DEFAULT_LIVENESS_POLICY },
      retro: {
        ...DEFAULT_RETRO,
        enabled: true,
        threshold: 2,
        factoryItemsDestination: FACTORY,
        ...overrides,
      },
      notifications: true,
      configPath: join(dir, "msf.yaml"),
    };
  }

  function makeFactory(
    config: Config,
    retro: RetroScript[] = [{ filed: [] }],
    options: { notifier?: FakeNotifier } = {},
  ) {
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: ["pr-open"], retro });
    const notifier = options.notifier ?? new FakeNotifier();
    const deps: LoopDeps = {
      config,
      tickets: tracker,
      pullRequests: tracker,
      runtime,
      git: expandedGitWorkOf(new FakeGitWork()),
      workspace: layout,
      notifier,
      probe: async () => [],
      log: () => {},
    };
    return { tracker, runtime, notifier, deps };
  }

  function makeLoggedFactory(config: Config, retro: RetroScript[] = [{ filed: [] }]) {
    const logs: string[] = [];
    const built = makeFactory(config, retro);
    return { ...built, logs, deps: { ...built.deps, log: (line: string) => logs.push(line) } };
  }

  /**
   * One archived finished work: the archive layout the factory writes
   * (`arquivo/<repo>#<n>-<date>`), the outcome record and its finish time.
   */
  function seedArchived(
    number: number,
    completedAtMs: number,
    options: { repo?: string; record?: Record<string, unknown>; attempts?: number[] } = {},
  ): string {
    const repo = options.repo ?? REPO;
    const workArchive = join(layout.archive, `${repo}#${number}-2026-02-01`);
    mkdirSync(workArchive, { recursive: true });
    for (const attempt of options.attempts ?? [1]) {
      writeFileSync(join(workArchive, `log-${attempt}.jsonl`), "{}\n", "utf8");
    }
    const record = options.record ?? { class: "pr-open", attempt: 1 };
    const recordPath = join(workArchive, DESFECHO_FILENAME);
    writeFileSync(recordPath, JSON.stringify(record), "utf8");
    utimesSync(recordPath, completedAtMs / 1000, completedAtMs / 1000);
    return workArchive;
  }

  /** A work still under trabalhos/ (a blocked work never gets archived). */
  function seedBlocked(number: number, completedAtMs: number): string {
    const work = workDir(layout, REPO, number);
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "log-1.jsonl"), "{}\n", "utf8");
    const recordPath = join(work, DESFECHO_FILENAME);
    writeFileSync(recordPath, JSON.stringify({ class: "blocked-self-report", attempt: 1 }), "utf8");
    utimesSync(recordPath, completedAtMs / 1000, completedAtMs / 1000);
    return work;
  }

  const at = (day: number): number => Date.UTC(2026, 1, day, 12, 0, 0);

  test("the archived-works threshold gates the automatic round, inside the sweep", async () => {
    const config = makeConfig({ threshold: 2 });
    const { runtime, deps } = makeFactory(config);
    seedArchived(1, at(1));

    await runOnce(deps);
    assert.equal(runtime.retroLaunched.length, 0, "one archived work is below the threshold");

    seedArchived(2, at(2));
    await runOnce(deps);
    assert.equal(runtime.retroLaunched.length, 1, "the second archived work triggers the round");

    const request = runtime.retroLaunched[0]!;
    assert.deepEqual(
      request.works.map((work) => work.key).sort(),
      [`${REPO}#1`, `${REPO}#2`],
      "the first round covers the finished works — its first report is the marker",
    );
    assert.equal(request.model, WORKER_MODEL, "retro.model absent: the round inherits the worker model");
    assert.equal(request.language, "en", "English by default");
    assert.equal(request.factoryItemsDestination, FACTORY);
    assert.match(request.summary, /2 finished work\(s\)/, "the factual summary of the window is carried");
    assert.match(request.summary, /2 attempt\(s\)/, "the summary counts the attempts from the records");
    assert.match(request.reportPath, /retros\/.+-retro\.md$/);
  });

  test("a dedicated retro model never falls back to the worker model by accident", async () => {
    const config = makeConfig({ threshold: 1, model: RETRO_MODEL, language: "pt-BR" });
    const { runtime, deps } = makeFactory(config);
    seedArchived(1, at(1));

    await runOnce(deps);

    const request = runtime.retroLaunched[0]!;
    assert.equal(request.model, RETRO_MODEL, "retro.model is the round's model");
    assert.equal(request.language, "pt-BR", "the configured language governs the automatic round");
    assert.ok(request.instructions.includes("needs-triage"), "the instructions carry the filing rule");
    assert.ok(
      /never add `ready-for-agent`/i.test(request.instructions),
      "the instructions forbid the factory's pool label — the operator's triage is the gate",
    );
    assert.match(request.instructions, /mattpocock\/skills/, "provenance is recorded in the instructions");
    assert.ok(request.instructionsVersion !== "", "the instructions are versioned with the factory code");
    assert.match(request.works[0]!.evidencePath, /^\/msf-arquivo\//);
  });

  test("the first round covers the last 10 finished works, not the whole archive", async () => {
    const config = makeConfig({ threshold: 1 });
    const { runtime, deps } = makeFactory(config);
    for (let day = 1; day <= 12; day += 1) seedArchived(day, at(day));

    await runOnce(deps);

    const keys = runtime.retroLaunched[0]!.works.map((work) => work.key);
    assert.equal(keys.length, 10, "the first retrospective has substance without covering everything");
    assert.deepEqual(
      keys,
      Array.from({ length: 10 }, (_value, index) => `${REPO}#${index + 3}`),
      "exactly the last ten finished works, oldest first",
    );
  });

  test("a forced full round on a fresh workspace also covers the last ten, never the whole archive", async () => {
    const config = makeConfig({ threshold: 5 });
    const { runtime } = makeFactory(config);
    for (let day = 1; day <= 12; day += 1) seedArchived(day, at(day));

    const finished = await collectFinishedWorks(layout);
    const plan = await planManualRound(config, layout, finished);
    assert.ok(!("empty" in plan));
    await runRetroRound(
      { config, runtime, workspace: layout, log: () => {}, notifier: new FakeNotifier() },
      plan as RetroPlan,
    );

    const keys = runtime.retroLaunched[0]!.works.map((work) => work.key);
    assert.deepEqual(
      keys,
      Array.from({ length: 10 }, (_value, index) => `${REPO}#${index + 3}`),
      "the first round's window is the last ten works, whichever trigger started it",
    );
    assert.notEqual((await readRetroState(layout)).boundaryAt, null, "a full round advances the boundary");
  });

  test("the report is the marker: a second round covers only works after the boundary", async () => {
    const config = makeConfig({ threshold: 2 });
    const { runtime, deps } = makeFactory(config);
    seedArchived(1, at(1));
    seedArchived(2, at(2));
    await runOnce(deps);
    const firstWindow = runtime.retroLaunched[0]!.works.map((work) => work.key);
    assert.deepEqual(firstWindow.sort(), [`${REPO}#1`, `${REPO}#2`]);
    const state = await readRetroState(layout);
    assert.equal(state.lastReport !== null, true, "the report moved the marker");
    assert.equal(state.boundaryAt, at(2), "the boundary is the newest finish the report covered");

    seedArchived(3, at(3));
    await runOnce(deps);
    assert.equal(runtime.retroLaunched.length, 1, "one new work is below the threshold again");

    seedArchived(4, at(4));
    await runOnce(deps);
    assert.equal(runtime.retroLaunched.length, 2);
    assert.deepEqual(
      runtime.retroLaunched[1]!.works.map((work) => work.key).sort(),
      [`${REPO}#3`, `${REPO}#4`],
      "the new window starts after the last report — rounds never overlap",
    );
  });

  test("a round that writes no report advances nothing — the same window is retried", async () => {
    const config = makeConfig({ threshold: 1 });
    const first = makeLoggedFactory(config, [{ report: false }]);
    seedArchived(1, at(1));
    await runOnce(first.deps);
    assert.equal(first.runtime.retroLaunched.length, 1);
    assert.equal(existsSync(retroReportPath(layout, first.runtime.retroLaunched[0]!.round)), false);
    assert.equal(existsSync(join(layout.retros, RETRO_STATE_FILENAME)), false, "no report, no marker move");
    assert.ok(
      first.logs.some((line) => line.includes("no report was written")),
      "the operator learns the round produced nothing",
    );

    // The next sweep retries the same window.
    const second = makeLoggedFactory(config, [{ filed: [] }]);
    second.runtime.holdRetro = () => {};
    await runOnce(second.deps);
    assert.deepEqual(
      second.runtime.retroLaunched[0]?.works.map((work) => work.key),
      [`${REPO}#1`],
      "the window was not consumed by the failed round",
    );
  });

  test("works pending reconciliation are deferred; blocked works enter the window", async () => {
    const config = makeConfig({ threshold: 1 });
    const { runtime, deps } = makeFactory(config);
    // Settled archived delivery.
    seedArchived(1, at(1));
    // Archived, but attempt 2 wrote no record of its own: pending reconciliation.
    seedArchived(2, at(2), { attempts: [1, 2] });
    // A blocked work still under trabalhos/: finished, never archived.
    seedBlocked(3, at(3));

    await runOnce(deps);

    assert.deepEqual(
      runtime.retroLaunched[0]!.works.map((work) => work.key),
      [`${REPO}#1`, `${REPO}#3`].sort((a, b) => a.localeCompare(b)),
      "delivered and blocked works are analyzed; the pending one waits",
    );
    const blocked = runtime.retroLaunched[0]!.works.find((work) => work.key === `${REPO}#3`);
    assert.equal(blocked?.archived, false);
    assert.match(blocked?.evidencePath ?? "", /^\/msf-trabalhos\//);
    assert.equal(blocked?.outcome, "blocked-self-report");
  });

  test("the summary anchors factory-axis findings in the operational log, not only in the records", async () => {
    const config = makeConfig({ threshold: 1 });
    const { runtime, deps } = makeFactory(config);
    seedArchived(1, at(1));
    writeFileSync(
      join(layout.root, OPERATIONAL_LOG_FILENAME),
      [
        "[2026-02-01T10:00:00Z] derived Sanmoo/my-tasks#1: issue closed — done; archiving artifacts",
        "[2026-02-01T10:05:00Z] derived Sanmoo/my-tasks#1: repair round skipped: remote head unreadable",
        "[2026-02-01T10:06:00Z] derived pool: 0 eligible work(s), 0 reserved work(s)",
      ].join("\n"),
      "utf8",
    );

    await runOnce(deps);

    const summary = runtime.retroLaunched[0]!.summary;
    assert.match(summary, /Operational log: 2 line\(s\) mention the window's works/);
    assert.match(summary, /repair round skipped/, "the last operational line about the work is quoted");
  });

  test("a single-work round before the first report never steals or duplicates the first window", async () => {
    const config = makeConfig({ threshold: 1 });
    const { runtime, deps } = makeFactory(config);
    for (let day = 1; day <= 12; day += 1) seedArchived(day, at(day));

    const finished = await collectFinishedWorks(layout);
    const single = await planManualRound(config, layout, finished, { work: `${REPO}#12` });
    assert.ok(!("empty" in single));
    await runRetroRound(
      { config, runtime, workspace: layout, log: () => {}, notifier: new FakeNotifier() },
      single as RetroPlan,
    );
    assert.equal((await readRetroState(layout)).boundaryAt, null, "no full window was ever analyzed");

    await runOnce(deps);
    const fullWindow = runtime.retroLaunched.at(-1)!.works.map((work) => work.key);
    assert.equal(
      fullWindow.length,
      10,
      "the first full round still covers ten works — the single-work report did not move the boundary",
    );
    assert.ok(!fullWindow.includes(`${REPO}#12`), "the post-mortemed work is never analyzed a second time");
  });

  test("a lost state index never makes the factory skip work: it degrades to the first-round rule", async () => {
    const config = makeConfig({ threshold: 2 });
    const { runtime, deps } = makeFactory(config);
    seedArchived(1, at(1));
    seedArchived(2, at(2));
    await runOnce(deps);
    rmSync(join(layout.retros, RETRO_STATE_FILENAME), { force: true });
    seedArchived(3, at(3));
    seedArchived(4, at(4));

    await runOnce(deps);

    const state = await readRetroState(layout);
    assert.notEqual(state.lastReport, null, "the reports on disk still mark the last round");
    assert.deepEqual(
      runtime.retroLaunched.at(-1)!.works.map((work) => work.key),
      [`${REPO}#1`, `${REPO}#2`, `${REPO}#3`, `${REPO}#4`],
      "the boundary degrades to the first-round rule (the last ten finished works) — re-analysis, never a skip",
    );
  });

  test("the round runs on its own lane — a full worker slot never delays it", async () => {
    const config = makeConfig({ threshold: 1 }, 1);
    let releaseWorker: () => void = () => {};
    const workerParked = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    let retroStarted: () => void = () => {};
    const retroRan = new Promise<void>((resolve) => {
      retroStarted = resolve;
    });

    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    const runtime = new FakeWorkerRuntime({
      tracker,
      outcomes: ["pr-open"],
      retro: [{ filed: [] }],
      // The worker cannot finish before the round ran: if the round waited for
      // a free slot, this would deadlock — the timeout in the test runner would
      // be the only way out.
      hold: async () => {
        await retroRan;
        releaseWorker();
      },
      holdRetro: () => {
        retroStarted();
      },
    });
    const deps: LoopDeps = {
      config,
      tickets: tracker,
      pullRequests: tracker,
      runtime,
      git: expandedGitWorkOf(new FakeGitWork()),
      workspace: layout,
      notifier: new FakeNotifier(),
      probe: async () => [],
      log: () => {},
    };
    seedArchived(1, at(1));
    seedIssue(tracker, { repo: REPO, number: 10, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    await runOnce(deps);

    assert.equal(runtime.launched.length, 1, "the worker launched in the only slot");
    assert.equal(runtime.retroLaunched.length, 1, "and the round still ran, outside the slots");
    await workerParked;
  });

  test("filed items notify the triage destination; discarded candidates are logged", async () => {
    const config = makeConfig({ threshold: 1 });
    const { runtime, deps, logs, notifier } = makeLoggedFactory(config, [
      {
        filed: [
          { repo: REPO, number: 501, title: "check the repo's test command" },
          { repo: FACTORY, number: 502, title: "the worker prompt lacks the triage label" },
        ],
        discarded: [{ title: "flaky docker build", reason: "one occurrence, no cost" }],
      },
    ]);
    seedArchived(1, at(1));

    await runOnce(deps);

    assert.equal(runtime.retroLaunched.length, 1);
    const notices = notifier.notifications.filter((notice) => notice.kind === "retro-items");
    assert.equal(notices.length, 2, "one notice per destination whose queue grew");
    const byDestination = new Map(
      notices.map((notice) => [notice.kind === "retro-items" ? notice.destination : "", notice]),
    );
    assert.equal(byDestination.get(REPO)?.items, 1);
    assert.equal(byDestination.get(FACTORY)?.items, 1);
    const state = await readRetroState(layout);
    assert.equal(state.lastFiled, 2, "the marker records how many items the round filed");
    assert.ok(
      logs.some((line) => line.includes("2 item(s) filed as needs-triage") && line.includes("1 candidate(s) discarded")),
      "the report records the filing and the discard — the operator can overrule the filter",
    );
  });

  test("a forced round analyzes one work and never moves the boundary", async () => {
    const config = makeConfig({ threshold: 1 });
    const { runtime, deps } = makeFactory(config);
    seedArchived(1, at(1));
    await runOnce(deps);
    const boundary = (await readRetroState(layout)).boundaryAt;

    seedArchived(2, at(2));
    const finished = await collectFinishedWorks(layout);
    const plan = await planManualRound(config, layout, finished, {
      work: `${REPO}#1`,
      language: "pt-BR",
    });
    assert.ok(!("empty" in plan));
    await runRetroRound(
      { config, runtime, workspace: layout, log: () => {}, notifier: new FakeNotifier() },
      plan as RetroPlan,
    );

    const forced = runtime.retroLaunched.at(-1)!;
    assert.deepEqual(forced.works.map((work) => work.key), [`${REPO}#1`], "a window of exactly one work");
    assert.equal(forced.language, "pt-BR", "the per-invocation language overrides the config");
    const state = await readRetroState(layout);
    assert.equal(state.boundaryAt, boundary, "a single-work post-mortem does not consume the window");
    assert.ok(state.analyzed.includes(`${REPO}#1`), "the analyzed work is not re-analyzed by the next window");
  });

  test("a manual round on an unknown work is refused, and an empty window is a notice, not a report", async () => {
    const config = makeConfig({ threshold: 5 });
    const noWork = await planManualRound(config, layout, []);
    assert.deepEqual(noWork, { empty: "no-finished-works" });

    await assert.rejects(
      () => planManualRound(config, layout, [], { work: `${REPO}#99` }),
      /not a finished work/,
    );
    assert.equal(existsSync(join(layout.retros, RETRO_STATE_FILENAME)), false, "nothing was launched or marked");
    assert.equal(existsSync(join(layout.retros, RETRO_IN_FLIGHT_FILENAME)), false);
  });

  test("msf status shows the round in flight and the last report once it lands", async () => {
    const config = makeConfig({ threshold: 1, model: RETRO_MODEL });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => {};
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { runtime, deps, tracker } = makeFactory(config, [{ filed: [{ repo: REPO, number: 7 }] }]);
    runtime.holdRetro = async () => {
      started();
      await held;
    };
    seedArchived(1, at(1));

    const running = runOnce(deps);
    await began;

    const inFlight = await deriveStatus(tracker, config, layout, async () => []);
    assert.equal(inFlight.retro?.inFlight?.round, runtime.retroLaunched[0]!.round);
    assert.deepEqual(inFlight.retro?.inFlight?.window, [`${REPO}#1`]);
    assert.match(renderStatus(inFlight), /retro in flight \(outside the worker slots\)/);

    release();
    await running;

    const settled = await deriveStatus(tracker, config, layout, async () => []);
    assert.equal(settled.retro?.inFlight, null, "the in-flight record is gone once the round ended");
    assert.match(settled.retro?.lastReport ?? "", /-retro\.md$/);
    assert.equal(settled.retro?.filed, 1);
    const rendered = renderStatus(settled);
    assert.match(rendered, /retro \(window reports mark the next window; items land as needs-triage\)/);
    assert.match(rendered, /1 item\(s\) filed by the last round/);
    assert.match(rendered, /window boundary: 2026-02-01T12:00:00\.000Z/);
  });

  test("a threshold met only by work a post-mortem already covered is a notice, not a report", async () => {
    const config = makeConfig({ threshold: 1 });
    const { runtime, deps, logs } = makeLoggedFactory(config);
    seedArchived(1, at(1));
    const finished = await collectFinishedWorks(layout);
    const single = await planManualRound(config, layout, finished, { work: `${REPO}#1` });
    assert.ok(!("empty" in single));
    await runRetroRound(
      { config, runtime, workspace: layout, log: () => {}, notifier: new FakeNotifier() },
      single as RetroPlan,
    );
    assert.equal(runtime.retroLaunched.length, 1);

    await runOnce(deps);

    assert.equal(runtime.retroLaunched.length, 1, "no second round: nothing is left to analyze");
    assert.ok(
      logs.some((line) => line.includes("nothing new since the last report")),
      "the sweep says the window is empty instead of writing an empty report",
    );
    assert.equal(
      readdirSync(layout.retros).filter((name) => name.endsWith("-retro.md")).length,
      1,
      "the post-mortem's report stays the only artifact",
    );
  });

  test("a window covers works of any source, not only the legacy GitHub keys", async () => {
    const config = makeConfig({ threshold: 1 });
    const { runtime, deps } = makeFactory(config);
    // The record-form key of a Jira work (issue 126): its destination repo is
    // encoded in the key, never reconstructed from the configuration.
    const key = "jira@https%3A%2F%2Facme.atlassian.net@ABC-1@Sanmoo%2Fmy-tasks";
    const workArchive = join(layout.archive, `${key}-2026-02-05`);
    mkdirSync(workArchive, { recursive: true });
    writeFileSync(join(workArchive, "log-1.jsonl"), "{}\n", "utf8");
    const recordPath = join(workArchive, DESFECHO_FILENAME);
    writeFileSync(recordPath, JSON.stringify({ class: "blocked-self-report", attempt: 1 }), "utf8");
    utimesSync(recordPath, at(5) / 1000, at(5) / 1000);

    await runOnce(deps);

    const window = runtime.retroLaunched[0]!.works;
    assert.deepEqual(window.map((work) => work.key), [key]);
    assert.equal(window[0]!.repo, REPO, "the items are routed to the work's own repo");
    assert.match(window[0]!.evidencePath, /^\/msf-arquivo\//);
  });

  test("an unknown liveness defers the round: the window's premise cannot be confirmed", async () => {
    const config = makeConfig({ threshold: 1 });
    const { runtime, deps, logs } = makeLoggedFactory(config);
    seedArchived(1, at(1));
    deps.probe = async () => {
      throw new Error("Cannot connect to the Docker daemon");
    };

    await runOnce(deps);

    assert.equal(runtime.retroLaunched.length, 0, "no round on an unverifiable window");
    assert.ok(logs.some((line) => line.includes("liveness is unknown")));
    assert.equal(existsSync(join(layout.retros, RETRO_STATE_FILENAME)), false, "nothing was consumed");
  });

  test("an in-flight record that names no owner never holds the lane", async () => {
    const config = makeConfig({ threshold: 1 });
    const { runtime, deps } = makeFactory(config);
    seedArchived(1, at(1));
    mkdirSync(layout.retros, { recursive: true });
    writeFileSync(
      join(layout.retros, RETRO_IN_FLIGHT_FILENAME),
      JSON.stringify({ round: "2026-03-01T00-00-00-000Z", startedAt: at(1), window: [], manual: false, pid: 0 }),
      "utf8",
    );

    await runOnce(deps);

    // pid 0 is the caller's own process group: `kill(0, 0)` always answers.
    assert.equal(runtime.retroLaunched.length, 1, "an ownerless record is stale, never a live round");
  });

  test("one round at a time: a live round's marker keeps the lane, and a dead owner's is cleared", async () => {
    const config = makeConfig({ threshold: 1 });
    const { runtime, deps, logs } = makeLoggedFactory(config);
    seedArchived(1, at(1));
    const inFlightPath = join(layout.retros, RETRO_IN_FLIGHT_FILENAME);
    const inFlight = (pid: number): string =>
      JSON.stringify({
        round: "2026-03-01T00-00-00-000Z",
        startedAt: at(1),
        window: [`${REPO}#9`],
        manual: false,
        pid,
      });
    mkdirSync(layout.retros, { recursive: true });

    // This test process is alive: the round belongs to a factory that is still running.
    writeFileSync(inFlightPath, inFlight(process.pid), "utf8");
    await runOnce(deps);
    assert.equal(runtime.retroLaunched.length, 0, "the lane is taken");
    assert.ok(logs.some((line) => line.includes("already in flight")));
    assert.ok(readdirSync(layout.retros).includes(RETRO_IN_FLIGHT_FILENAME), "a live owner's record is never wiped");

    // A process that exited owns nothing: its record is stale, the lane is free.
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!;
    writeFileSync(inFlightPath, inFlight(deadPid), "utf8");
    let heldWhileRunning = "";
    runtime.holdRetro = () => {
      heldWhileRunning = readFileSync(inFlightPath, "utf8");
    };
    await runOnce(deps);
    assert.equal(runtime.retroLaunched.length, 1, "the stale record never blocks a round");
    assert.match(
      heldWhileRunning,
      new RegExp(`"pid": ${process.pid}\\b`),
      "the new round holds the lane for its own lifetime",
    );
  });

  test("an empty workspace launches no round and writes no marker", async () => {
    const config = makeConfig({ threshold: 1 });
    const { runtime, deps } = makeFactory(config);
    await runOnce(deps);
    assert.equal(runtime.retroLaunched.length, 0, "no finished work, no round");
    assert.equal(existsSync(join(layout.retros, RETRO_STATE_FILENAME)), false);
    assert.equal(existsSync(join(layout.retros, RETRO_IN_FLIGHT_FILENAME)), false);
  });
});
