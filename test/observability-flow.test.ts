import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectEligibility } from "../src/config/project-eligibility.js";
import { parseConfig } from "../src/config/validate.js";
import type { InstanceConfig } from "../src/config/types.js";
import { Admission } from "../src/core/admission.js";
import { jobBranch } from "../src/core/job.js";
import { createObserver, type Observer } from "../src/core/observability.js";
import type { PrRef } from "../src/core/result.js";
import type { PrFeedback, PrLookup, PrPort, PrSnapshot } from "../src/pr/port.js";
import { FakeRunner, finished, withWorkspace } from "../src/runtime/fake-runner.js";
import type { Runner, RunnerOutput, Workspace } from "../src/runtime/runner.js";
import { createFileCommandQueue } from "../src/state/command-queue.js";
import { createFileHistory } from "../src/state/history.js";
import { createFileInstanceControl } from "../src/state/instance-control.js";
import { createFileJobStore } from "../src/state/file-job-store.js";
import { loadMemoryTracker, type MemoryTracker } from "../src/tracker/memory.js";
import { PartialWriteError, type IssueRef, type TrackerPort } from "../src/tracker/port.js";

// The operational events of the orchestrator (issue #15), read where the operator reads them:
// the main log lines and the local history, through the real queue, store and history files.

const REPO = "acme/app";
const KEY = (id: string) => `memory:${REPO}#${id}`;
const REF = (id: string): IssueRef => ({ tracker: "memory", project: REPO, id });
const HEAD = (id: string) => jobBranch(REF(id));
const HELP = { status: "needs_help", question: "Which seam?", context: "slugify" };
const PR_READY = { status: "pr_ready", pr: { repository: REPO, number: 14 } };
const WORKSPACE: Workspace = { session: "session-1", area: "area-1" };
const dir = () => mkdtemp(join(tmpdir(), "msf-obs-flow-"));

const instance = (maxConcurrent = 1): InstanceConfig => {
  const parsed = parseConfig({
    credentials: { copilot: { kind: "pi-auth", ref: "copilot" } },
    instances: [{
      name: "trabalho", maxConcurrent, pollIntervalSeconds: 300, maxIterations: 5, modelAuth: "copilot",
      projects: [{
        name: REPO, enabled: true, adapter: "github", repository: REPO, targetBranch: "main",
        prIntegration: "github.com", runtimeProfile: "docker-default", githubAccount: "acme",
        models: {
          implementer: "github-copilot/gpt-6-luna", "reviewer-standards": "github-copilot/claude-haiku-5.5",
          "reviewer-spec": "github-copilot/claude-haiku-5.5", default: "github-copilot/claude-haiku-5.5",
        },
      }],
    }],
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.config.instances[0]!;
};

const memoryOf = (ids: string[]) => loadMemoryTracker({
  issues: ids.map((id) => ({
    project: REPO, id, title: `Issue ${id}`, labels: ["ready-for-agent"], assignees: [], claimed: false,
    statusCategory: "to-do", priority: null, blockers: [], comments: [],
  })),
});

class FakePrs implements PrPort {
  feedback: PrFeedback = { comments: [], checks: [] };
  state: PrSnapshot["state"] = "open";

  async readPr(ref: PrRef): Promise<PrLookup> {
    return {
      status: "found",
      pr: {
        ref, state: this.state, baseBranch: "main", headBranch: HEAD("1"),
        checks: { known: true, value: "pending" }, review: { known: true, value: "none" },
      },
    };
  }

  async readFeedback(): Promise<PrFeedback> {
    return this.feedback;
  }
}

interface Setup {
  stateDir: string;
  lines: string[];
  observer: Observer;
  admission: Admission;
  memory: MemoryTracker;
  runner: Runner;
  prs: FakePrs;
}

async function setup(options: {
  ids?: string[];
  maxConcurrent?: number;
  runner: Runner;
  tracker?: (base: MemoryTracker) => TrackerPort;
  historyBlocked?: boolean;
}): Promise<Setup> {
  const stateDir = await dir();
  if (options.historyBlocked) await writeFile(join(stateDir, "history"), "blocks the directory");
  const lines: string[] = [];
  const observer = createObserver({
    instance: "trabalho", console: (line) => lines.push(line), history: createFileHistory(stateDir),
    cli: { config: "/etc/msf/config.json", instance: "trabalho", stateDir },
  });
  const memory = memoryOf(options.ids ?? ["1"]);
  const prs = new FakePrs();
  const config = instance(options.maxConcurrent);
  const admission = await Admission.open({
    instance: config, eligibility: (project) => projectEligibility(config, project),
    tracker: options.tracker ? options.tracker(memory) : memory, runner: options.runner,
    store: createFileJobStore(stateDir), commands: createFileCommandQueue(stateDir),
    control: createFileInstanceControl(stateDir), prs, observer,
  });
  return { stateDir, lines, observer, admission, memory, runner: options.runner, prs };
}

const trackerWith = (base: MemoryTracker, overrides: Partial<TrackerPort>): TrackerPort => ({
  discoverCandidates: (scope) => base.discoverCandidates(scope),
  readIssue: (ref) => base.readIssue(ref),
  claim: (ref) => base.claim(ref),
  releaseClaim: (ref) => base.releaseClaim(ref),
  readComments: (ref) => base.readComments(ref),
  postComment: (ref, body) => base.postComment(ref, body),
  markDone: (ref) => base.markDone(ref),
  ...overrides,
});

const matching = (lines: string[], pattern: RegExp) => lines.filter((line) => pattern.test(line));
const gate = () => {
  let release!: (output: RunnerOutput) => void;
  const promise = new Promise<RunnerOutput>((resolve) => { release = resolve; });
  return { promise, release };
};
const helpRunner = () => new FakeRunner((context) => (context.kind === "new"
  ? withWorkspace(finished(HELP), WORKSPACE)
  : withWorkspace(finished(PR_READY), WORKSPACE)));

test("a help request is on the main log with question, context and a copyable reply command, without waiting for another poll", async () => {
  const s = await setup({ runner: helpRunner() });
  await s.admission.poll();
  await s.admission.settle();
  await s.observer.flush();

  const text = s.lines.join("\n");
  assert.match(text, /ajuda solicitada trabalho=memory:acme\/app#1 invocação=inv-/);
  assert.match(text, /pergunta: Which seam\?/);
  assert.match(text, /contexto: slugify/);
  assert.match(text, new RegExp(`responder: npm run reply -- --config /etc/msf/config.json --instance trabalho --state-dir ${s.stateDir} 'memory:acme/app#1' --message '<resposta>'`));
  assert.match(text, /histórico: npm run logs -- /);
  // The first start says why: the first admission is the only one called "trabalho admitido".
  assert.equal(matching(s.lines, /trabalho admitido/).length, 1);
  assert.match(matching(s.lines, /invocação iniciada/)[0]!, /tipo=nova motivo=issue-elegível/);
});

test("the question, the reply and the reason survive in the history after the job turns active", async () => {
  const s = await setup({ runner: helpRunner() });
  await s.admission.poll();
  await s.admission.settle();
  const id = await createFileCommandQueue(s.stateDir).enqueue({ type: "reply", job: KEY("1"), message: "Use the v2 seam" });
  await s.admission.poll();
  await s.admission.settle();
  await s.observer.flush();

  const { records } = await createFileHistory(s.stateDir).read(KEY("1"));
  const help = records.find((record) => record.kind === "ajuda-solicitada")!;
  assert.match(help.lines.join("\n"), /pergunta: Which seam\?/);
  const resumed = records.find((record) => record.kind === "invocação-retomada")!;
  assert.equal(resumed.fields.motivo, "resposta-humana");
  assert.equal(resumed.fields.origem, "terminal");
  assert.equal(resumed.fields.comando, id);
  assert.equal(resumed.fields.sessão, "session-1");
  assert.ok(typeof resumed.invocation === "string");
  // Applied and included are separate steps, correlated by the command id; neither says delivered.
  assert.deepEqual(
    records.filter((record) => record.fields.comando === id).map((record) => record.kind),
    ["comando-aplicado", "invocação-retomada", "resposta-incluída"],
  );
  assert.ok(!records.some((record) => /entregue/.test(record.text)), "no delivery is claimed by the orchestrator");
  assert.equal(matching(s.lines, /trabalho admitido/).length, 1, "a continuation is not a new admission");
});

test("a new poll does not repeat the consumption of a reply or start a second invocation", async () => {
  const s = await setup({ runner: helpRunner() });
  await s.admission.poll();
  await s.admission.settle();
  await createFileCommandQueue(s.stateDir).enqueue({ type: "reply", job: KEY("1"), message: "ok" });
  await s.admission.poll();
  await s.admission.settle();
  const before = s.lines.length;
  await s.admission.poll();
  await s.admission.settle();
  await s.observer.flush();

  assert.equal((s.runner as FakeRunner).calls.length, 2);
  assert.equal(matching(s.lines.slice(before), /invocação (iniciada|retomada)|reply aplicado|resposta incluída/).length, 0);
});

test("feedback waiting for a slot keeps its original reason, announced once, until the invocation starts", async () => {
  const second = gate();
  const runner = new FakeRunner((context) => (context.ref.id === "2" ? second.promise : withWorkspace(finished(PR_READY), WORKSPACE)));
  const s = await setup({ ids: ["1", "2"], runner });
  await s.admission.poll();
  await s.admission.settle();
  assert.deepEqual((await s.admission.poll()).admitted, [KEY("2")]);

  await s.memory.postComment(REF("1"), "agent: Renomeie a função");
  await s.admission.poll();
  await s.admission.poll();
  const waits = matching(s.lines, /invocação aguardando vaga/);
  assert.equal(waits.length, 1, "the same wait is announced once");
  assert.match(waits[0]!, /motivo=resposta-humana origem=issue .*impedimento="sem vaga livre"/);

  second.release(withWorkspace(finished(HELP), WORKSPACE));
  await s.admission.settle();
  await s.admission.poll();
  await s.admission.settle();
  const resumed = matching(s.lines, /invocação retomada trabalho=memory:acme\/app#1/)[0]!;
  assert.match(resumed, /motivo=resposta-humana origem=issue/);
  assert.doesNotMatch(resumed, /bloqueio removido/, "an unobserved unblock is not claimed");
});

test("several feedbacks behind one invocation are summarized with short references and kept whole in the history", async () => {
  const s = await setup({ runner: new FakeRunner(() => withWorkspace(finished(PR_READY), WORKSPACE)) });
  await s.admission.poll();
  await s.admission.settle();
  s.prs.feedback = {
    comments: [
      { id: "PRR_5", kind: "review", author: "Sanmoo", isBot: false, body: "troque o nome", createdAt: "" },
      { id: "IC_7", kind: "comment", author: "ana", isBot: false, body: "e a doc", createdAt: "" },
    ],
    checks: [{ id: "chk1", name: "verify", state: { known: true, value: "failing" }, required: { known: true, value: true } }],
  };
  await s.admission.poll();
  await s.admission.settle();
  await s.observer.flush();

  const resumed = matching(s.lines, /invocação retomada/)[0]!;
  assert.match(resumed, /motivo=feedback-pr\+check-falhou causas=3 origens="[^"]*revisão PRR_5 \(Sanmoo\)[^"]*" pr=#14/);
  const { records } = await createFileHistory(s.stateDir).read(KEY("1"));
  const record = records.find((entry) => entry.kind === "invocação-retomada")!;
  assert.equal(record.lines.length, 3);
  assert.match(record.lines.join("\n"), /check=verify/);
  const received = records.filter((entry) => entry.kind === "feedback-recebido");
  assert.equal(received.length, 3, "each feedback is announced when taken");

  const before = s.lines.length;
  await s.admission.poll();
  assert.equal(matching(s.lines.slice(before), /feedback recebido|invocação/).length, 0, "no duplicate consumption events");
});

test("a manual resume is its own reason", async () => {
  const runner = new FakeRunner((context) => (context.kind === "new"
    ? withWorkspace(finished({ status: "interrupted", reason: "falha" }), WORKSPACE)
    : withWorkspace(finished(PR_READY), WORKSPACE)));
  const s = await setup({ runner });
  await s.admission.poll();
  await s.admission.settle();
  const id = await createFileCommandQueue(s.stateDir).enqueue({ type: "resume", job: KEY("1") });
  await s.admission.poll();
  await s.admission.settle();
  assert.match(matching(s.lines, /invocação retomada/)[0]!, new RegExp(`motivo=retomada-manual origem=terminal.*comando=${id}`));
});

test("an external merge is announced once, before and apart from the done update, which stays pending until confirmed", async () => {
  let attempts = 0;
  const runner = new FakeRunner(() => withWorkspace(finished(PR_READY), WORKSPACE));
  const s = await setup({
    runner,
    tracker: (base) => trackerWith(base, {
      async markDone(ref) {
        attempts += 1;
        if (attempts === 1) throw new Error("jira fora do ar");
        return base.markDone(ref);
      },
    }),
  });
  await s.admission.poll();
  await s.admission.settle();
  s.prs.state = "merged";

  const first = await s.admission.poll();
  assert.equal(first.errors.length, 1);
  assert.equal(s.admission.job(KEY("1"))?.state, "waiting-for-pr", "done is not declared");
  assert.equal(matching(s.lines, /merge detectado/).length, 1);
  assert.match(matching(s.lines, /merge detectado/)[0]!, /pr=acme\/app#14 destino=main origem=externa/);
  assert.equal(matching(s.lines, /trabalho concluído/).length, 0);
  assert.match(matching(s.lines, /merge confirmado; done ainda não confirmado/)[0]!, /jira fora do ar/);
  assert.match(matching(s.lines, /resultado da alteração incerto/)[0]!, /origem=orquestrador operação=done/);

  await s.admission.poll();
  await s.observer.flush();
  assert.equal(s.admission.job(KEY("1"))?.state, "done");
  assert.equal(matching(s.lines, /merge detectado/).length, 1, "detected once across polls");
  const confirmed = matching(s.lines, /alteração confirmada/);
  assert.match(confirmed.at(-1)!, /issue=memory:acme\/app#1 origem=orquestrador operação=fechar estado=in-progress→done motivo=conclusão-após-merge/);
  const order = s.lines.findIndex((line) => /alteração confirmada.*fechar/.test(line));
  assert.ok(s.lines.findIndex((line) => /merge detectado/.test(line)) < order);
  assert.ok(order < s.lines.findIndex((line) => /trabalho concluído/.test(line)));
  assert.match(matching(s.lines, /trabalho concluído/)[0]!, /done=confirmado/);
});

test("a done that was already expected writes nothing and says so", async () => {
  const runner = new FakeRunner(() => withWorkspace(finished(PR_READY), WORKSPACE));
  const s = await setup({ runner });
  await s.admission.poll();
  await s.admission.settle();
  await s.memory.markDone(REF("1"));
  s.prs.state = "merged";
  await s.admission.poll();
  await s.observer.flush();

  assert.match(matching(s.lines, /nenhuma alteração/)[0]!, /operação=fechar/);
  assert.equal(matching(s.lines, /alteração confirmada.*fechar/).length, 0, "no change is claimed that the factory did not make");
});

test("the claim at admission names the concrete changes, attempt before confirmation", async () => {
  const s = await setup({ runner: helpRunner() });
  await s.admission.poll();
  await s.admission.settle();

  const claim = matching(s.lines, /issue=memory:acme\/app#1 origem=orquestrador/);
  assert.match(claim[0]!, /tentativa de alteração na issue.*operação=claim motivo=admissão/);
  assert.match(claim[1]!, /alteração confirmada.*operação=adicionar-label alvo=claim estado=ausente→presente motivo=admissão/);
  assert.match(claim[2]!, /alteração confirmada.*operação=transição.*estado=to-do→in-progress/);
});

test("a release with a partial failure keeps the confirmed write visible and the failure explicit", async () => {
  const s = await setup({
    runner: helpRunner(),
    tracker: (base) => trackerWith(base, {
      async releaseClaim(ref) {
        await base.releaseClaim(ref);
        throw new PartialWriteError("atribuição recusada", [
          { operation: "remover-label", target: "agent-claimed", before: "presente", after: "ausente", result: "attempted" },
        ]);
      },
    }),
  });
  await s.admission.poll();
  await s.admission.settle();
  await createFileCommandQueue(s.stateDir).enqueue({ type: "release", job: KEY("1") });
  await s.admission.poll();
  await s.observer.flush();

  assert.match(matching(s.lines, /alteração tentada, não confirmada/)[0]!, /operação=remover-label/);
  assert.match(matching(s.lines, /resultado da alteração incerto/)[0]!, /operação=release.*erro="atribuição recusada"/);
});

test("a failing history is reported and does not stop, repeat or duplicate the work", async () => {
  const s = await setup({ runner: helpRunner(), historyBlocked: true });
  await s.admission.poll();
  await s.admission.settle();
  await s.observer.flush();

  assert.equal((s.runner as FakeRunner).calls.length, 1, "one invocation, no restart because of logging");
  assert.equal(s.admission.job(KEY("1"))?.state, "waiting-for-help");
  assert.equal(matching(s.lines, /falha de observabilidade/).length, 1);
  assert.match(s.lines.join("\n"), /ajuda solicitada/, "the main log still carries the events");
});

test("a pause is an impediment: the continuation waits with its original reason, and starts when unpaused", async () => {
  const s = await setup({ runner: helpRunner() });
  await s.admission.poll();
  await s.admission.settle();
  await createFileCommandQueue(s.stateDir).enqueue({ type: "pause" });
  await createFileCommandQueue(s.stateDir).enqueue({ type: "reply", job: KEY("1"), message: "siga" });
  await s.admission.poll();
  await s.admission.poll();

  const waits = matching(s.lines, /invocação aguardando vaga/);
  assert.equal(waits.length, 1);
  assert.match(waits[0]!, /motivo=resposta-humana origem=terminal.*impedimento="instância pausada"/);
  assert.equal((s.runner as FakeRunner).calls.length, 1, "nothing starts while paused");

  await createFileCommandQueue(s.stateDir).enqueue({ type: "unpause" });
  await s.admission.poll();
  await s.admission.settle();
  assert.match(matching(s.lines, /invocação retomada/)[0]!, /motivo=resposta-humana origem=terminal/);
});

test("a release whose write errored but whose reread shows the claim gone is confirmed by evidence", async () => {
  const s = await setup({
    runner: helpRunner(),
    tracker: (base) => trackerWith(base, {
      async releaseClaim(ref) {
        await base.releaseClaim(ref);
        throw new Error("resposta perdida");
      },
    }),
  });
  await s.admission.poll();
  await s.admission.settle();
  await createFileCommandQueue(s.stateDir).enqueue({ type: "release", job: KEY("1") });
  await s.admission.poll();

  assert.match(matching(s.lines, /resultado da alteração incerto/)[0]!, /erro="resposta perdida"/);
  assert.match(matching(s.lines, /alteração confirmada.*operação=remover-label/)[0]!, /confirmada por releitura após erro de escrita/);
});
