import assert from "node:assert/strict";
import test from "node:test";
import { ISSUE_BODY_LIMIT, ISSUE_TITLE_LIMIT, issueContextOf } from "../src/core/issue-context.js";
import type { IssueSnapshot } from "../src/tracker/port.js";

// The context an implementation invocation receives about its issue (R07, CA09). Tracker text is
// bounded: a long body is cut and says how much was left out, so a prompt has a known size.

const snapshot = (overrides: Partial<IssueSnapshot> = {}): IssueSnapshot => ({
  ref: { tracker: "github", project: "acme/app", id: "1" },
  title: "Slugify",
  labels: { known: true, value: ["ready-for-agent"] },
  assignees: { known: true, value: [] },
  claimed: { known: true, value: false },
  blockers: { known: true, value: [] },
  statusCategory: { known: true, value: "to-do" },
  priority: { known: true, value: null },
  ...overrides,
});

test("a short issue title and body reach the context unchanged", () => {
  const context = issueContextOf(snapshot({ body: { known: true, value: "Implementar slugify.\n\nVer docs/spec.md" } }));
  assert.deepEqual(context, {
    title: "Slugify",
    body: { known: true, value: "Implementar slugify.\n\nVer docs/spec.md" },
  });
});

test("a long body is cut to the limit and ends with a marker that says how much was left out", () => {
  const body = `${"x".repeat(ISSUE_BODY_LIMIT)}${"y".repeat(500)}`;
  const context = issueContextOf(snapshot({ body: { known: true, value: body } }));
  assert.equal(context.body.known, true);
  if (!context.body.known) return;
  assert.ok(context.body.value.startsWith("x".repeat(ISSUE_BODY_LIMIT)));
  assert.doesNotMatch(context.body.value, /y/);
  assert.match(context.body.value, /truncado: 500 caracteres omitidos/);
});

test("a long title is cut as well, so the context has a bounded size", () => {
  const context = issueContextOf(snapshot({ title: "t".repeat(ISSUE_TITLE_LIMIT + 50) }));
  assert.ok(context.title.length <= ISSUE_TITLE_LIMIT);
  assert.match(context.title, /…$/);
});

test("a body the tracker did not read stays unknown, with its reason", () => {
  const context = issueContextOf(snapshot());
  assert.deepEqual(context.body, { known: false, reason: "corpo não lido pelo tracker" });
});
