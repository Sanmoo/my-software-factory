import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CredentialRef, InstanceConfig, ProjectConfig } from "../src/config/types.js";
import { createObserver, type Observer } from "../src/core/observability.js";
import { createRedactor } from "../src/core/redaction.js";
import { git, jobLayout } from "../src/runtime/docker-area.js";
import { createDockerRunner, type SandboxBoundary, type SandboxOutcome, type SandboxRun } from "../src/runtime/docker-runner.js";
import type { IssueState } from "../src/runtime/agent-issue-writes.js";
import type { PiEvent } from "../src/runtime/pi-events.js";
import type { RunnerContext } from "../src/runtime/runner.js";
import { createFileHistory } from "../src/state/history.js";

// The runtime seam of issue #15: synthetic Pi events go through the real runner and the real
// activity into the real detailed log and the main log. No Pi, Docker, model or tracker runs.

const GPT = "github-copilot/gpt-6-luna";
const TOKEN = "ghp_fixture_token_value_0123";
const SECRET = "synthetic-credential-9f8e7d";
const models = { implementer: GPT, "reviewer-standards": GPT, "reviewer-spec": GPT, default: GPT };
const project: ProjectConfig = {
  name: "app", enabled: true, adapter: "github", repository: "acme/app", targetBranch: "main",
  prIntegration: "github.com", runtimeProfile: "personal", githubAccount: "acme-bot",
  labels: { ready: "ready-for-agent", claimed: "agent-claimed" }, models: { ...models },
} as ProjectConfig;
const instance: InstanceConfig = {
  name: "personal", maxConcurrent: 1, pollIntervalSeconds: 300, maxIterations: 5, modelAuth: "MODEL_AUTH", projects: [project],
};
const credentials: Record<string, CredentialRef> = { MODEL_AUTH: { kind: "pi-auth", ref: "PI_AUTH" } };
const ref = { tracker: "github" as const, project: "acme/app", id: "6" };
const key = "github:acme/app#6";
const context = (over: Partial<RunnerContext> = {}): RunnerContext =>
  ({ jobId: key, ref, repository: "acme/app", kind: "new", iteration: 1, maxIterations: 5, invocation: "inv-test-1", ...over });

const line = (event: unknown) => JSON.stringify(event);
const settled = (result: unknown): PiEvent[] => [
  { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `<msf-result>${JSON.stringify(result)}</msf-result>\n<promise>MSF-RESULT</promise>` }] } },
  { type: "agent_settled", aborted: false },
];
const PR_READY = { status: "pr_ready", pr: { repository: "acme/app", number: 7 } };

async function fixture() {
  const source = await mkdtemp(join(tmpdir(), "msf-src-"));
  await git(source, "init", "-q", "-b", "main");
  await git(source, "config", "user.name", "Operator");
  await git(source, "config", "user.email", "operator@invalid");
  await writeFile(join(source, "AGENTS.md"), "Strict TypeScript.\n");
  await git(source, "add", ".");
  await git(source, "commit", "-q", "-m", "fixture");
  const stateDir = await mkdtemp(join(tmpdir(), "msf-state-"));
  const agentDir = await mkdtemp(join(tmpdir(), "msf-agent-"));
  return { source, stateDir, agentDir };
}

type Script = (run: SandboxRun, call: number) => Promise<Partial<SandboxOutcome>>;

async function harness(script: Script, options: {
  now?: () => number;
  evidence?: (ref: unknown) => () => Promise<IssueState>;
  preBlockLogs?: boolean;
} = {}) {
  const f = await fixture();
  const lines: string[] = [];
  const observer: Observer = createObserver({
    instance: "personal", console: (text) => lines.push(text), history: createFileHistory(f.stateDir),
    redactor: createRedactor([SECRET]), cli: { instance: "personal" },
  });
  let calls = 0;
  const runs: SandboxRun[] = [];
  const boundary: SandboxBoundary = {
    async preflight() { return { token: TOKEN }; },
    async imageHas() { return true; },
    async run(input) {
      runs.push(input);
      calls += 1;
      return { iterations: 1, completed: true, events: settled(PR_READY), sessionId: "session-1", ...(await script(input, calls)) };
    },
  };
  const layout = jobLayout(f.stateDir, key);
  if (options.preBlockLogs) {
    await mkdir(layout.areaDir, { recursive: true });
    await writeFile(join(layout.areaDir, "logs"), "a file where the directory should be");
  }
  const runner = createDockerRunner({
    instance, credentials, profiles: { PI_AUTH: f.agentDir, personal: f.agentDir }, stateDir: f.stateDir,
    image: "msf-docker-runner:test", repositorySource: () => f.source, boundary, observer,
    ...(options.now ? { now: options.now } : {}),
    ...(options.evidence ? { issueEvidence: options.evidence as never } : {}),
  });
  const detail = async () => {
    const logs = join(layout.areaDir, "logs");
    const name = (await readdir(logs)).find((entry) => entry.endsWith(".log") && !entry.endsWith(".runtime.log"));
    return name ? readFile(join(logs, name), "utf8") : "";
  };
  return { f, lines, observer, runner, runs, layout, detail, calls: () => calls };
}

const matching = (lines: string[], pattern: RegExp) => lines.filter((entry) => pattern.test(entry));

test("tool calls and results, with ids and arguments, reach the detailed log while the invocation is still running", async () => {
  let midRun = "";
  const h = await harness(async (run) => {
    run.activity.line(line({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "PRIVATE-REASONING" } }));
    run.activity.line(line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Vou ler o arquivo.\nDepois edito." } }));
    run.activity.line(line({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "src/a.ts" } }));
    run.activity.line(line({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: { content: [{ type: "text", text: "conteúdo do arquivo" }] }, isError: false }));
    run.activity.line(line({ type: "tool_execution_start", toolCallId: "c2", toolName: "bash", args: { command: "npm test" } }));
    run.activity.line(line({ type: "tool_execution_end", toolCallId: "c2", toolName: "bash", result: "1 falhou", isError: true }));
    run.activity.line(line({ type: "tool_execution_start", toolCallId: "c3", toolName: "ferramenta-desconhecida", args: { x: 1 } }));
    await run.activity.drain();
    midRun = await readFile(join(jobLayout(h.f.stateDir, key).areaDir, "logs", (await readdir(join(jobLayout(h.f.stateDir, key).areaDir, "logs"))).find((n) => n.endsWith(".log") && !n.endsWith(".runtime.log"))!), "utf8");
    run.activity.line(line({ type: "tool_execution_end", toolCallId: "c3", toolName: "ferramenta-desconhecida", result: "ok", isError: false }));
    return {};
  });
  await h.runner.run(context());

  // Before the run ended: the agent's text, both calls and their outcomes, any tool name.
  assert.match(midRun, /agente: Vou ler o arquivo\./);
  assert.match(midRun, /→ ferramenta read id=c1\n\s+\{"path":"src\/a\.ts"\}/);
  assert.match(midRun, /← ferramenta read id=c1 ok\n\s+conteúdo do arquivo/);
  assert.match(midRun, /→ ferramenta bash id=c2/);
  assert.match(midRun, /← ferramenta bash id=c2 ERRO\n\s+1 falhou/);
  assert.match(midRun, /→ ferramenta ferramenta-desconhecida id=c3/);
  assert.doesNotMatch(midRun, /PRIVATE-REASONING/, "private reasoning is never written");
  assert.match(midRun, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\dZ /m, "lines carry timestamps");
  const final = await h.detail();
  assert.match(final, /← ferramenta ferramenta-desconhecida id=c3 ok/);
  assert.match(matching(h.lines, /logs da invocação/)[0]!, /invocação=inv-test-1 detalhado=\S+\.log/);
});

test("silence is a technical warning with duration, last activity and effective timeout; output resuming is announced; nothing is retried", async () => {
  let clock = 1_000_000;
  const h = await harness(async (run) => {
    run.activity.line(line({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "sleep 500" } }));
    clock += 61_000;
    run.activity.checkIdle();
    clock += 60_000;
    run.activity.checkIdle();
    run.activity.checkIdle(); // the same minute again: no repeated warning
    clock += 5_000;
    run.activity.line(line({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: "ok", isError: false }));
    return {};
  }, { now: () => clock });
  const output = await h.runner.run(context());

  const warnings = matching(h.lines, /aviso técnico: sem saída recebida/);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0]!, /sem-saída=61s timeout-efetivo=600s última-atividade="ferramenta bash id=t1 iniciada" ferramentas-ativas=bash:t1/);
  assert.match(warnings[1]!, /sem-saída=121s/);
  assert.match(matching(h.lines, /atividade do agente retomada/)[0]!, /sem-saída-por=126s/);
  assert.equal(matching(h.lines, /timeout:/).length, 0, "a warning is not a timeout");
  assert.equal(h.calls(), 1, "no retry");
  assert.equal(output.kind, "finished");
  assert.match(JSON.stringify(output), /pr_ready/, "the job result is untouched by the warnings");
});

test("a real idle timeout is a transition of its own, distinct from the warnings", async () => {
  let clock = 0;
  const h = await harness(async (run) => {
    clock += 61_000;
    run.activity.checkIdle();
    throw new Error("Agent idle for 600 seconds — no output received. Consider increasing the idle timeout");
  }, { now: () => clock });
  const output = await h.runner.run(context());

  assert.equal(matching(h.lines, /aviso técnico/).length, 1);
  assert.match(matching(h.lines, /timeout: sem saída do agente/)[0]!, /timeout-efetivo=600s .*motivo="Agent idle for 600 seconds/);
  assert.match(JSON.stringify(output), /interrupted/);
});

test("a long tool result is kept whole in an artifact and summarized with its reference, never truncated silently", async () => {
  const long = `INICIO ${"x".repeat(5000)} FIM`;
  const h = await harness(async (run) => {
    run.activity.line(line({ type: "tool_execution_start", toolCallId: "big", toolName: "bash", args: { command: "cat big" } }));
    run.activity.line(line({ type: "tool_execution_end", toolCallId: "big", toolName: "bash", result: long, isError: false }));
    return {};
  });
  await h.runner.run(context());

  const text = await h.detail();
  const reference = /conteúdo completo em (\S+)\]/.exec(text)?.[1];
  assert.ok(reference, "the log says where the whole content is");
  assert.match(text, /resultado extenso: 5011 caracteres/);
  assert.match(text, /resultado: INICIO x+…/, "a bounded summary is shown");
  assert.equal(await readFile(reference, "utf8"), long, "the artifact has the whole output");
  assert.ok(!text.includes(long), "the log itself stays readable");
});

test("known credentials are hidden in the detailed log, artifacts, main log, history and error messages", async () => {
  const big = `${"y".repeat(2500)} ${SECRET} ${TOKEN}`;
  const h = await harness(async (run) => {
    run.activity.line(line({ type: "tool_execution_start", toolCallId: "s1", toolName: "bash", args: { command: `curl -H 'Authorization: ${SECRET}'` } }));
    run.activity.line(line({ type: "tool_execution_end", toolCallId: "s1", toolName: "bash", result: `${SECRET} and ${TOKEN}`, isError: true }));
    run.activity.line(line({ type: "tool_execution_start", toolCallId: "s2", toolName: "bash", args: { command: "env" } }));
    run.activity.line(line({ type: "tool_execution_end", toolCallId: "s2", toolName: "bash", result: big, isError: false }));
    run.activity.line(line({ type: "error", message: `falhou com ${SECRET}` }));
    throw new Error(`boundary quebrou com ${TOKEN}`);
  });
  const output = await h.runner.run(context());
  await h.observer.flush();

  const everywhere: string[] = [await h.detail(), h.lines.join("\n"), JSON.stringify(output)];
  const artifacts = join(h.layout.areaDir, "logs");
  for (const name of await readdir(artifacts)) {
    if (name.endsWith(".artifacts")) {
      for (const sub of await readdir(join(artifacts, name, "tool-output"))) everywhere.push(await readFile(join(artifacts, name, "tool-output", sub), "utf8"));
    }
  }
  everywhere.push(await readFile(join(h.f.stateDir, "history", "_instance.jsonl"), "utf8").catch(() => ""));
  const history = await createFileHistory(h.f.stateDir).read(key);
  everywhere.push(JSON.stringify(history.records));
  everywhere.push(await readFile(h.layout.auditPath, "utf8"));
  for (const text of everywhere) {
    assert.ok(!text.includes(SECRET), "synthetic credential found");
    assert.ok(!text.includes(TOKEN), "token found");
  }
  assert.match(everywhere[0]!, /\[redacted\]/);
});

test("subagents are identified, summarized with a log of their own, and the runtime's limit is explicit", async () => {
  const h = await harness(async (run) => {
    run.activity.line(line({ type: "tool_execution_start", toolCallId: "k1", toolName: "subagent", args: { agent: "reviewer-spec", async: false, model: GPT } }));
    run.activity.line(line({ type: "tool_execution_update", toolCallId: "k1", toolName: "subagent", partialResult: "lendo a spec" }));
    run.activity.line(line({ type: "tool_execution_end", toolCallId: "k1", toolName: "subagent", result: "sem achados", isError: false }));
    run.activity.line(line({ type: "tool_execution_start", toolCallId: "k2", toolName: "subagent", args: { agent: "reviewer-standards", async: true, model: GPT } }));
    run.activity.line(line({ type: "tool_execution_end", toolCallId: "k2", toolName: "subagent", result: "lançado", isError: false }));
    return {};
  });
  await h.runner.run(context());
  await h.observer.flush();

  assert.match(matching(h.lines, /filho iniciado/)[0]!, /filho=k1 agente=reviewer-spec assíncrono=não modelo=\S+ log-do-filho=\S+k1\.log/);
  assert.equal(matching(h.lines, /limitação do runtime/).length, 1, "the limitation is announced once");
  assert.match(matching(h.lines, /filho concluído/)[0]!, /filho=k1 agente=reviewer-spec resultado="sem achados"/);
  assert.match(matching(h.lines, /filho lançado em segundo plano/)[0]!, /agente=reviewer-standards/);
  assert.match(matching(h.lines, /filho sem desfecho observado/)[0]!, /filho=k2/, "launch is not progress or success");
  const childLog = /log-do-filho=(\S+k1\.log)/.exec(h.lines.join("\n"))![1]!;
  const child = await readFile(childLog, "utf8");
  assert.match(child, /lançado/);
  assert.match(child, /atividade observada: lendo a spec/);
  assert.match(child, /desfecho: sem achados/);
});

test("an async child reported by notification is concluded, not left unknown", async () => {
  const h = await harness(async (run) => {
    run.activity.line(line({ type: "tool_execution_start", toolCallId: "k9", toolName: "subagent", args: { agent: "reviewer-spec", async: true, model: GPT } }));
    run.activity.line(line({ type: "tool_execution_end", toolCallId: "k9", toolName: "subagent", result: "lançado", isError: false }));
    run.activity.line(line({ type: "message_end", message: { role: "custom", customType: "subagent-notify", content: "Background task completed: **reviewer-spec**" } }));
    return {};
  });
  await h.runner.run(context());
  assert.equal(matching(h.lines, /filho concluído \(notificação\)/).length, 1);
  assert.equal(matching(h.lines, /filho sem desfecho/).length, 0);
});

test("a failing detailed log is reported on the main log and in status, and the run is neither stopped nor repeated", async () => {
  const h = await harness(async (run) => {
    run.activity.line(line({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "a" } }));
    return {};
  }, { preBlockLogs: true });
  const output = await h.runner.run(context());

  assert.equal(h.calls(), 1);
  assert.match(JSON.stringify(output), /pr_ready/, "the invocation result is preserved");
  assert.equal(matching(h.lines, /falha de observabilidade sink="log detalhado"/).length, 1);
});

test("a reply is reported delivered only when the stream shows it reaching the agent", async () => {
  for (const evidence of [true, false]) {
    const h = await harness(async (run, call) => {
      if (call === 2 && evidence) {
        run.activity.line(line({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "Operator input: Use o seam v2" }] } }));
      }
      return { sessionId: "session-1" };
    });
    await h.runner.run(context());
    h.lines.length = 0;
    await h.runner.run(context({
      kind: "resume", invocation: "inv-test-2", replyCommands: ["cmd-1"],
      continuation: { workspace: { session: "session-1", area: h.layout.repoDir }, replies: ["Use o seam v2"] },
    }));
    if (evidence) {
      assert.match(matching(h.lines, /resposta entregue ao agente/)[0]!, /comando=cmd-1 respostas=1 evidência=/);
      assert.equal(matching(h.lines, /não confirmada/).length, 0);
    } else {
      assert.match(matching(h.lines, /entrega da resposta ao agente não confirmada/)[0]!, /comando=cmd-1/);
      assert.equal(matching(h.lines, /resposta entregue/).length, 0, "an unobserved step is not confirmed");
    }
  }
});

test("a write the agent makes on its issue is confirmed only by the tracker's evidence", async () => {
  const states: IssueState[] = [
    { labels: ["ready-for-agent"], done: false, commentIds: ["c1"] },
    { labels: ["ready-for-agent", "needs-review"], done: false, commentIds: ["c1"] },
  ];
  let reads = 0;
  const h = await harness(async (run) => {
    run.activity.line(line({ type: "tool_execution_start", toolCallId: "w1", toolName: "bash", args: { command: "cd repo && gh issue edit 6 --add-label needs-review" } }));
    run.activity.line(line({ type: "tool_execution_end", toolCallId: "w1", toolName: "bash", result: "https://github.com/acme/app/issues/6", isError: false }));
    run.activity.line(line({ type: "tool_execution_start", toolCallId: "w2", toolName: "bash", args: { command: "gh issue close 6" } }));
    run.activity.line(line({ type: "tool_execution_end", toolCallId: "w2", toolName: "bash", result: "✓ Closed issue", isError: false }));
    run.activity.line(line({ type: "tool_execution_start", toolCallId: "w3", toolName: "bash", args: { command: "gh api -X PATCH repos/acme/app/issues/6 -f state=closed" } }));
    run.activity.line(line({ type: "tool_execution_end", toolCallId: "w3", toolName: "bash", result: "{}", isError: false }));
    run.activity.line(line({ type: "tool_execution_start", toolCallId: "r1", toolName: "bash", args: { command: "gh issue view 6" } }));
    return {};
  }, {
    evidence: () => async () => {
      reads += 1;
      // Reads 1-2: before/after of the label call. Reads 3-4: before/after of the close call; the
      // tracker never shows the issue closed, so the agent's call is not a confirmed change.
      return reads <= 1 ? states[0]! : reads === 2 ? states[1]! : { ...states[1]!, done: false };
    },
  });
  await h.runner.run(context());
  await h.observer.flush();

  const attempts = matching(h.lines, /tentativa de alteração na issue/);
  assert.equal(attempts.length, 2, "recognized writes are announced as attempts; a read is not");
  assert.match(attempts[0]!, /origem=agente operação=adicionar-label motivo=.* alvo=needs-review/);
  const confirmed = matching(h.lines, /alteração confirmada/);
  assert.equal(confirmed.length, 1);
  assert.match(confirmed[0]!, /origem=agente operação=adicionar-label alvo=needs-review estado=ausente→presente/);
  const notConfirmed = matching(h.lines, /alteração tentada, não confirmada/);
  assert.equal(notConfirmed.length, 1);
  assert.match(notConfirmed[0]!, /operação=fechar.*o tracker não mostra a alteração/);
  assert.match(matching(h.lines, /não identificável/)[0]!, /origem=agente.*gh api com escrita em issues.*não confirmada; limitação de observação/);
});

test("without tracker evidence an agent write is reported as unconfirmable, never as a change", async () => {
  const h = await harness(async (run) => {
    run.activity.line(line({ type: "tool_execution_start", toolCallId: "w1", toolName: "bash", args: { command: "gh issue comment 6 --body 'pronto'" } }));
    run.activity.line(line({ type: "tool_execution_end", toolCallId: "w1", toolName: "bash", result: "https://github.com/acme/app/issues/6#c9", isError: false }));
    return {};
  });
  await h.runner.run(context());

  assert.equal(matching(h.lines, /alteração confirmada/).length, 0);
  assert.match(matching(h.lines, /alteração tentada, não confirmada/)[0]!, /operação=comentar.*confirmação indisponível/);
});

test("a change is not attributed to the agent when the state before the call is unknown", async () => {
  let reads = 0;
  const h = await harness(async (run) => {
    run.activity.line(line({ type: "tool_execution_start", toolCallId: "w1", toolName: "bash", args: { command: "gh issue close 6" } }));
    run.activity.line(line({ type: "tool_execution_end", toolCallId: "w1", toolName: "bash", result: "ok", isError: false }));
    return {};
  }, {
    // The read before the call fails; the one after shows the issue closed.
    evidence: () => async () => {
      reads += 1;
      if (reads === 1) throw new Error("tracker indisponível");
      return { done: true };
    },
  });
  await h.runner.run(context());

  assert.equal(matching(h.lines, /alteração confirmada/).length, 0);
  assert.match(matching(h.lines, /alteração tentada, não confirmada/)[0]!, /estado anterior desconhecido/);
});

test("a failed run does not claim the reply was delivered, and says it is unconfirmed", async () => {
  const h = await harness(async (_run, call) => {
    if (call === 2) throw new Error("docker caiu");
    return { sessionId: "session-1" };
  });
  await h.runner.run(context());
  h.lines.length = 0;
  await h.runner.run(context({
    kind: "resume", invocation: "inv-test-2", replyCommands: ["cmd-2"],
    continuation: { workspace: { session: "session-1", area: h.layout.repoDir }, replies: ["sim"] },
  }));
  assert.match(matching(h.lines, /entrega da resposta ao agente não confirmada/)[0]!, /comando=cmd-2/);
});

test("a detailed-log failure of one invocation stops standing in status once a later invocation writes it", async () => {
  const f = await fixture();
  const layout = jobLayout(f.stateDir, key);
  const { createFileFailureStore, readFailures } = await import("../src/state/history.js");
  const lines: string[] = [];
  const observer = createObserver({
    instance: "personal", console: (text) => lines.push(text), failures: createFileFailureStore(f.stateDir),
  });
  let call = 0;
  const boundary: SandboxBoundary = {
    async preflight() { return { token: TOKEN }; },
    async imageHas() { return true; },
    async run(input) {
      call += 1;
      input.activity.line(line({ type: "tool_execution_start", toolCallId: `c${call}`, toolName: "read", args: { path: "a" } }));
      return { iterations: 1, completed: true, events: settled(PR_READY), sessionId: "session-1" };
    },
  };
  const runner = createDockerRunner({
    instance, credentials, profiles: { PI_AUTH: f.agentDir, personal: f.agentDir }, stateDir: f.stateDir,
    image: "msf-docker-runner:test", repositorySource: () => f.source, boundary, observer,
  });
  await mkdir(layout.areaDir, { recursive: true });
  await writeFile(join(layout.areaDir, "logs"), "blocks the directory");
  await runner.run(context());
  await observer.flush();
  assert.equal((await readFailures(f.stateDir)).length, 1);

  const { rm } = await import("node:fs/promises");
  await rm(join(layout.areaDir, "logs"));
  await runner.run(context({ kind: "resume", continuation: { workspace: { session: "session-1", area: layout.repoDir }, replies: [] } }));
  await observer.flush();
  assert.deepEqual(await readFailures(f.stateDir), [], "the recovered sink no longer shows in status");
});
