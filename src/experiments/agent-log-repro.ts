import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { createBindMountSandboxProvider, pi, run } from "@ai-hero/sandcastle";

// Diagnostic fixture only: no agent process, Docker, tracker or credentials.
// Sandcastle uses its real Pi parser and file logger; only command execution is synthetic.
const exec = promisify(execFile);
const root = resolve(".smoke");
await mkdir(root, { recursive: true });
const dir = await mkdtemp(join(root, "agent-log-"));
const repo = join(dir, "repo");
await mkdir(repo);
const env = { ...process.env, GIT_CONFIG_GLOBAL: join(dir, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
await writeFile(env.GIT_CONFIG_GLOBAL, "[user]\nname = Fixture\nemail = fixture@invalid\n");
await exec("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
await exec("git", ["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "fixture"], { cwd: repo, env });

const verbose = process.argv.includes("--verbose");
const recognizedTool = process.argv.includes("--recognized-tool");
const lines = [
  { type: "tool_execution_start", toolCallId: "fixture-read-1", toolName: recognizedTool ? "Bash" : "read", args: recognizedTool ? { command: "FIXTURE_FILE.md" } : { path: "FIXTURE_FILE.md" } },
  { type: "tool_execution_end", toolCallId: "fixture-read-1", toolName: recognizedTool ? "Bash" : "read", result: { content: [{ type: "text", text: "FIXTURE_TOOL_RESULT: approved seam" }] }, isError: false },
].map(event => JSON.stringify(event));
const logPath = join(dir, "agent.log");
const raw: string[] = [];
let invocations = 0;
const sandbox = createBindMountSandboxProvider({
  name: "synthetic-command-fixture",
  create: async ({ worktreePath }) => ({
    worktreePath,
    async exec(command, options) {
      if (command.startsWith("pi ")) {
        invocations++;
        for (const line of lines) options?.onLine?.(line);
        return { exitCode: 0, stderr: "", stdout: lines.join("\n") + "\n" };
      }
      assert.ok(command.trim().startsWith("git "), `unexpected fixture setup command: ${command}`);
      const output = await exec("sh", ["-c", command], { cwd: options?.cwd ?? worktreePath, env });
      return { ...output, exitCode: 0 };
    },
    copyFileIn: async () => { throw new Error("fixture does not transfer files"); },
    copyFileOut: async () => { throw new Error("fixture does not transfer files"); },
    close: async () => {},
  }),
});
await run({
  agent: pi("fixture/synthetic", { captureSessions: false }),
  sandbox, cwd: repo, branchStrategy: { type: "head" },
  prompt: "Fixture: report progress and read the approved seam.",
  maxIterations: 1, completionSignal: "<promise>FIXTURE-DONE</promise>",
  logging: { type: "file", path: logPath, verbose, onAgentStreamEvent(event) {
    if (event.type === "raw") raw.push(event.line);
  } },
});
assert.equal(invocations, 1);
assert.equal(raw.length, lines.length, "real streaming callback received all fixture events");
// A bounded drain avoids asserting before the library's asynchronous file writes finish.
let log = "";
for (let attempt = 0; attempt < 100; attempt++) {
  log = await readFile(logPath, "utf8");
  if (log.includes("Run complete:")) break;
  await new Promise(resolve => setTimeout(resolve, 10));
}
assert.ok(log.includes("Run complete:"), "the actual log has finished draining");
console.log(`Log: ${logPath}`);
console.log(`Stream events received: ${raw.length}; verbose=${verbose}; recognizedTool=${recognizedTool}; tool args visible=${log.includes("FIXTURE_FILE.md")}; result visible=${log.includes("FIXTURE_TOOL_RESULT")}`);
if (process.argv.includes("--expect-missing")) {
  assert.equal(log.includes("FIXTURE_FILE.md"), recognizedTool, "recognized tool formatting control");
  assert.ok(!log.includes("FIXTURE_TOOL_RESULT"), "baseline reproduces missing tool result after log drain");
} else {
  assert.ok(log.includes("FIXTURE_FILE.md"), "tool arguments must be visible in the detailed log");
  assert.ok(log.includes("FIXTURE_TOOL_RESULT"), "tool result emitted by the agent must be visible in the detailed log");
}
