import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_LABELS,
  DEFAULT_LIVENESS_POLICY,
  DEFAULT_MODEL_PROVIDER_BUDGET,
  DEFAULT_RECOVERY_BUDGET,
  type Config,
  type Labels,
} from "../config.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import { withPullRequestIdentity } from "../tracker/expanded-port.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime, type ScriptedOutcome } from "../runtime/fake-runtime.js";
import { workBranchName, type GitWork, type LocalWorkFacts, type PreparedWork } from "../git/port.js";
import { githubRepository, type TicketIdentity, type WorkIdentity } from "../tracker/identity.js";
import type { WriteOutcome } from "../tracker/port.js";
import type { WorkRequest, WorkerRuntime } from "../runtime/port.js";
import { workKeyOf } from "../pool/work-key.js";
import { githubTicketNumber, githubWork } from "../e2e/work-fixtures.js";
import { openLaunch, type Launch, type Launchable, type LaunchCycle } from "./launch.js";
import { openWorkState } from "../work-state/state.js";
import { recordFailure } from "../pool/recovery.js";
import { readLaunchFacts } from "../pool/registry.js";
import { readRecoveryLedger } from "../work-record/recovery.js";
import { DESFECHO_FILENAME, type OutcomeRecord } from "../work-record/outcome.js";
import { appendAttemptEvent } from "../work-record/logs.js";
import { writeFileSync } from "node:fs";

/**
 * The launch at its own seam (epic #198, ticket #205): the pipeline from the
 * claim to the collected end, exercised through {@link Launch} with a fake
 * runtime, a fake tracker and a fake git host — no factory, no derivation, no
 * container. What the engine decides (the state, the slot, the verdict) is
 * supplied by a recording {@link LaunchCycle}, so a test can see exactly what
 * the pipeline asked the cycle for, and in which order.
 */

const REPO = "Sanmoo/my-tasks";
const CREATED = "2026-01-01T00:00:00Z";
const ISSUE = 7;
const OTHER = 8;

/** The git host as a launch sees it: prepare is observable, holdable and
 *  failable, which is all the pipeline can tell about it. */
class ProbeGit implements GitWork {
  constructor(readonly events: string[]) {}

  /** Releases a prepare that a test parked; absent = prepare is immediate. */
  readonly gates = new Map<number, () => Promise<void>>();
  /** When armed, the next prepare fails — the launch must not go on. */
  failPrepare = false;
  /** Prepare reports the branch as already prepared (a relaunch). */
  branchReused = false;

  async prepareWorkFor(work: WorkIdentity): Promise<PreparedWork> {
    const number = githubTicketNumber(work.ticket) ?? 0;
    this.events.push(`prepare:start:${number}`);
    const gate = this.gates.get(number);
    if (gate !== undefined) await gate();
    if (this.failPrepare) {
      this.failPrepare = false;
      throw new Error("fake: git could not prepare the work branch");
    }
    this.events.push(`prepare:end:${number}`);
    return {
      repoDir: `/clones/${work.destination.repo.replaceAll("/", "#")}`,
      branch: workBranchName(number),
      baseBranch: "main",
      branchCreated: !this.branchReused,
      branchOnOrigin: false,
    };
  }

  async cleanupDoneWorkFor(_work: WorkIdentity): Promise<void> {}

  async observeRemoteHeadFor(_work: WorkIdentity): Promise<string | null> {
    return null;
  }

  async diffWorkFor(_work: WorkIdentity): Promise<string> {
    return "";
  }

  async inspectLocalWorkFor(_work: WorkIdentity): Promise<LocalWorkFacts> {
    return { headSha: null, commits: 0, uncommitted: false, operationInProgress: null };
  }
}

/** The tracker with the claim swap of the launch made observable in order. */
class ProbeTracker extends FakeTrackerAdapter {
  /** Whether the reservation was already on disk when the claim landed — the
   *  safety footprint of issue 98 lands before the tracker is touched. */
  reservationAtClaim: boolean | null = null;

  constructor(
    workerAccount: string,
    private readonly events: string[],
    private readonly dir: string,
  ) {
    super({ workerAccount });
  }

  override async claimTicket(ticket: TicketIdentity, account: string, readyLabel?: string): Promise<WriteOutcome> {
    this.events.push("claim");
    this.reservationAtClaim = existsSync(join(this.dir, "reserva.json"));
    return super.claimTicket(ticket, account, readyLabel);
  }

  override async resumeTicketClaim(ticket: TicketIdentity, labels: Labels): Promise<WriteOutcome> {
    this.events.push("resume");
    return super.resumeTicketClaim(ticket, labels);
  }

  override async reopenPullRequest(target: Parameters<FakeTrackerAdapter["reopenPullRequest"]>[0]): Promise<WriteOutcome> {
    this.events.push("reopen");
    return super.reopenPullRequest(target);
  }
}

/** A runtime whose session dies before it starts: the launch fails after the
 *  claim, and nothing is collected. */
class FailingRuntime implements WorkerRuntime {
  readonly requests: WorkRequest[] = [];

  async launch(request: WorkRequest): Promise<never> {
    this.requests.push(request);
    throw new Error("fake: the worker never started");
  }

  requestStop(): void {}

  async forceStop(): Promise<void> {}
}

/** What the pipeline asked the cycle for, in order. */
interface Calls {
  announced: Array<{ key: string; resulting: string | null }>;
  launched: string[];
  collected: Array<{ key: string; attempt: number; outcome: string }>;
  cancelled: Array<{ key: string; attempt: number }>;
  pauses: string[];
}

interface Harness {
  launch: Launch;
  tracker: ProbeTracker;
  runtime: FakeWorkerRuntime;
  git: ProbeGit;
  layout: WorkspaceLayout;
  logs: string[];
  events: string[];
  calls: Calls;
}

interface HarnessOptions {
  /** The scripted outcomes of the fake runtime, in launch order. */
  outcomes?: ScriptedOutcome[];
  /** The issues seeded ready for a claim. */
  issues?: number[];
  /** A runtime replacing the fake one (a session that dies before it starts). */
  runtime?: WorkerRuntime;
  /** A cycle duty the test overrides (the collection, the stop, ...). */
  cycle?: Partial<LaunchCycle>;
}

function configOf(layout: WorkspaceLayout): Config {
  return {
    workerGhAccount: "bot-do-samuca",
    workerModel: "opencode-go/glm-3.5-flash",
    jira: [],
    repos: [REPO],
    concurrency: 2,
    workspace: layout.root,
    labels: { ...DEFAULT_LABELS },
    recovery: { ...DEFAULT_RECOVERY_BUDGET },
    modelProvider: { ...DEFAULT_MODEL_PROVIDER_BUDGET },
    liveness: { ...DEFAULT_LIVENESS_POLICY },
    notifications: false,
    workerAuthFile: null,
    configPath: join(layout.root, "msf.yaml"),
  };
}

/** The prepare steps of the git host, in order — the launch's only git write path. */
function prepares(h: Harness): string[] {
  return h.git.events.filter((event) => event.startsWith("prepare:"));
}

/** Poll until `condition` holds; the timeout names what was waited for. */
async function waitFor(condition: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("the launch — the pipeline from the claim to the collected end", () => {
  let root: string;
  let layout: WorkspaceLayout;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "msf-launch-"));
    layout = ensureWorkspace(join(root, "ws"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeHarness(options: HarnessOptions = {}): Harness {
    const logs: string[] = [];
    const events: string[] = [];
    const calls: Calls = { announced: [], launched: [], collected: [], cancelled: [], pauses: [] };
    const config = configOf(layout);
    const work = githubWork(REPO, ISSUE);
    const dir = workDir(layout, REPO, ISSUE);
    mkdirSync(dir, { recursive: true });
    const tracker = new ProbeTracker(config.workerGhAccount, events, dir);
    for (const number of options.issues ?? [ISSUE]) {
      seedIssue(tracker, { repo: REPO, number, labels: [DEFAULT_LABELS.ready], createdAt: CREATED });
    }
    const fake = new FakeWorkerRuntime({ tracker, outcomes: options.outcomes ?? ["pr-open"] });
    const git = new ProbeGit(events);
    const cycle: LaunchCycle = {
      stopping: () => false,
      stopped: new Promise<void>(() => {}),
      announce: (ref, resulting) => {
        calls.announced.push({ key: workKeyOf(ref), resulting });
      },
      cancelAdmission: async (entry, attempt) => {
        calls.cancelled.push({ key: workKeyOf(entry.work), attempt });
        return false;
      },
      launched: (result) => {
        calls.launched.push(result.outcome);
      },
      collect: async (launchable, result, attempt) => {
        calls.collected.push({
          key: workKeyOf(launchable.work),
          attempt,
          outcome: result.outcome,
        });
        return null;
      },
      pauseInterrupted: async (_ref, _dir, attempt) => {
        calls.pauses.push(`interrupted:${attempt}`);
      },
      pauseForContinuity: async (_ref, _dir, pause, attempt) => {
        calls.pauses.push(`continuity:${pause.reason}:${attempt}`);
      },
      settleModelProviderFailure: async () => {
        throw new Error("no model provider failure was scripted");
      },
      inspectLocalWork: async () => null,
      observeRemote: async () => ({ known: false }),
      ...options.cycle,
    };
    return {
      launch: openLaunch({
        config,
        tickets: tracker,
        pullRequests: tracker,
        runtime: options.runtime ?? fake,
        git,
        workspace: layout,
        log: (message) => logs.push(message),
        wait: async () => {},
        cycle,
      }),
      tracker,
      runtime: fake,
      git,
      layout,
      logs,
      events,
      calls,
    };
  }

  function claimable(work: WorkIdentity, dir: string): Launchable {
    return { work, dir, kind: "claim", createdAt: CREATED, pr: null };
  }

  test("a claim reserves, claims and prepares before the worker, then collects the end", async () => {
    const h = makeHarness();
    const work = githubWork(REPO, ISSUE);
    const dir = workDir(h.layout, REPO, ISSUE);

    const next = await h.launch.attempt(claimable(work, dir));

    assert.equal(next, null, "a collected end that asks for nothing continues nothing");
    assert.equal(h.tracker.reservationAtClaim, true, "the reservation lands before the tracker is touched");
    assert.deepEqual(h.events, ["claim", "prepare:start:7", "prepare:end:7"]);
    assert.deepEqual(
      h.tracker.claimedOrder,
      [`${REPO}#${ISSUE}`],
      "the claim is the one the pipeline made, once",
    );
    const issue = await h.tracker.readIssue({ repo: REPO, number: ISSUE });
    assert.ok(issue.known);
    assert.ok(issue.value.labels.includes(DEFAULT_LABELS.claimed), "the work is claimed");
    assert.ok(!issue.value.labels.includes(DEFAULT_LABELS.ready), "the pool label left with the claim");

    assert.equal(h.runtime.launched.length, 1, "one worker for one claim");
    const request = h.runtime.launched[0]!;
    assert.equal(request.attempt, 1, "a bare reservation is attempt 1");
    assert.equal(request.branch, workBranchName(ISSUE), "the branch prepare revealed");
    assert.equal(request.baseBranch, "main");
    assert.equal(request.repoDir, `/clones/${REPO.replaceAll("/", "#")}`);
    assert.equal(request.workDir, dir);
    assert.equal(request.material.ticket.title, `issue #${ISSUE}`, "the material carries the ticket");

    assert.deepEqual(h.calls.launched, ["pr-open"], "the sweep reports the worker it launched");
    assert.deepEqual(
      h.calls.collected,
      [{ key: `${REPO}#${ISSUE}`, attempt: 1, outcome: "pr-open" }],
      "the end is collected with the attempt the registry numbered",
    );
    assert.deepEqual(h.calls.announced, [{ key: `${REPO}#${ISSUE}`, resulting: "reserved" }]);
    assert.ok(
      h.logs.some((line) => line.startsWith(`claiming ${REPO}#${ISSUE} (`)),
      `the claim is announced; saw: ${h.logs.join(" | ")}`,
    );
    assert.ok(
      h.logs.some((line) => line.includes(`launching worker for ${REPO}#${ISSUE} (branch ${workBranchName(ISSUE)}, created from base main)`)),
      `the launch is announced; saw: ${h.logs.join(" | ")}`,
    );
  });

  test("a resume swaps blocked→claimed on the tracker and reuses the same branch and PR", async () => {
    const h = makeHarness();
    const work = githubWork(REPO, ISSUE);
    const dir = workDir(h.layout, REPO, ISSUE);
    h.git.branchReused = true;
    h.tracker.seedPullRequest({ repo: REPO, number: 11, state: "closed" });
    const closed = withPullRequestIdentity(
      {
        number: 11,
        state: "closed",
        merged: false,
        headBranch: workBranchName(ISSUE),
        baseBranch: "main",
        author: "bot-do-samuca",
      },
      githubRepository(REPO),
    );
    seedIssue(h.tracker, { repo: REPO, number: ISSUE, labels: [DEFAULT_LABELS.blocked], createdAt: CREATED });

    const next = await h.launch.attempt({ work, dir, kind: "resume", createdAt: CREATED, pr: closed });

    assert.equal(next, null);
    assert.deepEqual(
      h.events,
      ["resume", "reopen", "prepare:start:7", "prepare:end:7"],
      "no claim: the retomada swaps the label and reopens the PR before preparing",
    );
    const issue = await h.tracker.readIssue({ repo: REPO, number: ISSUE });
    assert.ok(issue.known);
    assert.ok(issue.value.labels.includes(DEFAULT_LABELS.claimed), "the claim is held again");
    assert.ok(!issue.value.labels.includes(DEFAULT_LABELS.blocked), "the blocked mark left with the answer");
    assert.ok(h.events.includes("reopen"), "the rejection's retomada reopens the SAME PR");
    assert.equal(h.runtime.launched[0]?.branch, workBranchName(ISSUE), "the same branch, never a new one");
    assert.ok(
      h.logs.some((line) => line.startsWith(`resuming ${REPO}#${ISSUE}: a human answered after the marker`)),
      `the resume is announced; saw: ${h.logs.join(" | ")}`,
    );
    assert.ok(
      h.logs.some((line) => line.includes("(branch agent-issue-7, reused from base main)")),
      `the reuse is announced; saw: ${h.logs.join(" | ")}`,
    );
  });

  test("a human answer WRITES the fall-count reset, so both readings agree the next fall releases (ticket 14)", async () => {
    // Attempts 1 and 2 both fell: the 2nd blocked, and `recordFailure` left the
    // consecutive count in the ledger (`lastFallAttempt`). The human answered, so
    // the resume launches attempt 3.
    const h = makeHarness({ outcomes: ["clean-without-pr"] });
    const work = githubWork(REPO, ISSUE);
    const dir = workDir(h.layout, REPO, ISSUE);
    mkdirSync(dir, { recursive: true });
    const fell: OutcomeRecord = { class: "clean-without-pr", attempt: 2 };
    writeFileSync(join(dir, DESFECHO_FILENAME), JSON.stringify(fell), "utf8");
    appendAttemptEvent(dir, 1, { event: "session-start" });
    appendAttemptEvent(dir, 2, { event: "session-start" });
    await recordFailure(dir, 2, "clean-without-pr", () => new Date("2026-01-01T00:00:00Z"));
    seedIssue(h.tracker, { repo: REPO, number: ISSUE, labels: [DEFAULT_LABELS.blocked], createdAt: CREATED });

    // The fact both readings start from: the previous attempt fell.
    assert.deepEqual(await readLaunchFacts(dir), { attempt: 3, previousFall: true });
    assert.equal((await readRecoveryLedger(dir))?.lastFallAttempt, 2, "the ledger counts the 2nd fall");

    const next = await h.launch.attempt({ work, dir, kind: "resume", createdAt: CREATED, pr: null });
    assert.equal(next, null);

    // The reset is the RECORD's fact, not a launch's memory: the answer is over,
    // so the count is gone from disk and survives the sweep that reads it next.
    assert.equal(
      (await readRecoveryLedger(dir))?.lastFallAttempt,
      null,
      "the human's answer restarts the count in the ledger (an in-memory flag would be lost)",
    );

    // And the collection reading — the one a survivor end or the next sweep uses,
    // which reads the ledger and never a launch's memory — agrees: attempt 3's
    // written failure is the 1st of a FRESH count, so it releases. Reading the
    // stale ledger instead is exactly how the two readings used to disagree.
    const state = openWorkState({
      tickets: h.tracker,
      pullRequests: h.tracker,
      workspace: h.layout,
      labels: configOf(h.layout).labels,
      workerAccount: configOf(h.layout).workerGhAccount,
      recovery: configOf(h.layout).recovery,
      modelProvider: configOf(h.layout).modelProvider,
      inFlight: new Set<string>(),
    });
    const reading = await state.afterAttempt({ work, dir, attempt: 3, stopping: false });
    assert.equal(reading.state, "fall");
    assert.equal(reading.state === "fall" ? reading.decision : null, "release", "the reset count releases");
  });

    test("a prepare that fails rejects the admission and launches nothing", async () => {
    const h = makeHarness();
    const work = githubWork(REPO, ISSUE);
    const dir = workDir(h.layout, REPO, ISSUE);
    h.git.failPrepare = true;

    await assert.rejects(h.launch.attempt(claimable(work, dir)), /could not prepare the work branch/);

    assert.equal(h.runtime.launched.length, 0, "no worker starts without the prepared branch");
    assert.deepEqual(h.calls.launched, [], "nothing is reported as launched");
    assert.deepEqual(h.calls.collected, [], "there is no end to collect");
    assert.ok(
      h.tracker.claimedOrder.includes(`${REPO}#${ISSUE}`),
      "the claim that landed before the failure stays — the next sweep reconciles it",
    );
  });

  test("a runtime that never starts rejects the admission and collects nothing", async () => {
    const runtime = new FailingRuntime();
    const h = makeHarness({ runtime });
    const work = githubWork(REPO, ISSUE);
    const dir = workDir(h.layout, REPO, ISSUE);

    await assert.rejects(h.launch.attempt(claimable(work, dir)), /the worker never started/);

    assert.equal(runtime.requests.length, 1, "the worker was asked for once");
    assert.equal(runtime.requests[0]?.attempt, 1);
    assert.deepEqual(h.calls.launched, [], "a worker that never started is not a launch");
    assert.deepEqual(h.calls.collected, [], "a worker that never started has no end to collect");
  });

  test("a collection that fails rejects the admission after the launch was reported", async () => {
    const failure = new Error("fake: the verdict could not be applied");
    const h = makeHarness({
      cycle: {
        collect: async () => {
          throw failure;
        },
      },
    });
    const work = githubWork(REPO, ISSUE);
    const dir = workDir(h.layout, REPO, ISSUE);

    await assert.rejects(h.launch.attempt(claimable(work, dir)), (error: unknown) => error === failure);

    assert.deepEqual(
      h.calls.launched,
      ["pr-open"],
      "the worker ran and is reported: the failure is the collection's, never a lost launch",
    );
    assert.deepEqual(h.launch.admissions(), [], "the admission no longer holds the work after its end");
    assert.equal(h.launch.carries(`${REPO}#${ISSUE}`), false);
  });

  test("the attempt the collection asks to continue is returned to the caller", async () => {
    const work = githubWork(REPO, ISSUE);
    const dir = workDir(layout, REPO, ISSUE);
    const continuation: Launchable = {
      work,
      dir,
      kind: "recover",
      createdAt: null,
      pr: null,
      attempt: 1,
    };
    const h = makeHarness({ cycle: { collect: async () => continuation } });

    const next = await h.launch.attempt(claimable(work, dir));

    assert.equal(next, continuation, "the same attempt is handed back for the same held slot");
  });

  test("the admission is visible to the stop while the worker runs, and gone when it ends", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = makeHarness();
    h.runtime.hold = async () => held;
    const work = githubWork(REPO, ISSUE);
    const dir = workDir(h.layout, REPO, ISSUE);

    const running = h.launch.attempt(claimable(work, dir));
    await waitFor(() => h.runtime.launched.length === 1, "the worker to be launched");

    const admissions = h.launch.admissions();
    assert.equal(admissions.length, 1, "the stop sees the admission that may carry a worker");
    assert.equal(workKeyOf(admissions[0]!.work), `${REPO}#${ISSUE}`);
    assert.equal(admissions[0]!.dir, dir);
    assert.equal(admissions[0]!.launched, true, "the worker really started");
    assert.equal(h.launch.carries(`${REPO}#${ISSUE}`), true);

    release();
    await running;

    assert.deepEqual(h.launch.admissions(), [], "a settled admission is no longer the stop's business");
    assert.equal(h.launch.carries(`${REPO}#${ISSUE}`), false);
  });

  test("two launches of one repository never interleave their prepare", async () => {
    const h = makeHarness({ issues: [ISSUE, OTHER], outcomes: ["pr-open", "pr-open"] });
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    h.git.gates.set(ISSUE, () => firstHeld);
    const first = claimable(githubWork(REPO, ISSUE), workDir(h.layout, REPO, ISSUE));
    const second = claimable(githubWork(REPO, OTHER), workDir(h.layout, REPO, OTHER));

    const runs = [h.launch.attempt(first), h.launch.attempt(second)];
    await waitFor(() => h.git.events.includes("prepare:start:7"), "the first prepare to start");
    // The second admission had every chance to reach prepare by now: it is
    // waiting on the first one, inside the same repository's clone.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(prepares(h), ["prepare:start:7"], "the second prepare of the repo waits its turn");

    releaseFirst();
    await Promise.all(runs);

    assert.deepEqual(
      prepares(h),
      ["prepare:start:7", "prepare:end:7", "prepare:start:8", "prepare:end:8"],
      "the prepares of one repository run one at a time, in arrival order",
    );
    assert.equal(h.runtime.launched.length, 2, "the launches themselves still ran");
  });
});
