import assert from "node:assert/strict";
import { describe, test, beforeEach } from "node:test";

import { FakeTrackerAdapter } from "./fake-adapter.js";
import type { ExpandedPrFeedback } from "./expanded-port.js";
import {
  GITHUB_SITE,
  githubRepository,
  githubTicket,
  issueRefOf,
  jiraTicket,
  pullRequestIdentity,
  pullRequestIdentityKey,
  ticketIdentityKey,
  workIdentityKey,
  type TicketIdentity,
  type WorkIdentity,
} from "./identity.js";
import { SimulatedRepoHarness } from "./github-sim-harness.js";
import { PartialWriteError } from "./port.js";

const REPO = "Sanmoo/sim-repo";
const WORKER = "bot-do-samuca";
const READY = "ready-for-agent";

const selection = { source: { provider: "github" as const, site: GITHUB_SITE }, destination: githubRepository(REPO) };

function work(ticket: TicketIdentity): WorkIdentity {
  return { ticket, destination: githubRepository(REPO) };
}

describe("Work, ticket, repository and PR identities are explicit", () => {
  test("provider and site scope the stable ticket identity; a readable key is not identity", () => {
    const githubA = githubTicket("Sanmoo/a", 42);
    const githubB = githubTicket("Sanmoo/b", 42);
    const jiraSiteOne = jiraTicket({ site: "one.atlassian.net", stableId: "10042", key: "ABC-42" });
    const jiraSiteTwo = jiraTicket({ site: "two.atlassian.net", stableId: "10042", key: "ABC-42" });
    const jiraRenamed = jiraTicket({ site: "one.atlassian.net", stableId: "10042", key: "XYZ-99" });

    assert.notEqual(ticketIdentityKey(githubA), ticketIdentityKey(githubB), "the same number in another repo is not the same ticket");
    assert.notEqual(ticketIdentityKey(githubA), ticketIdentityKey(jiraSiteOne), "a GitHub number never represents a Jira ticket");
    assert.notEqual(ticketIdentityKey(jiraSiteOne), ticketIdentityKey(jiraSiteTwo), "the same stable id on another site is another ticket");
    assert.equal(ticketIdentityKey(jiraSiteOne), ticketIdentityKey(jiraRenamed), "a mutable Jira key never replaces the stable id");
    assert.notEqual(
      workIdentityKey(work(githubA)),
      workIdentityKey(work(jiraRenamed)),
      "equal numbers/keys from different providers never collide as Work",
    );
    assert.throws(() => issueRefOf(jiraSiteOne), /not a GitHub issue/);
  });

  test("the destination repository and the PR identity are scoped too", () => {
    const repoA = githubRepository("Sanmoo/a");
    const repoB = githubRepository("Sanmoo/b");
    const prA = pullRequestIdentity(repoA, 7);
    const prB = pullRequestIdentity(repoB, 7);

    assert.notEqual(pullRequestIdentityKey(prA), pullRequestIdentityKey(prB), "PR #7 of another repo is another PR");
    assert.equal(prA.repository.repo, repoA.repo);
    assert.equal(prA.provider, "github");
  });
});

describe("expanded contracts — the real GitHub adapter over simulated REST", () => {
  let harness: SimulatedRepoHarness;
  const port = () => harness.getExpandedAdapter();

  beforeEach(async () => {
    harness = new SimulatedRepoHarness();
    await harness.reset();
  });

  test("the whole GitHub cycle is available through the split ticket/PR contracts", async () => {
    const issue = await harness.createIssue({ title: "expanded contract cycle", labels: [READY] });
    const blocker = await harness.createIssue({ title: "closed blocker", closed: true });
    harness.sim.addBlocker(issue.ref.number, blocker.ref.number);
    const ticket = githubTicket(REPO, issue.ref.number);
    const destination = githubRepository(REPO);

    const listed = await port().listOpenTickets(selection);
    const listedTicket = listed.find((entry) => entry.ticket.stableId === ticket.stableId);
    assert.ok(listedTicket, "the open ticket is listed");
    assert.equal(listedTicket.ticket.provider, "github");
    assert.equal(listedTicket.ticket.site, GITHUB_SITE);
    assert.equal(listedTicket.ticket.key, `#${issue.ref.number}`);

    const snapshot = await port().readTicket(ticket);
    assert.ok(snapshot.known);
    assert.equal(snapshot.value.ticket.stableId, ticket.stableId);
    assert.equal(snapshot.value.title, "expanded contract cycle");
    assert.equal(snapshot.value.state, "open");

    const blockers = await port().readTicketBlockers(ticket);
    assert.ok(blockers.known);
    assert.equal(blockers.value.length, 1);
    assert.equal(blockers.value[0]?.state, "closed");

    const claimed = await port().claimTicket(ticket, WORKER, READY);
    assert.ok(claimed.performed.includes(`label+agent-claimed on ${REPO}#${issue.ref.number}`));
    const afterClaim = await port().readTicket(ticket);
    assert.ok(afterClaim.known);
    assert.ok(afterClaim.value.labels.includes("agent-claimed"));
    assert.ok(!afterClaim.value.labels.includes(READY));
    assert.deepEqual(afterClaim.value.assignees, [WORKER]);

    const released = await port().releaseTicketClaim(ticket, WORKER, READY);
    assert.ok(released.performed.length > 0);
    const afterRelease = await port().readTicket(ticket);
    assert.ok(afterRelease.known);
    assert.ok(afterRelease.value.labels.includes(READY));
    assert.ok(!afterRelease.value.labels.includes("agent-claimed"));

    await port().claimTicket(ticket, WORKER);
    await port().blockTicketClaim(ticket, {
      ready: READY,
      claimed: "agent-claimed",
      blocked: "agent-blocked",
    });
    const blocked = await port().readTicket(ticket);
    assert.ok(blocked.known);
    assert.ok(blocked.value.labels.includes("agent-blocked"));
    assert.ok(!blocked.value.labels.includes("agent-claimed"));

    await port().resumeTicketClaim(ticket, {
      ready: READY,
      claimed: "agent-claimed",
      blocked: "agent-blocked",
    });
    const resumed = await port().readTicket(ticket);
    assert.ok(resumed.known);
    assert.ok(resumed.value.labels.includes("agent-claimed"));
    assert.ok(!resumed.value.labels.includes("agent-blocked"));

    const branch = `agent-issue-${issue.ref.number}`;
    await port().pushWorkBranch({ destination, branch });
    assert.ok(harness.sim.pushedBranches.has(branch));

    const pr = await port().openPullRequest({
      work: work(ticket),
      headBranch: branch,
      baseBranch: harness.sim.defaultBranch,
      title: "expanded contract cycle",
    });
    assert.equal(pr.identity.repository.repo, REPO);
    assert.equal(pr.identity.number, pr.number);

    const feedback = await port().readPullRequestFeedback({ work: work(ticket), pullRequest: null });
    assert.ok(feedback.known);
    assert.equal(feedback.value.pr?.identity.number, pr.number);
    assert.equal(feedback.value.pr?.state, "open");

    const explicitFeedback = await port().readPullRequestFeedback({
      work: work(ticket),
      pullRequest: pr.identity,
    });
    assert.ok(explicitFeedback.known);
    assert.equal(explicitFeedback.value.pr?.number, pr.number);

    const repair = await port().readPullRequestRepairFacts({
      work: work(ticket),
      pullRequest: pr.identity,
    });
    assert.ok(repair.known);
    assert.equal(repair.value.mergeState, "unknown", "a missing mergeability fact is unknown, not mergeable");
    assert.equal(repair.value.requiredChecks, null, "the required set could not be determined");

    const simPr = harness.sim.issues.get(pr.number);
    assert.ok(simPr);
    simPr.state = "closed";
    await port().reopenPullRequest({ work: work(ticket), pullRequest: pr.identity });
    const reopened = await port().readPullRequestFeedback({
      work: work(ticket),
      pullRequest: pr.identity,
    });
    assert.ok(reopened.known);
    assert.equal(reopened.value.pr?.state, "open", "the SAME PR is reopened, never a new one");
    assert.equal(reopened.value.pr?.number, pr.number);

    await port().commentOnTicket(ticket, "expanded: blocked valve test");
    const comments = await port().readTicketComments(ticket);
    assert.ok(comments.known);
    assert.ok(comments.value.some((comment) => comment.body.includes("expanded: blocked valve test")));

    const rank = await port().rankTicket(ticket);
    assert.ok(rank.known);
    assert.equal(rank.value, null);

    await port().markTicketDone(ticket);
    const done = await port().readTicket(ticket);
    assert.ok(done.known);
    assert.equal(done.value.state, "closed");
    assert.equal(done.value.stateReason, "completed");
  });

  test("the PR contract opens for a Jira ticket without a GitHub issue or a Jira PR implementation", async () => {
    const ticket = jiraTicket({
      site: "acme.atlassian.net",
      stableId: "10001",
      key: "ABC-1",
      url: "https://acme.atlassian.net/browse/ABC-1",
    });
    const pr = await port().openPullRequest({
      work: { ticket, destination: githubRepository(REPO) },
      headBranch: "agent-issue-abc-1",
      baseBranch: harness.sim.defaultBranch,
      title: "Jira work ABC-1",
    });

    assert.equal(pr.identity.repository.repo, REPO);
    const simulated = harness.sim.issues.get(pr.number);
    assert.ok(simulated);
    assert.match(simulated.body, /ABC-1/);
    assert.match(simulated.body, /acme\.atlassian\.net/);
    assert.doesNotMatch(simulated.body, /Closes #/, "a Jira key never becomes a GitHub issue-closing number");
  });

  test("a read failure is never an absent ticket; a missing ticket is known-unknown", async () => {
    const issue = await harness.createIssue({ title: "read failure" });
    const ticket = githubTicket(REPO, issue.ref.number);
    harness.failNext("GET", `/issues/${issue.ref.number}`);

    await assert.rejects(port().readTicket(ticket), /injected server failure/);

    const missing = githubTicket(REPO, harness.sim.missingNumber());
    const unknown = await port().readTicket(missing);
    assert.equal(unknown.known, false, "404 is known-unknown, never a fabricated snapshot");
  });

  test("an interrupted ticket write reports the performed intents and leaves the claim recoverable", async () => {
    const issue = await harness.createIssue({ title: "interrupted claim", labels: [READY] });
    const ticket = githubTicket(REPO, issue.ref.number);
    harness.failNext("DELETE", `/labels/${READY}`);

    await assert.rejects(port().claimTicket(ticket, WORKER, READY), (error: unknown) => {
      assert.ok(error instanceof PartialWriteError);
      assert.ok(error.performed.includes(`label+agent-claimed on ${REPO}#${issue.ref.number}`));
      assert.ok(error.performed.includes(`assignee ${WORKER}`));
      return true;
    });

    const after = await port().readTicket(ticket);
    assert.ok(after.known);
    assert.ok(after.value.labels.includes("agent-claimed"), "the padlock landed before the interrupted step");
    assert.ok(after.value.labels.includes(READY), "the pool label remained — the work is never orphaned");
    assert.deepEqual(after.value.assignees, [WORKER]);
  });
});

describe("expanded contracts — the fake adapter", () => {
  test("the fake exercises the split interfaces with synthetic GitHub identities", async () => {
    const adapter = new FakeTrackerAdapter({ workerAccount: WORKER });
    adapter.seedIssue({ repo: REPO, number: 3, labels: [READY] });
    const ticket = githubTicket(REPO, 3);

    const listed = await adapter.listOpenTickets(selection);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.ticket.stableId, ticket.stableId);

    await adapter.claimTicket(ticket, WORKER, READY);
    const snapshot = await adapter.readTicket(ticket);
    assert.ok(snapshot.known);
    assert.ok(snapshot.value.labels.includes("agent-claimed"));

    const pr = await adapter.openPullRequest({
      work: work(ticket),
      headBranch: "agent-issue-3",
      baseBranch: "main",
      title: "fake expanded",
    });
    const feedbackResult = await adapter.readPullRequestFeedback({
      work: work(ticket),
      pullRequest: pr.identity,
    });
    assert.ok(feedbackResult.known);
    const feedback: ExpandedPrFeedback = feedbackResult.value;
    assert.equal(feedback.pr?.identity.repository.repo, REPO);
    assert.equal(feedback.pr?.number, pr.number);
  });

  test("the fake serves a Jira ticket's PR through the same interface, with no GitHub issue", async () => {
    const adapter = new FakeTrackerAdapter({ workerAccount: WORKER });
    const ticket = jiraTicket({
      site: "acme.atlassian.net",
      stableId: "10001",
      key: "ABC-1",
    });

    const pr = await adapter.openPullRequest({
      work: { ticket, destination: githubRepository(REPO) },
      headBranch: "agent-issue-abc-1",
      baseBranch: "main",
      title: "Jira work ABC-1",
    });
    const feedback = await adapter.readPullRequestFeedback({
      work: { ticket, destination: githubRepository(REPO) },
      pullRequest: pr.identity,
    });

    assert.ok(feedback.known);
    assert.equal(feedback.value.pr?.identity.number, pr.number);
    assert.equal(feedback.value.pr?.identity.repository.repo, REPO);

    const repair = await adapter.readPullRequestRepairFacts({
      work: { ticket, destination: githubRepository(REPO) },
      pullRequest: pr.identity,
    });
    assert.ok(repair.known);
    assert.equal(repair.value.mergeState, "unknown");
    assert.equal(repair.value.requiredChecks, null);
  });
});
