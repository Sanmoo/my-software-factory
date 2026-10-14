import assert from "node:assert/strict";
import test from "node:test";
import { Announcements } from "../src/core/announcements.js";
import { AttentionKeeper } from "../src/core/attention.js";
import { newJob, type Job } from "../src/core/job.js";
import { JobRegistry } from "../src/core/job-registry.js";
import type { JobStore } from "../src/core/job-store.js";
import { noopObserver } from "../src/core/observability.js";

// The registry's public seam, without opening or polling Admission: reservations and
// state transitions, with persistence and announcements observable at their boundaries.
const jobOf = (id: string, repository = "acme/app"): Job => newJob({
  ref: { tracker: "memory", project: repository, id }, repository,
});

const emptyStore: JobStore = {
  load: async () => ({ jobs: [], unreadable: [] }),
  save: async () => {},
  remove: async () => {},
};

test("apply persists the transitioned job before announcing and raising attention", async () => {
  const job = jobOf("9");
  const order: string[] = [];
  let saved: Job | undefined;
  let commandKeys: readonly string[] = [];
  const store: JobStore = {
    ...emptyStore,
    save: async (next) => {
      await Promise.resolve();
      saved = next;
      order.push("persisted");
    },
  };
  const attention = new AttentionKeeper({ store: {
    load: async () => ({ pendings: [], unreadable: [] }),
    save: async (pending) => { if (pending.notification === undefined) order.push("attention"); },
    remove: async () => {},
  } });
  const announcements = new Announcements({
    ...noopObserver,
    commands: (_key, keys) => { commandKeys = keys ?? []; return undefined; },
    emit: (event) => { order.push(event.kind); },
  }, attention);
  const registry = new JobRegistry(store, 1, announcements, [job], []);

  const next = await registry.apply(job.key, "waiting-for-help", {
    message: "pedido de ajuda", question: "Qual branch?", context: "Duas branches",
    consumed: ["memory:comment:1@1"],
  });

  assert.deepEqual(order, ["persisted", "ajuda-solicitada", "attention"]);
  assert.equal(saved, next);
  assert.equal(registry.job(job.key), next);
  assert.equal(next.state, "waiting-for-help");
  assert.equal(next.question, "Qual branch?");
  assert.deepEqual(next.log, ["pedido de ajuda"]);
  assert.deepEqual(next.consumed, ["memory:comment:1@1"]);
  assert.deepEqual(commandKeys, [job.key]);
});
