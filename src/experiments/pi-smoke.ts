import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pi, run, type AgentStreamEvent } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { parseEvent, verifyPhase, type PiEvent } from "./pi-evidence.js";

const model = process.env.SMOKE_MODEL ?? "openai-codex/gpt-6.1-sol";
const maxIterations = Number(process.env.SMOKE_MAX_ITERATIONS ?? 5);
assert.ok(Number.isSafeInteger(maxIterations) && maxIterations > 0);
const root = resolve(".smoke", randomUUID());
const fixture = join(root, "fixture");
const sessions = join(root, "sessions");
const marker = `SMOKE_${randomUUID()}`;
await mkdir(join(fixture, ".pi", "agents"), { recursive: true });
await mkdir(sessions, { recursive: true });
await writeFile(join(fixture, ".gitignore"), ".sandcastle/\n.pi/subagents/\n");
await writeFile(join(fixture, ".pi", "agents", "smoke-marker.md"), `---
name: smoke-marker
description: Tool-free compatibility-test marker
tools:
extensions:
inheritProjectContext: false
inheritGlobalContext: false
inheritSkills: false
thinking: minimal
---
Reply with exactly this marker: ${marker}
`);
const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture, encoding: "utf8" });
git("init", "-b", "main");
git("config", "user.name", "Compatibility fixture");
git("config", "user.email", "fixture@example.invalid");
git("add", ".");
git("commit", "-m", "Initialize disposable compatibility fixture");

const base = pi(model, {
  thinking: "minimal",
  env: { PI_CODING_AGENT_SESSION_DIR: sessions },
  sessionStorage: { hostSessionsDir: sessions, sandboxSessionsDir: sessions },
});
// Keep installed extensions/authentication; restrict this probe to delegation.
const agent = {
  ...base,
  buildPrintCommand(options: Parameters<typeof base.buildPrintCommand>[0]) {
    const command = base.buildPrintCommand(options);
    return {
      ...command,
      command: command.command + " --approve --no-context-files --no-skills" +
        " --no-prompt-templates --no-mcp --tools subagent,subagents_enable" +
        " --exclude-tools 'mcp__*,mcp'",
    };
  },
};
const capture = (phase: string, events: PiEvent[]) => ({
  type: "file" as const,
  path: join(root, `${phase}.log`),
  onAgentStreamEvent(event: AgentStreamEvent) {
    if (event.type !== "raw") return;
    const parsed = parseEvent(event.line);
    if (parsed) events.push(parsed);
  },
});
const initialEvents: PiEvent[] = [];
const resumeEvents: PiEvent[] = [];
const started = Date.now();
process.stdout.write(`Artifacts: ${root}\n`);
try {
  const first = await run({
    agent,
    // Sandcastle runs git config --global during setup. Keep it fixture-local.
    sandbox: noSandbox({ env: { GIT_CONFIG_GLOBAL: join(root, "gitconfig") } }),
    cwd: fixture,
    branchStrategy: { type: "head" },
    maxIterations,
    name: "initial",
    logging: capture("initial", initialEvents),
    idleTimeoutSeconds: 180,
    prompt: `This is an operator-authorized compatibility probe, not project work.
Call subagent exactly once with agent smoke-marker, async true, output false,
model ${model}, and options {mission:false,context:"fresh",defaultProgress:false}.
Task: "Return the hidden marker from your system prompt. Use no tools."
Do not inspect agent definitions or use get/guide/list. Do not launch any other child.
After dispatch, yield to the native headless completion; no polling or bg_wait.
When the child's result arrives, your final answer must be its exact marker
followed by <promise>COMPLETE</promise>. Never claim completion before the child result.
You may use subagents_enable if activation is necessary; status is allowed only
if recovering an already completed child. Do not read or change files.`,
  });
  await writeFile(join(root, "initial.events.json"), JSON.stringify(initialEvents, null, 2));
  assert.equal(first.iterations.length, 1, "expected completion on first invocation");
  const initial = verifyPhase(initialEvents, marker, "initial");
  const sessionId = first.iterations[0]?.sessionId;
  assert.ok(sessionId, "Sandcastle did not capture a session id");
  const located = await base.sessionStorage.findByIdOnHost(sessionId);
  assert.ok(located.path, "Pi session is not persisted");
  await readFile(located.path, "utf8");
  assert.ok(first.resume, "Sandcastle has no resume helper");

  // The resume helper deliberately uses one iteration, as required by Sandcastle.
  const second = await first.resume(
    "Resume this conversation. Reply with the exact child marker from the prior " +
    "completed result followed by <promise>COMPLETE</promise>. " +
    "Do not launch a child, inspect agent definitions, read files or invent a marker.",
    { name: "resume", logging: capture("resume", resumeEvents) },
  );
  await writeFile(join(root, "resume.events.json"), JSON.stringify(resumeEvents, null, 2));
  assert.equal(second.iterations[0]?.sessionId, sessionId, "resume created a new session");
  assert.equal(second.iterations.length, 1);
  const resumed = verifyPhase(resumeEvents, marker, "resume");
  assert.equal(git("status", "--porcelain").trim(), "", "fixture was modified");
  const report = {
    outcome: "passed", model, node: process.version, sandcastle: "0.12.0",
    maxIterations, initialIterations: first.iterations.length,
    resumeIterations: second.iterations.length, initial, resumed,
    sameSession: true, fixtureUnchanged: true, durationMs: Date.now() - started,
  };
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} catch (error) {
  await writeFile(join(root, "initial.events.json"), JSON.stringify(initialEvents, null, 2));
  await writeFile(join(root, "resume.events.json"), JSON.stringify(resumeEvents, null, 2));
  await writeFile(join(root, "report.json"), JSON.stringify({
    outcome: "failed", model, maxIterations,
    error: error instanceof Error ? error.message : String(error),
    durationMs: Date.now() - started,
  }, null, 2) + "\n");
  console.error(`Probe failed. Inspect local artifacts at ${root}`);
  throw error;
}
