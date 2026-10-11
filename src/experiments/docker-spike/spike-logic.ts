import assert from "node:assert/strict";
import { join } from "node:path";
import type { PiEvent } from "../pi-evidence.js";

export const SPIKE_MODELS = [
  "github-copilot/gpt-6-luna",
  "github-copilot/claude-haiku-5.5",
] as const;
export type SpikeModel = (typeof SPIKE_MODELS)[number];

export const CHILD_AGENT = "spike-child";
export const SANDBOX_SESSIONS_DIR = "/home/agent/.pi/agent/sessions";

/** Accepts only the operator-approved cheap models; there is no fallback. */
export function resolveSpikeModel(value: string | undefined): SpikeModel {
  if (value === undefined || value.trim() === "") {
    throw new Error("Set SMOKE_MODEL explicitly to github-copilot/gpt-6-luna or github-copilot/claude-haiku-5.5.");
  }
  const match = SPIKE_MODELS.find((model) => model === value);
  if (!match) throw new Error(`"${value}" is not an approved cheap model for this spike.`);
  return match;
}

export interface SpikeMount {
  readonly hostPath: string;
  readonly sandboxPath: string;
  readonly readonly: boolean;
}

/**
 * Mounts for the Docker sandbox. The operator profile is read-only and keeps its
 * host-absolute paths so the profile's symlinks resolve identically in the container.
 * Only the spike area (sessions, evidence) is writable; work-account roots are absent.
 */
export function spikeMounts(input: {
  home: string;
  repoRoot: string;
  evidenceDir: string;
  sessionsDir: string;
}): SpikeMount[] {
  const readOnly = (path: string): SpikeMount => ({ hostPath: path, sandboxPath: path, readonly: true });
  return [
    readOnly(join(input.home, ".pi", "agent")),
    readOnly(join(input.home, ".agents")),
    readOnly(join(input.home, "dev", "github.com", "Sanmoo", "dotfiles")),
    { hostPath: join(input.repoRoot, "src", "experiments", "docker-spike"),
      sandboxPath: "/msf-spike", readonly: true },
    { hostPath: input.evidenceDir, sandboxPath: "/msf-evidence", readonly: false },
    // Pi's default session layout under the container agent dir, so Sandcastle's host lookup matches.
    { hostPath: input.sessionsDir, sandboxPath: SANDBOX_SESSIONS_DIR, readonly: false },
  ];
}

export interface UsageSummary {
  messages: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costTotal: number;
}

/** Sums assistant usage reported by Pi, so cost can be compared with the envelope. */
export function summarizeUsage(events: PiEvent[]): UsageSummary {
  const summary: UsageSummary = {
    messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costTotal: 0,
  };
  for (const event of events) {
    if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
    const usage = event.message.usage;
    if (!usage) continue;
    summary.messages += 1;
    summary.input += usage.input ?? 0;
    summary.output += usage.output ?? 0;
    summary.cacheRead += usage.cacheRead ?? 0;
    summary.cacheWrite += usage.cacheWrite ?? 0;
    summary.totalTokens += usage.totalTokens ?? 0;
    summary.costTotal += usage.cost?.total ?? 0;
  }
  return summary;
}

/**
 * Checks that the parent delegated exactly one async child on the explicit model and
 * that the child's hidden marker reached the parent's settled final reply.
 */
export function verifyDelegation(
  events: PiEvent[],
  expected: { model: string; marker: string },
): { childLaunches: number; model: string } {
  const launches = events.filter((event) =>
    event.type === "tool_execution_start" && event.toolName === "subagent"
      && event.args?.agent === CHILD_AGENT);
  assert.equal(launches.length, 1, "expected exactly one child launch");
  assert.equal(launches[0]?.args?.async, true, "child must be async");
  assert.equal(launches[0]?.args?.model, expected.model, "child must use the explicit model");
  assert.equal(events.at(-1)?.type, "agent_settled", "parent did not reach a settled state");
  assert.equal(events.at(-1)?.aborted, false, "parent run was aborted");
  const finalText = events
    .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
    .at(-1)?.message?.content?.filter((block) => block.type === "text")
    .map((block) => block.text ?? "").join("") ?? "";
  assert.ok(finalText.includes(expected.marker), "child marker missing from parent's final reply");
  return { childLaunches: launches.length, model: expected.model };
}

/** Fails if a secret value appears in text that would be written to logs or reports. */
export function assertNoSecret(text: string, secret: string): void {
  if (secret.length > 0 && text.includes(secret)) {
    throw new Error("secret value found in text that would be persisted");
  }
}
