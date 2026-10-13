import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pi, run, type AgentStreamEvent } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { implementResult } from "../implement-result.js";
import { assertNoSecret } from "../secret-scan.js";
import { parseEvent, type PiEvent } from "../pi-evidence.js";
import {
  CHILD_AGENT,
  resolveSpikeModel,
  spikeMounts,
  summarizeUsage,
  verifyDelegation,
} from "./spike-logic.js";

// Disposable Docker spike (ticket #1). Two invocations, like the 004 smoke:
//   1. SMOKE_MODEL=<approved> npm run smoke:docker            -> async child + help request
//   2. SMOKE_MODEL=<approved> SMOKE_RUN=<area> SMOKE_REPLY='...' npm run smoke:docker
//                                                             -> resume the same session
// Every agent runs inside a Sandcastle Docker container. There is no noSandbox fallback.

const model = resolveSpikeModel(process.env.SMOKE_MODEL);
const image = process.env.SPIKE_IMAGE ?? "msf-docker-spike:local";
const account = "Sanmoo";
const home = homedir();
const repoRoot = process.cwd();
const profileDir = join(home, ".pi", "agent");
const previousRun = process.env.SMOKE_RUN;
const resuming = Boolean(previousRun);
const area = previousRun ? resolve(previousRun) : resolve(repoRoot, ".smoke", "docker-spike", randomUUID());
const fixture = join(area, "fixture");
const sessions = join(area, "sessions");
const evidence = join(area, "evidence");
const statePath = join(area, "state.json");
const childMarker = `SPIKE_CHILD_${randomUUID()}`;

// ---- Preflight: every failure is visible and stops the run. Nothing falls back to the host.
function preflight(): string {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    throw new Error("Docker is unavailable (docker info failed). Refusing to run outside the sandbox.", { cause: error });
  }
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "pipe" });
  } catch (error) {
    throw new Error(`Image ${image} is missing. Build it with: docker build --build-arg AGENT_UID=$(id -u) --build-arg AGENT_GID=$(id -g) -t ${image} src/experiments/docker-spike`, { cause: error });
  }
  if (!existsSync(join(profileDir, "auth.json")) || !existsSync(join(profileDir, "settings.json"))) {
    throw new Error(`Operator Pi profile is incomplete at ${profileDir}; refusing to run.`);
  }
  let token: string;
  try {
    token = execFileSync("gh", ["auth", "token", "--user", account], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    throw new Error(`gh has no token for account ${account}; the active gh account is not changed to fix this.`, { cause: error });
  }
  assert.ok(token.length > 0, "empty GitHub token");
  return token;
}

function activeGhAccount(): string {
  try {
    return execFileSync("gh", ["auth", "status"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    return error instanceof Error && "stdout" in error ? String((error as { stdout: unknown }).stdout) : "";
  }
}

const token = preflight();
const ghBefore = activeGhAccount();

function protocol(): string {
  return `This is an operator-authorized disposable fixture experiment inside a Docker sandbox.
Every agent you start (parent, child, reviewers) MUST use model ${model}. No external CLI, no other model.
If a human decision is required, end with
<smoke-result>{"status":"needs_help","question":"your concrete question"}</smoke-result>
followed by <promise>HELP</promise>, then end this invocation. Do not wait for stdin.
When the work is done and verified, use
<smoke-result>{"status":"complete","summary":"what was verified"}</smoke-result>
followed by <promise>COMPLETE</promise>.
Work only in /home/agent/workspace (the fixture). Fixture-local commits only: no push, PR, deployment or tracker call.
Do not dispatch reviewers or any further child in this spike; state the skipped review in your summary.
Spec: docs/spec.md; standards: CODING_STANDARDS.md.
`;
}

function helpPrompt(): string {
  return `/skill:implement Work on docs/spec.md.
${protocol()}
Before asking the human anything:
1. Call subagent exactly once with agent ${CHILD_AGENT}, async true, output false, model ${model}, options {mission:false,context:"fresh"}, task "Return your reply line now. Use no tools."
2. Do not inspect agent definitions or use get/guide/list; do not poll or use bg_wait. After dispatch, wait for the child's native headless completion.
3. When the child result arrives, write docs/seam-question.md with the question for the human, including the child's exact reply line verbatim, then make one fixture-local commit containing that file.
4. Then stop with the needs_help result. The question must include the child's exact reply line.
`;
}

function resumePrompt(reply: string): string {
  return `Human response to your prior question: ${reply}
${protocol()}
Continue from the approved seam: implement slugify(text: string): string in src/slugify.ts following the installed TDD skill (tests through the exported function, red then green), run npm test in the fixture, and make one fixture-local commit. Do not launch children. Finish with the complete result.
`;
}

const agent = (() => {
  const base = pi(model, {
    thinking: "minimal",
    captureSessions: false,
    env: { PI_CODING_AGENT_DIR: "/home/agent/.pi/agent" },
    sessionStorage: { hostSessionsDir: sessions },
  });
  return {
    ...base,
    buildPrintCommand(options: Parameters<typeof base.buildPrintCommand>[0]) {
      const command = base.buildPrintCommand(options);
      return { ...command, command: command.command +
        " --approve --no-context-files --no-prompt-templates --no-mcp" +
        " --tools read,bash,edit,write,subagent,subagents_enable" +
        " --exclude-tools 'mcp__*,mcp'" };
    },
  };
})();

function sandboxFor() {
  return docker({
    imageName: image,
    env: { GH_TOKEN: token },
    mounts: spikeMounts({ home, repoRoot, evidenceDir: evidence, sessionsDir: sessions }),
  });
}

function hooksFor(phase: "help" | "resume") {
  return {
    sandbox: {
      onSandboxReady: [{
        command: `sh /msf-spike/prepare-profile.sh ${profileDir} ${join(home, ".agents")} && sh /msf-spike/container-evidence.sh ${phase}`,
      }],
    },
  };
}

async function setupArea(): Promise<string> {
  await mkdir(join(fixture, "src"), { recursive: true });
  await mkdir(join(fixture, "test"), { recursive: true });
  await mkdir(join(fixture, "docs", "agents"), { recursive: true });
  await mkdir(join(fixture, ".pi", "agents"), { recursive: true });
  await mkdir(sessions, { recursive: true });
  await mkdir(evidence, { recursive: true });
  await writeFile(join(fixture, ".gitignore"), "/.sandcastle/\n/.pi/subagents/\n/node_modules/\n");
  await writeFile(join(fixture, "package.json"), JSON.stringify({
    name: "docker-spike-fixture", private: true, type: "module",
    scripts: { test: "node --test test/slugify.test.ts" },
  }, null, 2) + "\n");
  await writeFile(join(fixture, "src", "slugify.ts"),
    'export function slugify(text: string): string { throw new Error("Not implemented"); }\n');
  await writeFile(join(fixture, "docs", "spec.md"), `# Disposable fixture task
Implement the existing exported slugify(text: string): string for ASCII input.
Lowercase letters, replace each run of non-alphanumeric ASCII characters with
one hyphen, and remove leading/trailing hyphens.
Examples: " Hello, WORLD!! " -> "hello-world"; "" -> ""; "TypeScript & Pi" -> "typescript-pi".
Test seams have NOT been approved by the human yet. Propose the public exported
function as a seam and ask for approval, as required by the installed TDD skill.
Stop with a help result before writing tests or implementation.
No tracker API, push, PR, deployment or dependency installation is part of this task.
`);
  await writeFile(join(fixture, "CODING_STANDARDS.md"),
    "Use TypeScript strict mode. Test public behavior, without mocks or private seams.\n");
  await writeFile(join(fixture, "docs", "agents", "issue-tracker.md"),
    "# Fixture tracker\nLocal Markdown only: docs/spec.md is the task. No external tracker.\n");
  await writeFile(join(fixture, ".pi", "agents", `${CHILD_AGENT}.md`), `---
name: ${CHILD_AGENT}
description: Tool-free compatibility child for the Docker spike
tools:
extensions:
inheritProjectContext: false
inheritGlobalContext: false
inheritSkills: false
thinking: minimal
---
Reply with exactly this line and nothing else: ${childMarker}
`);
  const gitFixture = (...args: string[]) => execFileSync("git", args, { cwd: fixture, encoding: "utf8" });
  gitFixture("init", "-b", "smoke-work");
  gitFixture("config", "user.name", "Docker spike fixture");
  gitFixture("config", "user.email", "fixture@example.invalid");
  gitFixture("add", ".");
  gitFixture("commit", "-m", "Initialize Docker spike fixture");
  return gitFixture("rev-parse", "HEAD").trim();
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: fixture, encoding: "utf8" });
}

function collector(phase: string, events: PiEvent[]) {
  return {
    type: "file" as const,
    path: join(area, `${phase}.log`),
    onAgentStreamEvent(event: AgentStreamEvent) {
      if (event.type !== "raw") return;
      const parsed = parseEvent(event.line);
      if (parsed) events.push(parsed);
    },
  };
}

async function writeJson(name: string, value: unknown) {
  await writeFile(join(area, name), JSON.stringify(value, null, 2) + "\n");
}

async function scanForSecret(): Promise<void> {
  for (const name of await readdir(area)) {
    if (!/\.(json|log|txt)$/.test(name)) continue;
    assertNoSecret(await readFile(join(area, name), "utf8"), token);
  }
  for (const name of await readdir(evidence)) {
    assertNoSecret(await readFile(join(evidence, name), "utf8"), token);
  }
}

function sandcastleContainers(): string[] {
  return execFileSync("docker", ["ps", "-a", "--filter", "name=^sandcastle-", "--format", "{{.Names}}"],
    { encoding: "utf8" }).split("\n").filter(Boolean);
}

async function negativeMissingImage(): Promise<void> {
  const failure = await run({
    agent,
    sandbox: docker({ imageName: "msf-docker-spike:does-not-exist", env: { GH_TOKEN: token } }),
    cwd: fixture, branchStrategy: { type: "head" }, maxIterations: 1, name: "negative",
    prompt: "noop",
  }).then(() => undefined, (error: unknown) => (error instanceof Error ? error.message : String(error)));
  assert.ok(failure, "a missing Docker image must fail visibly");
  assert.match(failure, /not found locally|Build it first/);
  assert.equal(git("status", "--porcelain").trim(), "", "negative check changed the fixture");
  await writeJson("negative.json", { outcome: "rejected", error: failure, fallbackUsed: false });
}

const started = Date.now();
process.stdout.write(`Area: ${area}\n`);

if (!resuming) {
  await mkdir(area, { recursive: true });
  const base = await setupArea();
  await negativeMissingImage();

  const events: PiEvent[] = [];
  const result = await run({
    agent, sandbox: sandboxFor(), cwd: fixture, branchStrategy: { type: "head" },
    maxIterations: 1, name: "help", idleTimeoutSeconds: 600,
    completionSignal: ["<promise>HELP</promise>", "<promise>COMPLETE</promise>"],
    hooks: hooksFor("help"),
    logging: collector("help", events),
    prompt: helpPrompt(),
  });
  await writeJson("help.events.json", events);
  assert.equal(result.iterations.length, 1, "help should stop in one invocation");
  const sessionId = result.iterations[0]?.sessionId;
  assert.ok(sessionId, "Sandcastle did not capture a session id");
  const located = await agent.sessionStorage.findByIdOnHost(sessionId);
  assert.ok(located.path, "session must persist on the host, outside the container");
  const delegation = verifyDelegation(events, { model, marker: childMarker });
  const output = implementResult(events);
  assert.equal(output.status, "needs_help", "expected a help request");
  assert.equal(git("status", "--porcelain").trim(), "", "help phase left the fixture dirty");
  assert.notEqual(git("rev-parse", "HEAD").trim(), base, "checkpoint commit expected before the question");
  assert.equal(sandcastleContainers().length, 0, "help container must be removed after the run");
  await writeFile(statePath, JSON.stringify({
    model, base, sessionId, childMarker, question: output.question,
    checkpoint: git("rev-parse", "HEAD").trim(), sessionPath: located.path,
  }, null, 2));
  await writeJson("help.report.json", {
    phase: "help", model, sessionId, delegation, output,
    usage: summarizeUsage(events), durationMs: Date.now() - started,
    activeGhUnchanged: activeGhAccount() === ghBefore,
  });
  await scanForSecret();
  process.stdout.write(`Help request recorded. Question: ${output.question}\n` +
    `Reply with: SMOKE_MODEL=${model} SMOKE_RUN=${area} SMOKE_REPLY='...' npm run smoke:docker\n`);
} else {
  let state: {
    model: string; base: string; sessionId: string; childMarker: string; question: string; checkpoint: string;
  };
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    throw new Error(`could not read the help-phase state at ${statePath}`, { cause: error });
  }
  assert.equal(state.model, model, "do not change models during the experiment");
  const reply = process.env.SMOKE_REPLY?.trim();
  assert.ok(reply, "SMOKE_REPLY must contain the human answer");
  assert.equal(git("rev-parse", "HEAD").trim(), state.checkpoint, "checkpoint changed before resume");

  const events: PiEvent[] = [];
  const result = await run({
    agent, sandbox: sandboxFor(), cwd: fixture, branchStrategy: { type: "head" },
    maxIterations: 1, name: "resume", idleTimeoutSeconds: 600, resumeSession: state.sessionId,
    completionSignal: ["<promise>HELP</promise>", "<promise>COMPLETE</promise>"],
    hooks: hooksFor("resume"),
    logging: collector("resume", events),
    prompt: resumePrompt(reply),
  });
  await writeJson("resume.events.json", events);
  assert.equal(result.iterations.length, 1, "resume should use one invocation");
  assert.equal(result.iterations[0]?.sessionId, state.sessionId, "resume created a new session");
  const output = implementResult(events);
  assert.equal(output.status, "complete", "resume did not complete");
  assert.equal(git("status", "--porcelain").trim(), "", "fixture must be clean after completion");
  const commits = Number(git("rev-list", "--count", `${state.base}..HEAD`).trim());
  assert.ok(commits >= 2, "expected the checkpoint and the implementation commit");
  execFileSync("node", ["--test", "test/slugify.test.ts"], { cwd: fixture, stdio: "inherit" });
  assert.equal(sandcastleContainers().length, 0, "resume container must be removed after the run");
  await writeJson("resume.report.json", {
    phase: "resume", model, sameSession: true, output,
    fixtureCommits: commits, usage: summarizeUsage(events),
    durationMs: Date.now() - started, activeGhUnchanged: activeGhAccount() === ghBefore,
  });
  await scanForSecret();
  process.stdout.write(JSON.stringify({ output, fixtureCommits: commits }, null, 2) + "\n");
}
