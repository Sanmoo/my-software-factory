import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runOnce, type LoopDeps } from "../loop.js";
import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { FakeWorkerRuntime, type ScriptedOutcome } from "../runtime/fake-runtime.js";
import { workBranchName, type GitWork, type PreparedWork } from "../git/port.js";
import type { IssueRef } from "../tracker/port.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import { DEFAULT_LABELS, type Config } from "../config.js";
import { DESFECHO_FILENAME } from "../state/outcome.js";
import { scanRegistry } from "../pool/registry.js";

/**
 * End-to-end of ticket 14: the derivation of the tick now covers the states
 * of ALL reserved works — the feedback round (human comment on the PR),
 * the retomada (human answer on the issue after the marker), the rejection
 * (PR closed without merge) and done (issue closed — linkage or fallback),
 * with the artifacts archived at done and the git host's cleanup called for
 * real. Launches prioritize the parked reserved works before new claims by
 * age. The two fake seams + real temp workspace: fast, deterministic, no
 * network, no container.
 */

const REPO = "Sanmoo/my-tasks";
const NOW = "2026-01-01T00:00:00Z";

/** A git-host fake that records every cleanup — the real one is exercised in the branch test below. */
class RecordingGitWork implements GitWork {
  readonly prepared: IssueRef[] = [];
  readonly cleaned: IssueRef[] = [];
  private count = 0;

  async prepareWork(ref: IssueRef): Promise<PreparedWork> {
    this.prepared.push(ref);
    this.count += 1;
    return {
      repoDir: `/clones/${ref.repo.replaceAll("/", "#")}`,
      branch: workBranchName(ref.number),
      baseBranch: "main",
      branchCreated: this.prepared.filter((r) => r.number === ref.number).length === 1,
    };
  }

  async cleanupDoneWork(ref: IssueRef): Promise<void> {
    this.cleaned.push(ref);
  }

  async diffWork(_ref: IssueRef): Promise<string> {
    return "diff --git a/x b/x\n+work";
  }

  get prepareCount(): number {
    return this.count;
  }
}

describe("e2e: the derivation of ALL reserved works (ticket 14)", () => {
  let dir: string;
  let layout: WorkspaceLayout;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-derive-"));
    layout = ensureWorkspace(join(dir, "ws"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeConfig(concurrency: number): Config {
    return {
      workerGhAccount: "bot-do-samuca",
      repos: [REPO],
      concurrency,
      workspace: layout.root,
      labels: { ...DEFAULT_LABELS },
      profileAllowedRoots: [],
      profileSkipDanglingLinks: false,
      configPath: join(dir, "msf.yaml"),
    };
  }

  function makeFactory(config: Config, outcomes: ScriptedOutcome[]) {
    const tracker = new FakeTrackerAdapter({ workerAccount: config.workerGhAccount });
    const runtime = new FakeWorkerRuntime({ tracker, outcomes });
    const git = new RecordingGitWork();
    return { tracker, runtime, git, deps: { config, tracker, runtime, git, workspace: layout, log: () => {} } as LoopDeps };
  }

  async function labelsOf(tracker: FakeTrackerAdapter, number: number): Promise<string[]> {
    const issue = await tracker.readIssue({ repo: REPO, number });
    assert.ok(issue.known, `issue #${number} should exist`);
    return issue.value.labels;
  }

  async function openPrOf(tracker: FakeTrackerAdapter, number: number): Promise<number | null> {
    const feedback = await tracker.readPrFeedback({ repo: REPO, number });
    assert.ok(feedback.known);
    return feedback.value.pr && feedback.value.pr.state === "open" ? feedback.value.pr.number : null;
  }

  // ---- checklist 1: human comment on the PR → feedback round, same branch, same PR ----

  test("a new human comment on the PR launches a feedback round on the SAME branch and the SAME PR", async () => {
    const config = makeConfig(2);
    const { tracker, runtime, deps } = makeFactory(config, ["pr-open"]);

    seedIssue(tracker, { repo: REPO, number: 1, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    // Attempt 1: the worker opens the PR and the work stays reserved.
    const first = await runOnce(deps);
    assert.equal(first.collected[0]?.ruling?.decision, "reserve");
    assert.equal(await openPrOf(tracker, 1), 1, "the PR opened");
    const labelsBefore = await labelsOf(tracker, 1);
    assert.ok(labelsBefore.includes(DEFAULT_LABELS.claimed), "the claim is held");

    // The human reviews: a new comment on the PR conversation.
    tracker.addPrComment({ repo: REPO, prNumber: 1 }, "humano", "please split the diff");

    // The next sweep derives the feedback round and launches it.
    const second = await runOnce(deps);
    assert.equal(second.launched.length, 1, "the feedback round was launched");
    assert.equal(second.launched[0]?.request.attempt, 2, "the registry numbered the round");
    assert.equal(second.launched[0]?.request.branch, workBranchName(1), "the SAME branch — never a new one");
    assert.equal(await openPrOf(tracker, 1), 1, "the SAME PR — no second PR");
    assert.ok((await labelsOf(tracker, 1)).includes(DEFAULT_LABELS.claimed), "the claim was never released");

    // The worker ends the round commenting on the PR (the norma): the next
    // sweep derives idle — no infinite re-rounding.
    const third = await runOnce(deps);
    assert.equal(third.launched.length, 0, "the round was addressed; the ball is with the human");
    assert.equal(runtime.launched.length, 2, "no thrash between sweeps");
  });

  test("an inline review comment reaches the worker prompt, not only the empty review shell", async () => {
    const config = makeConfig(1);
    const { tracker, deps } = makeFactory(config, ["pr-open"]);
    seedIssue(tracker, { repo: REPO, number: 2, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    await runOnce(deps);
    tracker.addReviewComment({ repo: REPO, prNumber: 1 }, "humano", "seja mais sucinto");

    const second = await runOnce(deps);
    const comments = second.launched[0]?.request.material.pr?.comments ?? [];
    assert.ok(comments.some((comment) => comment.body === "seja mais sucinto"));
  });

  // ---- checklist 2: human comment on a blocked issue after the marker → retomada ----

  test("a human answer on the issue AFTER the marker resumes the work from the existing branch", async () => {
    const config = makeConfig(2);
    const { tracker, runtime, deps } = makeFactory(config, ["clean-without-pr"]);

    seedIssue(tracker, { repo: REPO, number: 2, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    // Two consecutive falls → blocked with the marker comment.
    await runOnce(deps);
    const second = await runOnce(deps);
    assert.equal(second.collected[0]?.ruling?.decision, "block");
    assert.ok((await labelsOf(tracker, 2)).includes(DEFAULT_LABELS.blocked));

    // A human comment BEFORE the marker would not resume it; the answer
    // comes AFTER: the retomada is derived.
    tracker.addComment({ repo: REPO, number: 2 }, "humano", "the token was rotated — try again");

    const third = await runOnce(deps);
    assert.equal(third.launched.length, 1, "the retomada was launched");
    assert.equal(third.launched[0]?.request.attempt, 3, "the registry numbered the resumed attempt");
    assert.equal(third.launched[0]?.request.branch, workBranchName(2), "the retomada continues from the existing branch");

    // The fall count restarted with the human's answer: a new fall is a 1st
    // fall (release), not an immediate re-block.
    assert.equal(third.collected[0]?.ruling?.decision, "release", "the answer reset the consecutive count");
    const labels = await labelsOf(tracker, 2);
    assert.ok(!labels.includes(DEFAULT_LABELS.blocked), "blocked swapped away by the retomada");
    assert.ok(labels.includes(DEFAULT_LABELS.ready), "released back to the pool");
    assert.equal(runtime.launched.length, 3);
  });

  // ---- checklist 3: PR closed without merge → rejected, blocked with a comment pointing at the PR ----

  test("a PR closed without merge becomes blocked, with a comment pointing at the PR", async () => {
    const config = makeConfig(2);
    const { tracker, deps, git } = makeFactory(config, ["pr-open"]);

    seedIssue(tracker, { repo: REPO, number: 3, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    const first = await runOnce(deps);
    assert.equal(first.collected[0]?.ruling?.decision, "reserve");
    const prNumber = await openPrOf(tracker, 3);
    assert.ok(prNumber);

    // The human rejects: closes the PR without merging.
    tracker.closePr({ repo: REPO, prNumber }, { merged: false });

    const second = await runOnce(deps);
    assert.equal(second.launched.length, 0, "a rejected work launches nothing");
    const labels = await labelsOf(tracker, 3);
    assert.ok(labels.includes(DEFAULT_LABELS.blocked), "the work is blocked");
    assert.ok(!labels.includes(DEFAULT_LABELS.claimed), "claimed swapped away");
    const comments = await tracker.readComments({ repo: REPO, number: 3 });
    assert.ok(comments.known);
    const rejection = comments.value.at(-1);
    assert.ok(rejection);
    assert.match(rejection.body, /PR #\d+/, "the comment points at the PR");
    assert.match(rejection.body, /closed without merging/);

    // No thrash: the handled rejection stays parked on the next sweeps.
    assert.equal(git.cleaned.length, 0, "a rejection is not a done — nothing is cleaned");
    const third = await runOnce(deps);
    assert.equal(third.launched.length, 0);
  });

  // ---- checklist 4: done — issue closed by linkage, and by the fallback ----

  test("done by linkage: the human's merge closes the issue — artifacts archived, branches cleaned", async () => {
    const config = makeConfig(2);
    const { tracker, deps, git } = makeFactory(config, ["pr-open"]);

    seedIssue(tracker, { repo: REPO, number: 4, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    const first = await runOnce(deps);
    assert.equal(first.collected[0]?.ruling?.decision, "reserve");
    assert.ok(existsSync(join(workDir(layout, REPO, 4), DESFECHO_FILENAME)), "the artifacts survive until done");

    // The human merges — the linkage closes the issue: done is the issue's state.
    tracker.closeIssue({ repo: REPO, number: 4 }, "completed");

    const second = await runOnce(deps);
    assert.equal(second.launched.length, 0, "a done work launches nothing");

    // The archive: the work dir MOVED out of trabalhos/ — nothing deleted.
    assert.ok(!existsSync(workDir(layout, REPO, 4)), "the work dir left trabalhos/");
    const view = await scanRegistry(layout);
    assert.equal(view.archived.length, 1, "the artifacts live in the archive now");
    assert.match(view.archived[0]!, /arquivo\/Sanmoo\/my-tasks#4-\d{4}-\d{2}-\d{2}$/);
    assert.ok(existsSync(join(view.archived[0]!, DESFECHO_FILENAME)), "the desfecho survived the move");
    assert.deepEqual(git.cleaned, [{ repo: REPO, number: 4 }], "the git host cleaned the work's branches");
  });

  test("done by fallback: a merged PR whose issue stayed open — the sweep closes it with a short comment, then archives", async () => {
    const config = makeConfig(2);
    const { tracker, deps, git } = makeFactory(config, ["pr-open"]);

    seedIssue(tracker, { repo: REPO, number: 5, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    await runOnce(deps);
    const prNumber = await openPrOf(tracker, 5);
    assert.ok(prNumber);

    // The human merges but forgets to close the issue (no linkage).
    tracker.closePr({ repo: REPO, prNumber }, { merged: true });

    const second = await runOnce(deps);

    // The fallback: the factory closed the issue with a short comment.
    const issue = await tracker.readIssue({ repo: REPO, number: 5 });
    assert.ok(issue.known && issue.value.state === "closed" && issue.value.stateReason === "completed");
    const comments = await tracker.readComments({ repo: REPO, number: 5 });
    assert.ok(comments.known);
    const last = comments.value.at(-1);
    assert.ok(last);
    assert.match(last.body, /merged without closing/i, "the short fallback comment");
    assert.ok(last.body.includes("<!-- msf:agent -->"), "the factory's write carries the marker");

    // And the done duties landed: artifacts archived, branches cleaned.
    assert.ok(!existsSync(workDir(layout, REPO, 5)), "the work dir left trabalhos/");
    assert.deepEqual(git.cleaned, [{ repo: REPO, number: 5 }], "the git host cleaned the work's branches");
  });

  // ---- checklist 2 (rejection branch): the rejected work's retomada reopens the SAME PR ----

  test("a rejected work answered on the issue resumes from the existing branch and reopens the SAME PR", async () => {
    const config = makeConfig(2);
    const { tracker, deps } = makeFactory(config, ["pr-open"]);

    seedIssue(tracker, { repo: REPO, number: 6, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });

    await runOnce(deps);
    const prNumber = await openPrOf(tracker, 6);
    assert.ok(prNumber);

    // The rejection: the human closes the PR without merging.
    tracker.closePr({ repo: REPO, prNumber }, { merged: false });
    await runOnce(deps); // derived rejected → blocked with the pointer comment
    assert.ok((await labelsOf(tracker, 6)).includes(DEFAULT_LABELS.blocked));

    // The human answers the issue AFTER the marker: the retomada swaps
    // blocked→claimed and reopens the SAME PR (never a new one).
    tracker.addComment({ repo: REPO, number: 6 }, "humano", "reopened by request — try again");
    const resumed = await runOnce(deps);

    assert.equal(resumed.launched.length, 1, "the retomada was launched");
    assert.equal(resumed.launched[0]?.request.attempt, 2);
    const labels = await labelsOf(tracker, 6);
    assert.ok(!labels.includes(DEFAULT_LABELS.blocked), "blocked swapped away");
    assert.ok(labels.includes(DEFAULT_LABELS.claimed), "the claim is held again");
    assert.equal(await openPrOf(tracker, 6), prNumber, "the SAME PR reopened — no PR novo");
  });

  // ---- checklist 5: parked reserved works launch BEFORE new claims, by age ----

  test("parked reserved works (feedback, retomada) launch before new claims, each group by creation age", async () => {
    const config = makeConfig(2);
    const { tracker, deps } = makeFactory(config, ["pr-open"]);

    seedIssue(tracker, { repo: REPO, number: 10, createdAt: "2026-01-05T00:00:00Z", labels: [DEFAULT_LABELS.ready] });
    const first = await runOnce(deps);
    assert.equal(first.launched[0]?.request.ref.number, 10, "the work was claimed and its PR opened");

    // Now: a feedback round due on #10, plus two fresh eligibles — the older
    // issue #1 first by age.
    seedIssue(tracker, { repo: REPO, number: 1, createdAt: "2026-01-01T00:00:00Z", labels: [DEFAULT_LABELS.ready] });
    seedIssue(tracker, { repo: REPO, number: 2, createdAt: "2026-01-02T00:00:00Z", labels: [DEFAULT_LABELS.ready] });
    tracker.addPrComment({ repo: REPO, prNumber: 1 }, "humano", "feedback on #10's PR");

    const second = await runOnce(deps);
    assert.deepEqual(
      tracker.claimedOrder,
      [`${REPO}#10`, `${REPO}#1`, `${REPO}#2`],
      "the parked feedback round is reserved first, then new claims by age",
    );
    assert.equal(second.launched.length, 3, "y=2: the feedback round and the oldest claim first, #3 renews a freed slot");
    assert.equal(second.launched.find((r) => r.request.ref.number === 10)?.request.attempt, 2, "the registry numbered the round");
  });

  // ---- checklist 6: the orphan claim (ticket 18) — a death between the claim and the spawn is an abrupt fall ----

  test("an orphan claim with zero footprint is released by the sweep, then re-claimed and launched as attempt 1", async () => {
    const config = makeConfig(2);
    const { tracker, runtime, deps } = makeFactory(config, ["pr-open"]);

    // The death scene (sweep #1): the work was claimed and the process died
    // before any spawn — the tracker holds the claim, the registry dir is
    // empty (no log-*.jsonl, no sessao/, no desfecho.json): zero footprint.
    seedIssue(tracker, { repo: REPO, number: 7, createdAt: NOW, labels: [DEFAULT_LABELS.ready] });
    await tracker.claim({ repo: REPO, number: 7 }, config.workerGhAccount, DEFAULT_LABELS.ready);
    mkdirSync(workDir(layout, REPO, 7), { recursive: true });

    // Sweep #2 (--once): the orphan is an abrupt fall — released back to the
    // pool in the very same sweep, then re-claimed and launched as attempt 1.
    const sweep = await runOnce(deps);
    const fall = sweep.reserved.find((decision) => decision.ref.number === 7);
    assert.ok(fall, "the orphan was derived as a reserved work");
    assert.equal(fall.state, "fall", "the orphan claim is an abrupt fall (story 22)");
    assert.ok(fall.state === "fall" && fall.decision === "release", "1st fall: release");

    assert.equal(runtime.launched.length, 1, "the released work was picked up again in the same sweep");
    assert.equal(runtime.launched[0]?.attempt, 1, "the registry honestly reports attempt 1 (zero evidence)");
    assert.ok((await labelsOf(tracker, 7)).includes(DEFAULT_LABELS.claimed), "re-claimed by this sweep");
    assert.ok(!(await labelsOf(tracker, 7)).includes(DEFAULT_LABELS.ready), "never stuck claimed-and-idle again");
  });
});
