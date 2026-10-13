import assert from "node:assert/strict";
import test from "node:test";
import { GitHubTracker } from "../src/tracker/github.js";
import { JiraTracker } from "../src/tracker/jira.js";
import { loadMemoryTracker } from "../src/tracker/memory.js";
import { PartialWriteError, type IssueRef, type TrackerPort } from "../src/tracker/port.js";
import { ACCOUNT, FakeGitHub, REPO } from "./support/fake-github.js";
import { FakeJira, OPERATOR_ACCOUNT, SETTINGS, fakeIssue, ref as jiraRef, startFake } from "./support/fake-jira.js";

// The port's write contract, run against the three adapters: each one only writes and reports
// intents, and the reread shows the mark and the state. The failure plan of the memory adapter and
// the injectable failures of the GitHub and Jira fakes cover the partial composite write. The
// scenarios that depend on the core's decisions live in test/issue-writes.test.ts.

interface Built {
  tracker: TrackerPort;
  ref: IssueRef;
  // Forces the second step of the composite claim to fail after the first one landed.
  failSecondStep: () => void;
  close: () => void;
}

interface ContractCase {
  name: string;
  build: () => Promise<Built>;
}

const MEMORY_ACCOUNT = "acme";

const memoryCase: ContractCase = {
  name: "memory",
  build: async () => {
    const tracker = loadMemoryTracker({
      claimMark: { labels: ["claim"], assignees: [MEMORY_ACCOUNT] },
      issues: [{
        project: REPO, id: "1", title: "Issue 1", labels: ["ready-for-agent"], assignees: ["human"],
        claimed: false, statusCategory: "to-do", priority: null, blockers: [], comments: [],
      }],
    });
    return {
      tracker,
      ref: { tracker: "memory", project: REPO, id: "1" },
      failSecondStep: () => tracker.failNext("claim", "parcial"),
      close: () => {},
    };
  },
};

const githubCase: ContractCase = {
  name: "github",
  build: async () => {
    const gh = new FakeGitHub();
    gh.add({ number: 1, labels: ["ready-for-agent"], assignees: ["human"] });
    return {
      tracker: new GitHubTracker({ account: ACCOUNT, claimedLabel: "agent-claimed", boundary: gh }),
      ref: { tracker: "github", project: REPO, id: "1" },
      failSecondStep: () => { gh.failAssigneeWrites = true; },
      close: () => {},
    };
  },
};

const jiraCase: ContractCase = {
  name: "jira",
  build: async () => {
    const fake = new FakeJira([fakeIssue({ key: "VAN-1", labels: ["ready-for-agent"], assignee: OPERATOR_ACCOUNT })]);
    const { server, connection } = await startFake(fake);
    return {
      tracker: new JiraTracker(connection, SETTINGS),
      ref: jiraRef("VAN-1"),
      failSecondStep: () => { fake.failTransitionWrites = true; },
      close: () => server.close(),
    };
  },
};

const CASES: ContractCase[] = [memoryCase, githubCase, jiraCase];

const withCase = async (contract: ContractCase, run: (built: Built) => Promise<void>): Promise<void> => {
  const built = await contract.build();
  try {
    await run(built);
  } finally {
    built.close();
  }
};

for (const contract of CASES) {
  test(`[${contract.name}] claim leaves the mark the port exposes and the in-progress category`, async () => {
    await withCase(contract, async ({ tracker, ref }) => {
      const mark = tracker.claimMarkOf(ref);
      assert.ok(mark.labels.length + mark.assignees.length > 0, "the factory's claim has a mark");

      const outcome = await tracker.claim(ref);
      assert.ok("made" in outcome, "a claim that landed reports the intents it made");
      // The mark the port exposes is exactly what the claim writes.
      for (const label of mark.labels) {
        assert.ok(outcome.made.some((intent) => intent.operation === "adicionar-label" && intent.target === label), `label ${label} written`);
      }
      for (const account of mark.assignees) {
        assert.ok(outcome.made.some((intent) => intent.operation === "atribuir" && intent.target === account), `account ${account} written`);
      }

      const after = await tracker.readIssue(ref);
      assert.deepEqual(after.claimed, { known: true, value: true });
      assert.deepEqual(after.statusCategory, { known: true, value: "in-progress" });
      for (const label of mark.labels) assert.ok(after.labels.known && after.labels.value.includes(label), `label ${label} visible`);
      for (const account of mark.assignees) assert.ok(after.assignees.known && after.assignees.value.includes(account), `account ${account} visible`);
    });
  });

  test(`[${contract.name}] releaseClaim removes the mark and leaves status and other assignments`, async () => {
    await withCase(contract, async ({ tracker, ref }) => {
      const mark = tracker.claimMarkOf(ref);
      await tracker.claim(ref);
      const claimed = await tracker.readIssue(ref);
      const beforeStatus = claimed.statusCategory;
      const others = claimed.assignees.known ? claimed.assignees.value.filter((account) => !mark.assignees.includes(account)) : [];

      const outcome = await tracker.releaseClaim(ref);
      assert.ok("made" in outcome, "a release that landed reports the intents it made");

      const after = await tracker.readIssue(ref);
      for (const label of mark.labels) assert.ok(after.labels.known && !after.labels.value.includes(label), `label ${label} gone`);
      for (const account of mark.assignees) assert.ok(after.assignees.known && !after.assignees.value.includes(account), `account ${account} gone`);
      assert.deepEqual(after.statusCategory, beforeStatus, "the status is left as it was");
      for (const other of others) assert.ok(after.assignees.known && after.assignees.value.includes(other), `assignment ${other} stays`);
    });
  });

  test(`[${contract.name}] markDone leaves the done category`, async () => {
    await withCase(contract, async ({ tracker, ref }) => {
      const outcome = await tracker.markDone(ref);
      assert.ok("made" in outcome, "a done that landed reports the intents it made");
      assert.deepEqual((await tracker.readIssue(ref)).statusCategory, { known: true, value: "done" });
    });
  });

  test(`[${contract.name}] a failure on the second step of the claim carries the first intent`, async () => {
    await withCase(contract, async ({ tracker, ref, failSecondStep }) => {
      failSecondStep();
      await assert.rejects(tracker.claim(ref), (error: unknown) => {
        assert.ok(error instanceof PartialWriteError);
        assert.equal(error.made.length, 1, "only the first step was made");
        return true;
      });
    });
  });
}
