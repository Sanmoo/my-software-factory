import { githubTicketNumber, githubWork } from "../e2e/work-fixtures.js";
import {
  githubRepository,
  jiraTicket,
  renderWorkIdentity,
  ticketUrl,
  workIdentity,
  type TicketIdentity,
} from "../tracker/identity.js";
import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { JiraTicketAdapter, type JiraTransport } from "../tracker/jira-adapter.js";
import { JiraSim, type SimJiraIssue } from "../tracker/jira-sim.js";
import type { TicketSelection, TicketSnapshot } from "../tracker/expanded-port.js";
import type { Known } from "../tracker/port.js";
import { ensureWorkspace, workDir, workDirOfKey, type WorkspaceLayout } from "../layout.js";
import {
  DEFAULT_LABELS,
  DEFAULT_LIVENESS_POLICY,
  DEFAULT_RETRO,
  DEFAULT_MODEL_PROVIDER_BUDGET,
  DEFAULT_RECOVERY_BUDGET,
  type Config,
} from "../config.js";
import { DESFECHO_FILENAME } from "../work-record/outcome.js";
import { writeRepairCycle } from "../work-record/repair.js";
import {
  consumeRecovery,
  recordFailure,
  recordStopRequest,
  recordUnconfirmedStop,
} from "../pool/recovery.js";
import { settleModelProviderFailure } from "../pool/model-provider.js";
import { appendAttemptEvent } from "../work-record/logs.js";
import { PAUSE_FILENAME, clearPause, writePause } from "../work-record/continuity.js";
import { RESERVED_STATE_READS_IN_FLIGHT, deriveStatus, type Liveness, type StatusView } from "./status.js";
import { renderStatus } from "./status-render.js";
import { fakeDocker, inspectedContainer } from "./fake-docker.js";
import { dockerWorkerProbe, type LivenessProbe, type LiveWorker } from "./liveness.js";

/**
 * `msf status`: derivation on demand through the
 * port — works with the factory stopped — plus the local registry scan and the
 * read-only liveness probe. Running and Orphaned come from Docker + disk
 * together; the overlap (outcome written, worker still alive) is shown as two
 * truths, never as a fused state.
 */

const REPO = "Sanmoo/my-tasks";

/** No live worker: the factory is stopped — the default every test starts from. */
const NO_WORKERS: LivenessProbe = () => Promise.resolve([]);

const fakeProbe =
  (...workers: LiveWorker[]): LivenessProbe =>
  () =>
    Promise.resolve(workers);

/**
 * A tracker whose ticket read is slow, so the reserved-work readings overlap
 * observably: `peakInFlight` is a fact of how many were in flight at
 * once — never of how fast this machine ran them.
 */
class SlowTicketTracker extends FakeTrackerAdapter {
  peakInFlight = 0;
  private inFlight = 0;

  constructor(private readonly delayMs: number) {
    super({ workerAccount: "bot-do-samuca" });
  }

  override async readTicket(ticket: TicketIdentity): Promise<Known<TicketSnapshot>> {
    this.inFlight += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.inFlight -= 1;
    return super.readTicket(ticket);
  }
}

/** The known liveness of a view: the tests that assert the states never expect unknown. */
function known(view: StatusView): Extract<Liveness, { state: "known" }> {
  if (view.liveness.state !== "known") assert.fail("the probe answered — liveness is known");
  return view.liveness;
}

describe("status — derivation on demand + local registry scan", () => {
  let dir: string;
  let layout: WorkspaceLayout;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-status-"));
    layout = ensureWorkspace(join(dir, "ws"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeConfig(): Config {
    return {
      workerGhAccount: "bot-do-samuca",
      workerModel: "opencode-go/glm-5.3-flash",
      jira: [],
      repos: [REPO],
      concurrency: 2,
      workspace: layout.root,
      labels: { ...DEFAULT_LABELS },
      recovery: { ...DEFAULT_RECOVERY_BUDGET },
      retro: { ...DEFAULT_RETRO },
      modelProvider: { ...DEFAULT_MODEL_PROVIDER_BUDGET },
      liveness: { ...DEFAULT_LIVENESS_POLICY },
      notifications: true,
      workerAuthFile: null,
      configPath: join(dir, "msf.yaml"),
    };
  }

  /** A work dir carrying attempt evidence: the attempt's log, no outcome record. */
  function seedAttempt(number: number, ...attempts: number[]): string {
    const target = workDir(layout, REPO, number);
    mkdirSync(target, { recursive: true });
    for (const attempt of attempts) writeFileSync(join(target, `log-${attempt}.jsonl`), "{}\n", "utf8");
    return target;
  }

  /** The tracker's side of a reserved work: an open issue carrying the claim —
   *  what the Work state reads to name the state the registry's own facts
   *  describe. A claim with a reservation on disk is not an
   *  unbacked claim, so no reconciliation line moves. */
  function claimIssue(tracker: FakeTrackerAdapter, number: number): void {
    seedIssue(tracker, { repo: REPO, number, labels: [DEFAULT_LABELS.claimed] });
  }

  test("eligible works derive on demand through the port — the factory being stopped is the default state", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedIssue(tracker, { repo: REPO, number: 1, labels: [DEFAULT_LABELS.ready] });

    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS);
    assert.deepEqual(view.pool.map((e) => githubTicketNumber(e.work.ticket)), [1]);
    assert.deepEqual(
      known(view),
      { state: "known", running: [], duplicates: [], orphaned: [] },
      "no container listed: no live worker",
    );
  });

  test("the registry view: reserved-without-attempt / attempts without an outcome / last outcome / archived", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });

    // Reserved without attempt: the claim landed, the worker has not.
    mkdirSync(workDir(layout, REPO, 1), { recursive: true });
    // An attempt on disk, no outcome record — liveness decides running vs
    // orphaned.
    seedAttempt(4, 1);
    // Last outcome: a concluded attempt.
    mkdirSync(workDir(layout, REPO, 2), { recursive: true });
    writeFileSync(
      join(workDir(layout, REPO, 2), DESFECHO_FILENAME),
      JSON.stringify({ class: "pr-open", attempt: 1 }),
      "utf8",
    );

    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS);
    assert.deepEqual(view.registry.reservedWithoutAttempt, [`${REPO}#1`], "the bare reservation is not an orphan");
    assert.deepEqual(view.registry.attemptsWithoutOwnOutcome, [
      { key: `${REPO}#4`, attempt: 1, recordedAttempt: null },
    ]);
    assert.deepEqual(
      known(view).orphaned,
      [{ key: `${REPO}#4`, attempt: 1, recordedAttempt: null }],
      "no outcome and no live worker: orphaned",
    );
    assert.equal(view.registry.lastOutcome[0]?.key, `${REPO}#2`);
    assert.equal(view.registry.lastOutcome[0]?.record.class, "pr-open");
  });

  test("a Work in two registry lists is ONE reserved Work — the grouped block counts it once", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    claimIssue(tracker, 2);
    // The overlap the registry preserves: a recorded outcome of
    // attempt 1 while attempt 2 sits on disk with no outcome of its own. Both
    // lists carry the key; the reserved block is one line per Work.
    seedAttempt(2, 1, 2);
    writeFileSync(
      join(workDir(layout, REPO, 2), DESFECHO_FILENAME),
      JSON.stringify({ class: "pr-open", attempt: 1 }),
      "utf8",
    );

    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS);
    assert.deepEqual(
      view.registry.attemptsWithoutOwnOutcome.map((entry) => entry.key),
      [`${REPO}#2`],
      "the registry keeps both facts",
    );
    assert.deepEqual(view.registry.lastOutcome.map((entry) => entry.key), [`${REPO}#2`]);
    const keys = view.reserved.map((entry) => entry.key);
    assert.deepEqual(keys, [...new Set(keys)], "no Work is read twice: the state is per Work");
    assert.deepEqual(keys, [`${REPO}#2`], "and the Work is still read — deduped, not dropped");
  });

  test("a live worker makes its work Running — the registry alone cannot say so — with its age and attempt", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedAttempt(4, 1, 2);

    const view = await deriveStatus(
      { github: tracker },
      makeConfig(),
      layout,
      fakeProbe({ key: `${REPO}#4`, containerId: "aaaa00000004", ageMs: 13 * 60_000 }),
    );

    assert.deepEqual(known(view).running, [
      { key: `${REPO}#4`, containerId: "aaaa00000004", ageMs: 13 * 60_000, attempt: 2 },
    ]);
    assert.deepEqual(known(view).orphaned, [], "a live worker is never orphaned");
    const text = renderStatus(view);
    assert.match(
      text,
      new RegExp(`running.*\\n\\s+${REPO}#4 \\(13m, attempt 2, container aaaa00000004\\)`),
    );
  });

  test("two containers of one work show as two workers and a duplicate diagnosis — never hidden by the work", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedAttempt(4, 1);

    const view = await deriveStatus(
      { github: tracker },
      makeConfig(),
      layout,
      fakeProbe(
        { key: `${REPO}#4`, containerId: "aaaa00000004", ageMs: 13 * 60_000 },
        { key: `${REPO}#4`, containerId: "bbbb00000004", ageMs: 2 * 60_000 },
      ),
    );

    const knownView = known(view);
    assert.deepEqual(knownView.duplicates, [{ key: `${REPO}#4`, containers: 2 }], "the multiplicity is a fact");
    assert.deepEqual(knownView.running.map((worker) => worker.containerId), ["aaaa00000004", "bbbb00000004"]);
    assert.deepEqual(knownView.orphaned, [], "a work with two live workers is not orphaned");
    const text = renderStatus(view);
    assert.match(text, /duplicate workers \(more than one container for the same work — a human decision is needed\): 1/);
    assert.match(text, new RegExp(`${REPO}#4 — 2 containers carry this work`), "the human sees the count");
  });

  test("a live worker of the previous image is running, not orphaned, and two of its containers are duplicates ", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    claimIssue(tracker, 6);
    seedAttempt(4, 1);
    seedAttempt(5, 1);
    seedAttempt(6, 1); // no container: a genuine orphan
    const dirOf = (number: number): string => workDir(layout, REPO, number);
    const first = "a".repeat(64);
    const second = "b".repeat(64);
    const third = "c".repeat(64);
    // `docker ps` shows the historical image as a bare ID once the tag moved:
    // the work mounts are the identity the probe reads.
    const listing = [
      `${first} ${dirOf(4)},/var/run/docker.sock`,
      `${second} ${dirOf(4)}/sessao`,
      `${third} ${dirOf(5)}`,
    ].join("\n");
    const inspect = [
      { id: first, work: 4, startedMinutesAgo: 5 },
      { id: second, work: 4, startedMinutesAgo: 3 },
      { id: third, work: 5, startedMinutesAgo: 1 },
    ].map((container) =>
      inspectedContainer(
        container.id,
        [dirOf(container.work)],
        new Date(Date.now() - container.startedMinutesAgo * 60_000).toISOString(),
      ),
    );
    const shell = fakeDocker({ listing, inspect: JSON.stringify(inspect) });
    const probe = dockerWorkerProbe({ worksRoot: layout.works, run: shell.run });

    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, probe);

    const knownView = known(view);
    assert.deepEqual(
      knownView.running.map((worker) => ({ key: worker.key, containerId: worker.containerId })),
      [
        { key: `${REPO}#4`, containerId: first },
        { key: `${REPO}#4`, containerId: second },
        { key: `${REPO}#5`, containerId: third },
      ],
      "the workers of the image the tag no longer names are still running",
    );
    assert.deepEqual(
      knownView.orphaned,
      [{ key: `${REPO}#6`, attempt: 1, recordedAttempt: null }],
      "only the attempt with no live container is orphaned",
    );
    assert.deepEqual(knownView.duplicates, [{ key: `${REPO}#4`, containers: 2 }]);
    const text = renderStatus(view);
    assert.match(text, new RegExp(`running[\\s\\S]*${REPO}#4 \\(5m, attempt 1, container ${first.slice(0, 12)}\\)`));
    assert.match(text, /duplicate workers[^\n]*: 1/);
    assert.match(text, new RegExp(`orphaned[\\s\\S]*${REPO}#6 \\(attempt 1 was interrupted`));
  });

  test("a work with an outcome written and a live worker shows in running AND last outcome — the overlap, not a fused state", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedAttempt(90, 1);
    writeFileSync(
      join(workDir(layout, REPO, 90), DESFECHO_FILENAME),
      JSON.stringify({ class: "pr-open", attempt: 1 }),
      "utf8",
    );

    const view = await deriveStatus(
      { github: tracker },
      makeConfig(),
      layout,
      fakeProbe({ key: `${REPO}#90`, containerId: "bbbb00000090", ageMs: 2 * 60_000 }),
    );

    assert.deepEqual(known(view).running.map((worker) => worker.key), [`${REPO}#90`]);
    assert.deepEqual(view.registry.lastOutcome.map((e) => e.key), [`${REPO}#90`]);
    assert.deepEqual(known(view).orphaned, []);
    const text = renderStatus(view);
    assert.match(text, new RegExp(`running[\\s\\S]*${REPO}#90 \\(2m, attempt 1, container bbbb00000090\\)[\\s\\S]*last outcome[\\s\\S]*${REPO}#90 = pr-open \\(attempt 1\\)`));
  });

  test("a live worker whose work dir is gone shows no attempt number — the registry never invents one", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    const view = await deriveStatus(
      { github: tracker },
      makeConfig(),
      layout,
      fakeProbe({ key: `${REPO}#77`, containerId: "cccc00000077", ageMs: 5 * 60_000 }),
    );

    assert.deepEqual(known(view).running, [
      { key: `${REPO}#77`, containerId: "cccc00000077", ageMs: 5 * 60_000, attempt: null },
    ]);
    const text = renderStatus(view);
    assert.match(text, new RegExp(`${REPO}#77 \\(5m, container cccc00000077\\)`));
    assert.doesNotMatch(text, /attempt 0/);
  });

  test("without Docker the status degrades: liveness unknown, the rest of the answers intact", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    claimIssue(tracker, 4);
    seedIssue(tracker, { repo: REPO, number: 1, labels: [DEFAULT_LABELS.ready] });
    seedAttempt(4, 1);
    mkdirSync(join(layout.archive, `${REPO}#3-2026-02-01`), { recursive: true });

    const unreachable: LivenessProbe = () => Promise.reject(new Error("docker: command not found"));
    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, unreachable);

    assert.deepEqual(
      view.liveness,
      { state: "unknown" },
      "unknown liveness is not a claim of zero workers, and never labels a work orphaned",
    );
    const text = renderStatus(view);
    assert.match(text, /running[^\n]*: liveness unknown \(docker not reachable\)/);
    assert.match(text, /orphaned[^\n]*: liveness unknown \(docker not reachable\)/);
    assert.match(
      text,
      new RegExp(
        `reserved work[^\\n]*: 1\\n\\s+the factory proceeds by itself: 1\\n\\s+${REPO}#4 — interrupted ` +
          "\\(attempt 1 has no outcome record of its own",
      ),
      "the state still names every reserved work when Docker cannot answer",
    );
    assert.match(text, /pool \(eligible\): 1/);
    assert.match(text, new RegExp(`archived \\(dones\\): 1[\\s\\S]*${REPO}#3-2026-02-01`));
  });

  test("renderStatus answers in the order a human asks: running → orphaned → last outcome → pool → archived", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    claimIssue(tracker, 5);
    claimIssue(tracker, 2);
    seedIssue(tracker, { repo: REPO, number: 1, labels: [DEFAULT_LABELS.ready] });
    mkdirSync(workDir(layout, REPO, 1), { recursive: true }); // reserved, no attempt yet
    seedAttempt(4, 1); // live below
    seedAttempt(5, 1); // orphaned
    const ended = workDir(layout, REPO, 2);
    mkdirSync(ended, { recursive: true });
    writeFileSync(
      join(ended, DESFECHO_FILENAME),
      JSON.stringify({ class: "clean-without-pr", attempt: 1 }),
      "utf8",
    );
    mkdirSync(join(layout.archive, `${REPO}#3-2026-02-01`), { recursive: true });

    const view = await deriveStatus(
      { github: tracker },
      makeConfig(),
      layout,
      fakeProbe({ key: `${REPO}#4`, containerId: "aaaa00000004", ageMs: 13 * 60_000 }),
    );

    assert.equal(
      renderStatus(view),
      [
        "msf status (derived on demand — the factory may be stopped)",
        "running (worker alive): 1",
        `  ${REPO}#4 (13m, attempt 1, container aaaa00000004)`,
        "duplicate workers (more than one container for the same work — a human decision is needed): none",
        "orphaned (attempt interrupted — no outcome record of its own, no worker alive): 1",
        `  ${REPO}#5 (attempt 1 was interrupted — no outcome record on disk; 0/3 recoveries consumed (waits 1s/4s/16s) — the next interruption recovers on this budget)`,
        "reserved work (the state the factory acts on — every reserved Work, grouped by what happens next): 2",
        "  the factory proceeds by itself: 1",
        `    ${REPO}#2 — fall (attempt 1: a written failure the factory did not rule yet — released to the pool)`,
        "  nothing to decide: 1",
        `    ${REPO}#1 — parked (waiting for the human, or a released work the pool owns)`,
        "last outcome: 1",
        `  ${REPO}#2 = clean-without-pr (attempt 1)`,
        "pool (eligible): 1",
        `  ${REPO}#1`,
        "archived (dones): 1",
        `  ${join(layout.archive, `${REPO}#3-2026-02-01`)}`,
        "reconciliation: none",
      ].join("\n"),
    );
  });

  test("a continuity pause is named with its reason — not hidden as an ordinary reservation", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    claimIssue(tracker, 21);
    const dir = seedAttempt(21, 1);
    writeFileSync(
      join(dir, "pausa.json"),
      JSON.stringify({
        version: 1,
        work: { repo: REPO, number: 21 },
        attempt: 1,
        reason: "session-missing",
        detail: "the session recorded for attempt 1 is not on disk",
        at: "2026-02-01T00:00:00.000Z",
      }),
      "utf8",
    );

    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS);

    assert.deepEqual(view.registry.continuityPauses.map((entry) => entry.pause.reason), ["session-missing"]);
    assert.match(
      renderStatus(view),
      new RegExp(`${REPO}#21 — continuity paused \\(attempt 1: session-missing — the session recorded for attempt 1 is not on disk\\)`),
    );
  });

  test("a pause on the attempt the launch planned is shown with the ledger's last evidenced attempt", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    claimIssue(tracker, 21);
    const dir = seedAttempt(21, 1);
    // The launch planned attempt 2 and continuity refused it before the runtime
    // spawned: the record names 2, the ledger evidences 1.
    writePause(dir, {
      version: 1,
      work: githubWork(REPO, 21),
      attempt: 2,
      reason: "effect-ambiguous",
      detail: "the push to the work branch may or may not have landed",
      at: "2026-02-01T00:00:00.000Z",
      sessionId: "sess-4f2a",
      announced: true,
    });
    const before = readFileSync(join(dir, PAUSE_FILENAME), "utf8");

    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS);

    assert.deepEqual(
      view.registry.continuityPauses.map((entry) => ({
        key: entry.key,
        planned: entry.pause.attempt,
        evidenced: entry.lastAttempt,
      })),
      [{ key: `${REPO}#21`, planned: 2, evidenced: 1 }],
      "the pause is current AND the ledger's own number is carried beside it",
    );
    assert.match(
      renderStatus(view),
      new RegExp(
        `${REPO}#21 — continuity paused \\(planned attempt 2; last evidenced attempt 1; session sess-4f2a: ` +
          `effect-ambiguous — the push to the work branch may or may not have landed\\)`,
      ),
    );
    assert.equal(readFileSync(join(dir, PAUSE_FILENAME), "utf8"), before, "the record is read, never rewritten");
    assert.ok(!existsSync(join(dir, `${PAUSE_FILENAME}.resolved`)), "status resolves nothing");
  });

  test("with liveness unknown, a paused work is listed once — under the pause, not as an interruption", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    claimIssue(tracker, 21);
    const dir = seedAttempt(21, 1);
    writePause(dir, {
      version: 1,
      work: githubWork(REPO, 21),
      attempt: 2,
      reason: "effect-ambiguous",
      detail: "the push may or may not have landed",
      at: "2026-02-01T00:00:00.000Z",
    });

    const unreachable: LivenessProbe = () => Promise.reject(new Error("docker: command not found"));
    const text = renderStatus(await deriveStatus({ github: tracker }, makeConfig(), layout, unreachable));

    assert.equal(
      (text.match(new RegExp(`${REPO}#21`, "g")) ?? []).length,
      1,
      "the pause's own state owns the work — never two lines for one wait",
    );
    assert.match(text, new RegExp(`${REPO}#21 — continuity paused \\(planned attempt 2`));
    assert.doesNotMatch(text, /#21[^\n]*interrupted/, "and never also as an interruption");
  });

  test("a pause on the attempt the ledger evidences shows one number", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    claimIssue(tracker, 21);
    const dir = seedAttempt(21, 1, 2);
    writePause(dir, {
      version: 1,
      work: githubWork(REPO, 21),
      attempt: 2,
      reason: "journal-unreadable",
      detail: "the effect journal could not be read",
      at: "2026-02-01T00:00:00.000Z",
    });

    const text = renderStatus(await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS));

    assert.match(
      text,
      new RegExp(`${REPO}#21 — continuity paused \\(attempt 2: journal-unreadable — the effect journal could not be read\\)`),
    );
  });

  test("a pause the ledger advanced beyond is history, not an active pause", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    claimIssue(tracker, 21);
    const dir = seedAttempt(21, 1, 2);
    writePause(dir, {
      version: 1,
      work: githubWork(REPO, 21),
      attempt: 1,
      reason: "session-missing",
      detail: "the session recorded for attempt 1 is not on disk",
      at: "2026-02-01T00:00:00.000Z",
    });

    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS);

    assert.deepEqual(view.registry.continuityPauses, [], "attempt 2 is evidenced: attempt 1's pause is over");
    const text = renderStatus(view);
    assert.doesNotMatch(text, /continuity paused/, "a pause the record advanced past is history");
    assert.match(text, /#21 \(attempt 2 was interrupted/, "the attempt is an interruption, and the state says so");
  });

  test("a resolved pause is not an active pause", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    claimIssue(tracker, 21);
    const dir = seedAttempt(21, 1);
    writePause(dir, {
      version: 1,
      work: githubWork(REPO, 21),
      attempt: 2,
      reason: "effect-ambiguous",
      detail: "the push may or may not have landed",
      at: "2026-02-01T00:00:00.000Z",
    });
    clearPause(dir);

    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS);

    assert.ok(existsSync(join(dir, `${PAUSE_FILENAME}.resolved`)), "the resolved evidence stays on disk");
    assert.deepEqual(view.registry.continuityPauses, []);
    const text = renderStatus(view);
    assert.doesNotMatch(text, /continuity paused/, "a resolved pause is never an active one");
    assert.match(text, /#21 \(attempt 1 was interrupted/, "the attempt is an interruption, and the state says so");
  });

  test("an unreadable pause is still shown — the attempt unknown, never an invented one", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    claimIssue(tracker, 21);
    const dir = seedAttempt(21, 1);
    writeFileSync(join(dir, PAUSE_FILENAME), "{not json", "utf8");

    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS);

    assert.deepEqual(
      view.registry.continuityPauses.map((entry) => ({
        key: entry.key,
        reason: entry.pause.reason,
        planned: entry.pause.attempt,
        evidenced: entry.lastAttempt,
      })),
      [{ key: `${REPO}#21`, reason: "record-unreadable", planned: 0, evidenced: 1 }],
    );
    const text = renderStatus(view);
    assert.match(
      text,
      new RegExp(`${REPO}#21 — continuity paused \\(attempt unknown: record-unreadable — the pause record at pausa\\.json could not be read`),
    );
    assert.doesNotMatch(text, /attempt 0/, "a number the record never named is not printed");
  });

  test("a fallen attempt is named even when an older outcome record sits on disk ", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    claimIssue(tracker, 20);
    const dir = seedAttempt(20, 1, 2);
    writeFileSync(
      join(dir, DESFECHO_FILENAME),
      JSON.stringify({ class: "pr-open", attempt: 1 }),
      "utf8",
    );

    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS);

    // The record is attempt 1's history: attempt 2 is the current, fallen one.
    assert.deepEqual(known(view).orphaned, [
      { key: `${REPO}#20`, attempt: 2, recordedAttempt: 1 },
    ]);
    assert.deepEqual(view.registry.lastOutcome.map((entry) => entry.record.attempt), [1]);
    const text = renderStatus(view);
    assert.match(
      text,
      /#20 \(attempt 2 was interrupted — the record on disk is attempt 1's — history, not this attempt's;/,
    );
    assert.match(text, /last outcome: 1[\s\S]*#20 = pr-open \(attempt 1\)/);
    assert.doesNotMatch(text, /attempt 2 was interrupted[^\n]*pr-open/, "history is never presented as the current result");
  });

  test("the repair section exposes the unpublished attempt, its local work and the pending reconciliation", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    claimIssue(tracker, 21);
    const dir = seedAttempt(21, 1, 2);
    await writeRepairCycle(dir, {
      usedRounds: 1,
      lastEvidence: `${REPO}#21|abc123|conflicts|`,
      consecutiveFalls: 1,
      attempt: {
        evidence: `${REPO}#21|abc123|conflicts|`,
        attempt: 2,
        observedHeadSha: "abc123",
        remoteHeadSha: null,
        publication: "pending",
        localWork: {
          headSha: "def456789012",
          commits: 2,
          uncommitted: true,
          operationInProgress: "rebase",
        },
      },
    });

    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS);
    const text = renderStatus(view);

    assert.match(
      text,
      /#21 — parked[^\n]*repair cycle: rounds 1\/2; falls 1\/2; attempt 2: publication not verified yet \(reconciliation pending\); local work: 2 commits on the branch, HEAD def456789012, uncommitted changes, a rebase in progress; evidence: reservation trabalhos\/Sanmoo\/my-tasks#21\/ present, event log trabalhos\/Sanmoo\/my-tasks#21\/log-2\.jsonl present, sandcastle log trabalhos\/Sanmoo\/my-tasks#21\/sessao\/sandcastle-2\.log absent/,
      "the diagnosis names the attempt's own evidence paths, present or absent ",
    );
    assert.doesNotMatch(text, /\/tmp\/|\/home\//, "the status never shows an absolute path");
  });

  test("the repair evidence reports an unverifiable location as such, never as absent", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    claimIssue(tracker, 23);
    const dir = seedAttempt(23, 1, 2);
    // A file where the attempt's session dir should be: the probe cannot look
    // inside it (ENOTDIR is absence; a permission error is "could not be
    // verified").
    writeFileSync(join(dir, "sessao"), "not a dir", "utf8");
    await writeRepairCycle(dir, {
      usedRounds: 1,
      lastEvidence: `${REPO}#23|abc123|conflicts|`,
      consecutiveFalls: 0,
      attempt: {
        evidence: `${REPO}#23|abc123|conflicts|`,
        attempt: 2,
        observedHeadSha: "abc123",
        remoteHeadSha: null,
        publication: "pending",
        localWork: null,
      },
    });

    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS);
    const text = renderStatus(view);
    assert.match(text, /event log trabalhos\/Sanmoo\/my-tasks#23\/log-2\.jsonl present/);
    assert.match(text, /sandcastle log trabalhos\/Sanmoo\/my-tasks#23\/sessao\/sandcastle-2\.log absent/);
  });

  test("the state says whether an attempt was interrupted or fell, and the record facts stay ", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    claimIssue(tracker, 30);
    claimIssue(tracker, 31);
    // #30: interrupted twice — two recoveries consumed, the attempt kept.
    const interrupted = seedAttempt(30, 2);
    const now = () => new Date("2026-01-01T00:00:00Z");
    await consumeRecovery(interrupted, DEFAULT_RECOVERY_BUDGET, 2, now);
    await consumeRecovery(interrupted, DEFAULT_RECOVERY_BUDGET, 2, now);
    // #31: a written failure — the attempt was consumed. The outcome record is
    // the fact the state rules on; the ledger is what the collection writes
    // beside it (settleFailure writes both).
    const failed = seedAttempt(31, 1);
    writeFileSync(
      join(failed, DESFECHO_FILENAME),
      JSON.stringify({ class: "clean-without-pr", attempt: 1 }),
      "utf8",
    );
    await recordFailure(failed, 1, "clean-without-pr", now);

    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS);
    const text = renderStatus(view);

    assert.match(
      text,
      /#30 \(attempt 2 was interrupted — no outcome record on disk; 2\/3 recoveries consumed \(waits 1s\/4s\/16s\) — the next interruption recovers on this budget\)/,
      "the interruption names the consumed recoveries and the configured backoff",
    );
    assert.match(
      text,
      /#31 — fall \(attempt 1: a written failure the factory did not rule yet — released to the pool\)/,
      "a written failure is a fall, and the state names the attempt it consumed",
    );
    assert.match(text, /#31 = clean-without-pr \(attempt 1\)/, "the outcome record is still a fact of its own");
    assert.doesNotMatch(text, /\/tmp\/|\/home\//, "the status never shows an absolute path");
  });

  test("an interruption whose recovery budget is spent waits for the operator, not for the factory", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    claimIssue(tracker, 40);
    claimIssue(tracker, 41);
    const now = () => new Date("2026-01-01T00:00:00Z");
    // A reservation whose interrupted attempt left only its recovery ledger:
    // the reading is `interrupted`, and the reserved block is where it is
    // named.
    const recovering = workDir(layout, REPO, 40);
    mkdirSync(recovering, { recursive: true });
    await consumeRecovery(recovering, DEFAULT_RECOVERY_BUDGET, 1, now);
    const exhausted = workDir(layout, REPO, 41);
    mkdirSync(exhausted, { recursive: true });
    for (let spent = 0; spent < DEFAULT_RECOVERY_BUDGET.maxRecoveries; spent += 1) {
      await consumeRecovery(exhausted, DEFAULT_RECOVERY_BUDGET, 1, now);
    }

    const text = renderStatus(await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS));

    const factoryGroup = /the factory proceeds by itself: 1\n\s+Sanmoo\/my-tasks#40 — interrupted/;
    const operatorGroup = /waiting for the operator: 1\n\s+Sanmoo\/my-tasks#41 — interrupted/;
    assert.match(text, factoryGroup, "a recoverable interruption is the factory's own business");
    assert.match(text, operatorGroup, "an exhausted one is grouped where it waits: the tick blocks and asks");
    assert.ok(
      text.indexOf("#40 — interrupted") < text.indexOf("waiting for the operator"),
      "and the two are not rendered in the same group",
    );
  });

    test("many reservations cost a bounded burst, not one per reservation ", async () => {
    const tracker = new SlowTicketTracker(100);
    const numbers = Array.from({ length: 12 }, (_, index) => 100 + index);
    for (const number of numbers) {
      claimIssue(tracker, number);
      mkdirSync(workDir(layout, REPO, number), { recursive: true });
    }

    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS);

    assert.deepEqual(
      view.reserved.map((entry) => entry.key).sort(),
      numbers.map((number) => `${REPO}#${number}`).sort(),
      "every reserved work still gets its reading, in input order",
    );
    assert.equal(
      view.reserved.every((entry) => entry.reading.dir === workDirOfKey(layout, entry.key)),
      true,
      "each reading answers for its own reservation, not for a shared placeholder",
    );
    // The burst is the bound, not the number of reservations: up to
    // RESERVED_STATE_READS_IN_FLIGHT tracker reads overlap and never more.
    assert.equal(tracker.peakInFlight, RESERVED_STATE_READS_IN_FLIGHT);
  });

    test("a PR closed without merge is blocked with the PR pointed at — the status reads the state that says so ", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    claimIssue(tracker, 50);
    seedAttempt(50, 1);
    tracker.seedPullRequest({ repo: REPO, number: 50 });
    tracker.closePr({ repo: REPO, prNumber: 50 }, { merged: false });

    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS);
    const reading = view.reserved.find((entry) => entry.key === `${REPO}#50`)?.reading;
    assert.equal(reading?.state, "rejected", "a PR closed without merge is a Block, never a release");
    assert.ok(reading?.state === "rejected", "the state carries the payload its action needs");
    assert.equal(reading.pr.number, 50, "the PR the block points at travels with the state");
    assert.match(reading.comment, /closed without merging/);

    const text = renderStatus(view);
    assert.match(
      text,
      new RegExp(
        `${REPO}#50 — rejected \\(PR #50 was closed without merging — blocked with a comment pointing at the PR\\)`,
      ),
      "the operator reads the reserved work blocked, with the PR pointed at",
    );
  });

  /** The attempt's current session ended by a model provider error at `at`. */
  function seedModelProviderEnding(target: string, attempt: number, at = 1_700_000_000_000): string {
    appendAttemptEvent(target, attempt, {
      event: "agent-raw",
      iteration: 1,
      line: JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          provider: "fake",
          model: "fake/model",
          stopReason: "error",
          errorMessage: "429: upstream unavailable",
          timestamp: at,
        },
      }),
    });
    return new Date(at).toISOString();
  }

  test("the model provider section names the failure and its message, and says retrying — never a block ", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    claimIssue(tracker, 40);
    const dir = seedAttempt(40, 1);
    const at = seedModelProviderEnding(dir, 1);
    await settleModelProviderFailure(dir, DEFAULT_MODEL_PROVIDER_BUDGET, 1, {
      message: "429: upstream unavailable",
      identity: at,
    });

    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS);
    const text = renderStatus(view);

    assert.match(
      text,
      /the factory proceeds by itself: 1/,
      "a model provider failure is the factory's own retry, not a wait for the operator",
    );
    assert.match(
      text,
      /#40 — model provider failure \(attempt 1: 1\/4 retries \(waits 15s\/30s\/60s\/120s\); last model provider error: 429: upstream unavailable — retrying after the model provider backoff\)/,
    );
    assert.doesNotMatch(text, /blocked/, "a model provider failure is never rendered as a block");
  });

  test("awaiting model provider is a state of its own: the exhausted budget says the help request, not a block ", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    claimIssue(tracker, 41);
    const dir = seedAttempt(41, 1);
    const at = seedModelProviderEnding(dir, 1, 1_700_000_000_900);
    for (let index = 0; index < DEFAULT_MODEL_PROVIDER_BUDGET.maxRetries; index += 1) {
      await settleModelProviderFailure(dir, DEFAULT_MODEL_PROVIDER_BUDGET, 1, {
        message: "503: unavailable",
        identity: `2026-01-01T00:00:0${index}.000Z`,
      });
    }
    await settleModelProviderFailure(dir, DEFAULT_MODEL_PROVIDER_BUDGET, 1, {
      message: "503: unavailable",
      identity: at,
    });

    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS);
    const text = renderStatus(view);

    assert.match(
      text,
      /#41 — model provider failure \(attempt 1: 4\/4 retries \(waits 15s\/30s\/60s\/120s\); last model provider error: 429: upstream unavailable — awaiting model provider — a help request, not a block\)/,
      "the exhausted budget is the help request the attempt's own stream reports",
    );
    assert.doesNotMatch(text, /\/tmp\/|\/home\//, "the status never shows an absolute path");
  });

  test("a later plain interruption is not read as 'retrying after the model provider' ", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    claimIssue(tracker, 42);
    const dir = seedAttempt(42, 1);
    const at = seedModelProviderEnding(dir, 1);
    await settleModelProviderFailure(dir, DEFAULT_MODEL_PROVIDER_BUDGET, 1, {
      message: "429: upstream unavailable",
      identity: at,
    });
    // The retry session started and was killed before writing any message.
    appendAttemptEvent(dir, 1, { event: "session-start" });

    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS);
    const text = renderStatus(view);

    assert.doesNotMatch(
      text,
      /model provider failure/,
      "the earlier failure is history: the current session is a plain interruption",
    );
    assert.match(
      text,
      /orphaned \(attempt interrupted — no outcome record of its own, no worker alive\): 1/,
      "the work is an interruption again, and the recovery budget answers it",
    );
    assert.match(text, /#42 \(attempt 1 was interrupted/);
  });

  test("the requested stop and the unconfirmed stop are states of their own ", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    claimIssue(tracker, 33);
    claimIssue(tracker, 34);
    const stopped = seedAttempt(33, 1);
    await recordStopRequest(stopped, 1);
    const unconfirmed = seedAttempt(34, 2);
    await recordUnconfirmedStop(unconfirmed, 2, "a worker of this work is still alive");

    const text = renderStatus(await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS));

    assert.match(
      text,
      /#33 — stop-resume \(attempt 1: last stop was the operator's requested stop — no attempt consumed and no recovery spent; it resumes on the next run\)/,
    );
    assert.match(
      text,
      /#34 — stop-unconfirmed \(attempt 2: the requested stop could not be confirmed — a worker of this work is still alive; it will not relaunch until the previous worker is known to be gone\)/,
      "an unconfirmed stop is a diagnosis the operator can act on",
    );
    // The stop owns its explanation: neither work is repeated under the
    // interruption wording (the branch's own GLOSSARY stops calling the
    // operator's act an Interruption).
    assert.doesNotMatch(text, /#33[^\n]*interrupted/);
    assert.doesNotMatch(text, /#34[^\n]*interrupted/);
  });

  test("a legacy work dir without a recovery ledger shows no recovery budget — nothing is invented", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    claimIssue(tracker, 32);
    const dir = seedAttempt(32, 1);
    writeFileSync(
      join(dir, DESFECHO_FILENAME),
      JSON.stringify({ class: "clean-without-pr", attempt: 1 }),
      "utf8",
    );

    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS);

    assert.deepEqual(view.registry.recovery, []);
    const text = renderStatus(view);
    assert.match(text, /#32 — fall \(attempt 1/, "the written outcome is ruled by the state");
    assert.doesNotMatch(text, /recoveries consumed/, "an absent ledger spends nothing and is given no budget");
    assert.equal(
      JSON.parse(readFileSync(join(dir, DESFECHO_FILENAME), "utf8")).class,
      "clean-without-pr",
      "the legacy record is untouched",
    );
  });

  test("a legacy reparo.json is read as it stands: rounds counted, no attempt or fall invented", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    claimIssue(tracker, 22);
    const dir = seedAttempt(22, 1);
    writeFileSync(
      join(dir, "reparo.json"),
      JSON.stringify({ usedRounds: 1, lastEvidence: `${REPO}#22|abc123|conflicts|` }),
      "utf8",
    );

    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS);
    const text = renderStatus(view);
    assert.match(
      text,
      /#22[^\n]*repair cycle: rounds 1\/2; falls 0\/2/,
      "the legacy cycle is shown without invented facts",
    );
  });

  test("the archived and the pool list one entry per line, capped at 10 with an omission marker", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    for (let number = 1; number <= 12; number += 1) {
      seedIssue(tracker, { repo: REPO, number, labels: [DEFAULT_LABELS.ready] });
      mkdirSync(join(layout.archive, `${REPO}#${number}-2026-02-01`), { recursive: true });
    }
    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS);

    const capped = renderStatus(view);
    const archivedLines = capped.split("\n").filter((line) => /^\s+\S+#\d+-2026-02-01$/.test(line));
    assert.equal(archivedLines.length, 10, "ten entries, then the marker");
    assert.match(capped, /archived \(dones\): 12[\s\S]*… and 2 more/);
    assert.match(capped, /pool \(eligible\): 12[\s\S]*… and 2 more/);
    assert.doesNotMatch(capped, /… and 3 more/);
  });

  test("--all lifts every cap — the complete lists on demand", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    for (let number = 1; number <= 12; number += 1) {
      mkdirSync(join(layout.archive, `${REPO}#${number}-2026-02-01`), { recursive: true });
    }
    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS);

    const all = renderStatus(view, { all: true });
    const archivedLines = all.split("\n").filter((line) => /^\s+\S+#\d+-2026-02-01$/.test(line));
    assert.equal(archivedLines.length, 12);
    assert.doesNotMatch(all, /more$/);
  });

  test("status writes nothing: the workspace tree is unchanged before and after the derivation", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedIssue(tracker, { repo: REPO, number: 1, labels: [DEFAULT_LABELS.ready] });
    seedAttempt(4, 1);
    const before = readdirSync(layout.root, { recursive: true });

    await deriveStatus({ github: tracker }, makeConfig(), layout, fakeProbe({ key: `${REPO}#4`, containerId: "aaaa00000004", ageMs: 60_000 }));

    assert.deepEqual(readdirSync(layout.root, { recursive: true }), before);
  });

  test("an empty workspace and empty pool render a clean, never-crashing status", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS);
    const text = renderStatus(view);
    assert.match(text, /pool \(eligible\): none/);
    assert.match(text, /running \(worker alive\): none/);
    assert.match(text, /reconciliation: none/);
  });

  test("status reports an unbacked claim: the mark without a reservation, the command and the caveat", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedIssue(tracker, { repo: REPO, number: 10, labels: [DEFAULT_LABELS.claimed] });
    await tracker.claim({ repo: REPO, number: 10 }, "bot-do-samuca", DEFAULT_LABELS.ready);

    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS);
    assert.equal(view.unbackedClaims.length, 1);
    assert.match(view.unbackedClaims[0]!.command!, /gh issue edit 10 --repo Sanmoo\/my-tasks/);

    const text = renderStatus(view);
    assert.match(text, /unbacked claim: Sanmoo\/my-tasks#10/);
    assert.match(text, /another factory or workspace may hold this claim/);
    assert.match(text, /gh issue edit 10/);
  });

  test("status reports an unmarked reservation as a fact only — the dir is there, the tracker is silent", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedIssue(tracker, { repo: REPO, number: 11, labels: [] });
    mkdirSync(workDir(layout, REPO, 11), { recursive: true });

    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS);
    assert.equal(view.unmarkedReservations.length, 1);

    const text = renderStatus(view);
    assert.match(text, /unmarked reservation: Sanmoo\/my-tasks#11/);
    assert.match(text, /no factory mark/);
    assert.doesNotMatch(text, /gh issue edit 11/);
  });

  test("a claimed issue with a reservation and a released reservation are never reported", async () => {
    const tracker = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedIssue(tracker, { repo: REPO, number: 12, labels: [DEFAULT_LABELS.claimed] });
    mkdirSync(workDir(layout, REPO, 12), { recursive: true });
    seedIssue(tracker, { repo: REPO, number: 13, labels: [DEFAULT_LABELS.ready] });
    mkdirSync(workDir(layout, REPO, 13), { recursive: true });

    const view = await deriveStatus({ github: tracker }, makeConfig(), layout, NO_WORKERS);
    assert.deepEqual(view.unbackedClaims, []);
    assert.deepEqual(view.unmarkedReservations, []);
    const text = renderStatus(view);
    assert.match(text, /reconciliation: none/);
  });

  test("a Jira Work is presented by its source and destination — status invents no GitHub issue", () => {
    const jiraWork = workIdentity(
      jiraTicket({
        site: "acme.atlassian.net",
        stableId: "10042",
        key: "ABC-42",
        url: "https://acme.atlassian.net/browse/ABC-42",
      }),
      githubRepository(REPO),
    );
    const config = makeConfig();
    const view: StatusView = {
      pool: [{ work: jiraWork, title: "a Jira request", createdAt: "2026-01-01T00:00:00Z" }],
      jira: [],
      unbackedClaims: [],
      unmarkedReservations: [],
      registry: {
        attemptsWithoutOwnOutcome: [],
        reservedWithoutAttempt: ["jira@acme.atlassian.net@10042@Sanmoo%2Fmy-tasks"],
        lastOutcome: [],
        repair: [],
        recovery: [],
        modelProvider: [],
        continuityPauses: [
          // The record's own Work is the identity a pause names: the readable
          // Jira key lives in the record, never in the registry key.
          {
            key: "jira@acme.atlassian.net@10042@Sanmoo%2Fmy-tasks",
            lastAttempt: 1,
            pause: {
              version: 1,
              work: jiraWork,
              attempt: 2,
              reason: "session-missing",
              detail: "the session recorded for attempt 2 is not on disk",
              at: "2026-02-01T00:00:00.000Z",
            },
          },
          // A record unreadable as a whole has no Work of its own: the
          // directory's key names it, and the attempt stays unknown.
          {
            key: "jira@acme.atlassian.net@99999@Sanmoo%2Fmy-tasks",
            lastAttempt: 2,
            pause: {
              version: 1,
              attempt: 0,
              reason: "record-unreadable",
              detail: "the pause record could not be read",
              at: "",
            },
          },
        ],
        archived: [],
      },
      liveness: { state: "known", running: [], duplicates: [], orphaned: [] },
      // Neither dir names a GitHub Work: the state cannot address them, and the
      // registry says what it knows without inventing a state.
      reserved: [],
      unaddressedReservations: [
        "jira@acme.atlassian.net@10042@Sanmoo%2Fmy-tasks",
        "jira@acme.atlassian.net@99999@Sanmoo%2Fmy-tasks",
      ],
      recoveryBudget: config.recovery,
      modelProviderBudget: config.modelProvider,
      retro: null,
    };

    const text = renderStatus(view);
    assert.match(text, /ABC-42 \(jira:acme\.atlassian\.net\) → Sanmoo\/my-tasks/, "source and destination are separate facts");
    assert.match(
      text,
      /not read \(the registry key names no GitHub Work[\s\S]*jira:acme\.atlassian\.net:10042 → Sanmoo\/my-tasks/,
      "a registry-only Jira work shows its site and stable ticket id, never a raw key",
    );
    assert.doesNotMatch(text, /github\.com\/.*\/issues\//, "no synthesized GitHub issue URL for a Jira ticket");
    assert.doesNotMatch(text, /10042 \(jira/, "the stable id is never fabricated into a readable key");
    assert.match(
      text,
      /the record names it ABC-42 \(jira:acme\.atlassian\.net\) → Sanmoo\/my-tasks; a continuity pause waits: planned attempt 2; last evidenced attempt 1: session-missing/,
      "a pause names the Work its own record carries",
    );
    assert.match(
      text,
      /jira:acme\.atlassian\.net:99999 → Sanmoo\/my-tasks \([^\n]*a continuity pause waits: attempt unknown: record-unreadable/,
      "without a recorded Work the directory key names it — the key is not invented, its readable ticket is simply absent",
    );
  });
});

// ---- Jira candidates: read-only, one native Rank order per site ----

/** Does this JQL name the configured query (with or without the native ordering
 *  the adapter appends)? The one reading of "this request is a selection's". */
function namesQuery(jql: string, query: string): boolean {
  return jql === query || jql === `${query} ORDER BY Rank ASC`;
}

describe("status: Jira candidates are read-only, and one site has one native Rank order", () => {
  let dir: string;
  let layout: WorkspaceLayout;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-status-jira-"));
    layout = ensureWorkspace(join(dir, "ws"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const TOKEN_ENV = "MSF_JIRA_ALPHA_TOKEN";

  function jiraAdapter(sim: JiraSim, env: NodeJS.ProcessEnv = { [TOKEN_ENV]: sim.token }) {
    return new JiraTicketAdapter({
      site: sim.site,
      account: sim.account.emailAddress,
      tokenEnv: TOKEN_ENV,
      env,
      transport: sim.transport,
    });
  }

  function statusConfig(): Config {
    return {
      workerGhAccount: "bot-do-samuca",
      workerModel: "opencode-go/glm-5.3-flash",
      repos: [],
      jira: [],
      concurrency: 2,
      workspace: layout.root,
      labels: { ...DEFAULT_LABELS },
      workerAuthFile: null,
      recovery: { ...DEFAULT_RECOVERY_BUDGET },
      retro: { ...DEFAULT_RETRO },
      modelProvider: { ...DEFAULT_MODEL_PROVIDER_BUDGET },
      liveness: { ...DEFAULT_LIVENESS_POLICY },
      notifications: true,
      configPath: join(dir, "msf.yaml"),
    };
  }

  function selection(site: string, jql = "project = ABC", destination = REPO): TicketSelection {
    return {
      source: { provider: "jira", site },
      destination: githubRepository(destination),
      jql,
    };
  }

  /** A controlled Jira selection stand-in: a configured JQL gets its own
   *  issues; any other read (the site's ordered result) sees the whole site. */
  function selectBy(members: Record<string, (issue: SimJiraIssue) => boolean>): NonNullable<JiraSim["select"]> {
    return (jql, issues) => {
      const direct = Object.entries(members).find(([query]) => namesQuery(jql, query));
      return direct === undefined ? issues : issues.filter(direct[1]);
    };
  }

  test("one site's candidates keep native Rank order; another site that cannot be read is unreadable", async () => {
    const healthy = new JiraSim();
    healthy.addIssue({ id: "10001", key: "ABC-1", summary: "Fix login", assignee: null });
    healthy.addIssue({ id: "10002", key: "ABC-2", summary: "Fix logout" });
    const broken = new JiraSim({ site: "beta.atlassian.net" });

    const view = await deriveStatus(
      {
        github: new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" }),
        jira: [
          { selection: selection("acme.atlassian.net"), tickets: jiraAdapter(healthy), prerequisites: [] },
          { selection: selection("beta.atlassian.net"), tickets: jiraAdapter(broken, {}), prerequisites: [] },
        ],
      },
      statusConfig(),
      layout,
      NO_WORKERS,
    );

    const [alpha, beta] = view.jira;
    if (alpha?.state !== "known" || beta?.state !== "unreadable") assert.fail("one site reads, the other does not");
    assert.equal(alpha.site, "acme.atlassian.net");
    assert.deepEqual(
      alpha.candidates.map((candidate) => renderWorkIdentity(candidate.work)),
      [
        "ABC-1 (jira:acme.atlassian.net) → Sanmoo/my-tasks",
        "ABC-2 (jira:acme.atlassian.net) → Sanmoo/my-tasks",
      ],
      "the site's adapter Rank order is presented as-is",
    );
    assert.deepEqual(alpha.candidates[0]?.assignees, [], "an unassigned candidate is presented, not dropped");
    assert.equal(beta.site, "beta.atlassian.net");
    assert.match(beta.reason, new RegExp(TOKEN_ENV), "the diagnostic names the missing local credential");
    assert.match(beta.reason, /not set/);
    assert.deepEqual(beta.candidates, []);
    assert.deepEqual(beta.ambiguous, []);

    assert.deepEqual(
      healthy.requests.map((request) => `${request.method} ${request.path}`),
      ["GET /rest/api/3/myself", "POST /rest/api/3/search/jql"],
      "status only reads: one identity read and one selection's native search, no claim or transition",
    );
    assert.deepEqual(broken.requests, [], "the site without a credential never reaches the network");
    assert.deepEqual(readdirSync(join(layout.works)), [], "no reservation, workspace or attempt is created");
  });

  test("the report presents each site's candidates apart from the executable pool and says they are read-only", async () => {
    const sim = new JiraSim();
    sim.addIssue({ id: "10001", key: "ABC-1", summary: "Fix login", assignee: { accountId: "h", emailAddress: "ana@acme.example", displayName: "Ana Silva" } });
    sim.addIssue({ id: "10002", key: "ABC-2", summary: "Fix logout", assignee: null });

    const view = await deriveStatus(
      {
        github: new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" }),
        jira: [{ selection: selection("acme.atlassian.net"), tickets: jiraAdapter(sim), prerequisites: [] }],
      },
      statusConfig(),
      layout,
      NO_WORKERS,
    );
    const text = renderStatus(view);

    assert.match(
      text,
      /jira candidates \(read-only[^)]*one native Rank order[^)]*nothing is claimed, commented or launched\): 1 site$/m,
      "the header counts sites: candidates are never summed across sites as one order",
    );
    assert.match(text, /acme\.atlassian\.net \(1 selection\) → Sanmoo\/my-tasks: 2 candidates$/m);
    assert.match(
      text,
      /1\. ABC-1 \(jira:acme\.atlassian\.net\) → Sanmoo\/my-tasks — Fix login \[assignee: Ana Silva\]/,
    );
    assert.match(
      text,
      /2\. ABC-2 \(jira:acme\.atlassian\.net\) → Sanmoo\/my-tasks — Fix logout — prerequisites: none configured for this selection$/m,
    );
    assert.match(text, /pool \(eligible\): none/, "a Jira candidate is not presented as an eligible Work");
    assert.doesNotMatch(text, /acme\.atlassian\.net → Sanmoo\/my-tasks: 1 candidate/, "no per-selection queues");
  });

  test("several selections on one site keep the site's Rank across destinations and pages; only the conflicting ticket is held", async () => {
    const sim = new JiraSim();
    sim.pageSize = 2;
    // The site's Rank order deliberately disagrees with both creation age and
    // Jira Priority: neither may reorder the candidates. The ages are not even
    // monotone, so no age sort — ascending or descending — can reproduce Rank.
    sim.addIssue({ id: "10001", key: "ABC-1", summary: "Frontend first", labels: ["frontend", "shared"], created: "2026-03-01T00:00:00.000+0000", priority: "Low" });
    sim.addIssue({ id: "10002", key: "ABC-2", summary: "Backend first", labels: ["backend"], created: "2026-06-01T00:00:00.000+0000", priority: "Highest" });
    sim.addIssue({ id: "10003", key: "ABC-3", summary: "Touches both layers", labels: ["frontend", "backend"], created: "2026-01-01T00:00:00.000+0000", priority: "Medium", assignee: null });
    sim.addIssue({ id: "10004", key: "ABC-4", summary: "Frontend second", labels: ["frontend"], created: "2026-05-01T00:00:00.000+0000", priority: "Lowest" });
    sim.addIssue({ id: "10005", key: "ABC-5", summary: "Backend second", labels: ["backend"], created: "2026-02-01T00:00:00.000+0000", priority: "High" });
    sim.select = selectBy({
      "project = ABC AND labels = frontend": (issue) => issue.labels.includes("frontend"),
      "project = ABC AND labels = backend": (issue) => issue.labels.includes("backend"),
      "project = ABC AND labels = shared": (issue) => issue.labels.includes("shared"),
    });

    const adapter = jiraAdapter(sim);
    const view = await deriveStatus(
      {
        github: new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" }),
        jira: [
          // Declared backend first: the site's Rank must not follow declarations.
          {
            selection: selection("acme.atlassian.net", "project = ABC AND labels = backend", "Sanmoo/backend"),
            tickets: adapter,
            prerequisites: [],
          },
          {
            selection: selection("acme.atlassian.net", "project = ABC AND labels = frontend", "Sanmoo/frontend"),
            tickets: adapter,
            prerequisites: [],
          },
          {
            selection: selection("acme.atlassian.net", "project = ABC AND labels = shared", "Sanmoo/frontend"),
            tickets: adapter,
            prerequisites: [],
          },
        ],
      },
      statusConfig(),
      layout,
      NO_WORKERS,
    );

    const [site] = view.jira;
    assert.equal(view.jira.length, 1, "one site is one ordered set, not one queue per selection");
    if (site?.state !== "known") assert.fail("the site is readable");
    assert.deepEqual(
      site.candidates.map((candidate) => `${candidate.work.ticket.key} -> ${candidate.work.destination.repo}`),
      ["ABC-1 -> Sanmoo/frontend", "ABC-2 -> Sanmoo/backend", "ABC-4 -> Sanmoo/frontend", "ABC-5 -> Sanmoo/backend"],
      "the candidate order is the site's native Rank across destinations and pages",
    );
    assert.deepEqual(
      site.ambiguous.map((entry) => ({
        key: entry.ticket.key,
        destinations: entry.destinations.map((destination) => destination.repo),
      })),
      [{ key: "ABC-3", destinations: ["Sanmoo/backend", "Sanmoo/frontend"] }],
      "only the ticket two destinations promise is held; the other candidates stay usable",
    );
    assert.ok(
      sim.requests.every(
        (request) =>
          (request.method === "GET" && request.path === "/rest/api/3/myself") ||
          (request.method === "POST" && request.path === "/rest/api/3/search/jql"),
      ),
      "status only reads the identity and the search; nothing is claimed or transitioned",
    );

    const text = renderStatus(view);
    assert.match(
      text,
      /acme\.atlassian\.net \(3 selections\) → Sanmoo\/backend, Sanmoo\/frontend: 4 candidates, 1 held as ambiguous$/m,
    );
    const frontendFirst = text.indexOf("1. ABC-1");
    const backendFirst = text.indexOf("2. ABC-2");
    assert.ok(frontendFirst >= 0 && frontendFirst < backendFirst, "the declared-later frontend candidate still comes first by Rank");
    assert.match(
      text,
      /selection \(project = ABC AND labels = backend\) → Sanmoo\/backend: 3 selected, 1 held as ambiguous/,
      "each readable selection's contribution is visible in the report",
    );
    assert.equal(
      (text.match(/ABC-1/g) ?? []).length,
      1,
      "a ticket two same-destination selections share is deduplicated in the same integrated read",
    );
    assert.match(
      text,
      /ambiguous \(more than one destination — held, no destination chosen\): 1[\s\S]*ABC-3 \(jira:acme\.atlassian\.net\) — Touches both layers → Sanmoo\/backend, Sanmoo\/frontend/,
    );
    assert.doesNotMatch(text, /^\s+\d+\. ABC-3 \(jira:[^)]*\) → /m, "the ambiguous ticket is never offered as a candidate");
  });

  test("one site's Rank spans two Jira projects, so neither project's queue is concatenated", async () => {
    const sim = new JiraSim();
    // The site's Rank interleaves the two projects, and DEF-1 is the NEWEST:
    // neither concatenating the projects nor sorting by creation age could
    // produce this sequence.
    sim.addIssue({ id: "20001", key: "DEF-1", summary: "Platform first", labels: ["platform"], created: "2026-12-01T00:00:00.000+0000" });
    sim.addIssue({ id: "10001", key: "ABC-1", summary: "Product first", labels: ["product"], created: "2026-02-01T00:00:00.000+0000" });
    sim.addIssue({ id: "20002", key: "DEF-2", summary: "Platform second", labels: ["platform"], created: "2026-03-01T00:00:00.000+0000" });
    sim.addIssue({ id: "10002", key: "ABC-2", summary: "Product second", labels: ["product"], created: "2026-04-01T00:00:00.000+0000" });
    sim.select = selectBy({
      "project = ABC": (issue) => issue.key.startsWith("ABC-"),
      "project = DEF": (issue) => issue.key.startsWith("DEF-"),
    });
    const adapter = jiraAdapter(sim);

    const view = await deriveStatus(
      {
        github: new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" }),
        jira: [
          { selection: selection("acme.atlassian.net", "project = ABC", "Sanmoo/product"), tickets: adapter, prerequisites: [] },
          { selection: selection("acme.atlassian.net", "project = DEF", "Sanmoo/platform"), tickets: adapter, prerequisites: [] },
        ],
      },
      statusConfig(),
      layout,
      NO_WORKERS,
    );

    const [site] = view.jira;
    if (site?.state !== "known") assert.fail("the site is readable");
    assert.deepEqual(
      site.candidates.map((candidate) => `${candidate.work.ticket.key} -> ${candidate.work.destination.repo}`),
      [
        "DEF-1 -> Sanmoo/platform",
        "ABC-1 -> Sanmoo/product",
        "DEF-2 -> Sanmoo/platform",
        "ABC-2 -> Sanmoo/product",
      ],
      "the site's Rank orders the two projects together; each keeps its own explicit destination",
    );
  });

  test("a site whose only tickets are held says so instead of 'none'", async () => {
    const sim = new JiraSim();
    sim.addIssue({ id: "10001", key: "ABC-1", summary: "One ticket, two selections", labels: ["a", "b"] });
    sim.select = selectBy({
      "labels = a": (issue) => issue.labels.includes("a"),
      "labels = b": (issue) => issue.labels.includes("b"),
    });
    const adapter = jiraAdapter(sim);

    const view = await deriveStatus(
      {
        github: new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" }),
        jira: [
          { selection: selection("acme.atlassian.net", "labels = a", "Sanmoo/a"), tickets: adapter, prerequisites: [] },
          { selection: selection("acme.atlassian.net", "labels = b", "Sanmoo/b"), tickets: adapter, prerequisites: [] },
        ],
      },
      statusConfig(),
      layout,
      NO_WORKERS,
    );
    const text = renderStatus(view);

    assert.match(text, /acme\.atlassian\.net \(2 selections\) → Sanmoo\/a, Sanmoo\/b: 0 candidates, 1 held as ambiguous/);
    assert.match(text, /ambiguous \(more than one destination — held, no destination chosen\): 1/);
    assert.doesNotMatch(text, /→ Sanmoo\/[ab]: none/, "a held ticket never reads as an empty JQL result");
  });

  test("any unreadable selection holds the whole site, so no candidate keeps a guessed destination", async () => {
    const sim = new JiraSim();
    sim.addIssue({ id: "10001", key: "ABC-1", summary: "One", labels: ["abc"] });
    sim.select = selectBy({ "labels = abc": (issue) => issue.labels.includes("abc") });
    const transport = async (url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }) => {
      if (url.endsWith("/rest/api/3/search/jql")) {
        const body = JSON.parse(init.body ?? "{}") as { jql?: string };
        if (body.jql?.includes("project = XYZ")) {
          return { status: 400, text: JSON.stringify({ errorMessages: ["Error in the JQL Query"] }) };
        }
      }
      return sim.transport(url, init);
    };
    const adapter = new JiraTicketAdapter({
      site: sim.site,
      account: sim.account.emailAddress,
      tokenEnv: TOKEN_ENV,
      env: { [TOKEN_ENV]: sim.token },
      transport,
    });

    const view = await deriveStatus(
      {
        github: new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" }),
        jira: [
          { selection: selection("acme.atlassian.net", "labels = abc", "Sanmoo/a"), tickets: adapter, prerequisites: [] },
          { selection: selection("acme.atlassian.net", "project = XYZ", "Sanmoo/a"), tickets: adapter, prerequisites: [] },
        ],
      },
      statusConfig(),
      layout,
      NO_WORKERS,
    );
    const [site] = view.jira;
    if (site?.state !== "unreadable") assert.fail("the sibling that cannot be read leaves the site's routing unreadable");
    assert.match(site.reason, /no candidate's destination is exclusive/);
    assert.deepEqual(site.candidates, [], "a readable selection alone cannot prove the ticket's destination");
    assert.deepEqual(
      site.selections.map((entry) => entry.state),
      ["known", "unreadable"],
      "the readable selection is not mistaken for the whole site",
    );
    const text = renderStatus(view);

    assert.match(text, /acme\.atlassian\.net \(2 selections\) → Sanmoo\/a: unreadable \(/);
    assert.match(text, /selection \(project = XYZ\) → Sanmoo\/a: unreadable \(/);
    assert.doesNotMatch(text, /^    \d+\. ABC-1 /m, "no candidate is offered while a destination is unreadable");
  });

  test("selections of one site that do not share one tracker never read through a declared-first adapter", async () => {
    const left = new JiraSim();
    left.addIssue({ id: "10001", key: "ABC-1", summary: "Left" });
    const right = new JiraSim();
    right.addIssue({ id: "10002", key: "ABC-2", summary: "Right" });

    const view = await deriveStatus(
      {
        github: new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" }),
        jira: [
          { selection: selection("acme.atlassian.net", "labels = left", "Sanmoo/a"), tickets: jiraAdapter(left), prerequisites: [] },
          { selection: selection("acme.atlassian.net", "labels = right", "Sanmoo/b"), tickets: jiraAdapter(right), prerequisites: [] },
        ],
      },
      statusConfig(),
      layout,
      NO_WORKERS,
    );

    const [site] = view.jira;
    if (site?.state !== "unreadable") assert.fail("the site's identity is not one tracker");
    assert.match(site.reason, /do not share one tracker/);
    assert.deepEqual(left.requests, [], "no selection read ran through a guessed adapter");
    assert.deepEqual(right.requests, [], "no selection read ran through a guessed adapter");
  });

  test("a site whose ordered union cannot be read is unreadable, never its selections concatenated", async () => {
    const sim = new JiraSim();
    sim.addIssue({ id: "10001", key: "ABC-1", summary: "Frontend", labels: ["frontend"] });
    sim.addIssue({ id: "10002", key: "ABC-2", summary: "Backend", labels: ["backend"] });
    sim.select = selectBy({
      "labels = frontend": (issue) => issue.labels.includes("frontend"),
      "labels = backend": (issue) => issue.labels.includes("backend"),
    });
    const directQueries = ["labels = frontend", "labels = backend"];
    const transport = async (url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }) => {
      if (url.endsWith("/rest/api/3/search/jql")) {
        const body = JSON.parse(init.body ?? "{}") as { jql?: string };
        const direct = directQueries.some((query) => namesQuery(body.jql ?? "", query));
        if (!direct) {
          return { status: 503, text: JSON.stringify({ errorMessages: ["The service is unavailable"] }) };
        }
      }
      return sim.transport(url, init);
    };
    const adapter = new JiraTicketAdapter({
      site: sim.site,
      account: sim.account.emailAddress,
      tokenEnv: TOKEN_ENV,
      env: { [TOKEN_ENV]: sim.token },
      transport,
    });

    const view = await deriveStatus(
      {
        github: new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" }),
        jira: [
          { selection: selection("acme.atlassian.net", "labels = frontend", "Sanmoo/frontend"), tickets: adapter, prerequisites: [] },
          { selection: selection("acme.atlassian.net", "labels = backend", "Sanmoo/backend"), tickets: adapter, prerequisites: [] },
        ],
      },
      statusConfig(),
      layout,
      NO_WORKERS,
    );

    const [site] = view.jira;
    if (site?.state !== "unreadable") assert.fail("without the ordered union, the site is unreadable");
    assert.deepEqual(site.candidates, [], "independent selection queues are never offered as the site order");
    assert.deepEqual(site.ambiguous, []);
    assert.match(site.reason, /could not read Jira site/);
    assert.match(site.reason, /503|unavailable/);
    assert.deepEqual(
      site.selections.map((entry) => entry.state),
      ["known", "known"],
      "the individual selections were readable; only the order is unreadable",
    );
    const text = renderStatus(view);
    assert.match(text, /acme\.atlassian\.net \(2 selections\) → Sanmoo\/backend, Sanmoo\/frontend: unreadable \(/);
    assert.doesNotMatch(text, /^    \d+\. ABC-/m, "no candidate line is invented from a concatenated order");
  });

  test("an unreadable selection that configures a rule holds the whole site, so no candidate claims a verdict", async () => {
    // The site's rule is all-or-nothing: a selection whose own requirement
    // cannot be applied could overturn any verdict here, so none is offered.
    const readable = new JiraSim();
    readable.addIssue({ id: "10001", key: "ABC-1", summary: "One", assignee: null });
    const blind = new JiraSim();

    const view = await deriveStatus(
      {
        github: new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" }),
        jira: [
          {
            selection: selection("acme.atlassian.net", "project = ABC", "Sanmoo/a"),
            tickets: jiraAdapter(readable),
            prerequisites: [{ type: "Blocks", direction: "inward" }],
          },
          {
            selection: selection("acme.atlassian.net", "labels = shared", "Sanmoo/a"),
            tickets: jiraAdapter(blind, {}),
            prerequisites: [{ type: "Blocks", direction: "inward" }],
          },
        ],
      },
      statusConfig(),
      layout,
      NO_WORKERS,
    );

    const [site] = view.jira;
    assert.equal(site?.state, "unreadable", "one unreadable selection holds the whole site");
    const text = renderStatus(view);
    assert.match(text, /acme\.atlassian\.net \(2 selections\) → Sanmoo\/a: unreadable \(/);
    assert.doesNotMatch(text, /prerequisites/, "no candidate line claims a verdict the unapplied rule could overturn");
  });

  test("the same Work selected by two selections for one destination is listed once", async () => {
    const sim = new JiraSim();
    sim.addIssue({ id: "10001", key: "ABC-1", summary: "One Work", labels: ["ready"] });

    const adapter = jiraAdapter(sim);
    const view = await deriveStatus(
      {
        github: new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" }),
        jira: [
          { selection: selection("acme.atlassian.net", "project = ABC", "Sanmoo/a"), tickets: adapter, prerequisites: [] },
          { selection: selection("acme.atlassian.net", "labels = ready", "Sanmoo/a"), tickets: adapter, prerequisites: [] },
        ],
      },
      statusConfig(),
      layout,
      NO_WORKERS,
    );

    const [site] = view.jira;
    if (site?.state !== "known") assert.fail("the site is readable");
    assert.deepEqual(
      site.candidates.map((candidate) => renderWorkIdentity(candidate.work)),
      ["ABC-1 (jira:acme.atlassian.net) → Sanmoo/a"],
    );
    assert.deepEqual(site.ambiguous, [], "one destination is not a conflict");
    assert.deepEqual(
      site.selections.map((entry) => (entry.state === "known" ? entry.selected : null)),
      [1, 1],
      "both selections did select the ticket; it is still one candidate",
    );
    const text = renderStatus(view);
    assert.match(text, /acme\.atlassian\.net \(2 selections\) → Sanmoo\/a: 1 candidate$/m);
  });

  test("equal readable keys on different sites stay distinct Works with their own browse URLs", async () => {
    const alpha = new JiraSim({ site: "alpha.atlassian.net" });
    alpha.addIssue({ id: "10001", key: "ABC-1", summary: "Alpha request" });
    const beta = new JiraSim({ site: "beta.atlassian.net" });
    beta.addIssue({ id: "10001", key: "ABC-1", summary: "Beta request" });

    const view = await deriveStatus(
      {
        github: new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" }),
        jira: [
          { selection: selection("beta.atlassian.net", "project = ABC", REPO), tickets: jiraAdapter(beta), prerequisites: [] },
          { selection: selection("alpha.atlassian.net", "project = ABC", REPO), tickets: jiraAdapter(alpha), prerequisites: [] },
        ],
      },
      statusConfig(),
      layout,
      NO_WORKERS,
    );

    assert.deepEqual(view.jira.map((site) => site.site), ["alpha.atlassian.net", "beta.atlassian.net"]);
    const candidates = view.jira.flatMap((site) => (site.state === "known" ? site.candidates : []));
    assert.equal(candidates.length, 2, "the same key/stable id on another site is another Work");
    assert.deepEqual(
      candidates.map((candidate) => ticketUrl(candidate.work.ticket)),
      [
        "https://alpha.atlassian.net/browse/ABC-1",
        "https://beta.atlassian.net/browse/ABC-1",
      ],
      "each candidate keeps its own site's browse URL",
    );
    const text = renderStatus(view);
    assert.match(text, /alpha\.atlassian\.net \(1 selection\)/);
    assert.match(text, /beta\.atlassian\.net \(1 selection\)/);
    assert.equal(
      (text.match(/^    1\. ABC-1 /gm) ?? []).length,
      2,
      "each site restarts its own numbering: no global order is implied across sites",
    );
  });

  test("two spellings of one destination are one destination, so the ticket is deduplicated", async () => {
    const sim = new JiraSim();
    sim.addIssue({ id: "10001", key: "ABC-1", summary: "One Work", labels: ["a", "b"] });
    sim.select = selectBy({
      "labels = a": (issue) => issue.labels.includes("a"),
      "labels = b": (issue) => issue.labels.includes("b"),
    });
    const adapter = jiraAdapter(sim);

    const view = await deriveStatus(
      {
        github: new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" }),
        jira: [
          // GitHub repository names are case-insensitive: the same repository,
          // so the repetition is the same Work and not a conflict.
          { selection: selection("acme.atlassian.net", "labels = b", "sanmoo/My-Tasks"), tickets: adapter, prerequisites: [] },
          { selection: selection("acme.atlassian.net", "labels = a", "Sanmoo/my-tasks"), tickets: adapter, prerequisites: [] },
        ],
      },
      statusConfig(),
      layout,
      NO_WORKERS,
    );

    const [site] = view.jira;
    if (site?.state !== "known") assert.fail("the site is readable");
    assert.deepEqual(site.candidates.map((candidate) => candidate.work.ticket.key), ["ABC-1"]);
    assert.deepEqual(site.ambiguous, [], "one repository is not two destinations");
    assert.equal(site.destinations.length, 1, "the destination is listed once");

    const reversed = await deriveStatus(
      {
        github: new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" }),
        jira: [
          { selection: selection("acme.atlassian.net", "labels = a", "Sanmoo/my-tasks"), tickets: adapter, prerequisites: [] },
          { selection: selection("acme.atlassian.net", "labels = b", "sanmoo/My-Tasks"), tickets: adapter, prerequisites: [] },
        ],
      },
      statusConfig(),
      layout,
      NO_WORKERS,
    );
    const [sameSite] = reversed.jira;
    if (sameSite?.state !== "known") assert.fail("the site is readable in either declaration order");
    assert.deepEqual(
      sameSite.destinations,
      site.destinations,
      "the spelling shown never depends on which selection was declared first",
    );
  });

  test("a site whose ordered union names a ticket no selection selected is unreadable, never that extra candidate", async () => {
    const sim = new JiraSim();
    sim.addIssue({ id: "10001", key: "ABC-1", summary: "Frontend", labels: ["frontend"] });
    sim.addIssue({ id: "10002", key: "ABC-2", summary: "Backend", labels: ["backend"] });
    sim.addIssue({ id: "10003", key: "ABC-3", summary: "Nobody's selection", labels: ["other"] });
    // The per-selection reads answer exactly, the site-wide union answers wider:
    // routing and order would come from different reads.
    sim.select = selectBy({
      "labels = frontend": (issue) => issue.labels.includes("frontend"),
      "labels = backend": (issue) => issue.labels.includes("backend"),
    });
    const adapter = jiraAdapter(sim);

    const view = await deriveStatus(
      {
        github: new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" }),
        jira: [
          { selection: selection("acme.atlassian.net", "labels = frontend", "Sanmoo/frontend"), tickets: adapter, prerequisites: [] },
          { selection: selection("acme.atlassian.net", "labels = backend", "Sanmoo/backend"), tickets: adapter, prerequisites: [] },
        ],
      },
      statusConfig(),
      layout,
      NO_WORKERS,
    );

    const [site] = view.jira;
    if (site?.state !== "unreadable") assert.fail("the disagreement leaves the site's order unreadable");
    assert.match(site.reason, /ordered result and its selections disagree/);
    assert.deepEqual(site.candidates, [], "no candidate is offered from reads that disagree");
    assert.deepEqual(site.ambiguous, []);
    const text = renderStatus(view);
    assert.doesNotMatch(text, /^    \d+\. ABC-/m, "no candidate line is invented from the wider read");
  });

  test("a Jira key and a GitHub issue number never stand in for one another at the status seam", async () => {
    const sim = new JiraSim();
    sim.addIssue({ id: "42", key: "ABC-42", summary: "Jira request" });
    const github = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedIssue(github, { repo: REPO, number: 42, labels: [DEFAULT_LABELS.ready] });

    const view = await deriveStatus(
      {
        github,
        jira: [
          { selection: selection("acme.atlassian.net", "project = ABC", REPO), tickets: jiraAdapter(sim), prerequisites: [] },
        ],
      },
      { ...statusConfig(), repos: [REPO] },
      layout,
      NO_WORKERS,
    );

    const [jira] = view.jira;
    if (jira?.state !== "known") assert.fail("the Jira site is readable");
    assert.equal(view.pool.length, 1);
    assert.equal(jira.candidates.length, 1);
    assert.deepEqual(
      [view.pool[0]?.work.ticket.provider, jira.candidates[0]?.work.ticket.provider],
      ["github", "jira"],
      "the readable suffix 42 is presentation; provider identity keeps the Works apart",
    );
    assert.deepEqual(
      [
        ticketUrl(view.pool[0]!.work.ticket),
        ticketUrl(jira.candidates[0]!.work.ticket),
      ],
      [
        "https://github.com/Sanmoo/my-tasks/issues/42",
        "https://acme.atlassian.net/browse/ABC-42",
      ],
      "each Work links to its own provider's ticket",
    );
  });

  test("a candidate waits for its configured prerequisites in the Done category while the others advance", async () => {
    const sim = new JiraSim();
    sim.addIssue({
      id: "10001",
      key: "ABC-1",
      summary: "Waits for its prerequisite",
      assignee: null,
      links: [{ type: "Blocks", side: "inward", key: "ABC-5" }],
    });
    sim.addIssue({ id: "10002", key: "ABC-2", summary: "Nothing to wait for", assignee: null });
    sim.addIssue({
      id: "10005",
      key: "ABC-5",
      summary: "Still in review",
      status: { name: "In Review", categoryKey: "indeterminate" },
    });

    const view = await deriveStatus(
      {
        github: new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" }),
        jira: [
          {
            selection: selection("acme.atlassian.net"),
            tickets: jiraAdapter(sim),
            prerequisites: [{ type: "Blocks", direction: "inward" }],
          },
        ],
      },
      statusConfig(),
      layout,
      NO_WORKERS,
    );

    const [listed] = view.jira;
    if (listed?.state !== "known") assert.fail("the selection is readable");
    assert.deepEqual(
      listed.candidates.map((candidate) => [candidate.work.ticket.key, candidate.prerequisites.state]),
      [
        ["ABC-1", "unmet"],
        ["ABC-2", "met"],
        // The sim does not model JQL, so the prerequisite is selected too.
        ["ABC-5", "met"],
      ],
      "a prerequisite outside Done holds its dependent, and only it",
    );

    const text = renderStatus(view);
    // The sim's JQL is not modelled, so the prerequisite itself is selected too.
    assert.match(text, /acme\.atlassian\.net \(1 selection\) → Sanmoo\/my-tasks: 3 candidates, 1 held by prerequisites/);
    assert.match(
      text,
      /1\. ABC-1 \(jira:acme\.atlassian\.net\) → Sanmoo\/my-tasks — Waits for its prerequisite — held by prerequisites: prerequisite ABC-5 \("In Review", outside the Done status category\)/,
      "the report says why the ticket cannot advance, past the JQL that selected it",
    );
    assert.match(text, /2\. ABC-2 .* — prerequisites: none on the ticket/);
    assert.deepEqual(
      sim.requests.map((request) => `${request.method} ${request.path}`),
      [
        "GET /rest/api/3/myself",
        "POST /rest/api/3/search/jql",
        "GET /rest/api/3/issueLinkType",
        "GET /rest/api/3/issue/10001",
        "GET /rest/api/3/issue/10002",
        "GET /rest/api/3/issue/10005",
      ],
      "the site's link types once, one link read per candidate, and no transitive read of the prerequisite",
    );
    assert.deepEqual(readdirSync(join(layout.works)), [], "status stays read-only");
  });

  test("a prerequisite whose status category is unknown names the fact that is missing", async () => {
    const sim = new JiraSim();
    sim.addIssue({
      id: "10001",
      key: "ABC-1",
      summary: "Waits for ABC-5",
      assignee: null,
      links: [{ type: "Blocks", side: "inward", key: "ABC-5" }],
    });
    sim.addIssue({ id: "10005", key: "ABC-5", summary: "Uncategorised", assignee: null });
    // The site names the prerequisite's status but sends no category the
    // adapter can read: the ticket is known, its completion is not.
    const transport: JiraTransport = async (url, init) => {
      const response = await sim.transport(url, init);
      if (!url.includes("/rest/api/3/issue/10001")) return response;
      return {
        status: 200,
        text: JSON.stringify({
          id: "10001",
          key: "ABC-1",
          fields: {
            issuelinks: [
              {
                id: "1",
                type: { name: "Blocks" },
                inwardIssue: { id: "10005", key: "ABC-5", fields: { status: { name: "Waiting" } } },
              },
            ],
          },
        }),
      };
    };
    const tickets = new JiraTicketAdapter({
      site: sim.site,
      account: sim.account.emailAddress,
      tokenEnv: TOKEN_ENV,
      env: { [TOKEN_ENV]: sim.token },
      transport,
    });

    const view = await deriveStatus(
      {
        github: new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" }),
        jira: [
          {
            selection: selection("acme.atlassian.net"),
            tickets,
            prerequisites: [{ type: "Blocks", direction: "inward" }],
          },
        ],
      },
      statusConfig(),
      layout,
      NO_WORKERS,
    );

    assert.match(
      renderStatus(view),
      /held by prerequisites: prerequisite ABC-5 \("Waiting", whose status category is unknown\)/,
      "the diagnosis names the missing category instead of claiming the whole status was unreadable",
    );
    assert.doesNotMatch(renderStatus(view), /ABC-5 \(its status could not be read\)/);
  });

  test("a Work two selections promise to one destination obeys the strictest of their rules", async () => {
    // One site, one tracker, two selections for the same destination: the one
    // that configures no rule must not hide the other's prerequisite.
    const sim = new JiraSim();
    sim.addIssue({
      id: "10001",
      key: "ABC-1",
      summary: "Shared by two selections",
      assignee: null,
      links: [{ type: "Blocks", side: "inward", key: "ABC-5" }],
    });
    sim.addIssue({
      id: "10005",
      key: "ABC-5",
      summary: "Still open",
      status: { name: "To Do", categoryKey: "new" },
    });
    const adapter = jiraAdapter(sim);

    const view = await deriveStatus(
      {
        github: new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" }),
        jira: [
          {
            selection: selection("acme.atlassian.net", "project = ABC", "Sanmoo/a"),
            tickets: adapter,
            prerequisites: [],
          },
          {
            selection: selection("acme.atlassian.net", "labels = shared", "Sanmoo/a"),
            tickets: adapter,
            prerequisites: [{ type: "Blocks", direction: "inward" }],
          },
        ],
      },
      statusConfig(),
      layout,
      NO_WORKERS,
    );

    const [site] = view.jira;
    if (site?.state !== "known") assert.fail("the site is readable");
    assert.deepEqual(
      site.candidates.map((candidate) => [candidate.work.ticket.key, candidate.prerequisites.state]),
      [
        ["ABC-1", "unmet"],
        ["ABC-5", "met"],
      ],
      "the shared Work is listed once and carries the stricter selection's verdict",
    );
    assert.match(renderStatus(view), /held by prerequisites: prerequisite ABC-5 \("To Do", outside the Done status category\)/);
  });

  test("a merged PR and the factory's archived history do not satisfy a Jira prerequisite still in QA", async () => {
    const github = new FakeTrackerAdapter({ workerAccount: "bot-do-samuca" });
    seedIssue(github, { repo: REPO, number: 5, labels: [DEFAULT_LABELS.claimed] });
    mkdirSync(workDir(layout, REPO, 5), { recursive: true });
    writeFileSync(join(workDir(layout, REPO, 5), "log-1.jsonl"), "{}\n", "utf8");
    // A merged PR whose issue is still open: the factory's own delivery fact.
    github.seedPullRequest({ repo: REPO, number: 5 });
    github.closePr({ repo: REPO, prNumber: 5 }, { merged: true });
    // And the factory already archived a delivered Work.
    mkdirSync(join(layout.archive, `${REPO}#6-2026-02-01`), { recursive: true });

    const sim = new JiraSim();
    sim.addIssue({
      id: "10001",
      key: "ABC-1",
      summary: "Waits for ABC-5",
      assignee: null,
      links: [{ type: "Blocks", side: "inward", key: "ABC-5" }],
    });
    sim.addIssue({
      id: "10005",
      key: "ABC-5",
      summary: "Still in QA",
      status: { name: "In Review", categoryKey: "indeterminate" },
      resolution: "Done",
    });

    const view = await deriveStatus(
      {
        github,
        jira: [
          {
            selection: selection("acme.atlassian.net"),
            tickets: jiraAdapter(sim),
            prerequisites: [{ type: "Blocks", direction: "inward" }],
          },
        ],
      },
      { ...statusConfig(), repos: [REPO] },
      layout,
      NO_WORKERS,
    );

    const reading = view.reserved.find((entry) => entry.key === `${REPO}#5`)?.reading;
    assert.equal(
      reading?.state,
      "done-fallback",
      "the factory sees the merge of its own PR while the GitHub issue is still open",
    );
    assert.match(renderStatus(view), /archived \(dones\): 1/);

    const [listed] = view.jira;
    if (listed?.state !== "known") assert.fail("the selection is readable");
    assert.deepEqual(
      listed.candidates.map((candidate) => [candidate.work.ticket.key, candidate.prerequisites.state]),
      [["ABC-1", "unmet"], ["ABC-5", "met"]],
      "the Jira prerequisite in QA still holds its dependent, whatever the factory merged",
    );
    assert.match(
      renderStatus(view),
      /1\. ABC-1 .* — held by prerequisites: prerequisite ABC-5 \("In Review", outside the Done status category\)/,
      "neither the merge nor the archive is the Jira issue's Done category",
    );
  });
});
