import assert from "node:assert/strict";
import test from "node:test";
import type { PiEvent } from "../src/experiments/pi-evidence.js";
import { assertNoSecret } from "../src/experiments/secret-scan.js";
import {
  resolveSpikeModel,
  spikeMounts,
  summarizeUsage,
  verifyDelegation,
} from "../src/experiments/docker-spike/spike-logic.js";

test("accepts only the two operator-approved cheap models, never a fallback", () => {
  assert.equal(resolveSpikeModel("github-copilot/gpt-6-luna"), "github-copilot/gpt-6-luna");
  assert.equal(resolveSpikeModel("github-copilot/claude-haiku-5.5"), "github-copilot/claude-haiku-5.5");
  assert.throws(() => resolveSpikeModel(undefined), /SMOKE_MODEL/);
  assert.throws(() => resolveSpikeModel("github-copilot/gpt-6.1-sol"), /approved cheap model/);
  assert.throws(() => resolveSpikeModel("openai-codex/gpt-6-luna"), /approved cheap model/);
});

test("mounts the personal profile read-only at host-identical paths and keeps only the area writable", () => {
  const mounts = spikeMounts({
    home: "/Users/operator",
    repoRoot: "/repo",
    evidenceDir: "/repo/.smoke/a/evidence",
    sessionsDir: "/repo/.smoke/a/sessions",
  });
  const profile = mounts.find((m) => m.sandboxPath === "/Users/operator/.pi/agent");
  assert.ok(profile, "personal Pi profile must be mounted");
  assert.equal(profile.hostPath, "/Users/operator/.pi/agent");
  assert.equal(profile.readonly, true);
  assert.equal(mounts.find((m) => m.sandboxPath === "/Users/operator/.agents")?.readonly, true);
  assert.equal(mounts.find((m) => m.sandboxPath === "/home/agent/.pi/agent/sessions")?.readonly, false);
  assert.equal(mounts.find((m) => m.sandboxPath === "/msf-evidence")?.readonly, false);
  assert.equal(mounts.find((m) => m.sandboxPath === "/msf-spike")?.hostPath, "/repo/src/experiments/docker-spike");
  assert.equal(mounts.find((m) => m.sandboxPath === "/msf-spike")?.readonly, true);
  for (const mount of mounts) {
    assert.ok(!mount.hostPath.includes("bjd"), `work-account path must not be mounted: ${mount.hostPath}`);
  }
});

test("sums Pi assistant usage and cost across message_end events", () => {
  const events: PiEvent[] = [
    { type: "message_end", message: { role: "user" } },
    { type: "message_end", message: { role: "assistant", usage: {
      input: 3, output: 6, cacheRead: 0, cacheWrite: 9414, totalTokens: 9423,
      cost: { total: 0.5 } } } },
    { type: "message_end", message: { role: "assistant", usage: {
      input: 10, output: 4, cacheRead: 9414, cacheWrite: 0, totalTokens: 9428,
      cost: { total: 0.25 } } } },
  ];
  assert.deepEqual(summarizeUsage(events), {
    messages: 2, input: 13, output: 10, cacheRead: 9414, cacheWrite: 9414,
    totalTokens: 18851, costTotal: 0.75,
  });
});

test("requires exactly one async child launched with the explicit model and a child marker in the reply", () => {
  const model = "github-copilot/gpt-6-luna";
  const events: PiEvent[] = [
    { type: "tool_execution_start", toolName: "subagent",
      args: { agent: "spike-child", async: true, model } },
    { type: "tool_execution_end", toolName: "subagent", isError: false },
    { type: "message_end", message: { role: "assistant", content: [
      { type: "text", text: "<smoke-result>{\"status\":\"needs_help\",\"question\":\"CHILD_MARK ok?\"}</smoke-result>\n<promise>HELP</promise>" },
    ] } },
    { type: "agent_settled", aborted: false },
  ];
  assert.deepEqual(verifyDelegation(events, { model, marker: "CHILD_MARK" }), {
    childLaunches: 1, model,
  });
  assert.throws(() => verifyDelegation(events, { model: "github-copilot/claude-haiku-5.5", marker: "CHILD_MARK" }),
    /model/);
  assert.throws(() => verifyDelegation(events, { model, marker: "MISSING" }), /marker/);
});

test("rejects delegation that never reaches a settled assistant reply", () => {
  const model = "github-copilot/gpt-6-luna";
  const events: PiEvent[] = [
    { type: "tool_execution_start", toolName: "subagent",
      args: { agent: "spike-child", async: true, model } },
    { type: "tool_execution_end", toolName: "subagent", isError: false },
  ];
  assert.throws(() => verifyDelegation(events, { model, marker: "CHILD_MARK" }), /settled/);
});

test("secret scan fails when a token value would appear in logs or reports", () => {
  assertNoSecret("no credentials here", "gho_example_token_value");
  assert.throws(() => assertNoSecret("leak gho_example_token_value", "gho_example_token_value"),
    /secret/);
});
