import assert from "node:assert/strict";
import test from "node:test";
import { githubTicket } from "./explorer.js";
import { SimTracker } from "./tracker.js";

test("a read projection can hide a write that was already applied", () => {
  const tracker = new SimTracker(githubTicket("Sanmoo/fixture", 168));
  tracker.apply({ kind: "add-label", label: "agent-claimed" });
  tracker.apply({ kind: "comment", author: "factory-a", body: "claim" });

  assert.deepEqual(tracker.read({ kind: "prefix", upto: 0 }).comments, []);
  assert.deepEqual(tracker.read({ kind: "prefix", upto: 1 }).comments, []);
  assert.equal(tracker.read({ kind: "prefix", upto: 2 }).comments.length, 1);
  assert.deepEqual(tracker.read({ kind: "omit", indices: [1] }).comments, []);
  assert.equal(tracker.read({ kind: "all" }).comments.length, 1);
});

test("comments are listed by ascending id, even when ids do not follow application order", () => {
  const tracker = new SimTracker(
    githubTicket("Sanmoo/fixture", 168),
    {},
    "reverse",
  );
  tracker.apply({ kind: "comment", author: "a", body: "first applied" });
  tracker.apply({ kind: "comment", author: "b", body: "second applied" });
  const ids = tracker.snapshot().comments.map((comment) => comment.id);
  assert.equal(ids.length, 2);
  assert.ok((ids[0] ?? 0) < (ids[1] ?? 0));
  assert.equal(tracker.snapshot().comments[0]?.body, "second applied");
});

test("a multi-write claim is representable partially", () => {
  const tracker = new SimTracker(githubTicket("Sanmoo/fixture", 168));
  tracker.apply({ kind: "add-label", label: "agent-claimed" });
  // The padlock was applied; the assignment and the claim record were not.
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.labels.includes("agent-claimed"), true);
  assert.equal(snapshot.comments.length, 0);
  assert.equal(tracker.appliedCount, 1);
});

test("replaying a prefix is independent of later writes", () => {
  const tracker = new SimTracker(githubTicket("Sanmoo/fixture", 168));
  tracker.apply({ kind: "add-label", label: "one" });
  const before = tracker.read({ kind: "prefix", upto: 1 });
  tracker.apply({ kind: "add-label", label: "two" });
  const after = tracker.read({ kind: "prefix", upto: 1 });
  assert.deepEqual(before.labels, after.labels);
  assert.deepEqual(after.labels, ["one"]);
});
