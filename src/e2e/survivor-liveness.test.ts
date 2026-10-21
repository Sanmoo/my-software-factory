import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_LABELS, DEFAULT_LIVENESS_POLICY, DEFAULT_RECOVERY_BUDGET, type Config } from "../config.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import { runForever, runOnce, type LoopDeps } from "../loop.js";
import { workBranchName, type GitWork, type LocalWorkFacts, type PreparedWork } from "../git/port.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime, type ScriptedOutcome } from "../runtime/fake-runtime.js";
import { FakeNotifier } from "../notify/fake-notifier.js";
import { DESFECHO_FILENAME } from "../state/outcome.js";
import { RECOVERY_FILENAME, readRecoveryLedger } from "../pool/recovery.js";
import type { LiveWorker, LivenessProbe } from "../state/liveness.js";
import type { IssueRef } from "../tracker/port.js";

/**
 * e2e of issue 118 at the PUBLIC cycle boundary (`runOnce` / `runForever`):
 * the liveness probe is the only controlled seam, the tracker, the runtime,
 * the git host and the notifier are the adapters the other suites use, and
 * the work artifacts are real files in a temp workspace. Recognition never
 * launches anything by itself; the assertions read observable effects —
 * launches, claims, attempt numbers, preserved files, labels, notices and the
 * operator's log — never private functions.
 */

const REPO = "Sanmoo/my-tasks";
const NOW = "2026-01-01T00:00:00Z";

class FakeGitWork implements GitWork {
  readonly prepared: IssueRef[] = [];
  readonly cleaned: IssueRef[] = [];

  async prepareWork(ref: IssueRef): Promise<PreparedWork> {
    this.prepared.push(ref);
    return {
      repoDir: `/clones/${ref.repo.replaceAll("/", "#")}`,
      branch: workBranchName(ref.number),
      baseBranch: "main",
      branchCreated: true,
      branchOnOrigin: false,
    };
  }

  async cleanupDoneWork(ref: IssueRef): Promise<void> {
    this.cleaned.push(ref);
  }

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

/** One live worker the fake Docker reports: the container's own identity. */
function worker(number: number, containerId: string, ageMs = 5 * 60_000): LiveWorker {
  return { key: `${REPO}#${number}`, containerId, ageMs };
}

/** A promise a test resolves by hand — the worker parked in flight, no sleep. */
function deferred(): { promise: Promise<void>; fire: () => void } {
  let fire: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { promise, fire };
}

const probeOf =
  (...workers: LiveWorker[]): LivenessProbe =>
  async () =>
    workers;

const failingProbe =
  (message = "docker: daemon is not reachable"): LivenessProbe =>
  () =>
    Promise.reject(new Error(message));

describe("e2e: surviving workers and liveness on the operational cycle (issue 118)", () => {
  let dir: string;
  let layout: WorkspaceLayout;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-survivor-"));
    layout = ensureWorkspace(join(dir, "ws"));
  });

  afterEach(() => {
    rmSync(join(dir, "ws"), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  function makeConfig(concurrency: number, overrides: Partial<Config> = {}): Config {
    return {
      workerGhAccount: "bot-do-samuca",
      workerModel: "opencode-go/glm-5.3-flash",
      repos: [REPO],
      concurrency,
      workspace: layout.root,
      labels: { ...DEFAULT_LABELS },
      profileAllowedRoots: [],
      profileSkipDanglingLinks: false,
      recovery: { ...DEFAULT_RECOVERY_BUDGET, waitsMs: [0, 0, 0] },
      liveness: { ...DEFAULT_LIVENESS_POLICY },
      notifications: true,
      configPath: join(dir, "msf.yaml"),
      ...overrides,
    };
  }

  interface FactoryOptions {
    config: Config;
    probe?: LivenessProbe;
    now?: () => number;
    probeTimeoutMs?: number;
    outcomes?: ScriptedOutcome[];
  }

  function makeFactory(options: FactoryOptions) {
    const tracker = new FakeTrackerAdapter({ workerAccount: options.config.workerGhAccount });
    const runtime = new FakeWorkerRuntime({ tracker, outcomes: options.outcomes ?? [] });
    const git = new FakeGitWork();
    const notifier = new FakeNotifier();
    const log: string[] = [];
    const deps: LoopDeps = {
      config: options.config,
      tracker,
      runtime,
      git,
      workspace: layout,
      notifier,
      log: (message) => log.push(message),
      wait: async () => {},
      ...(options.probe === undefined ? {} : { probe: options.probe }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: options.probeTimeoutMs }),
    };
    return { tracker, runtime, git, notifier, log, deps };
  }

  /** A work the factory reserved in a previous life: claim + attempt evidence. */
  function seedReserved(number: number, attempts: number[], record?: object): string {
    seedIssue(trackerFor(number), { repo: REPO, number, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });
    const target = workDir(layout, REPO, number);
    mkdirSync(target, { recursive: true });
    for (const attempt of attempts) writeFileSync(join(target, `log-${attempt}.jsonl`), "{}\n", "utf8");
    if (record !== undefined) {
      writeFileSync(join(target, DESFECHO_FILENAME), JSON.stringify(record), "utf8");
    }
    return target;
  }

  // `seedReserved` needs the tracker of the current test; the tests below run
  // one engine each, so the tracker is bound in a describe-level variable.
  let trackerFor: (number: number) => FakeTrackerAdapter = () => {
    throw new Error("tracker not bound");
  };

  function bindTracker(tracker: FakeTrackerAdapter): void {
    trackerFor = () => tracker;
  }

  async function waitFor(what: string, condition: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  async function labelSet(tracker: FakeTrackerAdapter, number: number): Promise<string[]> {
    const issue = await tracker.readIssue({ repo: REPO, number });
    assert.ok(issue.known, `issue #${number} exists`);
    return issue.value.labels;
  }

  test("a survivor seen after a restart keeps the work reserved: no substitute, no new attempt, no recovery spent", async () => {
    const config = makeConfig(2);
    const { tracker, deps, runtime, log } = makeFactory({ config, probe: probeOf(worker(7, "ctr000000007")) });
    bindTracker(tracker);
    const target = seedReserved(7, [1, 2]);
    const before = readdirSync(target).sort();

    const sweep = await runOnce(deps);

    assert.equal(sweep.launched.length, 0, "no substitute was launched over the survivor");
    assert.equal(runtime.launched.length, 0);
    assert.deepEqual(tracker.claimedOrder, [], "no claim was written for a work already reserved");
    assert.deepEqual(readdirSync(target).sort(), before, "attempt evidence untouched — no attempt 3 was created");
    assert.ok(!existsSync(join(target, RECOVERY_FILENAME)), "recognition is observation: no recovery consumed");
    assert.ok(
      log.some((line) => line.includes("recognizing surviving worker") && line.includes("attempt 2")),
      "the survivor is recognised with the attempt its artifacts number",
    );
    assert.ok(
      !log.some((line) => line.includes("recovering") || line.includes("interrupted")),
      "recognition is not a relaunch and not an interruption",
    );
  });

  test("a closed issue whose worker is alive is not archived or cleaned before the confirmed exit", async () => {
    const config = makeConfig(1);
    let calls = 0;
    const probe: LivenessProbe = async () => {
      calls += 1;
      return calls <= 6 ? [worker(8, "ctr000000008")] : [];
    };
    const { tracker, deps, git } = makeFactory({ config, probe });
    bindTracker(tracker);
    const target = seedReserved(8, [1], { class: "pr-open", attempt: 1 });
    const issue = await tracker.readIssue({ repo: REPO, number: 8 });
    assert.ok(issue.known);
    await tracker.markDone({ repo: REPO, number: 8 });

    const controller = new AbortController();
    const running = runForever(deps, { tickMs: 5, signal: controller.signal });
    running.catch(() => {});

    try {
      await waitFor("several ticks with the survivor alive", () => calls >= 5);
      assert.ok(existsSync(target), "the work dir of a live worker is never archived");
      assert.ok(!existsSync(join(layout.archive, `${REPO}#8-${new Date().toISOString().slice(0, 10)}`)));
      assert.equal(git.cleaned.length, 0, "no branch cleanup while the worker lives");

      // The exit is confirmed by a reliable probe: now the done ruling applies
      // — artifacts archived first, then the branches cleaned.
      await waitFor("the confirmed exit's done duties", () => git.cleaned.length === 1);
      assert.deepEqual(git.cleaned.map((ref) => ref.number), [8], "the confirmed exit reconciles the done");
      assert.ok(!existsSync(target), "the artifacts moved to the archive after the exit was confirmed");
    } finally {
      controller.abort();
      await running;
    }
  });

  test("a confirmed survivor exit reconciles its result without the launch result this process never had", async () => {
    const config = makeConfig(1);
    let calls = 0;
    const probe: LivenessProbe = async () => {
      calls += 1;
      return calls <= 3 ? [worker(9, "ctr000000009")] : [];
    };
    const { tracker, deps, notifier, log } = makeFactory({ config, probe });
    bindTracker(tracker);
    seedReserved(9, [1], { class: "pr-open", attempt: 1, pr: { repo: REPO, number: 5, branch: "agent-issue-9" } });
    tracker.seedPullRequest({ repo: REPO, number: 9, headBranch: "agent-issue-9" });

    const controller = new AbortController();
    const running = runForever(deps, { tickMs: 5, signal: controller.signal });
    running.catch(() => {});

    try {
      await waitFor("the survivor's exit reconciliation", () =>
        log.some((line) => line.includes("survivor") && line.includes("ended: attempt 1")),
      );
      await waitFor("the review notice of the survivor's open PR", () =>
        notifier.notifications.some((notice) => notice.kind === "review"),
      );
      const review = notifier.notifications.find((notice) => notice.kind === "review");
      assert.ok(review && review.kind === "review");
      assert.equal(review.ref.number, 9, "the notice names the work the survivor carried");
      assert.deepEqual(await labelSet(tracker, 9), [DEFAULT_LABELS.claimed], "the claim stays held for the human");
      const feedback = await tracker.readPrFeedback({ repo: REPO, number: 9 });
      assert.ok(feedback.known);
      assert.equal(feedback.value.pr?.state, "open", "the PR the survivor opened is untouched");
    } finally {
      controller.abort();
      await running;
    }
  });

  test("an older attempt's record is never inherited: the survivor's exit continues the attempt its evidence numbers", async () => {
    const config = makeConfig(1);
    let calls = 0;
    const probe: LivenessProbe = async () => {
      calls += 1;
      return calls <= 2 ? [worker(10, "ctr000000010")] : [];
    };
    const { tracker, deps, runtime, log } = makeFactory({
      config,
      probe,
      outcomes: ["pr-open"],
    });
    bindTracker(tracker);
    const target = seedReserved(10, [1, 2], { class: "pr-open", attempt: 1 });

    const controller = new AbortController();
    const running = runForever(deps, { tickMs: 5, signal: controller.signal });
    running.catch(() => {});

    try {
      await waitFor("the recovery of the survivor's interrupted attempt", () => runtime.launched.length === 1);
      assert.equal(runtime.launched[0]!.attempt, 2, "the SAME attempt continues — the old record is history");
      assert.ok(
        log.some((line) => line.includes("attempt 2 keeps its number")),
        "the absence of a record is an interruption, not a fall",
      );
      const ledger = await readRecoveryLedger(target);
      assert.equal(ledger.attempt, 2);
      assert.equal(ledger.consumed, 1, "the survivor's own end spends ONE recovery, within the same attempt");
      assert.deepEqual(
        readdirSync(target)
          .filter((name) => /^log-\d+\.jsonl$/.test(name))
          .sort(),
        ["log-1.jsonl", "log-2.jsonl"],
        "no attempt 3 was created by an interruption of the factory",
      );
    } finally {
      controller.abort();
      await running;
    }
  });

  test("capacity 3 with two survivors allows exactly one more launch", async () => {
    const config = makeConfig(3);
    let calls = 0;
    const probe: LivenessProbe = async () => {
      calls += 1;
      return [worker(20, "ctr000000020"), worker(21, "ctr000000021")];
    };
    const { tracker, deps, runtime } = makeFactory({ config, probe, outcomes: ["pr-open"] });
    bindTracker(tracker);
    seedReserved(20, [1]);
    seedReserved(21, [1]);
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    seedIssue(tracker, { repo: REPO, number: 2, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    // The launched worker is held in flight: its container is alive, so its
    // slot counts together with the two survivors'.
    const hold = deferred();
    runtime.hold = () => hold.promise;
    const controller = new AbortController();
    const running = runForever(deps, { tickMs: 5, signal: controller.signal });
    running.catch(() => {});

    try {
      await waitFor("the one extra launch", () => runtime.launched.length >= 1);
      await waitFor("several more ticks", () => calls >= 8);
      assert.deepEqual(
        runtime.launched.map((request) => request.ref.number),
        [1],
        "three slots minus two survivors leaves room for exactly one",
      );
      assert.ok(!(await labelSet(tracker, 2)).includes(DEFAULT_LABELS.claimed), "the second eligible waits for a slot");
    } finally {
      hold.fire();
      controller.abort();
      await running;
    }
  });

  test("above the limit launches are suspended without ending anyone; capacity returns by itself", async () => {
    const config = makeConfig(2);
    let calls = 0;
    const probe: LivenessProbe = async () => {
      calls += 1;
      // Three survivors at first; after the sixth sample two of them ended.
      if (calls <= 6) {
        return [
          worker(30, "ctr000000030"),
          worker(31, "ctr000000031"),
          worker(32, "ctr000000032"),
        ];
      }
      return [worker(30, "ctr000000030")];
    };
    const { tracker, deps, runtime, log } = makeFactory({ config, probe, outcomes: ["pr-open"] });
    bindTracker(tracker);
    for (const number of [30, 31, 32]) {
      const target = seedReserved(number, [1], {
        class: "pr-open",
        attempt: 1,
        pr: { repo: REPO, number: number, branch: `agent-issue-${number}` },
      });
      assert.ok(existsSync(target));
      tracker.seedPullRequest({ repo: REPO, number, headBranch: `agent-issue-${number}` });
    }
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    const controller = new AbortController();
    const running = runForever(deps, { tickMs: 5, signal: controller.signal });
    running.catch(() => {});

    try {
      await waitFor("the over-capacity diagnosis", () => calls >= 4);
      assert.equal(runtime.launched.length, 0, "no launch while the live workforce is above the limit");
      assert.deepEqual(tracker.claimedOrder, []);
      assert.ok(log.some((line) => line.includes("capacity exceeded")), "the suspension is diagnosed");
      assert.ok(existsSync(workDir(layout, REPO, 30)), "nobody is ended by an excess of capacity");

      // Two survivors end: the next sweep re-reads Docker and resumes by itself.
      await waitFor("capacity to return by itself", () => runtime.launched.length === 1);
      assert.deepEqual(runtime.launched.map((request) => request.ref.number), [1]);
      assert.ok(log.some((line) => line.includes("capacity available again")), "the return is diagnosed");
      assert.ok(
        log.some((line) => line.includes("survivor") && line.includes("attempt 1 confirmed finished")),
        "the confirmed exits are reconciled, not mistaken for failures",
      );
    } finally {
      controller.abort();
      await running;
    }
  });

  test("two containers of one work take two slots, block a substitute and ask for a human — another work still advances", async () => {
    const config = makeConfig(3);
    const { tracker, deps, notifier, log } = makeFactory({
      config,
      probe: probeOf(worker(40, "ctr000000040"), worker(40, "ctr000000041")),
      outcomes: ["pr-open"],
    });
    bindTracker(tracker);
    // No claim on the tracker: the only reason this work is not launched is Docker.
    seedIssue(tracker, { repo: REPO, number: 40, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    const sweep = await runOnce(deps);

    assert.equal(sweep.launched.length, 1, "one container pair (2 slots) plus one launch fits in 3");
    assert.deepEqual(tracker.claimedOrder, [`${REPO}#1`], "the duplicated work is never claimed or replaced");
    assert.ok(
      log.some((line) => line.includes("duplicate workers for") && line.includes("2 containers")),
      "the multiplicity is diagnosed",
    );
    assert.ok(
      notifier.notifications.some(
        (notice) => notice.kind === "intervention" && notice.ref.number === 40,
      ),
      "the operator is asked about the duplicated work",
    );
    assert.deepEqual(await labelSet(tracker, 40), [DEFAULT_LABELS.ready], "no owner chosen, no block invented");
  });

  test("a probe failure suspends launches, preserves workers, and consumes no attempt, recovery or block", async () => {
    const config = makeConfig(2);
    const { tracker, deps, runtime, log } = makeFactory({ config, probe: failingProbe() });
    bindTracker(tracker);
    const interrupted = seedReserved(50, [1]);
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    const sweep = await runOnce(deps);

    assert.equal(sweep.launched.length, 0, "no launch by omission while liveness is unknown");
    assert.equal(runtime.launched.length, 0);
    assert.deepEqual(tracker.claimedOrder, []);
    assert.ok(!existsSync(join(interrupted, RECOVERY_FILENAME)), "no recovery is spent on unknown liveness");
    assert.deepEqual(readdirSync(interrupted).sort(), ["log-1.jsonl"], "the attempt's evidence is preserved");
    assert.deepEqual(await labelSet(tracker, 1), [DEFAULT_LABELS.ready], "no issue is blocked by Docker's silence");
    assert.deepEqual(await labelSet(tracker, 50), [DEFAULT_LABELS.claimed]);
    assert.ok(log.some((line) => line.includes("liveness unknown")), "the cause is diagnosed from the first failure");
    assert.ok(
      log.some((line) => line.includes("held") && line.includes("presume a worker stopped")),
      "a decision that would presume a stop is held",
    );
  });

  test("a hung probe is bounded: the sweep keeps going and nothing is launched", async () => {
    const config = makeConfig(1);
    const { tracker, deps, runtime } = makeFactory({
      config,
      probe: () => new Promise<LiveWorker[]>(() => {}),
      probeTimeoutMs: 25,
      outcomes: ["pr-open"],
    });
    bindTracker(tracker);
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    const startedAt = Date.now();
    const sweep = await runOnce(deps);
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 5_000, "the hung query never stalls the cycle");
    assert.equal(sweep.launched.length, 0);
    assert.equal(runtime.launched.length, 0);
    assert.deepEqual(tracker.claimedOrder, []);
  });

  test("unknown liveness then recovery: launches resume by themselves, no issue blocked, no human needed", async () => {
    const config = makeConfig(1);
    let calls = 0;
    const probe: LivenessProbe = async () => {
      calls += 1;
      if (calls <= 2) throw new Error("docker: daemon is not reachable");
      return [];
    };
    const { tracker, deps, runtime, log } = makeFactory({ config, probe, outcomes: ["pr-open"] });
    bindTracker(tracker);
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    const controller = new AbortController();
    const running = runForever(deps, { tickMs: 5, signal: controller.signal });
    running.catch(() => {});

    try {
      await waitFor("the automatic recovery of the launch path", () => runtime.launched.length === 1);
      assert.deepEqual(tracker.claimedOrder, [`${REPO}#1`]);
      assert.ok(log.some((line) => line.includes("liveness reliable again")), "the episode closes by itself");
      assert.ok(!(await labelSet(tracker, 1)).includes(DEFAULT_LABELS.blocked), "Docker's silence blocked no issue");
      assert.ok(
        !log.some((line) => line.includes("blocked with")),
        "no comment or block was written for a probe failure",
      );
    } finally {
      controller.abort();
      await running;
    }
  });

  test("the unavailability warning: once per episode, at the configured threshold, and re-armed after a reliable answer", async () => {
    const config = makeConfig(1, { liveness: { unavailableWarnMs: 60_000 } });
    const clock = { t: 0 };
    let failing = true;
    const probe: LivenessProbe = async () => {
      clock.t += 30_000;
      if (failing) throw new Error("docker: daemon is not reachable");
      return [];
    };
    const { tracker, deps, notifier, log } = makeFactory({ config, probe, now: () => clock.t });
    bindTracker(tracker);

    const controller = new AbortController();
    const running = runForever(deps, { tickMs: 5, signal: controller.signal });
    running.catch(() => {});

    const warnings = (): number => log.filter((line) => line.includes("WARNING: Docker has not answered")).length;
    try {
      // 60 s of continuous unavailability = two 30 s samples past the episode's start.
      await waitFor("the one warning of the episode", () => warnings() >= 1);
      await waitFor("more cycles after the warning", () => clock.t >= 240_000);
      assert.equal(warnings(), 1, "the warning never repeats inside the same episode");
      const factoryNotices = (): number =>
        notifier.notifications.filter((notice) => notice.kind === "factory-unavailable").length;
      assert.equal(factoryNotices(), 1, "one notice per episode, identified as the factory's own occurrence");
      const notice = notifier.notifications.find((entry) => entry.kind === "factory-unavailable");
      assert.ok(notice && notice.kind === "factory-unavailable");
      assert.ok(!("ref" in notice), "a factory notice invents no work");

      // A reliable answer ends the episode; a new one warns again.
      failing = false;
      await waitFor("the episode to close", () => log.some((line) => line.includes("liveness reliable again")));
      failing = true;
      await waitFor("the second episode's warning", () => warnings() >= 2);
      assert.equal(factoryNotices(), 2, "each episode has its own single notice");
    } finally {
      controller.abort();
      await running;
    }
  });

  test("verifiable activity keeps a survivor accounted for; the factory's own log lines do not", async () => {
    const config = makeConfig(1);
    const clock = { t: 0 };
    let writeFactoryLog = true;
    const probe: LivenessProbe = async () => {
      clock.t += 5 * 60_000;
      return [worker(60, "ctr000000060")];
    };
    const { tracker, deps, notifier, log, runtime } = makeFactory({ config, probe, now: () => clock.t });
    bindTracker(tracker);
    const target = seedReserved(60, [1]);

    const controller = new AbortController();
    const running = runForever(deps, { tickMs: 5, signal: controller.signal });
    running.catch(() => {});

    const idleWarnings = (): number =>
      log.filter((line) => line.includes("no verifiable activity")).length;
    try {
      // The factory's derived log grows every cycle: it must not look like work.
      const interval = setInterval(() => {
        if (writeFactoryLog) appendFileSync(join(target, "log-1.jsonl"), '{"event":"heartbeat"}\n');
      }, 5);
      await waitFor("the idle warning of the silent survivor", () => idleWarnings() >= 1);
      clearInterval(interval);
      assert.equal(idleWarnings(), 1, "one warning per survivor, not one per cycle");
      assert.ok(existsSync(target), "nothing was cleaned");
      assert.equal(runtime.launched.length, 0, "no substitute was launched");
      assert.ok(
        notifier.notifications.some(
          (notice) => notice.kind === "intervention" && notice.ref.number === 60,
        ),
        "the operator is asked to decide, with the work's address",
      );
      assert.equal(
        (await labelSet(tracker, 60)).includes(DEFAULT_LABELS.claimed),
        true,
        "the survivor's claim is preserved",
      );
    } finally {
      controller.abort();
      await running;
    }
  });

  test("a worker writing files stays active past the idle limit — the observation is the agents' own work", async () => {
    const config = makeConfig(1);
    const clock = { t: 0 };
    const probe: LivenessProbe = async () => {
      clock.t += 5 * 60_000;
      return [worker(61, "ctr000000061")];
    };
    const { tracker, deps, log } = makeFactory({ config, probe, now: () => clock.t });
    bindTracker(tracker);
    const target = seedReserved(61, [1]);
    mkdirSync(join(target, "sessao"), { recursive: true });

    const controller = new AbortController();
    const running = runForever(deps, { tickMs: 5, signal: controller.signal });
    running.catch(() => {});

    let files = 0;
    const interval = setInterval(() => {
      files += 1;
      writeFileSync(join(target, "sessao", `turn-${files}.jsonl`), "{}\n", "utf8");
    }, 5);
    try {
      await waitFor("well past the idle limit", () => clock.t >= 30 * 60_000);
      assert.equal(
        log.filter((line) => line.includes("no verifiable activity")).length,
        0,
        "the survivor's own writes keep it active",
      );
    } finally {
      clearInterval(interval);
      controller.abort();
      await running;
    }
  });

  test("feedback, repair and retomada paths never bypass the gate when the probe is unknown", async () => {
    const config = makeConfig(2);
    const { tracker, deps, runtime } = makeFactory({ config, probe: failingProbe(), outcomes: ["pr-open"] });
    bindTracker(tracker);

    // A feedback round: claimed + open PR with a human comment.
    seedIssue(tracker, { repo: REPO, number: 70, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });
    tracker.seedPullRequest({ repo: REPO, number: 70, headBranch: "agent-issue-70" });
    tracker.addPrComment({ repo: REPO, prNumber: 70 }, "Sanmoo", "please fix the greeting");
    // A repair trigger: a conflicting PR on the same work.
    seedIssue(tracker, { repo: REPO, number: 71, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });
    tracker.seedPullRequest({ repo: REPO, number: 71, headBranch: "agent-issue-71" });
    tracker.setPrRepairFacts({ repo: REPO, prNumber: 71, mergeState: "conflicting" });
    // A retomada: blocked with a human answer after the marker.
    seedIssue(tracker, { repo: REPO, number: 72, createdAt: NOW, labels: [DEFAULT_LABELS.blocked] });
    tracker.addComment({ repo: REPO, number: 72 }, "Sanmoo", "go ahead, the API is approved");
    for (const number of [70, 71, 72]) {
      const target = workDir(layout, REPO, number);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "log-1.jsonl"), "{}\n", "utf8");
    }

    const sweep = await runOnce(deps);

    assert.equal(sweep.launched.length, 0, "every launch kind waits for a reliable liveness answer");
    assert.equal(runtime.launched.length, 0);
    assert.deepEqual(tracker.claimedOrder, [], "no resume swapped labels during the outage");
    assert.deepEqual(await labelSet(tracker, 72), [DEFAULT_LABELS.blocked], "the retomada stays parked");
  });

  test("a slot freed by a collection does not launch while liveness is unknown", async () => {
    const config = makeConfig(1);
    let calls = 0;
    const probe: LivenessProbe = async () => {
      calls += 1;
      // The first tick answers; from the second on Docker is gone.
      if (calls === 1) return [];
      throw new Error("docker: daemon is not reachable");
    };
    const { tracker, deps, runtime, log } = makeFactory({ config, probe, outcomes: ["pr-open"] });
    bindTracker(tracker);
    const hold = deferred();
    runtime.hold = () => hold.promise;
    seedIssue(tracker, { repo: REPO, number: 80, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    seedIssue(tracker, { repo: REPO, number: 81, createdAt: "2026-01-02T00:00:00Z", labels: [DEFAULT_LABELS.ready] });

    const controller = new AbortController();
    const running = runForever(deps, { tickMs: 5, signal: controller.signal });
    running.catch(() => {});

    try {
      await waitFor("the first launch of the healthy tick", () => runtime.launched.length === 1);
      await waitFor("the unknown episode to begin", () => calls >= 2);
      // The worker ends after the outage began: its slot is replenished by a
      // callback, which must respect the suspended gate.
      hold.fire();
      await waitFor("the collection of the launched worker", () =>
        log.some((line) => line.includes("collected") && line.includes("#80")),
      );
      await waitFor("a few more suspended cycles", () => calls >= 6);
      assert.equal(runtime.launched.length, 1, "the collection callback launched nothing under unknown liveness");
      assert.deepEqual(await labelSet(tracker, 81), [DEFAULT_LABELS.ready], "the waiting work stayed eligible");
    } finally {
      hold.fire();
      controller.abort();
      await running;
    }
  });
});
