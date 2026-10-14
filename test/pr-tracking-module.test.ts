import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectConfig } from "../src/config/types.js";
import { Announcements } from "../src/core/announcements.js";
import { IssueWrites } from "../src/core/issue-writes.js";
import { continuationCauses } from "../src/core/feedback.js";
import { holdsSlot, jobBranch, newJob, type Job } from "../src/core/job.js";
import { JobRegistry } from "../src/core/job-registry.js";
import type { JobStore } from "../src/core/job-store.js";
import { noopObserver, type OpsEvent } from "../src/core/observability.js";
import { PrTracking } from "../src/core/pr-tracking.js";
import type { PrFeedback, PrPort, PrSnapshot } from "../src/pr/port.js";
import type { Runner } from "../src/runtime/runner.js";
import { loadMemoryTracker } from "../src/tracker/memory.js";

const ref = { tracker: "memory" as const, project: "acme/app", id: "1" };
const pr = { repository: "acme/app", number: 9 };
const project: ProjectConfig = {
  name: "app", enabled: true, adapter: "github", repository: "acme/app", targetBranch: "main",
  prIntegration: "github.com", runtimeProfile: "docker-default", githubAccount: "bot",
  labels: { ready: "ready-for-agent", claimed: "claimed" },
  models: { default: "model", implementer: "model", "reviewer-spec": "model", "reviewer-standards": "model" },
};

function moduleOf(
  snapshot: Partial<PrSnapshot> = {},
  feedback: PrFeedback = { comments: [], checks: [] },
  runner: Pick<Runner, "triageUnavailable"> = {},
) {
  const job: Job = { ...newJob({ ref, repository: "acme/app" }), state: "waiting-for-pr", pr };
  const store: JobStore = {
    load: async () => ({ jobs: [job], unreadable: [] }), save: async () => {}, remove: async () => {},
  };
  const events: OpsEvent[] = [];
  const announcements = new Announcements({ ...noopObserver, emit: (event) => events.push(event) });
  const registry = new JobRegistry(store, 1, announcements, [job], []);
  const memory = loadMemoryTracker({ issues: [{
    project: "acme/app", id: "1", title: "Issue 1", labels: [], assignees: [], claimed: true,
    statusCategory: "in-progress", priority: null, blockers: [],
  }] });
  const prs: PrPort = {
    readPr: async () => ({ status: "found", pr: {
      ref: pr, state: "open", baseBranch: "main", headBranch: jobBranch(ref), headSha: "head-1", baseSha: "base-1",
      mergeable: { known: true, value: "mergeable" }, checks: { known: true, value: "pending" },
      review: { known: true, value: "none" }, ...snapshot,
    } }),
    readFeedback: async () => feedback,
  };
  const tracking = new PrTracking(prs, new IssueWrites(memory), registry, announcements, runner);
  const skipped: Array<{ key: string; reason: string }> = [];
  const errors: Array<{ key: string; message: string }> = [];
  // Direct public seam, without Admission or PollReport. The reporting surface has only
  // pular/falhar: admitted does not exist and cannot be written by PR tracking.
  const reporting: Parameters<PrTracking["trackPr"]>[2] = {
    pular: (key, reason) => { skipped.push({ key, reason }); },
    falhar: (key, message) => { errors.push({ key, message }); },
  };
  return { job, registry, memory, tracking, events, reporting, skipped, errors };
}

test("a merged PR reports pending until the tracker reread confirms done, then concludes", async () => {
  const s = moduleOf({ state: "merged" });
  s.memory.failNext("markDone", "invisível");

  await s.tracking.trackPr(s.job, project, s.reporting);

  assert.equal(s.registry.job(s.job.key)?.state, "waiting-for-pr");
  assert.deepEqual(s.errors, [{
    key: s.job.key,
    message: "PR mesclado; done ainda não confirmado pelo tracker (releitura não mostra done): nova tentativa no próximo polling",
  }]);
  assert.equal(s.events.filter((event) => event.kind === "merge-detectado").length, 1);
  assert.equal(s.events.at(-1)?.kind, "conclusão-pendente");
  assert.equal(s.memory.calls("markDone"), 1);
  assert.deepEqual((await s.memory.readIssue(ref)).statusCategory, { known: true, value: "in-progress" });

  await s.tracking.trackPr(s.registry.job(s.job.key)!, project, s.reporting);

  assert.equal(s.registry.job(s.job.key)?.state, "done");
  assert.deepEqual((await s.memory.readIssue(ref)).statusCategory, { known: true, value: "done" });
  assert.equal(s.memory.calls("markDone"), 2);
  assert.equal(s.events.filter((event) => event.kind === "merge-detectado").length, 1, "retry does not announce the merge again");
  assert.equal(s.events.at(-1)?.kind, "trabalho-concluído");
});

test("a conflict queues a correction with its own reason and waits for a free slot", async () => {
  const s = moduleOf({ mergeable: { known: true, value: "conflicting" } });
  const active = newJob({ ref: { ...ref, id: "2", project: "acme/other" }, repository: "acme/other" });
  assert.equal(s.registry.tryReserve(active), undefined);

  await s.tracking.trackPr(s.job, project, s.reporting);

  const queued = s.registry.job(s.job.key)!;
  assert.equal(queued.state, "waiting-for-pr", "tracking itself does not admit an invocation");
  assert.equal(holdsSlot(queued.state), false);
  assert.equal(queued.pending, "correction");
  assert.deepEqual(queued.feedback?.pending, [{
    kind: "conflict", key: "pr:conflict:head-1@base-1", head: "head-1", base: "base-1", targetBranch: "main", pr: "#9",
  }]);
  assert.deepEqual(continuationCauses(queued), [{ reason: "conflito-pr", origin: "pr", ref: "conflito head-1..base-1", pr: "#9" }]);
  assert.equal(s.registry.tryReserve(queued), "sem vaga livre");
  assert.equal(s.events.find((event) => event.kind === "feedback-recebido")?.fields?.motivo, "conflito-pr");
  assert.deepEqual(s.errors, []);
  assert.deepEqual(s.skipped, []);

  await s.registry.apply(active.key, "interrupted", { message: "vaga liberada" });
  assert.equal(s.registry.tryReserve(queued), undefined, "the correction reserves its own slot when available");
  assert.deepEqual(continuationCauses(s.registry.job(s.job.key)!), continuationCauses(queued), "waiting preserves the reason");
});

test("a human comment without triage asks for help without consuming the batch or taking a conflict", async () => {
  const triageContexts: unknown[] = [];
  const s = moduleOf({ mergeable: { known: true, value: "conflicting" } }, {
    comments: [{
      id: "comment-1", kind: "comment", author: "reviewer", isBot: false, body: "Please simplify this",
      createdAt: "2026-10-14T00:00:00Z",
    }],
    checks: [{ id: "check-1", name: "tests", state: { known: true, value: "failing" }, required: { known: true, value: true } }],
  }, {
    triageUnavailable: async (context) => { triageContexts.push(context); return "skill ausente"; },
  });

  await s.tracking.trackPr(s.job, project, s.reporting);

  const helped = s.registry.job(s.job.key)!;
  assert.equal(helped.state, "waiting-for-help");
  assert.match(helped.question ?? "", /Há comentário humano novo no PR \(acme\/app#9\)/);
  assert.match(helped.question ?? "", /skill ausente/);
  assert.match(helped.question ?? "", /nenhum item foi consumido/);
  assert.deepEqual(triageContexts, [{ ref, repository: "acme/app" }]);
  assert.deepEqual(helped.consumed ?? [], [], "neither the comment, check nor conflict is consumed");
  assert.equal(helped.pending, undefined);
  assert.equal(helped.feedback, undefined);
  assert.equal(s.events.some((event) => event.kind === "feedback-recebido"), false);
  assert.equal(s.events.at(-1)?.kind, "ajuda-solicitada");
  assert.deepEqual(s.errors, []);
  assert.deepEqual(s.skipped, []);
});
