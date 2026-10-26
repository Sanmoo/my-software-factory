import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeTrackerAdapter, seedIssue } from "../tracker/fake-adapter.js";
import { githubRepository, githubSelections, githubTicket, jiraTicket, workIdentity } from "../tracker/identity.js";
import { githubTicketNumber, githubTicketRepo } from "../e2e/work-fixtures.js";
import { notKnown, type Blocker, type IssueRef, type Known } from "../tracker/port.js";
import {
  BLOCKER_READS_IN_FLIGHT,
  deriveTrackerState,
  renderUnbackedClaim,
  renderUnmarkedReservation,
} from "./derive.js";
import { DEFAULT_LABELS, DEFAULT_MODEL_PROVIDER_BUDGET, DEFAULT_RECOVERY_BUDGET } from "../config.js";
import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import { openWorkState } from "../work-state/state.js";

/** The pool-only view over the single derivation, for the tests of the pool's rules. */
const derivePool = async (
  port: FakeTrackerAdapter,
  repos: string[],
  labels = DEFAULT_LABELS,
) => (await deriveTrackerState(port, githubSelections(repos), labels)).pool;

/** A tracker whose blocker read costs real time, as the REST one does: the
 *  derivation must not await them one at a time. `unreadable`
 *  answers unknown for a work, pinning that unknown never unblocks. */
class SlowBlockerTracker extends FakeTrackerAdapter {
  /** The most blocker reads this tracker ever had in flight at once. */
  peakInFlight = 0;
  private inFlight = 0;

  constructor(
    private readonly delayMs: number,
    private readonly unreadable: ReadonlySet<number> = new Set(),
  ) {
    super({ workerAccount: "bot" });
  }

  override async readBlockers(ref: IssueRef): Promise<Known<Blocker[]>> {
    this.inFlight += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.inFlight -= 1;
    if (this.unreadable.has(ref.number)) return notKnown;
    return super.readBlockers(ref);
  }
}

describe("derive — the pool of eligible works, stateless re-read", () => {
  let adapter: FakeTrackerAdapter;
  const repos = ["Sanmoo/a", "Sanmoo/b"];

  beforeEach(() => {
    adapter = new FakeTrackerAdapter({ workerAccount: "bot" });
  });

  test("an issue with the ready label and no blockers is eligible", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1, labels: [DEFAULT_LABELS.ready] });

    const pool = await derivePool(adapter, repos, DEFAULT_LABELS);

    assert.deepEqual(
      pool.map((entry) => `${githubTicketRepo(entry.work.ticket)}#${githubTicketNumber(entry.work.ticket)}`),
      ["Sanmoo/a#1"],
    );
  });

  test("equal createdAt keep GitHub's historical repo-then-number order (#2 before #10)", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 10, labels: [DEFAULT_LABELS.ready], createdAt: "2026-01-01T00:00:00Z" });
    seedIssue(adapter, { repo: "Sanmoo/a", number: 2, labels: [DEFAULT_LABELS.ready], createdAt: "2026-01-01T00:00:00Z" });

    const pool = await derivePool(adapter, ["Sanmoo/a"], DEFAULT_LABELS);

    assert.deepEqual(
      pool.map((entry) => githubTicketNumber(entry.work.ticket)),
      [2, 10],
    );
  });

  test("an issue without the ready label is not in the pool", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1, labels: ["other"] });
    const pool = await derivePool(adapter, repos, DEFAULT_LABELS);
    assert.deepEqual(pool, []);
  });

  test("an issue with an open blocker is not eligible", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1, labels: [DEFAULT_LABELS.ready] });
    seedIssue(adapter, { repo: "Sanmoo/a", number: 2 }); // open blocker
    adapter.addBlocker({ repo: "Sanmoo/a", number: 1 }, { repo: "Sanmoo/a", number: 2 });

    const pool = await derivePool(adapter, repos, DEFAULT_LABELS);
    assert.deepEqual(pool, []);
  });

  test("an issue whose blockers are all closed is eligible", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1, labels: [DEFAULT_LABELS.ready] });
    seedIssue(adapter, { repo: "Sanmoo/a", number: 2, state: "closed" });
    adapter.addBlocker({ repo: "Sanmoo/a", number: 1 }, { repo: "Sanmoo/a", number: 2 });

    const pool = await derivePool(adapter, repos, DEFAULT_LABELS);
    assert.equal(pool.length, 1);
  });

  test("unknown blockers (unknown issue) never count as 'without impediment'", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1, labels: [DEFAULT_LABELS.ready] });
    adapter.addBlocker({ repo: "Sanmoo/a", number: 1 }, { repo: "Sanmoo/a", number: 999 });

    const pool = await derivePool(adapter, repos, DEFAULT_LABELS);
    assert.deepEqual(pool, []);
  });

  test("an issue already claimed by the worker account is not in the pool", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1, labels: [DEFAULT_LABELS.ready] });
    await adapter.claim({ repo: "Sanmoo/a", number: 1 }, "bot");

    const pool = await derivePool(adapter, repos, DEFAULT_LABELS);
    assert.deepEqual(pool, []);
  });

  test("the pool is ordered by createdAt — eligible the longest first", async () => {
    seedIssue(adapter, {
      repo: "Sanmoo/a",
      number: 1,
      labels: [DEFAULT_LABELS.ready],
      createdAt: "2026-01-03T00:00:00Z",
    });
    seedIssue(adapter, {
      repo: "Sanmoo/b",
      number: 2,
      labels: [DEFAULT_LABELS.ready],
      createdAt: "2026-01-01T00:00:00Z",
    });
    seedIssue(adapter, {
      repo: "Sanmoo/a",
      number: 3,
      labels: [DEFAULT_LABELS.ready],
      createdAt: "2026-01-02T00:00:00Z",
    });

    const pool = await derivePool(adapter, repos, DEFAULT_LABELS);

    assert.deepEqual(
      pool.map((entry) => githubTicketNumber(entry.work.ticket)),
      [2, 3, 1],
    );
  });

  test("many candidates cost a few blocker round-trips, not their sum — with the same results", async () => {
    const candidates = 12;
    const DELAY_MS = 250;
    // The oldest keeps an open blocker, another's blockers are unreadable, and
    // the
    // other ten are eligible: the reads must run concurrently while every
    // verdict stays what it was.
    const tracker = new SlowBlockerTracker(DELAY_MS, new Set([7]));
    for (let number = 1; number <= candidates; number += 1) {
      seedIssue(tracker, {
        repo: "Sanmoo/a",
        number,
        labels: [DEFAULT_LABELS.ready],
        createdAt: `2026-01-${String(number).padStart(2, "0")}T00:00:00Z`,
      });
    }
    seedIssue(tracker, { repo: "Sanmoo/a", number: 90 }); // the open blocker
    tracker.addBlocker({ repo: "Sanmoo/a", number: 1 }, { repo: "Sanmoo/a", number: 90 });

    const state = await deriveTrackerState(tracker, githubSelections(["Sanmoo/a"]), DEFAULT_LABELS);

    assert.deepEqual(
      state.pool.map((entry) => githubTicketNumber(entry.work.ticket)),
      [2, 3, 4, 5, 6, 8, 9, 10, 11, 12],
      "a blocked or unreadable work is still out, and the rest keep their order",
    );
    // The reads overlap up to the bound and never past it — a fact of how many
    // were in flight, never of how fast this machine ran them.
    assert.equal(tracker.peakInFlight, Math.min(candidates, BLOCKER_READS_IN_FLIGHT));
  });

  test("the pool spans all target repos of the config", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1, labels: [DEFAULT_LABELS.ready] });
    seedIssue(adapter, { repo: "Sanmoo/b", number: 9, labels: [DEFAULT_LABELS.ready] });
    seedIssue(adapter, { repo: "Sanmoo/other", number: 5, labels: [DEFAULT_LABELS.ready] });

    const pool = await derivePool(adapter, repos, DEFAULT_LABELS);

    assert.deepEqual(
      new Set(pool.map((entry) => githubTicketRepo(entry.work.ticket))),
      new Set(["Sanmoo/a", "Sanmoo/b"]),
    );
  });

  test("an empty tracker derives an empty pool", async () => {
    const pool = await derivePool(adapter, repos, DEFAULT_LABELS);
    assert.deepEqual(pool, []);
  });

  test("the neutral read is filtered by the derivation: ready in, non-ready/claimed/PR-linked out", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1, labels: [DEFAULT_LABELS.ready] });
    seedIssue(adapter, { repo: "Sanmoo/a", number: 2, labels: ["other"] });
    seedIssue(adapter, { repo: "Sanmoo/a", number: 3, labels: [DEFAULT_LABELS.ready, DEFAULT_LABELS.blocked] });
    seedIssue(adapter, { repo: "Sanmoo/a", number: 4, labels: [DEFAULT_LABELS.ready] });
    adapter.seedPullRequest({ repo: "Sanmoo/a", number: 4, state: "open" });
    seedIssue(adapter, { repo: "Sanmoo/a", number: 5, labels: [DEFAULT_LABELS.ready] });
    adapter.seedPullRequest({ repo: "Sanmoo/a", number: 5, state: "closed" });

    const pool = await derivePool(adapter, repos, DEFAULT_LABELS);

    assert.deepEqual(
      pool.map((entry) => githubTicketNumber(entry.work.ticket)),
      [1, 5],
      "only the plain ready issue and the closed-PR issue are eligible",
    );
  });

  test("the pool derivation reads each repo's open issues once and never re-reads a candidate's issue", async () => {
    seedIssue(adapter, { repo: "Sanmoo/a", number: 1, labels: [DEFAULT_LABELS.ready] });
    seedIssue(adapter, { repo: "Sanmoo/a", number: 2, labels: ["other"] });
    seedIssue(adapter, { repo: "Sanmoo/b", number: 3, labels: [DEFAULT_LABELS.ready] });

    const before = adapter.readCost();
    const pool = await derivePool(adapter, repos, DEFAULT_LABELS);
    const after = adapter.readCost();

    assert.equal(pool.length, 2);
    assert.equal(
      after.issueListings - before.issueListings,
      repos.length,
      "one neutral open-issues read per target repo",
    );
    assert.equal(after.issueReads - before.issueReads, 0, "eligibility never re-reads a candidate's issue");
  });
});

describe("derive — the tracker↔workspace leftovers, from the same single read ", () => {
  let adapter: FakeTrackerAdapter;
  const REPO = "Sanmoo/a";
  const repos = [REPO];
  const keys = (...numbers: number[]) => new Set(numbers.map((n) => `${REPO}#${n}`));

  beforeEach(() => {
    adapter = new FakeTrackerAdapter({ workerAccount: "bot" });
  });

  test("an unbacked claim on a non-GitHub ticket offers no fictional GitHub command", () => {
    const jira = workIdentity(
      jiraTicket({ site: "acme.atlassian.net", stableId: "10001", key: "ABC-1" }),
      githubRepository("Sanmoo/a"),
    );
    const line = renderUnbackedClaim({ work: jira, command: null });

    assert.match(line, /ABC-1/);
    assert.match(line, /not a GitHub issue/);
    assert.doesNotMatch(line, /gh issue edit/, "a Jira ticket gets no GitHub issue command");
  });

  test("an open issue with the claim label and no reservation is an unbacked claim, with a copyable release command", async () => {
    seedIssue(adapter, { repo: REPO, number: 1, labels: [DEFAULT_LABELS.claimed] });
    await adapter.claim({ repo: REPO, number: 1 }, "bot", DEFAULT_LABELS.ready);

    const state = await deriveTrackerState(adapter, githubSelections(repos), DEFAULT_LABELS);

    assert.deepEqual(state.pool, []);
    assert.equal(state.unbackedClaims.length, 1);
    assert.equal(githubTicketNumber(state.unbackedClaims[0]!.work.ticket), 1);
    assert.equal(
      state.unbackedClaims[0]?.command!,
      `gh issue edit 1 --repo ${REPO} --add-label ${DEFAULT_LABELS.ready} --remove-label ${DEFAULT_LABELS.claimed} --remove-assignee bot`,
    );
    const line = renderUnbackedClaim(state.unbackedClaims[0]!);
    assert.match(line, /unbacked claim: Sanmoo\/a#1/);
    assert.match(line, /another factory or workspace may hold this claim/);
    assert.match(line, /gh issue edit 1/);
  });

  test("the release command drops every assignee, not only the worker's — an assigned work is never eligible", async () => {
    seedIssue(adapter, { repo: REPO, number: 10, labels: [DEFAULT_LABELS.claimed] });
    await adapter.claim({ repo: REPO, number: 10 }, "humano");

    const state = await deriveTrackerState(adapter, githubSelections(repos), DEFAULT_LABELS);

    assert.match(state.unbackedClaims[0]!.command!, /--remove-assignee humano/);
  });

  test("the blocked label is a claim mark too — an unbacked block is reported like an unbacked claim", async () => {
    seedIssue(adapter, { repo: REPO, number: 2, labels: [DEFAULT_LABELS.blocked] });

    const state = await deriveTrackerState(adapter, githubSelections(repos), DEFAULT_LABELS);

    assert.equal(state.unbackedClaims.length, 1);
    assert.match(state.unbackedClaims[0]!.command!, /--remove-label agent-blocked/);
  });

  test("a claim with a reservation in this workspace is normal — never a leftover", async () => {
    seedIssue(adapter, { repo: REPO, number: 3, labels: [DEFAULT_LABELS.claimed] });

    const state = await deriveTrackerState(adapter, githubSelections(repos), DEFAULT_LABELS, keys(3));

    assert.deepEqual(state.unbackedClaims, []);
    assert.deepEqual(state.unmarkedReservations, []);
  });

  test("a work this process is launching right now is never reported", async () => {
    seedIssue(adapter, { repo: REPO, number: 4, labels: [DEFAULT_LABELS.claimed] });

    const state = await deriveTrackerState(adapter, githubSelections(repos), DEFAULT_LABELS, new Set(), keys(4));

    assert.deepEqual(state.unbackedClaims, []);
    assert.deepEqual(state.unmarkedReservations, []);
  });

  test("an unmarked reservation is reported as a fact, without a command", async () => {
    seedIssue(adapter, { repo: REPO, number: 5, labels: ["outra-etiqueta"] });

    const state = await deriveTrackerState(adapter, githubSelections(repos), DEFAULT_LABELS, keys(5));

    assert.equal(state.unmarkedReservations.length, 1);
    assert.equal(githubTicketNumber(state.unmarkedReservations[0]!.work.ticket), 5);
    const line = renderUnmarkedReservation(state.unmarkedReservations[0]!);
    assert.match(line, /unmarked reservation: Sanmoo\/a#5/);
    assert.match(line, /no factory mark/);
    assert.doesNotMatch(line, /gh issue edit/, "the human decision has no safe command");
  });

  test("a released reservation (pool label back) is normal — never reported", async () => {
    seedIssue(adapter, { repo: REPO, number: 6, labels: [DEFAULT_LABELS.ready] });

    const state = await deriveTrackerState(adapter, githubSelections(repos), DEFAULT_LABELS, keys(6));

    assert.deepEqual(state.unmarkedReservations, []);
    assert.deepEqual(state.unbackedClaims, []);
    assert.deepEqual(state.pool.map((entry) => githubTicketNumber(entry.work.ticket)), [6]);
  });

  test("an unmarked reservation whose issue is closed is the done derivation's business, not a leftover", async () => {
    seedIssue(adapter, { repo: REPO, number: 7, state: "closed", stateReason: "completed" });

    const state = await deriveTrackerState(adapter, githubSelections(repos), DEFAULT_LABELS, keys(7));

    assert.deepEqual(state.unmarkedReservations, []);
  });

  test("the leftovers come from the same single read per repo — no extra listing, no per-issue reread", async () => {
    seedIssue(adapter, { repo: REPO, number: 8, labels: [DEFAULT_LABELS.claimed] });
    seedIssue(adapter, { repo: REPO, number: 9, labels: [] });

    const before = adapter.readCost();
    const state = await deriveTrackerState(adapter, githubSelections([REPO, "Sanmoo/b"]), DEFAULT_LABELS, keys(9));
    const after = adapter.readCost();

    assert.equal(state.unbackedClaims.length, 1);
    assert.equal(state.unmarkedReservations.length, 1);
    assert.equal(after.issueListings - before.issueListings, 2, "one open-issues read per target repo");
    assert.equal(after.issueReads - before.issueReads, 0, "the leftovers never re-read a candidate's issue");
  });
});

describe("a human answer stays bound to the pause it answered", () => {
  let adapter: FakeTrackerAdapter;
  let root: string;
  let layout: WorkspaceLayout;
  const REPO = "Sanmoo/a";
  const PAUSE_ID = "6f1c9a2e-1c1f-4f6b-9a1b-2f0f0b7c1111";
  const marker = `<!-- msf:pause:${PAUSE_ID} -->`;
  const ref = (number: number) => ({ repo: REPO, number });
  const work = (number: number) => ({
    ticket: githubTicket(REPO, number),
    destination: githubRepository(REPO),
  });

  beforeEach(() => {
    adapter = new FakeTrackerAdapter({ workerAccount: "bot" });
    root = mkdtempSync(join(tmpdir(), "msf-derive-pause-"));
    layout = ensureWorkspace(join(root, "ws"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** The pause the loop persisted for the blocked work (a real artifact). */
  function persistPause(number: number, overrides: Record<string, unknown> = {}): string {
    const dir = workDir(layout, REPO, number);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "log-1.jsonl"), "{}\n", "utf8");
    writeFileSync(
      join(dir, "pausa.json"),
      JSON.stringify({
        version: 1,
        work: ref(number),
        attempt: 1,
        reason: "effect-ambiguous",
        detail: "an interrupted external effect is ambiguous",
        at: "2026-01-01T00:00:00.000Z",
        id: PAUSE_ID,
        announced: true,
        ...overrides,
      }),
      "utf8",
    );
    return dir;
  }

  async function deriveOne(number: number) {
    const derived = await openWorkState({
      tickets: adapter,
      pullRequests: adapter,
      workspace: layout,
      labels: DEFAULT_LABELS,
      workerAccount: "bot",
      recovery: DEFAULT_RECOVERY_BUDGET,
      modelProvider: DEFAULT_MODEL_PROVIDER_BUDGET,
      inFlight: new Set(),
    }).beforeLaunch({ work: work(number), dir: workDir(layout, REPO, number) });
    assert.ok(derived, "the work was derived");
    return derived;
  }

  test("a later factory comment about the same pause does not displace the answer", async () => {
    seedIssue(adapter, { repo: REPO, number: 40, labels: [DEFAULT_LABELS.blocked] });
    persistPause(40);
    await adapter.comment(ref(40), `${marker}\nthe interrupted attempt 1 cannot be continued safely`);
    adapter.addComment(ref(40), "operator", "I pushed the commit abc123");
    // The factory speaks again about the SAME pause (a diagnostic, a
    // re-assertion): the answer is still the answer to the request.
    await adapter.comment(ref(40), `${marker}\nthe facts were checked again`);

    const derived = await deriveOne(40);

    assert.equal(derived.state, "resumable");
    assert.equal(derived.state === "resumable" && derived.issueReplies.length, 1);
    assert.deepEqual(
      derived.state === "resumable" && derived.issueReplies.map((comment) => comment.body),
      ["I pushed the commit abc123"],
    );
  });

  test("an answer posted before the pause request is not an answer to it", async () => {
    seedIssue(adapter, { repo: REPO, number: 41, labels: [DEFAULT_LABELS.blocked] });
    persistPause(41);
    adapter.addComment(ref(41), "operator", "context: the key was rotated");
    await adapter.comment(ref(41), `${marker}\nthe interrupted attempt 1 cannot be continued safely`);

    const derived = await deriveOne(41);

    assert.equal(derived.state, "continuity-paused", "the pause asked AFTER the answer: nothing answers it yet");
  });

  test("a pause whose request never landed consumes no answer — it is not on the issue to answer", async () => {
    seedIssue(adapter, { repo: REPO, number: 42, labels: [DEFAULT_LABELS.blocked] });
    persistPause(42);
    await adapter.comment(ref(42), "an earlier factory message that carries no pause marker");
    adapter.addComment(ref(42), "operator", "I think this is fine?");

    const derived = await deriveOne(42);

    assert.equal(
      derived.state,
      "continuity-paused",
      "an answer to an older message is never read as the answer to this pause — the pause stays current",
    );
  });

  test("another blocked cause keeps the generic rule: a later factory comment parks the answer", async () => {
    seedIssue(adapter, { repo: REPO, number: 43, labels: [DEFAULT_LABELS.blocked] });
    mkdirSync(workDir(layout, REPO, 43), { recursive: true });
    await adapter.comment(ref(43), "worker blocked after 2 consecutive falls (attempt 1)");
    adapter.addComment(ref(43), "operator", "try again");
    await adapter.comment(ref(43), "the fall was recorded");

    const derived = await deriveOne(43);

    assert.equal(derived.state, "parked", "a fall block has no request identity: the last marker still rules");
  });
});
