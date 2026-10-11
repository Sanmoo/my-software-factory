import assert from "node:assert/strict";
import test from "node:test";
import { jobBranch, newJob, recordPrStatus, transitionJob, type Job } from "../src/core/job.js";

const ref = { tracker: "github" as const, project: "acme/app", id: "7" };
const start = (): Job => newJob({ ref, repository: "acme/app" });

test("a new job is running, holds the identity tracker + project + issue id, and keeps a log", () => {
  const job = start();
  assert.equal(job.key, "github:acme/app#7");
  assert.equal(job.state, "running");
  assert.deepEqual(job.ref, ref);
  assert.equal(job.repository, "acme/app");
  assert.deepEqual(job.log, []);
});

test("help, PR and interruption are reached only from running and keep their details", () => {
  const help = transitionJob(start(), "waiting-for-help", {
    message: "pedido de ajuda", question: "Which seam?", context: "slugify",
  });
  assert.equal(help.state, "waiting-for-help");
  assert.equal(help.question, "Which seam?");
  assert.equal(help.context, "slugify");
  assert.deepEqual(help.log, ["pedido de ajuda"]);

  const pr = transitionJob(start(), "waiting-for-pr", { message: "PR", pr: { repository: "acme/app", number: 3 } });
  assert.deepEqual(pr.pr, { repository: "acme/app", number: 3 });

  const interrupted = transitionJob(start(), "interrupted", { message: "queda", reason: "orchestrator crashed" });
  assert.equal(interrupted.reason, "orchestrator crashed");
});

test("the job never moves from done and never moves to an unknown state", () => {
  const done = transitionJob(start(), "done", { message: "done" });
  assert.throws(() => transitionJob(done, "running", { message: "again" }), /transição/);
});

test("resuming a waiting job clears its question and reason but keeps its PR reference", () => {
  const pr = transitionJob(start(), "waiting-for-pr", { message: "PR", pr: { repository: "acme/app", number: 3 } });
  const correcting = transitionJob(pr, "running", { message: "correção" });
  assert.equal(correcting.state, "running");
  assert.equal(correcting.question, undefined);
  assert.deepEqual(correcting.pr, { repository: "acme/app", number: 3 });
});

test("a job cannot go straight from waiting-for-help to waiting-for-pr without running", () => {
  const help = transitionJob(start(), "waiting-for-help", { message: "ajuda", question: "?", context: "" });
  assert.throws(() => transitionJob(help, "waiting-for-pr", { message: "pr", pr: { repository: "acme/app", number: 1 } }), /transição/);
});

test("transitions do not mutate the job they start from", () => {
  const job = start();
  transitionJob(job, "interrupted", { message: "queda", reason: "x" });
  assert.equal(job.state, "running");
  assert.deepEqual(job.log, []);
});

test("the job branch is msf/ and the issue id, the head the factory checks a PR against", () => {
  assert.equal(jobBranch(ref), "msf/7");
  assert.equal(jobBranch({ tracker: "jira", project: "VAN", id: "VAN-12" }), "msf/VAN-12");
});

test("recording PR status keeps the state and the PR, and logs only when a message is given", () => {
  const pr = transitionJob(start(), "waiting-for-pr", { message: "PR validado", pr: { repository: "acme/app", number: 3 } });
  const status = { checks: { known: true as const, value: "pending" as const }, review: { known: true as const, value: "none" as const } };

  const silent = recordPrStatus(pr, status);
  assert.equal(silent.state, "waiting-for-pr");
  assert.deepEqual(silent.prStatus, status);
  assert.deepEqual(silent.log, ["PR validado"]);

  const logged = recordPrStatus(silent, { ...status, checks: { known: true, value: "passing" } }, "CI: passing");
  assert.deepEqual(logged.log, ["PR validado", "CI: passing"]);
  assert.equal(pr.prStatus, undefined, "the job it starts from is not mutated");
});
