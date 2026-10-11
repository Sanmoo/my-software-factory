import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pi, run, type AgentStreamEvent } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { parseEvent, type PiEvent } from "./pi-evidence.js";
import { implementResult } from "./implement-result.js";

const model = process.env.SMOKE_MODEL;
assert.equal(model, "github-copilot/gpt-6-luna", "use the operator-approved cheap model");
const previousRun = process.env.SMOKE_RUN;
const resuming = Boolean(previousRun);
const root = previousRun ? resolve(previousRun) : resolve(".smoke/implement-help", randomUUID());
const fixture = join(root, "fixture");
const sessionsRoot = join(root, "sessions");
const sessions = join(sessionsRoot, "project");
const git = (...args: string[]) => execFileSync("git", args, { cwd: fixture, encoding: "utf8" });
type State = { model: string; base: string; sessionId: string; question: string };
let state: State | undefined;

if (resuming) {
  try {
    state = JSON.parse(await readFile(join(root, "state.json"), "utf8")) as State;
  } catch (error) {
    throw new Error("could not read the previous probe state", { cause: error });
  }
  assert.ok(state && typeof state.sessionId === "string" && typeof state.base === "string");
  assert.equal(state.model, model, "do not change models during the experiment");
  assert.ok(process.env.SMOKE_REPLY?.trim(), "SMOKE_REPLY must contain the actual human answer");
} else {
  for (const dir of ["src", "test", "docs/agents"]) await mkdir(join(fixture, dir), { recursive: true });
  await mkdir(sessions, { recursive: true });
  await writeFile(join(fixture, ".gitignore"), "/node_modules/\n/.sandcastle/\n/.pi/subagents/\n");
  await writeFile(join(fixture, "package.json"), JSON.stringify({
    name: "implement-fixture", private: true, type: "module",
    scripts: { test: "tsx --test test/*.test.ts", typecheck: "tsc --noEmit" },
  }, null, 2));
  await writeFile(join(fixture, "tsconfig.json"), await readFile("tsconfig.json", "utf8"));
  await symlink(resolve("node_modules"), join(fixture, "node_modules"), "dir");
  await writeFile(join(fixture, "src/slugify.ts"),
    'export function slugify(text: string): string { throw new Error("Not implemented"); }\n');
  await writeFile(join(fixture, "docs/spec.md"), `# Disposable fixture task
Implement the existing exported slugify(text: string): string for ASCII input.
Lowercase letters, replace each run of non-alphanumeric ASCII characters with
one hyphen, and remove leading/trailing hyphens.
Examples: " Hello, WORLD!! " -> "hello-world"; "" -> ""; "TypeScript & Pi" -> "typescript-pi".
Test seams have NOT been approved by the human yet. Propose the public exported
function as a seam and ask for approval, as required by the installed TDD skill.
Stop with a help result before writing tests or implementation.
All work stays in this fixture; checkpoint commits on its work branch are allowed.
No tracker API, push, PR, deployment or dependency installation is part of this task.
`);
  await writeFile(join(fixture, "CODING_STANDARDS.md"),
    "Use TypeScript strict mode. Test public behavior, without mocks or private seams.\n");
  await writeFile(join(fixture, "docs/agents/issue-tracker.md"),
    "# Fixture tracker\nLocal Markdown only: docs/spec.md is the task. No external tracker.\n");
  git("init", "-b", "smoke-work");
  git("config", "user.name", "Compatibility fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("add", ".");
  git("commit", "-m", "Initialize implement/help fixture");
}

const baseHead = state?.base ?? git("rev-parse", "HEAD").trim();
const provider = pi(model, {
  thinking: "minimal",
  env: { PI_CODING_AGENT_SESSION_DIR: sessions },
  sessionStorage: { hostSessionsDir: sessionsRoot, sandboxSessionsDir: sessionsRoot },
});
const agent = {
  ...provider,
  buildPrintCommand(options: Parameters<typeof provider.buildPrintCommand>[0]) {
    const command = provider.buildPrintCommand(options);
    return { ...command, command: command.command +
      " --approve --no-context-files --no-prompt-templates --no-mcp" +
      " --tools read,bash,edit,write,subagent,subagents_enable" +
      " --exclude-tools 'mcp__*,mcp'" };
  },
};
const phase = resuming ? "resume" : "help";
const events: PiEvent[] = [];
const protocol = `This is an operator-authorized disposable fixture experiment.
All delegated agents MUST use model ${model}; no delegation to external CLIs.
If any human decision is required, ask it in a final
<smoke-result>{"status":"needs_help","question":"your concrete question"}</smoke-result>
followed by <promise>HELP</promise>, then end this invocation. Do not use dialogs
or wait for stdin. An unanswered question is not permission.
Only when implementation, tests and two-axis review are done, use
<smoke-result>{"status":"complete","summary":"what was verified"}</smoke-result>
followed by <promise>COMPLETE</promise>.
Keep changes/commands in the fixture, with read access to installed skill docs.
Use only fixture-local Git commits. Checkpoint before review is allowed so
code-review's HEAD diff is non-empty. Review base: ${baseHead}.
Spec source: docs/spec.md; standards: CODING_STANDARDS.md;
tracker: docs/agents/issue-tracker.md. Child reviewers read-only, no nested delegation.
`;
const prompt = resuming
  ? `Human response to your prior question: ${process.env.SMOKE_REPLY}\n${protocol}`
  : `/skill:implement Work on docs/spec.md.\n${protocol}`;
process.stdout.write(`Artifacts: ${root}\n`);
try {
  const result = await run({
    agent, sandbox: noSandbox({ env: { GIT_CONFIG_GLOBAL: join(root, "gitconfig") } }),
    cwd: fixture, branchStrategy: { type: "head" },
    maxIterations: resuming ? 1 : 5, resumeSession: state?.sessionId,
    completionSignal: ["<promise>HELP</promise>", "<promise>COMPLETE</promise>"],
    name: phase, idleTimeoutSeconds: 180,
    logging: { type: "file", path: join(root, `${phase}.log`),
      onAgentStreamEvent(event: AgentStreamEvent) {
        if (event.type === "raw") {
          const parsed = parseEvent(event.line);
          if (parsed) events.push(parsed);
        }
      } },
    prompt,
  });
  const output = implementResult(events);
  assert.equal(result.iterations.length, 1, "help/complete should stop in one invocation");
  const sessionId = result.iterations[0]?.sessionId;
  assert.ok(sessionId);
  const located = await provider.sessionStorage.findByIdOnHost(sessionId);
  assert.ok(located.path, "session must be persisted for a later human response");
  if (state) assert.equal(sessionId, state.sessionId, "must resume the same session");
  if (output.status === "needs_help") {
    if (!resuming) {
      assert.equal(git("status", "--porcelain").trim(), "", "initial help must not change fixture");
      assert.equal(git("rev-parse", "HEAD").trim(), baseHead, "initial help must not commit");
    }
    await writeFile(join(root, "state.json"), JSON.stringify({
      model, base: baseHead, sessionId, question: output.question,
    }, null, 2));
  } else {
    git("status", "--porcelain"); // Retain the full fixture and events for independent checks.
  }
  const report = { phase, model, output, sameSession: resuming,
    iterations: result.iterations.length, sessionId };
  await writeFile(join(root, `${phase}.report.json`), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally {
  await writeFile(join(root, `${phase}.events.json`), JSON.stringify(events, null, 2));
}
