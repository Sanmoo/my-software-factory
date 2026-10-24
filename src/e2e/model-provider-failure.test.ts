import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, describe, beforeEach, afterEach } from "node:test";

import { runOnce, type LoopDeps } from "../loop.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime, type ScriptedOutcome } from "../runtime/fake-runtime.js";
import { appendAttemptEvent, eventLogName } from "../runtime/attempt-logs.js";
import { readTurnModelProviderError } from "../runtime/model-provider-error.js";
import type { WorkRequest } from "../runtime/port.js";
import type { LocalWorkFacts, PreparedWork } from "../git/port.js";
import { workBranchName } from "../git/port.js";
import type { IssueRef } from "../tracker/port.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import {
  DEFAULT_LABELS,
  DEFAULT_LIVENESS_POLICY,
  DEFAULT_MODEL_PROVIDER_BUDGET,
  DEFAULT_RECOVERY_BUDGET,
  type Config,
} from "../config.js";
import { settleModelProviderFailure, MODEL_PROVIDER_FILENAME } from "../pool/model-provider.js";
import { RECOVERY_FILENAME } from "../pool/recovery.js";
import { seedSession } from "./session-fixtures.js";
import { expandedGitWorkOf, type LegacyGitWork } from "./legacy-git.js";

/**
 * End-to-end of issue 144: the recovery of an interrupted attempt must tell a
 * MODEL PROVIDER FAILURE from an interruption of the agent. A model provider
 * error in the attempt's own stream retries on its own budget and backoff; an
 * interruption without it keeps issue 123's recovery untouched; an exhausted
 * model provider budget waits for the operator ("awaiting model provider") as a
 * help request — never a block and never an infinite retry.
 *
 * The seams are the ticket's: the scriptable fake runtime (a model provider
 * error written into the attempt's stream log, exactly as the real runtime
 * records pi's stdout) and a real work dir under a temp workspace.
 */

const REPO = "Sanmoo/my-tasks";
const NOW = "2026-01-01T00:00:00Z";
const MODEL_PROVIDER_MESSAGE =
  '429: {"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}';

/** The runtime deadline seam only records the waits: the tests never sleep. */
class Waits {
  readonly observed: number[] = [];
  readonly wait = async (ms: number): Promise<void> => {
    this.observed.push(ms);
  };
}

/** Minimal git-host fake (ticket 15's seam): prepare is bookkeeping only. */
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

describe("e2e: a model provider failure is not an interruption of the agent (issue 144)", () => {
  let dir: string;
  let layout: WorkspaceLayout;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-provider-"));
    layout = ensureWorkspace(join(dir, "ws"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeConfig(modelProvider = DEFAULT_MODEL_PROVIDER_BUDGET): Config {
    return {
      workerGhAccount: "bot-do-samuca",
      workerModel: "opencode-go/glm-5.3-flash",
      jira: [],
      repos: [REPO],
      concurrency: 1,
      workspace: layout.root,
      labels: { ...DEFAULT_LABELS },
      recovery: { ...DEFAULT_RECOVERY_BUDGET },
      modelProvider: { ...modelProvider },
      liveness: { ...DEFAULT_LIVENESS_POLICY },
      notifications: true,
      workerAuthFile: null,
      configPath: join(dir, "msf.yaml"),
    };
  }

  /** A fresh factory instance: nothing but disk survives between sweeps. */
  function makeFactory(
    config: Config,
    tracker: FakeTrackerAdapter,
    outcomes: ScriptedOutcome[],
    options: { modelProviderErrors?: (request: WorkRequest, index: number) => string | null } = {},
  ) {
    const runtime = new FakeWorkerRuntime({
      tracker,
      outcomes,
      ...(options.modelProviderErrors === undefined ? {} : { modelProviderErrors: options.modelProviderErrors }),
    });
    const waits = new Waits();
    return {
      runtime,
      waits,
      deps: {
        config,
        tickets: tracker,
        pullRequests: tracker,
        runtime,
        git: expandedGitWorkOf(new FakeGitWork()),
        workspace: layout,
        log: () => {},
        wait: waits.wait,
      } as LoopDeps,
    };
  }

  async function labelsOf(tracker: FakeTrackerAdapter, number: number): Promise<string[]> {
    const issue = await tracker.readIssue({ repo: REPO, number });
    assert.ok(issue.known, `issue #${number} should exist`);
    return issue.value.labels;
  }

  function modelProviderLedger(workDirPath: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(workDirPath, MODEL_PROVIDER_FILENAME), "utf8"));
  }

  test("(a) a model provider error in the stream advances the model provider budget and retries on its own backoff", async () => {
    const config = makeConfig({ maxRetries: 2, waitsMs: [10, 20] });
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    const { deps, waits } = makeFactory(config, tracker, ["abrupt-death", "abrupt-death", "pr-open"], {
      modelProviderErrors: () => MODEL_PROVIDER_MESSAGE,
    });
    const result = await runOnce(deps);

    assert.deepEqual(waits.observed, [10, 20], "the model provider's own backoff — never the recovery schedule");
    assert.deepEqual(
      result.launched.map((launch) => launch.request.attempt),
      [1, 1, 1],
      "every retry continues the SAME attempt",
    );
    assert.deepEqual(
      result.launched.map((launch) => launch.request.session?.mode),
      ["new", "resume", "resume"],
      "the claim starts a fresh session; each retry reopens the attempt's own one (ADR 0005)",
    );
    assert.equal(result.collected.at(-1)?.ruling.decision, "reserve", "the third session opened the PR");

    const wd = workDir(layout, REPO, 1);
    const ledger = modelProviderLedger(wd);
    assert.equal(ledger["consumed"], 2, "two model provider retries were consumed and persisted");
    assert.ok(!existsSync(join(wd, RECOVERY_FILENAME)), "the recovery budget of issue 123 was never touched");

    const log = readFileSync(join(wd, eventLogName(1)), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const failures = log.filter((line) => line["event"] === "model-provider-failure");
    const retries = log.filter((line) => line["event"] === "model-provider-retry");
    assert.equal(failures.length, 2, "each model provider failure has its own event in the attempt's log");
    assert.equal(retries.length, 2, "each retry has its own event in the attempt's log");
    assert.ok(failures.every((line) => line["message"] === MODEL_PROVIDER_MESSAGE), "the log names the model provider's message");
    assert.deepEqual(retries.map((line) => line["waitMs"]), [10, 20], "the log names the granted backoff");

    const labels = await labelsOf(tracker, 1);
    assert.ok(labels.includes(DEFAULT_LABELS.claimed), "the claim is held through the retries");
    assert.ok(!labels.includes(DEFAULT_LABELS.blocked), "a model provider failure never blocks");
  });

  test("(b) an interruption WITHOUT a model provider error keeps issue 123's recovery unchanged", async () => {
    const config = makeConfig({ maxRetries: 2, waitsMs: [10, 20] });
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    const { deps, waits } = makeFactory(config, tracker, ["abrupt-death", "pr-open"]);
    const result = await runOnce(deps);

    assert.deepEqual(waits.observed, [1_000], "the recovery budget's own wait answered the interruption");
    assert.deepEqual(result.launched.map((launch) => launch.request.attempt), [1, 1]);
    assert.equal(result.collected[0]?.ruling.because, "no-outcome");

    const wd = workDir(layout, REPO, 1);
    assert.equal(
      JSON.parse(readFileSync(join(wd, RECOVERY_FILENAME), "utf8")).consumed,
      1,
      "the interruption consumed its recovery",
    );
    assert.ok(!existsSync(join(wd, MODEL_PROVIDER_FILENAME)), "no model provider ledger is invented for a plain interruption");
    assert.doesNotMatch(
      readFileSync(join(wd, eventLogName(1)), "utf8"),
      /provider-failure|provider-retry/,
      "no model provider event is written for an interruption of the agent",
    );
  });

  test("(c) an exhausted model provider budget waits for the operator: a help request, never a block and never a retry loop", async () => {
    const config = makeConfig({ maxRetries: 1, waitsMs: [10] });
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    const { deps, waits } = makeFactory(config, tracker, ["abrupt-death"], {
      modelProviderErrors: () => MODEL_PROVIDER_MESSAGE,
    });
    const result = await runOnce(deps);

    assert.deepEqual(waits.observed, [10], "exactly one retry was granted");
    assert.deepEqual(
      result.launched.map((launch) => launch.request.attempt),
      [1, 1],
      "the second failure exhausted the budget — no third launch",
    );

    const labels = await labelsOf(tracker, 1);
    assert.ok(labels.includes(DEFAULT_LABELS.claimed), "the claim stays held");
    assert.ok(!labels.includes(DEFAULT_LABELS.blocked), "awaiting model provider is NOT a block");

    const comments = await tracker.readComments({ repo: REPO, number: 1 });
    assert.ok(comments.known);
    assert.equal(comments.value.length, 1, "exactly one help request");
    const body = comments.value[0]!.body;
    assert.match(body, /model provider budget is exhausted/);
    assert.match(body, /the work is NOT blocked and no attempt was consumed/);
    assert.match(body, /429: .*Endpoint is unavailable/);

    const wd = workDir(layout, REPO, 1);
    const ledger = modelProviderLedger(wd);
    assert.equal(ledger["consumed"], 1);
    assert.equal((ledger["last"] as Record<string, unknown>)["granted"], false, "the failure is settled as awaiting");
    assert.ok(!existsSync(join(wd, RECOVERY_FILENAME)), "the recovery budget of issue 123 was never touched");

    // A restart keeps awaiting: no new worker, no second comment.
    const restarted = makeFactory(config, tracker, ["pr-open"], { modelProviderErrors: () => MODEL_PROVIDER_MESSAGE });
    const second = await runOnce(restarted.deps);
    assert.equal(second.launched.length, 0, "no infinite retry: the exhausted budget launches nothing");
    const after = await tracker.readComments({ repo: REPO, number: 1 });
    assert.ok(after.known);
    assert.equal(after.value.length, 1, "the help request is never repeated");
  });

  test("a death between the ledger and the help request never loses the request — the next sweep asks", async () => {
    const config = makeConfig({ maxRetries: 1, waitsMs: [10] });
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });

    const wd = workDir(layout, REPO, 1);
    mkdirSync(wd, { recursive: true });
    const at = new Date(1_700_000_000_555).toISOString();
    appendAttemptEvent(wd, 1, {
      event: "agent-raw",
      iteration: 1,
      line: JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          provider: "fake",
          model: "fake/model",
          stopReason: "error",
          errorMessage: MODEL_PROVIDER_MESSAGE,
          timestamp: 1_700_000_000_555,
        },
      }),
    });
    // A retry was spent, then the awaiting settlement was written — and the
    // factory died before the comment (helpRequested: false).
    await settleModelProviderFailure(wd, config.modelProvider, 1, {
      message: "503: unavailable",
      identity: "2026-01-01T00:00:00.000Z",
    });
    await settleModelProviderFailure(wd, config.modelProvider, 1, { message: MODEL_PROVIDER_MESSAGE, identity: at });
    assert.equal((modelProviderLedger(wd)["last"] as Record<string, unknown>)["helpRequested"], false);

    const { deps } = makeFactory(config, tracker, ["pr-open"]);
    const result = await runOnce(deps);

    assert.equal(result.launched.length, 0, "the work still awaits the model provider");
    const comments = await tracker.readComments({ repo: REPO, number: 1 });
    assert.ok(comments.known);
    assert.equal(comments.value.length, 1, "the help request that the death prevented is posted now");
    assert.equal((modelProviderLedger(wd)["last"] as Record<string, unknown>)["helpRequested"], true);
  });

  test("the operator answers the help request: the work resumes with a NEW attempt", async () => {
    const config = makeConfig({ maxRetries: 1, waitsMs: [10] });
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    const first = makeFactory(config, tracker, ["abrupt-death"], { modelProviderErrors: () => MODEL_PROVIDER_MESSAGE });
    await runOnce(first.deps);

    // The human answers on the issue, after the agent marker.
    tracker.addComment({ repo: REPO, number: 1 }, "operator", "go on, the model provider is back");

    const resumed = makeFactory(config, tracker, ["pr-open"]);
    const result = await runOnce(resumed.deps);

    assert.equal(result.launched.length, 1);
    assert.equal(result.launched[0]?.request.attempt, 2, "a human answer starts a new attempt");
    assert.equal(result.collected[0]?.ruling.decision, "reserve");
    const labels = await labelsOf(tracker, 1);
    assert.ok(labels.includes(DEFAULT_LABELS.claimed));
    assert.ok(!labels.includes(DEFAULT_LABELS.blocked));
  });

  test("(d) a restart with the persisted counter resumes the schedule where it stopped — never from zero", async () => {
    const config = makeConfig({ maxRetries: 3, waitsMs: [10, 20, 30] });
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });

    const wd = workDir(layout, REPO, 1);
    mkdirSync(wd, { recursive: true });
    // The interrupted session's own failure: the newest error in the log.
    appendAttemptEvent(wd, 1, {
      event: "agent-raw",
      iteration: 1,
      line: JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          provider: "fake",
          model: "fake/model",
          stopReason: "error",
          errorMessage: MODEL_PROVIDER_MESSAGE,
          timestamp: 1_700_000_000_123,
        },
      }),
    });
    // The attempt's own Pi session exists and is associated (issue 119): a
    // relaunch of the same attempt continues it instead of pausing for help.
    seedSession(wd, { repo: REPO, number: 1 }, 1);
    // A retry was already granted before the factory died (the persisted
    // counter of an earlier failure of the same attempt).
    await settleModelProviderFailure(
      wd,
      config.modelProvider,
      1,
      { message: "503: unavailable", identity: "2026-01-01T00:00:00.000Z" },
    );
    assert.ok(await readTurnModelProviderError(wd, 1), "the newest failure is the one the log carries");

    const { deps, waits } = makeFactory(config, tracker, ["pr-open"]);
    const result = await runOnce(deps);

    assert.deepEqual(waits.observed, [20], "the SECOND wait of the schedule — the first was already spent");
    assert.deepEqual(result.launched.map((launch) => launch.request.attempt), [1], "the same attempt continues");
    assert.equal(modelProviderLedger(wd)["consumed"], 2, "the persisted counter resumed at 2, not at 1");
    assert.ok(!existsSync(join(wd, RECOVERY_FILENAME)), "the recovery budget of issue 123 was never touched");
  });

  test("a work whose record exists is never read as a model provider failure — the record decides", async () => {
    const config = makeConfig({ maxRetries: 2, waitsMs: [10, 20] });
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    const { deps, waits } = makeFactory(config, tracker, ["pr-open"], {
      modelProviderErrors: () => MODEL_PROVIDER_MESSAGE,
    });
    const result = await runOnce(deps);

    assert.deepEqual(waits.observed, [], "no retry: the session wrote its outcome");
    assert.equal(result.collected[0]?.ruling.decision, "reserve");
  });

  test("the awaiting model provider state is visible to msf status, with the provider's message", async () => {
    const config = makeConfig({ maxRetries: 1, waitsMs: [10] });
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    const first = makeFactory(config, tracker, ["abrupt-death"], { modelProviderErrors: () => MODEL_PROVIDER_MESSAGE });
    await runOnce(first.deps);

    const { deriveStatus } = await import("../state/status.js");
    const { renderStatus } = await import("../state/status-render.js");
    const view = await deriveStatus({ github: tracker }, config, layout, () => Promise.resolve([]));
    const text = renderStatus(view);

    assert.match(
      text,
      /model provider \(the last attempt ended by a model provider failure — not an interruption of the agent\): 1/,
    );
    assert.match(
      text,
      /Sanmoo\/my-tasks#1 \(attempt 1: 1\/1 retries \(waits 10ms\); last model provider error: 429: .*Endpoint is unavailable/,
    );
    assert.match(text, /— awaiting model provider — a help request, not a block\)/);
    assert.match(
      text,
      /orphaned \(attempt interrupted — no outcome record of its own, no worker alive\): none/,
      "an awaiting-model-provider work is not repeated as an interrupted attempt",
    );
    assert.doesNotMatch(text, /\/tmp\/|\/home\//, "the status never shows an absolute path");
    assert.ok(!text.includes("blocked"), "awaiting model provider is never rendered as a block");
  });
});
