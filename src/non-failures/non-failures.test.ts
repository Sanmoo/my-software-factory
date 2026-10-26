import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import {
  DEFAULT_LABELS,
  DEFAULT_MODEL_PROVIDER_BUDGET,
  DEFAULT_RECOVERY_BUDGET,
  DEFAULT_RETRO,
  type Config,
  type Labels,
  type ModelProviderBudget,
} from "../config.js";
import { githubWork } from "../e2e/work-fixtures.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { AGENT_MARKER, pauseMarker } from "../tracker/port.js";
import type { WorkIdentity } from "../tracker/identity.js";
import type { RecheckResult } from "../runtime/continuity.js";
import { PAUSE_FILENAME, readPause, writePause, type PauseRecord } from "../work-record/continuity.js";
import { MODEL_PROVIDER_FILENAME, readModelProviderLedger } from "../work-record/model-provider.js";
import type { ModelProviderFailure } from "../work-record/model-provider-error.js";
import { RECOVERY_FILENAME } from "../work-record/recovery.js";
import { eventLogName } from "../work-record/logs.js";
import { openNonFailures, type NonFailureDeps, type NonFailures } from "./non-failures.js";

/**
 * The two endings that are not a failure, at their own seam: the **Continuity
 * pause** and the **model provider failure** through
 * {@link NonFailures}, with an INJECTED evidence read and FAKE ports — no
 * factory, no launch, no Docker.
 *
 * What the module asks the cycle for (block and ask, hold and ask, re-assert the
 * block, unblock the claim, whether a worker may be alive) is a recording port,
 * so a test sees exactly what was asked and how many times. Every "asks once"
 * rule below is proven the same way: the same world is swept several times and
 * the request is counted on the tracker.
 */

const REPO = "Sanmoo/my-tasks";
const NOW = "2026-01-01T00:00:00Z";
const FAILURE: ModelProviderFailure = {
  message: "429: Endpoint is unavailable",
  identity: "2026-01-01T00:00:00.000Z",
};

/** One ask the module made of the cycle, in order. */
interface Ask {
  kind: "block" | "hold";
  comment: string;
}

interface World {
  root: string;
  workspace: WorkspaceLayout;
  dir: string;
  work: WorkIdentity;
  tracker: FakeTrackerAdapter;
  log: string[];
  asks: Ask[];
  reasserted: number;
  unblocked: number;
  /** The pauses the module actually re-read, in order. */
  rechecks: PauseRecord[];
  module: NonFailures;
  labels: Labels;
  /** Steer what the next evidence read answers. */
  setEvidence(next: RecheckResult): void;
  /** Persist a pause and hand back the record the reading would give. */
  pause(overrides?: Partial<PauseRecord>): PauseRecord;
  comments(): Promise<string[]>;
  close(): void;
}

/** The world the tests steer: the disk of one Work, the tracker, the evidence
 *  the module re-reads, and whether a worker of the Work may still be alive. */
function world(
  options: {
    budget?: ModelProviderBudget;
    alive?: boolean;
    evidence?: RecheckResult | ((pause: PauseRecord) => RecheckResult);
  } = {},
): World {
  const root = mkdtempSync(join(tmpdir(), "msf-non-failures-"));
  const workspace = ensureWorkspace(root);
  const work = githubWork(REPO, 1);
  const dir = workDir(workspace, REPO, 1);
  // The reservation would have created it; the module only writes inside it.
  mkdirSync(dir, { recursive: true });
  const tracker = new FakeTrackerAdapter({ workerAccount: "bot" });
  seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.claimed] });

  const config: Config = {
    workerGhAccount: "bot",
    workerModel: "opencode-go/glm-5.3-flash",
    jira: [],
    repos: [REPO],
    concurrency: 1,
    workspace: workspace.root,
    labels: { ...DEFAULT_LABELS },
    recovery: { ...DEFAULT_RECOVERY_BUDGET },
    modelProvider: { ...(options.budget ?? DEFAULT_MODEL_PROVIDER_BUDGET) },
    retro: { ...DEFAULT_RETRO },
    liveness: { unavailableWarnMs: 60_000 },
    notifications: true,
    workerAuthFile: null,
    configPath: join(root, "msf.yaml"),
  };

  let evidence: RecheckResult | ((pause: PauseRecord) => RecheckResult) =
    options.evidence ?? { resolved: false, pause: null };
  const log: string[] = [];
  const asks: Ask[] = [];
  // The cycle's clock, injected: the settlement is written with it.
  const clock = () => new Date("2026-01-01T00:00:00Z");
  let reasserted = 0;
  let unblocked = 0;
  const rechecks: PauseRecord[] = [];

  const deps: NonFailureDeps = {
    config,
    tickets: tracker,
    pullRequests: tracker,
    workspace,
    log: (line) => log.push(line),
    now: clock,
    recheckEvidence: async (_work, _dir, _attempt, pause) => {
      rechecks.push(pause);
      return typeof evidence === "function" ? evidence(pause) : evidence;
    },
    cycle: {
      // The engine's own writes, recorded: the block (label + marked comment)
      // and the hold (claim + marked comment) with the notice the port owns.
      blockAndAsk: async (target, comment) => {
        asks.push({ kind: "block", comment });
        await tracker.blockTicketClaim(target.ticket, config.labels);
        await tracker.commentOnTicket(target.ticket, comment);
      },
      holdAndAsk: async (target, comment) => {
        asks.push({ kind: "hold", comment });
        await tracker.claimTicket(target.ticket, config.workerGhAccount, config.labels.ready);
        await tracker.commentOnTicket(target.ticket, comment);
      },
      reassertBlock: async (target) => {
        reasserted += 1;
        await tracker.blockTicketClaim(target.ticket, config.labels);
      },
      unblock: async (target) => {
        unblocked += 1;
        await tracker.resumeTicketClaim(target.ticket, config.labels);
      },
      workerMayBeAlive: () => options.alive === true,
    },
  };

  return {
    root,
    workspace,
    dir,
    work,
    tracker,
    log,
    asks,
    get reasserted() {
      return reasserted;
    },
    get unblocked() {
      return unblocked;
    },
    rechecks,
    module: openNonFailures(deps),
    labels: config.labels,
    setEvidence: (next) => {
      evidence = next;
    },
    pause: (overrides = {}) => {
      // A pause as the factory persists it BEFORE its request landed.
      const record: PauseRecord = {
        version: 1,
        work,
        attempt: 1,
        reason: "effect-ambiguous",
        detail: "the push may have landed: the remote could not be read",
        at: NOW,
        ...overrides,
      };
      writePause(dir, record);
      return readPause(dir)!;
    },
    comments: async () => {
      const comments = await tracker.readComments({ repo: REPO, number: 1 });
      assert.ok(comments.known, "the fake tracker answers");
      return comments.value.map((comment) => comment.body);
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  } as World;
}

/** The moment the injected clock reads. */
const clockTime = (): string => "2026-01-01T00:00:00.000Z";

/** The factory's comments about the Work (every one carries the agent marker). */
const agentAsks = (bodies: readonly string[]): string[] =>
  bodies.filter((body) => body.includes(AGENT_MARKER));

/** The diagnostic lines the module said about the pause. */
const pausedLines = (log: readonly string[]): string[] =>
  log.filter((line) => line.includes("continuity of") && line.includes("paused ("));

describe("the continuity pause — resolved by evidence, or waiting for the operator", () => {
  let w: World;
  afterEach(() => w?.close());

  test("reliable evidence clears the pause and continues the SAME attempt — no human answer needed", async () => {
    w = world({ evidence: { resolved: true, pause: null } });
    const pause = w.pause();

    const verdict = await w.module.recheckPause(w.work, w.dir, pause, 1);

    assert.equal(verdict.kind, "continue", "the doubt is settled: the work returns to the normal cycle");
    if (verdict.kind !== "continue") assert.fail("expected a continuation");
    assert.equal(verdict.launch.kind, "recover", "without an answer the SAME attempt continues");
    assert.equal(verdict.launch.attempt, 1, "the attempt keeps its number (no attempt is spent)");
    assert.equal(verdict.launch.createdAt, null, "a recovery waits for nothing human");
    assert.equal(verdict.launch.pr, null, "the fake tracker sees no PR — never invented");
    assert.equal(readPause(w.dir), null, "the record is closed by the same evidence");
    assert.equal(w.unblocked, 1, "the block leaves with the pause");
    assert.deepEqual(w.asks, [], "a resolved pause asks the operator nothing");
  });

  test("a human answer bound to the pause orients a NEW round instead of continuing", async () => {
    w = world({ evidence: { resolved: true, pause: null } });
    const pause = w.pause({ id: "occurrence-1", announced: true });
    w.tracker.addComment({ repo: REPO, number: 1 }, "bot", `${AGENT_MARKER} ${pauseMarker("occurrence-1")} the pause`);
    w.tracker.addComment({ repo: REPO, number: 1 }, "operator", "the push landed, go on");

    const verdict = await w.module.recheckPause(w.work, w.dir, pause, 1);

    if (verdict.kind !== "continue") assert.fail("expected a continuation");
    assert.equal(verdict.launch.kind, "resume", "an answer orients a NEW round");
    assert.equal(verdict.launch.createdAt, pause.at, "the new round keeps the moment the pause started");
    assert.deepEqual(
      verdict.launch.issueReplies?.map((reply) => reply.body),
      ["the push landed, go on"],
      "only the answer bound to this pause's request orients it",
    );
    assert.equal(readPause(w.dir), null, "the record is closed");
    assert.equal(w.unblocked, 0, "the resume launch swaps blocked→claimed itself");
  });

  test("an unresolved pause blocks the ticket and asks for help exactly once across sweeps", async () => {
    w = world();
    let pause = w.pause();

    const first = await w.module.recheckPause(w.work, w.dir, pause, 1);
    assert.equal(first.kind, "waiting", "no evidence, no launch");
    assert.equal(w.asks.length, 1, "the operator is asked");
    assert.equal(w.asks[0]!.kind, "block", "an unresolved pause BLOCKS the ticket");
    assert.match(w.asks[0]!.comment, /cannot be continued safely/, "the comment names the doubt");
    assert.equal(readPause(w.dir)?.announced, true, "the record says the request landed");

    // The next sweeps re-read the SAME record from disk, as the reading would.
    for (let sweep = 0; sweep < 3; sweep += 1) {
      pause = readPause(w.dir)!;
      const again = await w.module.recheckPause(w.work, w.dir, pause, 1);
      assert.equal(again.kind, "waiting", `sweep ${sweep + 2}: no launch`);
    }

    assert.equal(w.asks.length, 1, "the question is never repeated");
    assert.equal(agentAsks(await w.comments()).length, 1, "exactly one factory comment on the issue");
    assert.equal(pausedLines(w.log).length, 1, "and the diagnosis is said once, not once per sweep");
    assert.equal(readPause(w.dir)?.id, pause.id, "the occurrence keeps its identity");
  });

  test("a changed cause is a new fact: asked once again, on the same occurrence", async () => {
    w = world({ evidence: { resolved: false, pause: null } });
    const pause = w.pause({ id: "occurrence-7", announced: true });

    // A steady cause, already announced: no second request, only the record.
    const steady = await w.module.recheckPause(w.work, w.dir, pause, 1);
    assert.equal(steady.kind, "waiting");
    assert.deepEqual(w.asks, [], "the announced cause is not asked again");

    // The evidence moved to another doubt: a new fact the operator must see.
    w.setEvidence({
      resolved: false,
      pause: {
        version: 1,
        work: w.work,
        attempt: 1,
        reason: "session-unreadable",
        detail: "the session cannot be read now",
        at: NOW,
      },
    });
    await w.module.recheckPause(w.work, w.dir, readPause(w.dir)!, 1);
    assert.equal(w.asks.length, 1, "the changed cause is told");

    const rewritten = readPause(w.dir)!;
    assert.equal(rewritten.reason, "session-unreadable", "the record names the cause THIS read found");
    assert.equal(rewritten.id, "occurrence-7", "a changed cause keeps the occurrence's identity ");
    assert.equal(rewritten.at, NOW, "and the moment the operator was asked");

    const again = await w.module.recheckPause(w.work, w.dir, readPause(w.dir)!, 1);
    assert.equal(again.kind, "waiting");
    assert.equal(w.asks.length, 1, "the new cause was told once, not once per sweep");
  });

  test("an unreadable pause record is never read as its absence", async () => {
    w = world();
    writeFileSync(join(w.dir, PAUSE_FILENAME), "{not a pause", "utf8");
    const unreadable = readPause(w.dir);
    assert.equal(unreadable?.reason, "record-unreadable", "the record's doubt is what the reading reports");

    const verdict = await w.module.recheckPause(w.work, w.dir, unreadable!, 4);

    assert.equal(verdict.kind, "waiting", "an unreadable record never resolves into a recovery");
    assert.deepEqual(w.rechecks, [], "the doubt IS the record: it is not re-read as evidence");
    assert.equal(w.asks.length, 1, "the operator is told once");
    const written = readPause(w.dir)!;
    assert.equal(written.reason, "record-unreadable", "the doubt is preserved as itself");
    assert.equal(written.attempt, 4, "the attempt the factory knows is named, not a fabricated zero");
    assert.deepEqual(written.work, w.work, "and the Work it belongs to");
    assert.equal(written.announced, true, "the request landed");
    assert.equal(existsSync(join(w.dir, `${PAUSE_FILENAME}.unreadable`)), true, "the unreadable original is preserved");
  });

  test("a worker of the work may still be alive: the pause is not re-evaluated and nothing is written", async () => {
    w = world({ alive: true, evidence: { resolved: true, pause: null } });
    const pause = w.pause({ id: "occurrence-9" });

    const verdict = await w.module.recheckPause(w.work, w.dir, pause, 1);

    assert.equal(verdict.kind, "waiting");
    assert.deepEqual(w.rechecks, [], "no evidence is read while a substitute could be launched over a worker");
    assert.deepEqual(w.asks, [], "nothing is asked again");
    assert.deepEqual(readPause(w.dir), pause, "the record is untouched");
    assert.ok(
      w.log.some((line) => line.includes("may still be alive")),
      "the operator's log says why the pause is not re-evaluated",
    );
  });

  test("a resume the launcher refused persists the pause and asks once — never a second request", async () => {
    w = world();
    const refused = {
      version: 1 as const,
      work: w.work,
      attempt: 2,
      reason: "effect-unsupported" as const,
      detail: "still ambiguous",
      at: NOW,
    };

    await w.module.askForContinuity(w.work, w.dir, refused, 2);
    await w.module.askForContinuity(w.work, w.dir, readPause(w.dir)!, 2);

    assert.equal(w.asks.length, 1, "the launch path and the next sweep ask one question");
    assert.equal(w.asks[0]!.kind, "block");
    assert.equal(agentAsks(await w.comments()).length, 1);
    assert.equal(w.reasserted, 1, "the block is re-asserted, the comment is not repeated");
  });
});

describe("the model provider failure — its own budget, its own backoff", () => {
  let w: World;
  afterEach(() => w?.close());

  test("a failure retries on the configured backoff, continuing the SAME attempt", async () => {
    w = world({ budget: { maxRetries: 2, waitsMs: [15_000, 30_000] } });

    const first = await w.module.settleModelProvider(w.work, w.dir, 1, FAILURE);
    assert.equal(first.decision, "retry");
    assert.equal(first.decision === "retry" && first.waitMs, 15_000, "the first wait of the schedule");
    assert.equal(first.decision === "retry" && first.consumed, 1);

    const second = await w.module.settleModelProvider(w.work, w.dir, 1, { ...FAILURE, identity: "later" });
    assert.equal(second.decision === "retry" && second.waitMs, 30_000, "the schedule advances, never restarts");

    const ledger = await readModelProviderLedger(w.dir);
    assert.equal(ledger.consumed, 2, "the count is persisted on the Work's record");
    assert.deepEqual(ledger.events.map((event) => event.waitMs), [15_000, 30_000]);
    assert.deepEqual(
      ledger.events.map((event) => event.at),
      [clockTime(), clockTime()],
      "each retry is written with the cycle's clock, not the machine's",
    );

    const events = readFileSync(join(w.dir, eventLogName(1)), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      events.map((event) => event["event"]),
      ["model-provider-failure", "model-provider-retry", "model-provider-failure", "model-provider-retry"],
      "each failure and each granted retry is in the attempt's own log",
    );
    assert.deepEqual(w.asks, [], "a granted retry asks the operator nothing");
  });

  test("settling the same failure twice never spends a second retry", async () => {
    w = world({ budget: { maxRetries: 3, waitsMs: [1_000] } });

    await w.module.settleModelProvider(w.work, w.dir, 1, FAILURE);
    const again = await w.module.settleModelProvider(w.work, w.dir, 1, FAILURE);

    assert.equal(again.decision === "retry" && again.consumed, 1, "the failure's own identity is the settlement");
    assert.equal((await readModelProviderLedger(w.dir)).consumed, 1);
  });

  test("an exhausted budget awaits the model provider: a help request, never a block", async () => {
    w = world({ budget: { maxRetries: 1, waitsMs: [15_000] } });
    await w.module.settleModelProvider(w.work, w.dir, 1, FAILURE);

    const exhausted = await w.module.settleModelProvider(w.work, w.dir, 1, { ...FAILURE, identity: "second" });

    assert.equal(exhausted.decision, "awaiting-model-provider");
    assert.match(
      exhausted.decision === "awaiting-model-provider" ? exhausted.reason : "",
      /model provider budget is exhausted/,
    );
    assert.equal(w.asks.length, 1, "the operator is asked");
    assert.equal(w.asks[0]!.kind, "hold", "an exhausted provider budget HOLDS the claim — it never blocks");
    assert.match(w.asks[0]!.comment, /model provider budget is exhausted/);
    assert.match(w.asks[0]!.comment, /NOT blocked and no attempt was consumed/);
    assert.match(w.asks[0]!.comment, /429: Endpoint is unavailable/, "the provider's own message is named");

    assert.equal(agentAsks(await w.comments()).length, 1, "exactly one help request");

    // A sweep that sees the same settled failure asks nothing again.
    await w.module.settleModelProvider(w.work, w.dir, 1, { ...FAILURE, identity: "second" });
    assert.equal(w.asks.length, 1, "the request is never repeated");

    const ledger = await readModelProviderLedger(w.dir);
    assert.equal(ledger.consumed, 1, "an exhausted budget is never consumed further");
    assert.equal(ledger.last?.granted, false, "the failure is settled as awaiting");
  });

  test("a death between the ledger and the comment leaves the request unposted — the next sweep asks", async () => {
    w = world({ budget: { maxRetries: 1, waitsMs: [15_000] } });
    // The factory consumed the retry and wrote the awaiting settlement, then died
    // before the comment: the ledger says awaiting, `helpRequested` is false.
    const { settleModelProviderFailure } = await import("../pool/model-provider.js");
    await settleModelProviderFailure(w.dir, { maxRetries: 1, waitsMs: [15_000] }, 1, FAILURE);
    await settleModelProviderFailure(w.dir, { maxRetries: 1, waitsMs: [15_000] }, 1, {
      ...FAILURE,
      identity: "awaiting",
    });
    assert.equal((await readModelProviderLedger(w.dir)).last?.granted, false);

    await w.module.settleModelProvider(w.work, w.dir, 1, { ...FAILURE, identity: "awaiting" });

    assert.equal(w.asks.length, 1, "the request the death prevented is posted now");
    const settled = (await readModelProviderLedger(w.dir)).last;
    assert.equal(settled?.granted === false ? settled.helpRequested : null, true, "the request is marked as posted");
  });

  test("the provider budget and the recovery budget never spend each other", async () => {
    w = world({ budget: { maxRetries: 2, waitsMs: [15_000, 30_000] } });
    // An interruption already exhausted the recovery allowance of this attempt.
    const recoveryFile = join(w.dir, RECOVERY_FILENAME);
    writeFileSync(
      recoveryFile,
      JSON.stringify({
        attempt: 1,
        consumed: DEFAULT_RECOVERY_BUDGET.maxRecoveries,
        events: [],
        lastStop: null,
        lastFallAttempt: null,
      }),
      "utf8",
    );
    const recoveryBefore = readFileSync(recoveryFile, "utf8");

    const first = await w.module.settleModelProvider(w.work, w.dir, 1, FAILURE);
    assert.equal(first.decision === "retry" && first.waitMs, 15_000, "an exhausted recovery never spends the provider's retry");
    assert.equal(
      readFileSync(recoveryFile, "utf8"),
      recoveryBefore,
      "a retry writes nothing to the recovery ledger",
    );

    await w.module.settleModelProvider(w.work, w.dir, 1, { ...FAILURE, identity: "second" });
    const exhausted = await w.module.settleModelProvider(w.work, w.dir, 1, { ...FAILURE, identity: "third" });
    assert.equal(exhausted.decision, "awaiting-model-provider");
    assert.equal(
      readFileSync(recoveryFile, "utf8"),
      recoveryBefore,
      "an exhausted provider budget leaves the recovery allowance exactly as it was",
    );
    assert.equal(
      existsSync(join(w.dir, PAUSE_FILENAME)),
      false,
      "awaiting the model provider is not a continuity pause and not a block",
    );
  });

  test("an unreadable provider ledger is the honest initial state — nothing invented, nothing spent elsewhere", async () => {
    w = world({ budget: { maxRetries: 3, waitsMs: [10, 20, 30] } });
    writeFileSync(join(w.dir, MODEL_PROVIDER_FILENAME), "{not a ledger", "utf8");

    const verdict = await w.module.settleModelProvider(w.work, w.dir, 1, FAILURE);

    assert.equal(verdict.decision === "retry" && verdict.consumed, 1, "the first retry, never an invented count");
    assert.equal(verdict.decision === "retry" && verdict.waitMs, 10);
    assert.equal((await readModelProviderLedger(w.dir)).consumed, 1, "the ledger is rewritten from the honest initial state");
    assert.equal(existsSync(join(w.dir, RECOVERY_FILENAME)), false, "the recovery budget is still untouched");
  });
});
