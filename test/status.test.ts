import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runStatus, type StatusOptions } from "../src/cli/status.js";
import { loadInstance } from "../src/cli/instance.js";
import { newJob, transitionJob, type Job } from "../src/core/job.js";
import { createFileCommandQueue } from "../src/state/command-queue.js";
import { createFileJobStore } from "../src/state/file-job-store.js";
import { createFileFailureStore } from "../src/state/history.js";
import { createFileAttentionStore } from "../src/state/file-attention-store.js";
import { loadMemoryTracker } from "../src/tracker/memory.js";
import type { TrackerPort } from "../src/tracker/port.js";

// `status` reads the trackers of the instance and the state recorded on disk, and writes nothing.
// The seam is runStatus: the tracker is injected, the state directory is a temporary one.

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const memoryTracker = async (): Promise<TrackerPort> => loadMemoryTracker(JSON.parse(await readFile(fixture("status-tracker.json"), "utf8")));

async function status(instanceName: string, extra: Partial<StatusOptions> = {}) {
  const loaded = await loadInstance(fixture("instances.json"), instanceName);
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.run.stderr);
  const stateDir = extra.stateDir ?? join(await mkdtemp(join(tmpdir(), "msf-status-")), "state");
  return runStatus({ instance: loaded.instance, stateDir, env: {}, tracker: await memoryTracker(), ...extra });
}

// Lines of the status output whose issue reference is exactly `ref`, e.g. "dora-metrics#2"
// or "VAN-4". Matching on the whole token keeps "#9" from matching "#99" in a reason.
const linesFor = (stdout: string, ref: string) =>
  stdout.split("\n").filter((line: string) => line.trimStart().startsWith(`${ref} `));
const DORA = "samuel-santos_bjd/dora-metrics";

test("status lists the eligible issue of a GitHub project with its reference", async () => {
  const run = await status("trabalho");
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /\[dora-metrics\][\s\S]*elegíveis \(2\):\n {4}samuel-santos_bjd\/dora-metrics#1 Eligible\n {4}samuel-santos_bjd\/dora-metrics#5 /);
  assert.doesNotMatch(run.stdout, /candidatas/);
});

test("status explains every rejection of a GitHub project with its reason", async () => {
  const { stdout } = await status("trabalho");
  const reasons: Array<[string, RegExp]> = [
    ["#2", /já claimed/],
    ["#3", /bloqueada por #4 \(não terminal\)/],
    ["#7", /issue terminal \(done\)/],
    ["#8", /labels desconhecido: labels API timeout/],
    ["#9", /claim desconhecido: claim field not read/],
    ["#10", /bloqueadores desconhecido: dependency API timeout/],
    ["#12", /estado de #99 desconhecido/],
  ];
  for (const [id, reason] of reasons) {
    const lines = linesFor(stdout, `${DORA}${id}`);
    assert.equal(lines.length, 1, `expected one line for ${id}`);
    assert.match(lines[0]!, reason);
  }
});

test("status does not list an issue that is not ready for agent", async () => {
  assert.deepEqual(linesFor((await status("trabalho")).stdout, `${DORA}#11`), []);
});

test("a Jira issue without a routing label, or with two, is rejected with the routing reason", async () => {
  const { stdout } = await status("trabalho");
  for (const line of linesFor(stdout, "VAN-2")) assert.match(line, /sem roteamento/);
  for (const line of linesFor(stdout, "VAN-3")) assert.match(line, /roteamento ambíguo/);
  assert.ok(linesFor(stdout, "VAN-2").length > 0 && linesFor(stdout, "VAN-3").length > 0);
});

test("a Jira issue routed to the project is its eligible issue; sprint and assignee are checked", async () => {
  const { stdout } = await status("trabalho");
  assert.match(stdout, /\[revolving-monolith-backend\] jira VAN \/ monolith\n {2}elegíveis \(1\):\n {4}VAN-1 Monolith ready\n/);
  assert.match(linesFor(stdout, "VAN-4")[0]!, /fora da sprint atual/);
  assert.match(linesFor(stdout, "VAN-5")[0]!, /não atribuída ao operador/);
});

test("the personal instance shows its own projects only", async () => {
  const run = await status("pessoal");
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /Instância pessoal/);
  assert.match(run.stdout, /\[my-tasks\][\s\S]*elegíveis \(1\)[\s\S]*Sanmoo\/my-tasks#1 Personal eligible/);
  assert.doesNotMatch(run.stdout, /dora-metrics|VAN-/);
});

// ── state of the instance ──────────────────────────────────────────────────────────────────────

const REPO = "samuel-santos_bjd/dora-metrics";
const jobOf = (id: string, repository = REPO): Job => newJob({ ref: { tracker: "memory", project: repository, id }, repository });
const waitingForHelp = (job: Job, question: string): Job => transitionJob(job, "waiting-for-help", { message: "ajuda", question });
const interrupted = (job: Job, reason: string): Job => transitionJob(job, "interrupted", { message: "interrompido", reason });

async function withJobs(jobs: Job[]): Promise<string> {
  const stateDir = join(await mkdtemp(join(tmpdir(), "msf-status-")), "state");
  const store = createFileJobStore(stateDir);
  for (const job of jobs) await store.save(job);
  return stateDir;
}

test("the header gives the instance, N, polling, the iteration limit and the slots in use: only running jobs hold one", async () => {
  const stateDir = await withJobs([
    jobOf("1"),
    waitingForHelp(jobOf("2"), "Qual contrato?"),
    transitionJob(jobOf("3"), "waiting-for-pr", { message: "pr", pr: { repository: REPO, number: 9 } }),
  ]);
  const { stdout } = await status("trabalho", { stateDir });
  assert.match(stdout, /^Instância trabalho \(N=1, polling 300s, máx\. iterações 5\)\nVagas: 1\/1\n/);
});

test("a help request shows the short reference, the question and the copyable reply and logs commands", async () => {
  const stateDir = await withJobs([waitingForHelp(jobOf("13"), "Qual o contrato da API?")]);
  const { stdout } = await status("trabalho", { stateDir });
  assert.match(stdout, /Pedidos de ajuda \(1\):\n {2}#13 — Qual o contrato da API\?\n/);
  assert.match(stdout, /\.\/msf trabalho reply '#13' --message '<resposta>'/);
  assert.match(stdout, /\.\/msf trabalho logs '#13'/);
  assert.doesNotMatch(stdout, /memory:/);
});

test("an interrupted job and one needing intervention show resume and logs, and no line offers release", async () => {
  const stateDir = await withJobs([
    interrupted(jobOf("14"), "caiu a conexão"),
    transitionJob(jobOf("15"), "intervention-required", { message: "i", reason: "resultado inválido" }),
  ]);
  const { stdout } = await status("trabalho", { stateDir });
  assert.match(stdout, /Trabalhos acompanhados \(2\):/);
  assert.match(stdout, /#14 interrompido — caiu a conexão/);
  assert.match(stdout, /#15 intervenção necessária — resultado inválido/);
  assert.match(stdout, /\.\/msf trabalho resume '#14'/);
  assert.match(stdout, /\.\/msf trabalho logs '#15'/);
  assert.doesNotMatch(stdout, /release/);
});

test("running and waiting-for-PR jobs are listed with their summary; the PR conflict is said", async () => {
  const waiting = transitionJob(jobOf("16"), "waiting-for-pr", { message: "pr", pr: { repository: REPO, number: 9 } });
  const stateDir = await withJobs([jobOf("17"), { ...waiting, prStatus: { checks: { known: true, value: "pending" }, review: { known: true, value: "none" }, mergeable: { known: true, value: "conflicting" } } }]);
  const { stdout } = await status("trabalho", { stateDir });
  assert.match(stdout, /#17 em execução\n/);
  assert.match(stdout, new RegExp(`#16 aguardando PR — ${REPO}#9 — PR em conflito`));
});

test("finished jobs are only counted, never listed", async () => {
  const done = transitionJob(jobOf("20"), "done", { message: "ok" });
  const released = transitionJob(interrupted(jobOf("21"), "x"), "released", { message: "liberado", reason: "operador" });
  const stateDir = await withJobs([done, transitionJob(jobOf("22"), "done", { message: "ok" }), released]);
  const { stdout } = await status("trabalho", { stateDir });
  assert.match(stdout, /concluídos: 2, liberados: 1/);
  assert.doesNotMatch(stdout, /#2[012]/);
});

test("two jobs with the same short reference are shown by the full key", async () => {
  const stateDir = await withJobs([
    waitingForHelp(jobOf("13"), "uma"),
    waitingForHelp(jobOf("13", "samuel-santos_bjd/other"), "outra"),
    interrupted(jobOf("14"), "caiu"),
  ]);
  const { stdout } = await status("trabalho", { stateDir });
  assert.match(stdout, new RegExp(`memory:${REPO}#13 — uma`));
  assert.match(stdout, /memory:samuel-santos_bjd\/other#13 — outra/);
  assert.match(stdout, /resume '#14'/);
  assert.match(stdout, /logs 'memory:samuel-santos_bjd\/other#13'/);
});

test("--home other than the default is carried by the printed commands; the default is omitted", async () => {
  const stateDir = await withJobs([waitingForHelp(jobOf("13"), "q")]);
  const custom = await status("trabalho", { stateDir, home: "/srv/msf home" });
  assert.match(custom.stdout, /\.\/msf --home '\/srv\/msf home' trabalho logs '#13'/);
  assert.doesNotMatch((await status("trabalho", { stateDir })).stdout, /--home/);
});

test("admissions: active or paused with the pending pause, and the pending commands", async () => {
  const stateDir = await withJobs([]);
  assert.match((await status("trabalho", { stateDir })).stdout, /Admissões: ativas\nComandos pendentes: 0/);
  await createFileCommandQueue(stateDir).enqueue({ type: "pause" });
  const paused = await status("trabalho", { stateDir });
  assert.match(paused.stdout, /Admissões: pausadas \(comando aguarda o próximo ciclo\)\nComandos pendentes: 1/);
});

test("an issue that already has a job in the instance is in neither list, whatever the job state", async () => {
  const done = transitionJob(jobOf("1"), "done", { message: "ok" });
  const withJob = await status("trabalho", { stateDir: await withJobs([done, jobOf("2")]) });
  for (const id of ["#1", "#2"]) assert.deepEqual(linesFor(withJob.stdout, `${DORA}${id}`), []);
  assert.match(withJob.stdout, /elegíveis \(0\)/);
});

test("observability failures and unreadable files are reported as before", async () => {
  const stateDir = await withJobs([]);
  await createFileFailureStore(stateDir).record({ at: "2026-10-11T12:00:00.000Z", sink: "log detalhado", message: "EACCES" });
  await writeFile(join(stateDir, "broken.json"), "{");
  const { stdout } = await status("trabalho", { stateDir });
  assert.match(stdout, /Observabilidade: falha em log detalhado desde 2026-10-11T12:00:00.000Z: EACCES/);
  assert.match(stdout, /Arquivos ilegíveis \(1\): broken\.json/);
});

// ── trackers that fail, and the promise of writing nothing ─────────────────────────────────────

// The memory tracker keeps its methods on the prototype: a wrapper has to name them.
const delegating = (inner: TrackerPort): TrackerPort => ({
  claimMarkOf: (ref) => inner.claimMarkOf(ref),
  discoverCandidates: (scope) => inner.discoverCandidates(scope),
  readIssue: (ref) => inner.readIssue(ref),
  claim: (ref) => inner.claim(ref),
  releaseClaim: (ref) => inner.releaseClaim(ref),
  updateLabels: (ref, changes) => inner.updateLabels(ref, changes),
  readComments: (ref) => inner.readComments(ref),
  postComment: (ref, body) => inner.postComment(ref, body),
  markDone: (ref) => inner.markDone(ref),
});

const failingFor = (inner: TrackerPort, repository: string): TrackerPort => ({
  ...delegating(inner),
  discoverCandidates: async (scope) => {
    if (scope.project === repository) throw new Error("GitHub API 503");
    return inner.discoverCandidates(scope);
  },
});

test("a project whose tracker fails shows tracker indisponível, the others and the local state remain, and the exit is 1", async () => {
  const stateDir = await withJobs([waitingForHelp(jobOf("13"), "Qual?")]);
  const run = await status("trabalho", { stateDir, tracker: failingFor(await memoryTracker(), REPO) });
  assert.equal(run.exitCode, 1);
  assert.match(run.stdout, /\[dora-metrics\][^[]*tracker indisponível: GitHub API 503/);
  assert.match(run.stdout, /\[revolving-monolith-backend\][^[]*elegíveis \(1\):\n {4}VAN-1 Monolith ready/);
  assert.match(run.stdout, /Pedidos de ajuda \(1\)/);
  assert.match(run.stdout, /Admissões: ativas/);
});

test("credentials never reach the output through a tracker failure", async () => {
  const leaky: TrackerPort = { ...delegating(await memoryTracker()), discoverCandidates: async () => { throw new Error("401 for token super-secret-token-123"); } };
  const run = await status("pessoal", { tracker: leaky, env: { GH_TOKEN: "super-secret-token-123" } });
  assert.equal(run.exitCode, 1);
  assert.doesNotMatch(run.stdout, /super-secret-token-123/);
  assert.match(run.stdout, /tracker indisponível: 401 for token \[redacted\]/);
});

test("status never writes to the tracker", async () => {
  const inner = await memoryTracker();
  const writes: string[] = [];
  const guarded: TrackerPort = {
    ...delegating(inner),
    claim: async (ref) => { writes.push("claim"); return inner.claim(ref); },
    releaseClaim: async (ref) => { writes.push("release"); return inner.releaseClaim(ref); },
    postComment: async (ref, body) => { writes.push("comment"); return inner.postComment(ref, body); },
    markDone: async (ref) => { writes.push("done"); return inner.markDone(ref); },
  };
  const run = await status("trabalho", { tracker: guarded });
  assert.equal(run.exitCode, 0, run.stderr);
  assert.deepEqual(writes, []);
});

// ── Atendimento assistido consultável no status (ticket #56) ─────────────────────────────────

import { createFileAssistSessionStore } from "../src/state/file-assist-session-store.js";

test("status consults the assisted interruptions with their persisted decisions", async () => {
  const stateDir = join(await mkdtemp(join(tmpdir(), "msf-status-")), "state");
  const store = createFileAssistSessionStore(join(stateDir, "assist-sessions"));
  const base = {
    ref: { tracker: "memory" as const, project: "acme/app", id: "1" },
    repository: "acme/app", state: "pending" as const, reason: "execução encerrada (exit 0) sem resultado de atendimento reconhecido",
    promptKind: "needs-triage" as const, model: "p/m", image: "img", cloneDir: "/c",
    startedAt: "2026-10-14T12:00:00.000Z",
    continuity: {
      question: "a execução terminou sem atendimento concluído; autoriza uma retomada futura desta mesma sessão?",
      askedAt: "2026-10-14T12:05:00.000Z",
    },
    log: [],
  };
  const pendingKey = (base.ref.tracker + ":" + base.ref.project + "#" + base.ref.id) as string;
  const write = (over: Partial<typeof base>): Parameters<typeof store.save>[0] =>
    ({ key: pendingKey, ...base, ...over } as unknown as Parameters<typeof store.save>[0]);
  await store.save(write({}));

  const asked = await status("trabalho", { stateDir });
  assert.equal(asked.exitCode, 0, asked.stderr);
  assert.match(asked.stdout, /Atendimento assistido pendente \(1\)/);
  assert.match(asked.stdout, new RegExp(`${pendingKey} — a execução terminou sem atendimento concluído`));
  assert.match(asked.stdout, /\.\/msf trabalho resume '#1'/);
  assert.match(asked.stdout, /\.\/msf trabalho reply '#1' --message '<resposta>'/);
  assert.match(asked.stdout, /Sessões assistidas: abertas agora: 0, pendentes: 1/);

  // An answered question is the record of truth: shown answered, no longer asked.
  await store.save(write({ continuity: { ...base.continuity, answeredAt: "2026-10-14T12:06:00.000Z", answer: "não autorizo retomada automática" } as typeof base.continuity }));
  const answered = await status("trabalho", { stateDir });
  assert.match(answered.stdout, /pergunta respondida \(não autorizo retomada automática\)/);
  assert.doesNotMatch(answered.stdout, /autoriza uma retomada futura desta mesma sessão\?/);
  assert.doesNotMatch(answered.stdout, /Atendimento assistido pendente \(1\):?[\s\S]*autoriza/);

  // A confirmed release removes the record (t55's registry discipline): the pending list
  // reflects the store, consultable by the local commands.
  await store.remove(pendingKey);
  const freed = await status("trabalho", { stateDir });
  assert.match(freed.stdout, /Sessões assistidas: abertas agora: 0, pendentes: 0/);
  assert.doesNotMatch(freed.stdout, /Atendimento assistido pendente \(1\)/);
});

// ── the pendings consultation (ticket #59): what still needs a human, whatever the channel did ──

test("persisted pendings are consultable in status with their context, provenance and actions", async () => {
  const stateDir = await withJobs([waitingForHelp(jobOf("7"), "Qual contrato?")]);
  await createFileAttentionStore(join(stateDir, "pendencias")).save({
    id: "decisão|memory:samuel-santos_bjd/dora-metrics#7|abc123", kind: "decisão", key: jobOf("7").key,
    what: "decisão do operador pendente", at: "2026-10-14T10:00:00.000Z",
    question: "Autoriza o comentário publicado na issue?",
    work: { repository: REPO, ref: { tracker: "memory", project: REPO, id: "7" } },
    actions: ["reply", "resume", "release", "approve"],
    notification: { at: "2026-10-14T10:00:01.000Z", channel: "notify-send", ok: true },
  });
  const { stdout } = await status("trabalho", { stateDir });
  assert.match(stdout, /Pendências \(1\):/);
  assert.match(stdout, /decisão memory:samuel-santos_bjd\/dora-metrics#7 — decisão do operador pendente/);
  assert.match(stdout, /pergunta: Autoriza o comentário publicado na issue\?/);
  assert.match(stdout, /trabalho: samuel-santos_bjd\/dora-metrics#7/);
  assert.match(stdout, /comando executado; entrega de notificação ao desktop não comprovada/, "a prova do canal nunca é uma promessa de entrega");
  assert.match(stdout, /\.\/msf trabalho reply '#7' --message '<resposta>'/);
  assert.match(stdout, /\.\/msf trabalho release '#7'/);
});

test("an undelivered pending shows the failed attempt and stays, and an absent channel is said", async () => {
  const stateDir = await withJobs([]);
  await createFileAttentionStore(join(stateDir, "pendencias")).save({
    id: "intervenção|memory:samuel-santos_bjd/dora-metrics#9|def456", kind: "intervenção", key: jobOf("9").key,
    what: "execução ilegível: intervenção pedida", at: "2026-10-14T10:00:00.000Z",
    reason: "registro de fim ilegível", work: { repository: REPO, ref: { tracker: "memory", project: REPO, id: "9" } },
    actions: ["reply", "resume", "release"],
    notification: { at: "2026-10-14T10:00:01.000Z", channel: "tentado", ok: false, error: "canal caiu" },
  });
  await createFileAttentionStore(join(stateDir, "pendencias")).save({
    id: "intervenção|outro|ghi789", kind: "intervenção", key: "keyoutro",
    what: "sem canal nenhum", at: "2026-10-14T10:00:02.000Z", actions: [],
  });
  const { stdout } = await status("trabalho", { stateDir });
  assert.match(stdout, /Pendências \(2\):/);
  assert.match(stdout, /falhou: canal caiu/);
  assert.match(stdout, /sem canal tentado/);
});

test("status shows the scheduled single-use resume and its consumption (ticket #57)", async () => {
  const stateDir = join(await mkdtemp(join(tmpdir(), "msf-status-")), "state");
  const store = createFileAssistSessionStore(join(stateDir, "assist-sessions"));
  const base = {
    ref: { tracker: "memory" as const, project: "acme/app", id: "1" },
    repository: "acme/app", state: "pending" as const, reason: "execução encerrada (exit 0) sem resultado de atendimento reconhecido",
    promptKind: "needs-triage" as const, model: "p/m", image: "img", cloneDir: "/c",
    startedAt: "2026-10-14T12:00:00.000Z",
    continuity: {
      question: "autoriza uma retomada futura desta mesma sessão?",
      askedAt: "2026-10-14T12:05:00.000Z",
      answeredAt: "2026-10-14T12:06:00.000Z",
      answer: "sim, pode retomar",
    },
    scheduledResume: { at: "2026-10-14T12:06:00.000Z", command: "cmd-1", answer: "sim, pode retomar" },
    log: [],
  };
  const pendingKey = (base.ref.tracker + ":" + base.ref.project + "#" + base.ref.id) as string;
  const write = (over: Record<string, unknown>): Parameters<typeof store.save>[0] =>
    ({ key: pendingKey, ...base, ...over } as unknown as Parameters<typeof store.save>[0]);
  await store.save(write({}));
  const scheduled = await status("trabalho", { stateDir });
  assert.equal(scheduled.exitCode, 0, scheduled.stderr);
  assert.match(scheduled.stdout, /retomada agendada: uso único/);

  await store.save(write({ scheduledResume: { ...base.scheduledResume, consumed: { at: "2026-10-14T12:07:00.000Z", attempt: "msf-assist-outro-r1#abc12345" } } }));
  const consumed = await status("trabalho", { stateDir });
  assert.match(consumed.stdout, /retomada agendada consumida pela tentativa msf-assist-outro-r1#abc12345/);
});
