import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadMemoryTracker } from "../src/tracker/memory.js";

const fixturePath = fileURLToPath(new URL("./fixtures/status-tracker.json", import.meta.url));
const load = async () => loadMemoryTracker(JSON.parse(await readFile(fixturePath, "utf8")));
const github = { project: "samuel-santos_bjd/dora-metrics", readyLabel: "ready-for-agent" };

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
  const accepted = await tracker.claim(ref);
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.changes?.[0]?.operation, "adicionar-label");
  const claimed = await tracker.readIssue(ref);
  assert.deepEqual(claimed.claimed, { known: true, value: true });
  assert.equal((await tracker.releaseClaim(ref))?.changes[0]?.result, "confirmed");
  assert.deepEqual((await tracker.readIssue(ref)).claimed, { known: true, value: false });
  assert.equal((await tracker.markDone(ref)).status, "done");
  const again = await tracker.markDone(ref);
  assert.equal(again.status, "already-done");
  assert.equal(again.changes?.[0]?.result, "unchanged");
});
