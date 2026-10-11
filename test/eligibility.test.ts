import assert from "node:assert/strict";
import test from "node:test";
import { evaluateEligibility, type EligibilityInput, type Routing } from "../src/core/eligibility.js";
import { refKey, type IssueSnapshot, type Known } from "../src/tracker/port.js";

const known = <T>(value: T): Known<T> => ({ known: true, value });
const unknown = (reason: string): Known<never> => ({ known: false, reason });

const githubIssue = (overrides: Partial<IssueSnapshot> = {}): IssueSnapshot => ({
  ref: { tracker: "github", project: "owner/repo", id: "7" },
  title: "Ready task",
  labels: known(["ready-for-agent"]),
  assignees: known([]),
  claimed: known(false),
  blockers: known([]),
  statusCategory: known("to-do"),
  priority: known(null),
  ...overrides,
});

const repositoryRouting: Routing = { kind: "repository" };
const project = { enabled: true, readyLabel: "ready-for-agent", routing: repositoryRouting };

function check(
  issue: IssueSnapshot,
  options: { project?: Partial<EligibilityInput["project"]>; tracked?: string[] } = {},
) {
  return evaluateEligibility({
    project: { ...project, ...options.project },
    issue,
    tracked: new Set(options.tracked ?? []),
  });
}

const rejections = (verdict: ReturnType<typeof check>) => (verdict.eligible ? [] : verdict.rejections);

test("a ready GitHub issue with no claim, blockers or terminal state is eligible", () => {
  assert.deepEqual(check(githubIssue()), { eligible: true });
});

test("an issue without the ready-for-agent label is rejected by the ready rule", () => {
  const verdict = check(githubIssue({ labels: known(["bug"]) }));
  assert.deepEqual(rejections(verdict).map((r) => r.rule), ["ready"]);
  assert.match(rejections(verdict)[0].reason, /ready-for-agent/);
});

test("the ready label name is configurable per project", () => {
  const verdict = check(githubIssue({ labels: known(["pronta"]) }), { project: { readyLabel: "pronta" } });
  assert.deepEqual(verdict, { eligible: true });
});

test("a claimed issue is rejected", () => {
  const verdict = check(githubIssue({ claimed: known(true) }));
  assert.deepEqual(rejections(verdict).map((r) => r.rule), ["not-claimed"]);
});

test("an unreadable claim is rejected with its reason, never treated as unclaimed", () => {
  const verdict = check(githubIssue({ claimed: unknown("claim API timeout") }));
  assert.deepEqual(rejections(verdict).map((r) => r.rule), ["not-claimed"]);
  assert.match(rejections(verdict)[0].reason, /claim API timeout/);
});

test("an open blocker rejects the issue and names the blocker", () => {
  const blocker = { ref: { tracker: "github" as const, project: "owner/repo", id: "4" }, terminal: known(false) };
  const verdict = check(githubIssue({ blockers: known([blocker]) }));
  assert.deepEqual(rejections(verdict).map((r) => r.rule), ["no-blockers"]);
  assert.match(rejections(verdict)[0].reason, /#4/);
});

test("a blocker already in a terminal state does not block", () => {
  const blocker = { ref: { tracker: "github" as const, project: "owner/repo", id: "4" }, terminal: known(true) };
  assert.deepEqual(check(githubIssue({ blockers: known([blocker]) })), { eligible: true });
});

test("a blocker whose state cannot be read rejects the issue", () => {
  const blocker = { ref: { tracker: "github" as const, project: "owner/repo", id: "4" }, terminal: unknown("404 on blocker") };
  const verdict = check(githubIssue({ blockers: known([blocker]) }));
  assert.deepEqual(rejections(verdict).map((r) => r.rule), ["no-blockers"]);
  assert.match(rejections(verdict)[0].reason, /404 on blocker/);
});

test("an unreadable blocker list rejects the issue", () => {
  const verdict = check(githubIssue({ blockers: unknown("dependency API timeout") }));
  assert.deepEqual(rejections(verdict).map((r) => r.rule), ["no-blockers"]);
});

test("a terminal issue is not a candidate", () => {
  const verdict = check(githubIssue({ statusCategory: known("done") }));
  assert.deepEqual(rejections(verdict).map((r) => r.rule), ["not-terminal"]);
});

test("an unknown status category is rejected, not presumed open", () => {
  const verdict = check(githubIssue({ statusCategory: unknown("status not read") }));
  assert.deepEqual(rejections(verdict).map((r) => r.rule), ["not-terminal"]);
});

test("an issue already tracked by the script is not a new candidate", () => {
  const issue = githubIssue();
  const verdict = check(issue, { tracked: [refKey(issue.ref)] });
  assert.deepEqual(rejections(verdict).map((r) => r.rule), ["not-tracked"]);
});

test("a disabled project admits nothing", () => {
  const verdict = check(githubIssue(), { project: { enabled: false } });
  assert.deepEqual(rejections(verdict).map((r) => r.rule), ["enabled"]);
});

test("unreadable labels reject the issue because readiness cannot be shown", () => {
  const verdict = check(githubIssue({ labels: unknown("labels not read") }));
  assert.deepEqual(rejections(verdict).map((r) => r.rule), ["ready"]);
});

test("every failing criterion is reported, not only the first", () => {
  const verdict = check(githubIssue({ claimed: known(true), statusCategory: known("done") }));
  assert.deepEqual(rejections(verdict).map((r) => r.rule), ["not-claimed", "not-terminal"]);
});

test("GitHub adds no sprint or assignee requirement", () => {
  const verdict = check(githubIssue({ assignees: known([]) }));
  assert.deepEqual(verdict, { eligible: true });
});

test("routing: an issue without a routing label is rejected as sem roteamento", () => {
  const routing: Routing = { kind: "label", routingLabel: "monolith", knownLabels: ["monolith", "dealer-services"] };
  const verdict = check(githubIssue({ labels: known(["ready-for-agent"]) }), { project: { routing } });
  assert.deepEqual(rejections(verdict).map((r) => r.rule), ["routing"]);
  assert.match(rejections(verdict)[0].reason, /sem roteamento/);
});

test("routing: two routing labels are rejected as roteamento ambíguo", () => {
  const routing: Routing = { kind: "label", routingLabel: "monolith", knownLabels: ["monolith", "dealer-services"] };
  const verdict = check(githubIssue({ labels: known(["ready-for-agent", "monolith", "dealer-services"]) }),
    { project: { routing } });
  assert.deepEqual(rejections(verdict).map((r) => r.rule), ["routing"]);
  assert.match(rejections(verdict)[0].reason, /roteamento ambíguo/);
});

test("routing: exactly one matching routing label routes to this project", () => {
  const routing: Routing = { kind: "label", routingLabel: "monolith", knownLabels: ["monolith", "dealer-services"] };
  const verdict = check(githubIssue({ labels: known(["ready-for-agent", "monolith", "bug"]) }), { project: { routing } });
  assert.deepEqual(verdict, { eligible: true });
});

test("routing: a single routing label for another project is rejected for this project", () => {
  const routing: Routing = { kind: "label", routingLabel: "monolith", knownLabels: ["monolith", "dealer-services"] };
  const verdict = check(githubIssue({ labels: known(["ready-for-agent", "dealer-services"]) }), { project: { routing } });
  assert.deepEqual(rejections(verdict).map((r) => r.rule), ["routing"]);
  assert.match(rejections(verdict)[0].reason, /dealer-services/);
});

test("routing is never inferred from the title", () => {
  const routing: Routing = { kind: "label", routingLabel: "monolith", knownLabels: ["monolith"] };
  const verdict = check(githubIssue({ title: "[monolith] refactor", labels: known(["ready-for-agent"]) }), { project: { routing } });
  assert.match(rejections(verdict)[0].reason, /sem roteamento/);
});
