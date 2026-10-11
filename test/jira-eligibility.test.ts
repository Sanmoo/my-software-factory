import assert from "node:assert/strict";
import test from "node:test";
import { coreRules, evaluateEligibility, type EligibilityInput } from "../src/core/eligibility.js";
import { jiraEligibilityRules } from "../src/tracker/jira-rules.js";
import type { IssueSnapshot, Known } from "../src/tracker/port.js";

const known = <T>(value: T): Known<T> => ({ known: true, value });
const unknown = (reason: string): Known<never> => ({ known: false, reason });

const jiraIssue = (overrides: Partial<IssueSnapshot> = {}): IssueSnapshot => ({
  ref: { tracker: "memory", project: "VAN", id: "VAN-1" },
  title: "Jira task",
  labels: known(["ready-for-agent", "monolith"]),
  assignees: known(["samuel.santos"]),
  claimed: known(false),
  blockers: known([]),
  statusCategory: known("to-do"),
  priority: known(3),
  openSprint: known(true),
  assignee: known("samuel.santos"),
  ...overrides,
});

const input = (issue: IssueSnapshot): EligibilityInput => ({
  project: { enabled: true, readyLabel: "ready-for-agent", routing: { kind: "label", routingLabel: "monolith", knownLabels: ["monolith"] } },
  issue,
  tracked: new Set(),
});
const verdict = (issue: IssueSnapshot) => evaluateEligibility(input(issue), [...coreRules, ...jiraEligibilityRules("samuel.santos")]);
const rejectedBy = (result: ReturnType<typeof verdict>) => (result.eligible ? [] : result.rejections.map((r) => r.rule));

test("a Jira issue in the open sprint, assigned to the operator, is eligible", () => {
  assert.deepEqual(verdict(jiraIssue()), { eligible: true });
});

test("a Jira issue outside the open sprint is rejected", () => {
  assert.deepEqual(rejectedBy(verdict(jiraIssue({ openSprint: known(false) }))), ["sprint-atual"]);
});

test("an unreadable sprint state is rejected, not presumed open", () => {
  assert.deepEqual(rejectedBy(verdict(jiraIssue({ openSprint: unknown("sprint field not read") }))), ["sprint-atual"]);
});

test("a Jira issue whose sprint was never read is rejected", () => {
  assert.deepEqual(rejectedBy(verdict(jiraIssue({ openSprint: undefined }))), ["sprint-atual"]);
});

test("a Jira issue assigned to someone else is rejected", () => {
  assert.deepEqual(rejectedBy(verdict(jiraIssue({ assignee: known("colleague") }))), ["assignee-operador"]);
});

test("an unassigned Jira issue is rejected", () => {
  assert.deepEqual(rejectedBy(verdict(jiraIssue({ assignee: known(null) }))), ["assignee-operador"]);
});

test("an unreadable assignee is rejected", () => {
  assert.deepEqual(rejectedBy(verdict(jiraIssue({ assignee: unknown("assignee not read") }))), ["assignee-operador"]);
});

test("the Jira rules are an added set: core rules alone do not require sprint or assignee", () => {
  const core = evaluateEligibility(input(jiraIssue({ openSprint: known(false), assignee: known("colleague") })));
  assert.deepEqual(core, { eligible: true });
});
