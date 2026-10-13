import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadMemoryTracker, type MemoryTracker } from "../src/tracker/memory.js";
import { PartialWriteError, type ClaimMark, type Intent, type WriteOutcome } from "../src/tracker/port.js";

const fixturePath = fileURLToPath(new URL("./fixtures/status-tracker.json", import.meta.url));
const load = async () => loadMemoryTracker(JSON.parse(await readFile(fixturePath, "utf8")));
const github = { project: "samuel-santos_bjd/dora-metrics", readyLabel: "ready-for-agent" };
const ref = { tracker: "memory" as const, project: github.project, id: "1" };

// One To Do issue, ready for an agent, with no claim of its own; a test adjusts the mark when it
// needs a tracker that also assigns an account.
const single = (claimMark?: ClaimMark): MemoryTracker => loadMemoryTracker({
  ...(claimMark === undefined ? {} : { claimMark }),
  issues: [{
    project: github.project, id: "1", title: "Issue 1", labels: ["ready-for-agent"], assignees: [],
    claimed: false, statusCategory: "to-do", priority: null, blockers: [], comments: [],
  }],
});
const labelsOf = async (tracker: MemoryTracker): Promise<string[]> => {
  const labels = (await tracker.readIssue(ref)).labels;
  return labels.known ? labels.value : [];
};
// The intents a write reported; a refusal is a failure in these tests.
const madeOf = (outcome: WriteOutcome): Intent[] => {
  assert.ok("made" in outcome, "the write reported no intents");
  return outcome.made;
};

test("discovery returns ready issues of the scope, including ones with unreadable labels", async () => {
  const tracker = await load();
  const ids = (await tracker.discoverCandidates(github)).map((ref) => ref.id);
  assert.deepEqual(ids, ["1", "2", "3", "5", "7", "8", "9", "10", "12"]);
});

test("discovery is limited to the scope and to the ready label", async () => {
  const tracker = await load();
  const ids = (await tracker.discoverCandidates({ project: "VAN", readyLabel: "ready-for-agent" })).map((ref) => ref.id);
  assert.deepEqual(ids, ["VAN-1", "VAN-2", "VAN-3", "VAN-4", "VAN-5", "VAN-6"]);
});

test("readIssue reports a blocker terminal flag only when the blocker can be read", async () => {
  const tracker = await load();
  const open = await tracker.readIssue({ tracker: "memory", project: github.project, id: "3" });
  assert.equal(open.blockers.known, true);
  assert.deepEqual(open.blockers.known && open.blockers.value.map((b) => b.terminal), [{ known: true, value: false }]);
  const missing = await tracker.readIssue({ tracker: "memory", project: github.project, id: "12" });
  assert.equal(missing.blockers.known, true);
  assert.equal(missing.blockers.known && missing.blockers.value[0].terminal.known, false);
});

test("the claim mark is a label: claim adds it, release removes it, and another claim stays", async () => {
  const tracker = await load();
  const ref = { tracker: "memory" as const, project: github.project, id: "1" };
  assert.deepEqual(tracker.claimMarkOf(ref).assignees, []);
  const [mark] = tracker.claimMarkOf(ref).labels;
  assert.ok(mark);
  const labelsOf = async () => { const l = (await tracker.readIssue(ref)).labels; return l.known ? l.value : []; };
  assert.ok(!(await labelsOf()).includes(mark));
  await tracker.claim(ref);
  assert.ok((await labelsOf()).includes(mark));
  await tracker.releaseClaim(ref);
  assert.ok(!(await labelsOf()).includes(mark));
});

test("claim, release and done are observable through readIssue", async () => {
  const tracker = await load();
  const ref = { tracker: "memory" as const, project: github.project, id: "1" };
  assert.deepEqual(await tracker.claim(ref), {
    made: [
      { operation: "adicionar-label", target: "claim" },
      { operation: "transição", target: "doing", reaches: ["in-progress"] },
    ],
  });
  const claimed = await tracker.readIssue(ref);
  assert.deepEqual(claimed.claimed, { known: true, value: true });
  assert.deepEqual(await tracker.releaseClaim(ref), { made: [{ operation: "remover-label", target: "claim" }] });
  assert.deepEqual((await tracker.readIssue(ref)).claimed, { known: true, value: false });
  assert.deepEqual(await tracker.markDone(ref), { made: [{ operation: "fechar", reaches: ["done"] }] });
  assert.deepEqual((await tracker.readIssue(ref)).statusCategory, { known: true, value: "done" });
});

// ---- failure plan: one named way per scenario, no hand-rolled wrapper port --------------

test("falha-antes: the write does not land and the next call succeeds", async () => {
  const tracker = single();
  tracker.failNext("claim", "falha-antes");
  await assert.rejects(tracker.claim(ref), /falha de escrita/);
  assert.ok(!(await labelsOf(tracker)).includes("claim"), "nothing was written");

  assert.equal(madeOf(await tracker.claim(ref)).length, 2);
  assert.ok((await labelsOf(tracker)).includes("claim"));
  assert.equal(tracker.calls("claim"), 2, "the plan is consumed once");
});

test("resposta-perdida: the write lands and the answer is lost", async () => {
  const tracker = single();
  tracker.failNext("claim", "resposta-perdida");
  await assert.rejects(tracker.claim(ref), /resposta da escrita perdida/);
  assert.ok((await labelsOf(tracker)).includes("claim"));
  assert.deepEqual((await tracker.readIssue(ref)).claimed, { known: true, value: true });
});

test("invisível: the call is accepted but the reread does not show the write", async () => {
  const tracker = single();
  await tracker.claim(ref);
  tracker.failNext("releaseClaim", "invisível");
  const outcome = await tracker.releaseClaim(ref);
  assert.deepEqual(madeOf(outcome).map((intent) => intent.operation), ["remover-label"]);
  assert.ok((await labelsOf(tracker)).includes("claim"), "the reread still shows the mark");
});

test("ultima-invisivel: the earlier steps land and only the last one is not visible", async () => {
  const tracker = single({ labels: ["claim"], assignees: ["acme"] });
  await tracker.claim(ref);
  tracker.failNext("releaseClaim", "ultima-invisivel");
  const outcome = await tracker.releaseClaim(ref);
  assert.deepEqual(madeOf(outcome).map((intent) => intent.operation), ["remover-label", "remover-atribuição"]);
  const snapshot = await tracker.readIssue(ref);
  assert.ok(snapshot.labels.known && !snapshot.labels.value.includes("claim"), "the label removal is visible");
  assert.ok(snapshot.assignees.known && snapshot.assignees.value.includes("acme"), "the account removal is not");
});

test("falha-antes on markDone leaves the issue open and the next call closes it", async () => {
  const tracker = single();
  tracker.failNext("markDone", "falha-antes");
  await assert.rejects(tracker.markDone(ref));
  assert.deepEqual((await tracker.readIssue(ref)).statusCategory, { known: true, value: "to-do" });
  await tracker.markDone(ref);
  assert.deepEqual((await tracker.readIssue(ref)).statusCategory, { known: true, value: "done" });
});

test("sem-confirmacao: the write lands and the intents are reported without a result", async () => {
  const tracker = single();
  tracker.failNext("claim", "sem-confirmacao");
  const outcome = await tracker.claim(ref);
  assert.deepEqual(madeOf(outcome).map((intent) => intent.operation), ["adicionar-label", "transição"]);
  assert.ok((await labelsOf(tracker)).includes("claim"), "the write landed, only the report carries no result");
});

test("parcial: the first write lands and PartialWriteError carries what was made", async () => {
  const tracker = single({ labels: ["claim"], assignees: ["acme"] });
  await tracker.claim(ref);
  tracker.failNext("releaseClaim", "parcial", "atribuição recusada");
  await assert.rejects(tracker.releaseClaim(ref), (error: unknown) => {
    assert.ok(error instanceof PartialWriteError);
    assert.equal(error.message, "atribuição recusada");
    assert.deepEqual(error.made, [{ operation: "remover-label", target: "claim" }]);
    return true;
  });
  const snapshot = await tracker.readIssue(ref);
  assert.ok(snapshot.labels.known && !snapshot.labels.value.includes("claim"), "the label removal landed");
  assert.ok(snapshot.assignees.known && snapshot.assignees.value.includes("acme"), "the account removal did not");
});

test("recusa: the tracker refuses the claim without writing", async () => {
  const tracker = single();
  tracker.failNext("claim", "recusa", "issue já claimed");
  assert.deepEqual(await tracker.claim(ref), { refused: "issue já claimed" });
  assert.ok(!(await labelsOf(tracker)).includes("claim"));
});

test("releitura-falha: the next read fails once and the following one works", async () => {
  const tracker = single();
  tracker.failNext("readIssue", "releitura-falha");
  await assert.rejects(tracker.readIssue(ref), /releitura indisponível/);
  assert.equal((await tracker.readIssue(ref)).title, "Issue 1");
  assert.equal(tracker.calls("readIssue"), 2);
});

test("a claim mark with an account is added and removed by the mark", async () => {
  const tracker = single({ labels: ["claim"], assignees: ["acme"] });
  assert.deepEqual(tracker.claimMarkOf(ref), { labels: ["claim"], assignees: ["acme"] });
  await tracker.claim(ref);
  assert.deepEqual((await tracker.readIssue(ref)).assignees, { known: true, value: ["acme"] });
  const outcome = await tracker.releaseClaim(ref);
  assert.deepEqual(madeOf(outcome).map((intent) => [intent.operation, intent.target]),
    [["remover-label", "claim"], ["remover-atribuição", "acme"]]);
  assert.deepEqual((await tracker.readIssue(ref)).assignees, { known: true, value: [] });
});
