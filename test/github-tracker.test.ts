import assert from "node:assert/strict";
import test from "node:test";
import { coreRules, evaluateEligibility } from "../src/core/eligibility.js";
import { GitHubTracker, type GitHubBoundary } from "../src/tracker/github.js";
import { PartialWriteError, type BlockerRef, type IssueRef, type TrackerScope } from "../src/tracker/port.js";
import { ACCOUNT, FakeGitHub, REPO } from "./support/fake-github.js";

const scope: TrackerScope = { project: REPO, readyLabel: "ready-for-agent" };
const ref = (id: number | string): IssueRef => ({ tracker: "github", project: REPO, id: String(id) });
const tracker = (gh: FakeGitHub) => new GitHubTracker({ account: ACCOUNT, claimedLabel: "agent-claimed", boundary: gh });

test("discovery follows every page and returns only open ready issues, never pull requests", async () => {
  const gh = new FakeGitHub();
  for (let number = 1; number <= 120; number++) gh.add({ number, labels: ["ready-for-agent"] });
  gh.add({ number: 121, labels: ["ready-for-agent"], pullRequest: true });
  gh.add({ number: 122, labels: ["ready-for-agent"], state: "closed" });
  gh.add({ number: 123, labels: ["other"] });

  const found = await tracker(gh).discoverCandidates(scope);

  assert.equal(found.length, 120);
  assert.deepEqual(found[0], ref(1));
  assert.deepEqual(found[119], ref(120));
  const listPages = gh.calls.filter((call) => call.method === "GET" && call.path === `/repos/${REPO}/issues`);
  assert.equal(listPages.length, 2, "120 ready issues need two pages of 100");
});

test("discovery uses the configured ready label name", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["pronta-para-agente"] });
  gh.add({ number: 2, labels: ["ready-for-agent"] });

  const found = await tracker(gh).discoverCandidates({ project: REPO, readyLabel: "pronta-para-agente" });

  assert.deepEqual(found, [ref(1)]);
});

test("readIssue reads the body of the issue; an empty GitHub body is empty text, not an unknown one", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, body: "Implementar slugify.\n\nVer docs/spec.md" });
  gh.add({ number: 2 });
  const adapter = tracker(gh);

  assert.deepEqual((await adapter.readIssue(ref(1))).body, { known: true, value: "Implementar slugify.\n\nVer docs/spec.md" });
  assert.deepEqual((await adapter.readIssue(ref(2))).body, { known: true, value: "" });
});

test("claimed is true for any assignee or for the claimed label, and false otherwise", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent"], assignees: ["human"] });
  gh.add({ number: 2, labels: ["ready-for-agent", "agent-claimed"] });
  gh.add({ number: 3, labels: ["ready-for-agent"] });
  const adapter = tracker(gh);

  const claimed = [1, 2, 3].map(async (n) => (await adapter.readIssue(ref(n))).claimed);

  assert.deepEqual(await Promise.all(claimed), [
    { known: true, value: true },
    { known: true, value: true },
    { known: true, value: false },
  ]);
});

test("open blockers are non-terminal and closed blockers are terminal", async () => {
  const gh = new FakeGitHub();
  const open = gh.add({ number: 2 });
  const closed = gh.add({ number: 3, state: "closed", stateReason: "completed" });
  gh.add({ number: 1, labels: ["ready-for-agent"], blockedBy: [open.dbId, closed.dbId] });

  const snapshot = await tracker(gh).readIssue(ref(1));

  assert.deepEqual(snapshot.blockers, {
    known: true,
    value: [
      { ref: ref(2), terminal: { known: true, value: false } },
      { ref: ref(3), terminal: { known: true, value: true } },
    ],
  });
});

test("an issue that blocks another one is not blocked by that link", async () => {
  const gh = new FakeGitHub();
  const blocker = gh.add({ number: 1, labels: ["ready-for-agent"] });
  gh.add({ number: 2, labels: ["ready-for-agent"], blockedBy: [blocker.dbId] });
  const adapter = tracker(gh);

  assert.deepEqual((await adapter.readIssue(ref(1))).blockers, { known: true, value: [] });
  const blocked = await adapter.readIssue(ref(2));
  assert.equal(blocked.blockers.known && blocked.blockers.value.length, 1);
});

test("a failed dependency read leaves blockers unknown, so the issue is not eligible", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent"] });
  gh.failDependencies = true;
  const adapter = tracker(gh);

  const snapshot = await adapter.readIssue(ref(1));
  const verdict = evaluateEligibility({
    project: { enabled: true, readyLabel: scope.readyLabel, routing: { kind: "repository" } },
    issue: snapshot,
    tracked: new Set(),
  }, coreRules);

  assert.equal(snapshot.blockers.known, false);
  assert.equal(verdict.eligible, false);
  assert.deepEqual(!verdict.eligible && verdict.rejections.map((r) => r.rule), ["no-blockers"]);
});

test("a ready, unclaimed issue without blockers is eligible with no sprint or assignee requirement", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent"] });
  const snapshot = await tracker(gh).readIssue(ref(1));

  const verdict = evaluateEligibility({
    project: { enabled: true, readyLabel: scope.readyLabel, routing: { kind: "repository" } },
    issue: snapshot,
    tracked: new Set(),
  }, coreRules);

  assert.deepEqual(verdict, { eligible: true });
  assert.equal(snapshot.openSprint, undefined);
  assert.equal(snapshot.assignee, undefined);
});

test("claim reports the label and the assignment it wrote, and the reread shows the claim", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent"] });
  const adapter = tracker(gh);

  // The adapter only writes: it reports the intents, never a result (ADR 0001).
  assert.deepEqual(await adapter.claim(ref(1)), {
    made: [
      { operation: "adicionar-label", target: "agent-claimed" },
      { operation: "atribuir", target: ACCOUNT },
    ],
  });

  const snapshot = await adapter.readIssue(ref(1));
  assert.deepEqual(snapshot.claimed, { known: true, value: true });
  assert.deepEqual(snapshot.labels, { known: true, value: ["ready-for-agent", "agent-claimed"] });
  assert.deepEqual(snapshot.assignees, { known: true, value: [ACCOUNT] });
  assert.deepEqual(snapshot.statusCategory, { known: true, value: "in-progress" });
});

test("a claim that fails after the label write reports the label as the only intent made", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent"] });
  gh.failAssigneeWrites = true;

  await assert.rejects(tracker(gh).claim(ref(1)), (error: unknown) => {
    assert.ok(error instanceof PartialWriteError);
    // The label stays on the issue: the failure of the assignment must not hide that write.
    assert.deepEqual(error.made, [{ operation: "adicionar-label", target: "agent-claimed" }]);
    return true;
  });
});

test("a failed token read is not cached: the next call asks the boundary again", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent"] });
  let failuresLeft = 1;
  const flaky: GitHubBoundary = {
    accountToken: async (account) => {
      if (failuresLeft-- > 0) throw new Error("gh indisponível");
      return gh.accountToken(account);
    },
    api: (request, token) => gh.api(request, token),
  };
  const adapter = new GitHubTracker({ account: ACCOUNT, claimedLabel: "agent-claimed", boundary: flaky });

  await assert.rejects(adapter.discoverCandidates(scope), /gh indisponível/);
  assert.deepEqual(await adapter.discoverCandidates(scope), [ref(1)]);
});

test("every call is made with the project account token", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent"] });
  gh.add({ number: 2, labels: ["ready-for-agent"] });
  const adapter = tracker(gh);

  await adapter.discoverCandidates(scope);
  await adapter.claim(ref(1));
  await adapter.postComment(ref(1), "texto");
  await adapter.releaseClaim(ref(1));
  await adapter.markDone(ref(2));

  assert.ok(gh.calls.length > 5);
  assert.ok(gh.calls.every((call) => call.login === ACCOUNT));
  assert.deepEqual([...new Set(gh.tokenRequests)], [ACCOUNT]);
});

test("releaseClaim removes the claimed label and the project assignment without closing", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent"] });
  const adapter = tracker(gh);
  await adapter.claim(ref(1));

  await adapter.releaseClaim(ref(1));

  const snapshot = await adapter.readIssue(ref(1));
  assert.equal(snapshot.claimed.known && snapshot.claimed.value, false);
  assert.deepEqual(snapshot.labels, { known: true, value: ["ready-for-agent"] });
  assert.deepEqual(snapshot.assignees, { known: true, value: [] });
  assert.equal(gh.issues.get(1)?.state, "open");
});

test("claimMark is the claimed label and the project account", () => {
  assert.deepEqual(tracker(new FakeGitHub()).claimMarkOf(ref(1)), { labels: ["agent-claimed"], assignees: [ACCOUNT] });
});

test("releaseClaim keeps assignees that are not the project account", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent", "agent-claimed"], assignees: [ACCOUNT, "human"] });
  const adapter = tracker(gh);

  await adapter.releaseClaim(ref(1));

  assert.deepEqual((await adapter.readIssue(ref(1))).assignees, { known: true, value: ["human"] });
});

test("readComments maps identity, bot flag, body and time across pages", async () => {
  const gh = new FakeGitHub();
  const issue = gh.add({ number: 1, labels: ["ready-for-agent"] });
  for (let i = 0; i < 101; i++) {
    issue.comments.push({ id: 100 + i, login: "human", type: "User", body: `c${i}`, createdAt: "2026-10-11T10:00:00Z" });
  }
  issue.comments.push({ id: 900, login: "renovate[bot]", type: "Bot", body: "bot", createdAt: "2026-10-11T11:00:00Z" });

  const comments = await tracker(gh).readComments(ref(1));

  assert.equal(comments.length, 102);
  assert.deepEqual(comments[0], { id: "100", author: "human", isBot: false, body: "c0", createdAt: "2026-10-11T10:00:00Z" });
  assert.deepEqual(comments[101], { id: "900", author: "renovate[bot]", isBot: true, body: "bot", createdAt: "2026-10-11T11:00:00Z" });
});

test("postComment posts the body as given and returns the new comment id", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent"] });
  const adapter = tracker(gh);
  const body = "resultado\n\n<!-- msf:agent -->";

  const id = await adapter.postComment(ref(1), body);

  const [posted] = await adapter.readComments(ref(1));
  assert.equal(posted.id, id);
  assert.equal(posted.body, body);
  assert.equal(posted.author, ACCOUNT);
  assert.equal(posted.isBot, false);
});

test("markDone closes the issue as completed and the reread shows done", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent"] });
  const adapter = tracker(gh);

  assert.deepEqual(await adapter.markDone(ref(1)), { made: [{ operation: "fechar" }] });
  assert.equal(gh.issues.get(1)?.state, "closed");
  assert.equal(gh.issues.get(1)?.stateReason, "completed");
  assert.deepEqual((await adapter.readIssue(ref(1))).statusCategory, { known: true, value: "done" });
});

const PROJECT = { enabled: true, readyLabel: "ready-for-agent", routing: { kind: "repository" as const } };

test("terminal means closed as completed: a completed issue is done", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, state: "closed", stateReason: "completed" });

  assert.deepEqual((await tracker(gh).readIssue(ref(1))).statusCategory, { known: true, value: "done" });
});

test("an issue closed for another reason is not done and its category is not guessed", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, state: "closed", stateReason: "not_planned" });
  gh.add({ number: 2, state: "closed", stateReason: "duplicate" });
  gh.add({ number: 3, state: "closed", stateReason: null });
  const adapter = tracker(gh);

  for (const n of [1, 2, 3]) {
    const category = (await adapter.readIssue(ref(n))).statusCategory;
    assert.equal(category.known, false, `#${n} must not read as a known category`);
    assert.notDeepEqual(category, { known: true, value: "done" }, `#${n} is not done`);
  }
});

test("an issue closed for another reason is not eligible: its status is unknown, so eligibility rejects it", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent"], state: "closed", stateReason: "not_planned" });
  const snapshot = await tracker(gh).readIssue(ref(1));

  const verdict = evaluateEligibility({ project: PROJECT, issue: snapshot, tracked: new Set() }, coreRules);

  assert.equal(verdict.eligible, false);
});

test("only open blocked_by dependencies block: a blocker closed for another reason does not block", async () => {
  const gh = new FakeGitHub();
  const notPlanned = gh.add({ number: 3, state: "closed", stateReason: "not_planned" });
  gh.add({ number: 1, labels: ["ready-for-agent"], blockedBy: [notPlanned.dbId] });

  const snapshot = await tracker(gh).readIssue(ref(1));

  assert.deepEqual(snapshot.blockers, {
    known: true,
    value: [{ ref: ref(3), terminal: { known: true, value: true } }],
  });
  const verdict = evaluateEligibility({ project: PROJECT, issue: snapshot, tracked: new Set() }, coreRules);
  assert.equal(verdict.eligible, true);
});

test("the native blocked_by edge can be added and removed", async () => {
  const gh = new FakeGitHub();
  gh.add({ number: 1, labels: ["ready-for-agent"] });
  gh.add({ number: 2 });
  const adapter = tracker(gh);

  await adapter.addBlockedBy(ref(1), ref(2));
  const blocked = await adapter.readIssue(ref(1));
  assert.equal(blocked.blockers.known, true);
  const terminals = blocked.blockers.known ? blocked.blockers.value.map((b: BlockerRef) => b.terminal) : [];
  assert.deepEqual(terminals, [{ known: true, value: false }]);

  await adapter.removeBlockedBy(ref(1), ref(2));
  assert.deepEqual((await adapter.readIssue(ref(1))).blockers, { known: true, value: [] });
});
