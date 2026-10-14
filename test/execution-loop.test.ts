import assert from "node:assert/strict";
import test from "node:test";
import type { ContinuationContext, IssueContext, Runner, RunnerContext } from "../src/runtime/runner.js";
import type { IssueRef } from "../src/tracker/port.js";
import { Announcements } from "../src/core/announcements.js";
import { ExecutionLoop } from "../src/core/execution-loop.js";
import type { JobRegistry } from "../src/core/job-registry.js";
import { noopObserver } from "../src/core/observability.js";

const ref: IssueRef = { tracker: "memory", project: "acme/app", id: "1" };
const delivery = { repository: "acme/app", targetBranch: "main", headBranch: "job-1" };
const workspace = { session: "session-1", area: "/work/job-1" };

// Direct public seam, without Admission. The narrowed registry has no apply/persist:
// transitioning a job is unavailable to the loop, even when a run stops.
function registryDouble() {
  const updates: unknown[] = [];
  const notes: string[] = [];
  const registry: Pick<JobRegistry, "update" | "note"> = {
    update: async (key, changes) => { updates.push({ key, changes }); },
    note: async (_key, message) => { notes.push(message); },
  };
  return { registry, updates, notes };
}

test("iterations without a final result run to the limit without transitioning a job", async () => {
  const { registry, updates, notes } = registryDouble();
  const contexts: RunnerContext[] = [];
  const runner: Runner = { run: async (context) => {
    contexts.push(context);
    return { kind: "continue", workspace };
  } };
  const loop = new ExecutionLoop(runner, registry, new Announcements(noopObserver), async () => {});

  const outcome = await loop.execute("job-1", ref, "new", 3, delivery, "inv-1");

  assert.deepEqual(outcome, {
    status: "iteration_limit",
    reason: "limite de iterações (3) atingido sem resultado válido",
    triage: { step: undefined, outcome: "incomplete" },
  });
  assert.deepEqual(contexts.map(({ iteration }) => iteration), [1, 2, 3]);
  assert.deepEqual(updates, Array.from({ length: 3 }, () => ({ key: "job-1", changes: { workspace } })));
  assert.deepEqual(notes, [
    "iteração 1/3 (new) sem resultado final; nova iteração",
    "iteração 2/3 (new) sem resultado final; nova iteração",
  ]);
});

for (const { results, reason } of [
  { results: [], reason: "saída ausente: nenhum resultado estruturado" },
  { results: [{ status: "interrupted", reason: "stop" }, { status: "interrupted", reason: "stop" }], reason: "saída ambígua: 2 resultados" },
  { results: [{ status: "done" }], reason: "status desconhecido: done" },
]) {
  test(`a final ${reason} returns invalid immediately without transitioning a job`, async () => {
    const { registry, updates, notes } = registryDouble();
    let invocations = 0;
    const runner: Runner = { run: async () => {
      invocations += 1;
      return { kind: "finished", results, workspace };
    } };
    const loop = new ExecutionLoop(runner, registry, new Announcements(noopObserver), async () => {});

    assert.deepEqual(await loop.execute("job-1", ref, "new", 3, delivery, "inv-1"), {
      status: "invalid", reason: `resultado inválido: ${reason}`,
      triage: { step: undefined, outcome: "incomplete" },
    });
    assert.equal(invocations, 1);
    assert.deepEqual(updates, [{ key: "job-1", changes: { workspace } }]);
    assert.deepEqual(notes, []);
  });
}

for (const { result, triage } of [
  { result: { status: "needs_help", question: "Which comments?", context: "Numbered list" }, triage: "help" },
  { result: { status: "pr_ready", pr: { repository: "acme/app", number: 7 } }, triage: "complete" },
  { result: { status: "interrupted", reason: "operator stopped the invocation" }, triage: "incomplete" },
]) {
  test(`${result.status} carries the result and triage ending without transitioning a job`, async () => {
    const { registry } = registryDouble();
    const continuation: ContinuationContext = { workspace, plan: { step: "apply", choice: [], retained: [] } };
    const issue: IssueContext = { title: "Implement change", body: { known: true, value: "Details" } };
    const runner: Runner = { run: async (context) => {
      assert.deepEqual(context, {
        jobId: "job-1", ref, repository: "acme/app", kind: "correction",
        iteration: 1, maxIterations: 3, invocation: "inv-1", continuation, issue,
      });
      return { kind: "finished", results: [result] };
    } };
    const loop = new ExecutionLoop(runner, registry, new Announcements(noopObserver), async () => {});

    assert.deepEqual(await loop.execute("job-1", ref, "correction", 3, delivery, "inv-1", continuation, issue), {
      ...result, triage: { step: "apply", outcome: triage },
    });
  });
}

test("a listing cannot accept a PR before the operator chooses the comments", async () => {
  const { registry } = registryDouble();
  const runner: Runner = { run: async () => ({
    kind: "finished", results: [{ status: "pr_ready", pr: { repository: "acme/app", number: 7 } }],
  }) };
  const loop = new ExecutionLoop(runner, registry, new Announcements(noopObserver), async () => {});

  assert.deepEqual(await loop.execute("job-1", ref, "correction", 1, delivery, "inv-1", {
    workspace, plan: { step: "list", comments: [], replies: [] },
  }), {
    status: "invalid",
    reason: "triagem terminou com PR pronto em vez de pedido de ajuda; os comentários não foram escolhidos pelo operador",
    triage: { step: "list", outcome: "incomplete" },
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("settle waits for every run and its interpretation, returning persistence errors but not runner failures", async () => {
  const runnerGate = deferred<void>();
  const interpretationStarted = deferred<void>();
  const interpretationGate = deferred<void>();
  const persistenceFailed = deferred<void>();
  const error = new Error("workspace could not be saved");
  const { registry } = registryDouble();
  registry.update = async () => { persistenceFailed.resolve(); throw error; };
  const runner: Runner = { run: async ({ jobId }) => {
    if (jobId === "unsaved") return { kind: "continue", workspace };
    await runnerGate.promise;
    throw new Error("runner died");
  } };
  const loop = new ExecutionLoop(runner, registry, new Announcements(noopObserver), async (key, outcome, expectedDelivery, invocation) => {
    assert.equal(key, "failed-runner");
    assert.equal(invocation, "inv-2");
    assert.deepEqual(expectedDelivery, delivery);
    assert.deepEqual(outcome, { status: "runner_failure", triage: { step: undefined, outcome: "incomplete" } });
    interpretationStarted.resolve();
    await interpretationGate.promise;
  });
  loop.dispatch("unsaved", ref, "new", 1, delivery, "inv-1");
  loop.dispatch("failed-runner", ref, "new", 1, delivery, "inv-2");
  let settled = false;
  const errors = loop.settle().then((result) => { settled = true; return result; });

  await persistenceFailed.promise;
  assert.equal(settled, false);
  runnerGate.resolve();
  await interpretationStarted.promise;
  assert.equal(settled, false);
  interpretationGate.resolve();
  assert.deepEqual(await errors, [error]);
  assert.deepEqual(await loop.settle(), [error]);
});

test("settle returns errors raised while Admission interprets an outcome", async () => {
  const { registry } = registryDouble();
  const runner: Runner = { run: async () => ({ kind: "finished", results: [{ status: "interrupted", reason: "stop" }] }) };
  const error = new Error("transition could not be saved");
  const loop = new ExecutionLoop(runner, registry, new Announcements(noopObserver), async () => { throw error; });

  loop.dispatch("job-1", ref, "new", 1, delivery, "inv-1");

  assert.deepEqual(await loop.settle(), [error]);
});
