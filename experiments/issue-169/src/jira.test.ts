import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CAS_PREMISE_MODEL,
  DOCUMENTED_MODEL,
  JiraCloud,
  JiraRequestError,
  type JiraModel,
} from "./jira.js";

const SITE = "alpha.atlassian.net";
const ISSUE_ID = 10001;
const PROPERTY = "com.sanmoo.msf.claim";

function value(factory: string): { factory: string } {
  return { factory };
}

function seed(tracker: JiraCloud): void {
  tracker.seedIssue({ site: SITE, stableId: String(ISSUE_ID), key: "OPS-1" });
}

function claimOf(tracker: JiraCloud): string | null {
  const stored = tracker.storedProperty(SITE, ISSUE_ID, PROPERTY);
  return stored.kind === "present" ? String((stored.value as { factory?: string }).factory) : null;
}

describe("documented bulk-property semantics", () => {
  test("without isolation, two jobs can read the pre-state, both write, and the last write wins", () => {
    const tracker = new JiraCloud(DOCUMENTED_MODEL);
    seed(tracker);
    const a = tracker.submitConditional({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: value("A"),
      factory: "A",
    });
    const b = tracker.submitConditional({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: value("B"),
      factory: "B",
    });
    assert.equal(tracker.beginJob(a.taskId), true);
    assert.equal(tracker.beginJob(b.taskId), true, "both evaluated eligibility against the same pre-state");
    tracker.commitJob(a.taskId);
    tracker.commitJob(b.taskId);
    assert.equal(claimOf(tracker), "B");
    assert.equal(tracker.pollTask(a.taskId, "A").result, null, "the task result is undocumented for this operation");
    assert.equal(tracker.pollTask(b.taskId, "B").status, "COMPLETE");
  });

  test("the transaction is all-or-nothing, not a test-and-write: the second commit still writes", () => {
    const tracker = new JiraCloud(DOCUMENTED_MODEL);
    seed(tracker);
    const a = tracker.submitConditional({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: value("A"),
      factory: "A",
    });
    const b = tracker.submitConditional({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: value("B"),
      factory: "B",
    });
    tracker.beginJob(a.taskId);
    tracker.beginJob(b.taskId);
    tracker.commitJob(a.taskId);
    tracker.commitJob(b.taskId);
    const writes = tracker.requestLog().filter((entry) => entry.op === "bulk job" && entry.outcome === "applied");
    assert.equal(writes.length, 2);
  });

  test("when eligibility is fixed at enqueue, serialized writes do not undo the stale decision", () => {
    const model: JiraModel = { ...DOCUMENTED_MODEL, eligibilityAt: "enqueue" };
    const tracker = new JiraCloud(model);
    seed(tracker);
    const a = tracker.submitConditional({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: value("A"),
      factory: "A",
    });
    const b = tracker.submitConditional({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: value("B"),
      factory: "B",
    });
    tracker.applyJob(a.taskId);
    tracker.applyJob(b.taskId);
    assert.equal(claimOf(tracker), "B", "B's enqueue-time eligibility was true and its write ran second");
  });

  test("under the CAS premise the second job finds the property present and updates nothing", () => {
    const tracker = new JiraCloud(CAS_PREMISE_MODEL);
    seed(tracker);
    const a = tracker.submitConditional({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: value("A"),
      factory: "A",
    });
    const b = tracker.submitConditional({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: value("B"),
      factory: "B",
    });
    tracker.applyJob(a.taskId);
    tracker.applyJob(b.taskId);
    assert.equal(claimOf(tracker), "A");
    const skipped = tracker.requestLog().filter((entry) => entry.op === "bulk job" && entry.outcome === "skipped");
    assert.equal(skipped.length, 1);
  });

  test("'no eligible Ticket' is a successful 303, never an error", () => {
    const tracker = new JiraCloud(CAS_PREMISE_MODEL);
    seed(tracker);
    tracker.setPropertyBlind({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: value("already-claimed"),
      factory: "someone",
    });
    const job = tracker.submitConditional({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: value("late"),
      factory: "late",
    });
    tracker.applyJob(job.taskId);
    assert.equal(claimOf(tracker), "already-claimed");
    assert.equal(tracker.pollTask(job.taskId, "late").status, "COMPLETE");
  });

  test("the single-issue write is blind: it overwrites a present claim with no precondition", () => {
    const tracker = new JiraCloud(CAS_PREMISE_MODEL);
    seed(tracker);
    tracker.setPropertyBlind({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: value("A"),
      factory: "A",
    });
    tracker.setPropertyBlind({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: value("B"),
      factory: "B",
    });
    assert.equal(claimOf(tracker), "B");
  });

  test("a documented 409-style guard exists on neither the conditional PUT nor the single write", () => {
    const tracker = new JiraCloud(DOCUMENTED_MODEL);
    seed(tracker);
    // The model has no conflict rejection; the endpoint documents 303/400/401
    // only. A second submission is always scheduled.
    const a = tracker.submitConditional({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: value("A"),
      factory: "A",
    });
    const b = tracker.submitConditional({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: value("B"),
      factory: "B",
    });
    assert.notEqual(a.taskId, b.taskId);
  });
});

describe("reads the API admits", () => {
  test("fresh returns the stored value; prefix omits the most recent write; search staleness is separate", () => {
    const prefix = new JiraCloud({ ...DOCUMENTED_MODEL, readModel: "prefix" });
    seed(prefix);
    prefix.setPropertyBlind({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: value("A"),
      factory: "A",
    });
    assert.equal(
      prefix.readProperty({ site: SITE, issueId: ISSUE_ID, propertyKey: PROPERTY, factory: "B", via: "direct" }).kind,
      "absent",
    );

    const search = new JiraCloud({ ...DOCUMENTED_MODEL, searchStale: true });
    seed(search);
    search.setPropertyBlind({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: value("A"),
      factory: "A",
    });
    assert.equal(
      search.readProperty({ site: SITE, issueId: ISSUE_ID, propertyKey: PROPERTY, factory: "B", via: "search" }).kind,
      "absent",
    );
    assert.equal(
      search.readProperty({ site: SITE, issueId: ISSUE_ID, propertyKey: PROPERTY, factory: "B", via: "direct" }).kind,
      "present",
    );
  });

  test("a failed read throws once and the next read answers", () => {
    const tracker = new JiraCloud(DOCUMENTED_MODEL);
    seed(tracker);
    tracker.failNextRead("503 Service Unavailable");
    assert.throws(
      () => tracker.readProperty({ site: SITE, issueId: ISSUE_ID, propertyKey: PROPERTY, factory: "A", via: "direct" }),
      JiraRequestError,
    );
    assert.equal(
      tracker.readProperty({ site: SITE, issueId: ISSUE_ID, propertyKey: PROPERTY, factory: "A", via: "direct" }).kind,
      "absent",
    );
  });

  test("currentValue is compared by the same undocumented machinery: two value-conditioned jobs can both commit", () => {
    const tracker = new JiraCloud(DOCUMENTED_MODEL);
    seed(tracker);
    tracker.setPropertyBlind({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: { factory: "A" },
      factory: "A",
    });
    const observed = { factory: "A" };
    const first = tracker.submitConditional({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: { factory: "B" },
      factory: "B",
      filter: "current-value",
      currentValue: observed,
    });
    const second = tracker.submitConditional({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: { factory: "C" },
      factory: "C",
      filter: "current-value",
      currentValue: observed,
    });
    assert.equal(tracker.beginJob(first.taskId), true);
    assert.equal(tracker.beginJob(second.taskId), true, "both compared against the same observed value");
    tracker.commitJob(first.taskId);
    tracker.commitJob(second.taskId);
    assert.equal(claimOf(tracker), "C");

    const cas = new JiraCloud(CAS_PREMISE_MODEL);
    seed(cas);
    cas.setPropertyBlind({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: { factory: "A" },
      factory: "A",
    });
    const casFirst = cas.submitConditional({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: { factory: "B" },
      factory: "B",
      filter: "current-value",
      currentValue: observed,
    });
    const casSecond = cas.submitConditional({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: { factory: "C" },
      factory: "C",
      filter: "current-value",
      currentValue: observed,
    });
    cas.applyJob(casFirst.taskId);
    cas.applyJob(casSecond.taskId);
    assert.equal(claimOf(cas), "B", "the second transfer no longer matches the current value");
  });

  test("a currentValue filter without a value is rejected before any job exists", () => {
    const tracker = new JiraCloud(DOCUMENTED_MODEL);
    seed(tracker);
    assert.throws(
      () =>
        tracker.submitConditional({
          site: SITE,
          issueId: ISSUE_ID,
          propertyKey: PROPERTY,
          value: { factory: "B" },
          factory: "B",
          filter: "current-value",
        }),
      JiraRequestError,
    );
    assert.equal(tracker.scheduledTaskIds().length, 0);
  });

  test("a request that fails before scheduling leaves no job and no write", () => {
    const tracker = new JiraCloud(CAS_PREMISE_MODEL);
    seed(tracker);
    assert.throws(
      () =>
        tracker.submitConditional({
          site: SITE,
          issueId: ISSUE_ID,
          propertyKey: PROPERTY,
          value: { factory: "A" },
          factory: "A",
          failures: { failBeforeScheduling: true },
        }),
      JiraRequestError,
    );
    assert.equal(tracker.scheduledTaskIds().length, 0);
    assert.equal(claimOf(tracker), null);
  });

  test("a failed job updates nothing and is reported FAILED", () => {
    const tracker = new JiraCloud(CAS_PREMISE_MODEL);
    seed(tracker);
    const job = tracker.submitConditional({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: value("A"),
      factory: "A",
    });
    tracker.failJob(job.taskId, "transaction failed");
    const task = tracker.pollTask(job.taskId, "A");
    assert.equal(task.status, "FAILED");
    assert.equal(claimOf(tracker), null);
  });

  test("a task result reports the updated count only when the model says the format is known", () => {
    const counts = new JiraCloud({ ...CAS_PREMISE_MODEL, taskResult: "counts" });
    seed(counts);
    const job = counts.submitConditional({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: value("A"),
      factory: "A",
    });
    counts.applyJob(job.taskId);
    assert.deepEqual(counts.pollTask(job.taskId, "A").result, { updated: 1 });
  });
});

describe("the model offers no hidden coordination", () => {
  test("there is no winner oracle and no lock: the outcome follows only the chosen order", () => {
    const tracker = new JiraCloud(DOCUMENTED_MODEL);
    seed(tracker);
    const a = tracker.submitConditional({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: value("A"),
      factory: "A",
    });
    const b = tracker.submitConditional({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: value("B"),
      factory: "B",
    });
    tracker.beginJob(a.taskId);
    tracker.beginJob(b.taskId);
    tracker.commitJob(b.taskId);
    tracker.commitJob(a.taskId);
    assert.equal(claimOf(tracker), "A", "nothing prefers A or B; the commit order decides");

    const forward = new JiraCloud(DOCUMENTED_MODEL);
    seed(forward);
    const c = forward.submitConditional({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: value("A"),
      factory: "A",
    });
    const d = forward.submitConditional({
      site: SITE,
      issueId: ISSUE_ID,
      propertyKey: PROPERTY,
      value: value("B"),
      factory: "B",
    });
    forward.beginJob(c.taskId);
    forward.beginJob(d.taskId);
    forward.commitJob(c.taskId);
    forward.commitJob(d.taskId);
    assert.equal(claimOf(forward), "B");
  });
});
