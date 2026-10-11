import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { newJob, transitionJob } from "../src/core/job.js";
import { createFileJobStore } from "../src/state/file-job-store.js";

const dir = () => mkdtemp(join(tmpdir(), "msf-jobs-"));
const ref = (id: string) => ({ tracker: "github" as const, project: "acme/app", id });

test("a saved job is loaded again with its state, question and log intact", async () => {
  const store = createFileJobStore(await dir());
  const asked = transitionJob(newJob({ ref: ref("7"), repository: "acme/app" }), "waiting-for-help", {
    message: "pedido de ajuda", question: "Which seam?", context: "slugify",
  });
  await store.save(asked);
  const { jobs, unreadable } = await store.load();
  assert.deepEqual(jobs, [asked]);
  assert.deepEqual(unreadable, []);
});

test("saving again replaces the job and leaves only complete .json files behind", async () => {
  const root = await dir();
  const store = createFileJobStore(root);
  const job = newJob({ ref: ref("7"), repository: "acme/app" });
  await store.save(job);
  await store.save(transitionJob(job, "interrupted", { message: "queda", reason: "crash" }));
  const { jobs } = await store.load();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.state, "interrupted");
  assert.deepEqual((await readdir(root)).filter((name) => !name.endsWith(".json")), []);
});

test("a leftover temporary file from an interrupted write is ignored", async () => {
  const root = await dir();
  const store = createFileJobStore(root);
  await writeFile(join(root, "half-written.json.tmp"), "{\"key\":");
  assert.deepEqual((await store.load()).jobs, []);
});

test("an unreadable job file is reported and does not hide the other jobs", async () => {
  const root = await dir();
  const store = createFileJobStore(root);
  await store.save(newJob({ ref: ref("1"), repository: "acme/app" }));
  await writeFile(join(root, "corrupt.json"), "not json");
  const { jobs, unreadable } = await store.load();
  assert.deepEqual(jobs.map((job) => job.key), ["github:acme/app#1"]);
  assert.deepEqual(unreadable, ["corrupt.json"]);
});

test("remove deletes the job so that it is no longer loaded", async () => {
  const store = createFileJobStore(await dir());
  const job = newJob({ ref: ref("3"), repository: "acme/app" });
  await store.save(job);
  await store.remove(job.key);
  assert.deepEqual((await store.load()).jobs, []);
});
