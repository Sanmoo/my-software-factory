import assert from "node:assert/strict";
import test from "node:test";
import { coreRules, evaluateEligibility } from "../src/core/eligibility.js";
import { jiraEligibilityRules } from "../src/tracker/jira-rules.js";
import { JiraTracker, jiraConnectionFromEnv } from "../src/tracker/jira.js";
import {
  adf,
  BLOCKS,
  FakeJira,
  OPERATOR_ACCOUNT,
  RELATES,
  ref,
  SETTINGS,
  startFake,
  TOKEN,
  USERNAME,
  withTracker,
  fakeIssue,
  type FakeIssue,
} from "./support/fake-jira.js";

// Jira adapter seams: the TrackerPort of JiraTracker, exercised against a local HTTP
// fake of the Jira Cloud REST endpoints it uses (test/support/fake-jira.ts).
test("connection is read from the JIRA_* environment variables; missing ones are named without values", () => {
  assert.deepEqual(
    jiraConnectionFromEnv({ JIRA_URL: "https://example.atlassian.net", JIRA_USERNAME: USERNAME, JIRA_API_TOKEN: TOKEN }),
    { baseUrl: "https://example.atlassian.net", username: USERNAME, apiToken: TOKEN },
  );
  assert.throws(
    () => jiraConnectionFromEnv({ JIRA_URL: "https://example.atlassian.net", JIRA_API_TOKEN: TOKEN }),
    (error: Error) => error.message.includes("JIRA_USERNAME") && !error.message.includes(TOKEN),
  );
});

test("discovery returns every ready-for-agent issue of the project across pages, in key order", async () => {
  const issues = [
    fakeIssue({ key: "VAN-3" }),
    fakeIssue({ key: "VAN-1" }),
    fakeIssue({ key: "VAN-7", labels: ["playbooks"] }),
    fakeIssue({ key: "CON-2" }),
    fakeIssue({ key: "VAN-5" }),
    fakeIssue({ key: "VAN-2" }),
  ];
  const keys = await withTracker(issues, async (tracker, fake) => {
    const found = await tracker.discoverCandidates({ project: "VAN", readyLabel: "ready-for-agent" });
    assert.equal(fake.authorization, `Basic ${Buffer.from(`${USERNAME}:${TOKEN}`).toString("base64")}`);
    return found;
  });
  assert.deepEqual(keys, [
    { tracker: "jira", project: "VAN", id: "VAN-1" },
    { tracker: "jira", project: "VAN", id: "VAN-2" },
    { tracker: "jira", project: "VAN", id: "VAN-3" },
    { tracker: "jira", project: "VAN", id: "VAN-5" },
  ]);
});

test("readIssue maps labels, assignee, status category, priority and the open sprint", async () => {
  const snapshot = await withTracker(
    [fakeIssue({ key: "VAN-10", summary: "Playbook item", statusName: "Em andamento", category: "indeterminate", priority: "High" })],
    (tracker) => tracker.readIssue(ref("VAN-10")),
  );
  assert.deepEqual(snapshot, {
    ref: { tracker: "jira", project: "VAN", id: "VAN-10" },
    title: "Playbook item",
    labels: { known: true, value: ["ready-for-agent", "playbooks"] },
    assignees: { known: true, value: [OPERATOR_ACCOUNT] },
    claimed: { known: true, value: true },
    blockers: { known: true, value: [] },
    statusCategory: { known: true, value: "in-progress" },
    priority: { known: true, value: 2 },
    openSprint: { known: true, value: true },
    assignee: { known: true, value: OPERATOR_ACCOUNT },
    body: { known: true, value: "" },
  });
});

test("readIssue reads the description as the issue body, plain text with one line per paragraph", async () => {
  const snapshot = await withTracker(
    [fakeIssue({ key: "VAN-12", description: "Implementar slugify.\nVer docs/spec.md" })],
    (tracker) => tracker.readIssue(ref("VAN-12")),
  );
  assert.deepEqual(snapshot.body, { known: true, value: "Implementar slugify.\nVer docs/spec.md" });
});

test("an issue outside the open sprint, or unassigned, reads as such", async () => {
  const snapshot = await withTracker(
    [fakeIssue({ key: "VAN-11", openSprint: false, assignee: null, priority: null })],
    (tracker) => tracker.readIssue(ref("VAN-11")),
  );
  assert.deepEqual(snapshot.openSprint, { known: true, value: false });
  assert.deepEqual(snapshot.assignee, { known: true, value: null });
  assert.deepEqual(snapshot.priority, { known: true, value: null });
});

test("a To Do issue without the claimed label is not claimed; the label or a non To Do status claims it", async () => {
  const todo = await withTracker([fakeIssue({ key: "VAN-12" })], (tracker) => tracker.readIssue(ref("VAN-12")));
  assert.deepEqual(todo.claimed, { known: true, value: false });
  const labelled = await withTracker(
    [fakeIssue({ key: "VAN-13", labels: ["ready-for-agent", "agent-claimed"] })],
    (tracker) => tracker.readIssue(ref("VAN-13")),
  );
  assert.deepEqual(labelled.claimed, { known: true, value: true });
  const done = await withTracker(
    [fakeIssue({ key: "VAN-14", statusName: "Itens concluídos", category: "done" })],
    (tracker) => tracker.readIssue(ref("VAN-14")),
  );
  assert.deepEqual(done.claimed, { known: true, value: true });
});

test("an unreadable status makes claim and category unknown, never false", async () => {
  const snapshot = await withTracker([fakeIssue({ key: "VAN-15", hideStatus: true })], (tracker) => tracker.readIssue(ref("VAN-15")));
  assert.equal(snapshot.statusCategory.known, false);
  assert.equal(snapshot.claimed.known, false);
});

test("an unreadable sprint state is reported as unknown, not as outside the sprint", async () => {
  const snapshot = await withTracker([fakeIssue({ key: "VAN-16", summary: "NO_BOARD" })], (tracker) => tracker.readIssue(ref("VAN-16")));
  assert.equal(snapshot.openSprint?.known, false);
});

test("an open 'is blocked by' link is a non-terminal blocker; a done blocker is terminal", async () => {
  const issues = [
    fakeIssue({ key: "VAN-20", links: [{ type: BLOCKS, inwardIssue: "VAN-21" }, { type: BLOCKS, inwardIssue: "VAN-22" }] }),
    fakeIssue({ key: "VAN-21", category: "indeterminate", statusName: "Em andamento" }),
    fakeIssue({ key: "VAN-22", category: "done", statusName: "Itens concluídos" }),
  ];
  const snapshot = await withTracker(issues, (tracker) => tracker.readIssue(ref("VAN-20")));
  assert.deepEqual(snapshot.blockers, {
    known: true,
    value: [
      { ref: { tracker: "jira", project: "VAN", id: "VAN-21" }, terminal: { known: true, value: false } },
      { ref: { tracker: "jira", project: "VAN", id: "VAN-22" }, terminal: { known: true, value: true } },
    ],
  });
});

test("an issue that blocks another, or a link of another type, is not blocked", async () => {
  const issues = [
    fakeIssue({ key: "VAN-30", links: [{ type: BLOCKS, outwardIssue: "VAN-31" }, { type: RELATES, inwardIssue: "VAN-32" }] }),
    fakeIssue({ key: "VAN-31" }),
    fakeIssue({ key: "VAN-32" }),
  ];
  const snapshot = await withTracker(issues, (tracker) => tracker.readIssue(ref("VAN-30")));
  assert.deepEqual(snapshot.blockers, { known: true, value: [] });
});

test("a blocker whose status cannot be read has unknown terminal state", async () => {
  const issues = [
    fakeIssue({ key: "VAN-40", links: [{ type: BLOCKS, inwardIssue: "VAN-41" }] }),
    fakeIssue({ key: "VAN-41", hideStatus: true }),
  ];
  const snapshot = await withTracker(issues, (tracker) => tracker.readIssue(ref("VAN-40")));
  assert.equal(snapshot.blockers.known && snapshot.blockers.value[0].terminal.known, false);
});

test("a configured priority map replaces the default ranking; a name it does not list is unknown, not the default", async () => {
  const fake = new FakeJira([
    fakeIssue({ key: "VAN-30", priority: "Blocker" }),
    fakeIssue({ key: "VAN-31", priority: "Highest" }),
    fakeIssue({ key: "VAN-32", priority: "Medium" }),
  ]);
  const { server, connection } = await startFake(fake);
  try {
    const tracker = new JiraTracker(connection, { ...SETTINGS, priorityRanks: { Blocker: 1, Highest: 2, Medium: 3 } });
    const ranks = await Promise.all(["VAN-30", "VAN-31", "VAN-32"].map(async (key) => (await tracker.readIssue(ref(key))).priority));
    assert.deepEqual(ranks, [{ known: true, value: 1 }, { known: true, value: 2 }, { known: true, value: 3 }]);
    const unlisted = new JiraTracker(connection, { ...SETTINGS, priorityRanks: { Blocker: 1 } });
    const medium = await unlisted.readIssue(ref("VAN-32"));
    assert.equal(medium.priority.known, false, "Medium is not listed in this map");
  } finally {
    server.close();
  }
});

test("readComments returns id, author, bot flag, body text and time across pages", async () => {
  const issues = [
    fakeIssue({
      key: "VAN-50",
      comments: [
        { id: "101", accountId: "acc-human", body: adf(["primeira linha"], ["segunda ", "parte"]), created: "2026-05-01T10:00:00.000+0000" },
        { id: "102", accountId: "acc-bot", accountType: "app", body: adf(["[msf] relato do agente"]), created: "2026-05-01T11:00:00.000+0000" },
        { id: "103", accountId: "acc-human", body: adf(["agent: reavaliar"]), created: "2026-05-01T12:00:00.000+0000" },
      ],
    }),
  ];
  const comments = await withTracker(issues, (tracker) => tracker.readComments(ref("VAN-50")));
  assert.deepEqual(comments, [
    { id: "101", author: "acc-human", isBot: false, body: "primeira linha\nsegunda parte", createdAt: "2026-05-01T10:00:00.000+0000" },
    { id: "102", author: "acc-bot", isBot: true, body: "[msf] relato do agente", createdAt: "2026-05-01T11:00:00.000+0000" },
    { id: "103", author: "acc-human", isBot: false, body: "agent: reavaliar", createdAt: "2026-05-01T12:00:00.000+0000" },
  ]);
});

test("postComment posts the body as given: the core adds the [msf] marker, the adapter neither adds nor strips it", async () => {
  const issues = [fakeIssue({ key: "VAN-51" })];
  const comments = await withTracker(issues, async (tracker) => {
    const plain = await tracker.postComment(ref("VAN-51"), "resultado parcial");
    const marked = await tracker.postComment(ref("VAN-51"), "[msf] já marcado");
    assert.deepEqual([plain, marked], ["900", "901"]);
    return tracker.readComments(ref("VAN-51"));
  });
  assert.deepEqual(comments.map((comment) => [comment.id, comment.body]), [
    ["900", "resultado parcial"],
    ["901", "[msf] já marcado"],
  ]);
});

const writesOf = (fake: FakeJira) => fake.writes().map((request) => `${request.method} ${request.path}`);

test("claim reports the claimed label and the doing transition it wrote, and the reread shows them", async () => {
  await withTracker([fakeIssue({ key: "VAN-60" })], async (tracker, fake) => {
    const outcome = await tracker.claim(ref("VAN-60"));
    // The adapter only writes: the intents, never a result (ADR 0001).
    assert.deepEqual(outcome, {
      made: [
        { operation: "adicionar-label", target: "agent-claimed" },
        { operation: "transição", target: "Em andamento", reaches: ["in-progress"] },
      ],
    });
    assert.deepEqual(writesOf(fake), [
      "PUT /rest/api/3/issue/VAN-60",
      "POST /rest/api/3/issue/VAN-60/transitions",
    ]);
    const after = await tracker.readIssue(ref("VAN-60"));
    assert.deepEqual(after.claimed, { known: true, value: true });
    assert.deepEqual(after.statusCategory, { known: true, value: "in-progress" });
  });
});

test("claim without the configured doing transition is refused before the label is added", async () => {
  await withTracker([fakeIssue({ key: "VAN-63", transitions: [{ id: "31", name: "Itens concluídos", to: "done" }] })], async (tracker, fake) => {
    const outcome = await tracker.claim(ref("VAN-63"));
    assert.ok("refused" in outcome);
    assert.match("refused" in outcome ? outcome.refused : "", /Em andamento/);
    assert.deepEqual(writesOf(fake), []);
  });
});

test("claimMark is the claimed label only", async () => {
  await withTracker([], async (tracker) => {
    assert.deepEqual(tracker.claimMarkOf(ref("VAN-1")), { labels: ["agent-claimed"], assignees: [] });
  });
});

test("releaseClaim removes only the claimed label and never transitions the issue", async () => {
  const issue = fakeIssue({ key: "VAN-64", labels: ["ready-for-agent", "agent-claimed"], statusName: "Em andamento", category: "indeterminate" });
  await withTracker([issue], async (tracker, fake) => {
    assert.deepEqual(await tracker.releaseClaim(ref("VAN-64")), {
      made: [{ operation: "remover-label", target: "agent-claimed" }],
    });
    assert.deepEqual(writesOf(fake), ["PUT /rest/api/3/issue/VAN-64"]);
    const after = await tracker.readIssue(ref("VAN-64"));
    assert.deepEqual(after.labels, { known: true, value: ["ready-for-agent"] });
    assert.deepEqual(after.statusCategory, { known: true, value: "in-progress" });
  });
});

test("markDone runs the configured done transition and the reread shows the Done category", async () => {
  await withTracker([fakeIssue({ key: "VAN-65" })], async (tracker, fake) => {
    assert.deepEqual(await tracker.markDone(ref("VAN-65")), {
      made: [{ operation: "transição", target: "Itens concluídos", reaches: ["done"] }],
    });
    assert.deepEqual(writesOf(fake), ["POST /rest/api/3/issue/VAN-65/transitions"]);
    assert.deepEqual((await tracker.readIssue(ref("VAN-65"))).statusCategory, { known: true, value: "done" });
  });
});

test("markDone without the configured done transition is refused, naming it", async () => {
  await withTracker([fakeIssue({ key: "VAN-67", transitions: [] })], async (tracker) => {
    const outcome = await tracker.markDone(ref("VAN-67"));
    assert.ok("refused" in outcome);
    assert.match("refused" in outcome ? outcome.refused : "", /Itens concluídos/);
  });
});

// Eligibility of a real Jira snapshot under the core rules plus the Jira rules, for a
// project routed by the "playbooks" label. Every negative filter must reject with a rule.
const ROUTING = { kind: "label" as const, routingLabel: "playbooks", knownLabels: ["playbooks", "monolith"] };

async function eligibilityOf(issues: FakeIssue[], key: string): Promise<string[]> {
  return withTracker(issues, async (tracker) => {
    const issue = await tracker.readIssue(ref(key));
    const verdict = evaluateEligibility(
      { project: { enabled: true, readyLabel: "ready-for-agent", routing: ROUTING }, issue, tracked: new Set() },
      [...coreRules, ...jiraEligibilityRules(OPERATOR_ACCOUNT)],
    );
    return verdict.eligible ? [] : verdict.rejections.map((rejection) => rejection.rule);
  });
}

test("a Jira issue ready, unclaimed, unblocked, in the open sprint and assigned to the operator is eligible", async () => {
  assert.deepEqual(await eligibilityOf([fakeIssue({ key: "VAN-70" })], "VAN-70"), []);
});

test("each negative filter rejects the issue with its rule", async () => {
  const cases: Array<{ name: string; issue: FakeIssue; issues?: FakeIssue[]; rule: string }> = [
    { name: "outside the open sprint", issue: fakeIssue({ key: "VAN-71", openSprint: false }), rule: "sprint-atual" },
    { name: "sprint state unreadable", issue: fakeIssue({ key: "VAN-72", summary: "NO_BOARD" }), rule: "sprint-atual" },
    { name: "assigned to a colleague", issue: fakeIssue({ key: "VAN-73", assignee: "acc-colleague" }), rule: "assignee-operador" },
    { name: "unassigned", issue: fakeIssue({ key: "VAN-74", assignee: null }), rule: "assignee-operador" },
    { name: "already claimed by label", issue: fakeIssue({ key: "VAN-75", labels: ["ready-for-agent", "playbooks", "agent-claimed"] }), rule: "not-claimed" },
    { name: "not ready for agent", issue: fakeIssue({ key: "VAN-76", labels: ["playbooks"] }), rule: "ready" },
    { name: "terminal", issue: fakeIssue({ key: "VAN-77", statusName: "Itens concluídos", category: "done" }), rule: "not-terminal" },
    { name: "two routing labels", issue: fakeIssue({ key: "VAN-78", labels: ["ready-for-agent", "playbooks", "monolith"] }), rule: "routing" },
    {
      name: "blocked by an open issue",
      issue: fakeIssue({ key: "VAN-79", links: [{ type: BLOCKS, inwardIssue: "VAN-80" }] }),
      issues: [fakeIssue({ key: "VAN-80", category: "new", statusName: "A Fazer" })],
      rule: "no-blockers",
    },
    {
      name: "blocker state unreadable",
      issue: fakeIssue({ key: "VAN-81", links: [{ type: BLOCKS, inwardIssue: "VAN-82" }] }),
      issues: [fakeIssue({ key: "VAN-82", hideStatus: true })],
      rule: "no-blockers",
    },
  ];
  for (const testCase of cases) {
    const rules = await eligibilityOf([testCase.issue, ...(testCase.issues ?? [])], testCase.issue.key);
    assert.ok(rules.includes(testCase.rule), `${testCase.name} should be rejected by ${testCase.rule}, got ${rules.join(",")}`);
  }
});

test("a link to a blocker that is already Done does not block", async () => {
  const issues = [
    fakeIssue({ key: "VAN-83", links: [{ type: BLOCKS, inwardIssue: "VAN-84" }] }),
    fakeIssue({ key: "VAN-84", category: "done", statusName: "Itens concluídos" }),
  ];
  assert.deepEqual(await eligibilityOf(issues, "VAN-83"), []);
});
