import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttentionKeeper } from "../src/core/attention.js";
import { newJob } from "../src/core/job.js";
import { createFileAttentionStore } from "../src/state/file-attention-store.js";
import { Announcements } from "../src/core/announcements.js";
import { noopObserver, type OpsEvent } from "../src/core/observability.js";

// The announcer's public seam, without opening or polling Admission.
test("the same wait is announced once until clearWaits allows it again", () => {
  const events: OpsEvent[] = [];
  const announcements = new Announcements({ ...noopObserver, emit: (event) => events.push(event) });
  announcements.announceWait("memory:acme/app#9", "issue-elegível", "sem vaga livre", []);
  announcements.announceWait("memory:acme/app#9", "issue-elegível", "sem vaga livre", []);
  assert.deepEqual(events, [{
    kind: "invocação-aguardando", text: "issue elegível aguardando vaga", job: "memory:acme/app#9",
    fields: { motivo: "issue-elegível", impedimento: "sem vaga livre" },
  }]);

  announcements.clearWaits("memory:acme/app#9");
  announcements.announceWait("memory:acme/app#9", "issue-elegível", "sem vaga livre", []);
  assert.equal(events.length, 2);
  assert.deepEqual(events[1], events[0]);
});

for (const [state, kind, what] of [
  ["waiting-for-help", "ajuda", "ajuda solicitada pelo agente"],
  ["interrupted", "intervenção", "trabalho interrompido: retomada pedida"],
  ["intervention-required", "intervenção", "intervenção necessária"],
] as const) {
  for (const next of ["running", "waiting-for-pr", "done", "released"] as const) {
    test(`announceState raises a pending for ${state} and resolves it on ${next}`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "msf-announcements-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const attention = new AttentionKeeper({ store: createFileAttentionStore(root) });
      const announcements = new Announcements(noopObserver, attention);
      const job = newJob({ ref: { tracker: "memory", project: "acme/app", id: "9" }, repository: "acme/app" });
      await announcements.announceState({ ...job, state }, {
        question: "Qual branch?", context: "Duas branches disponíveis", reason: "execução parou",
      }, [job.key]);
      const raised = await attention.consult();
      assert.equal(raised.pendings.length, 1);
      assert.equal(raised.pendings[0]?.key, job.key);
      assert.equal(raised.pendings[0]?.kind, kind);
      assert.equal(raised.pendings[0]?.what, what);

      await announcements.announceState({ ...job, state: next }, {}, [job.key]);
      assert.deepEqual((await attention.consult()).pendings, []);
    });
  }
}
