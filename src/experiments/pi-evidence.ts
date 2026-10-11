import assert from "node:assert/strict";

export interface PiEvent {
  type: string;
  toolName?: string;
  args?: { agent?: string; async?: boolean; action?: string };
  isError?: boolean;
  aborted?: boolean;
  message?: {
    role?: string;
    stopReason?: string;
    errorMessage?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
}

export function parseEvent(line: string): PiEvent | undefined {
  try {
    const value = JSON.parse(line);
    if (value && typeof value === "object" && typeof value.type === "string") {
      return value;
    }
  } catch {
    // Extension diagnostics are not protocol events.
  }
  return undefined;
}

export function verifyPhase(
  events: PiEvent[],
  marker: string,
  phase: "initial" | "resume",
) {
  assert.equal(events.at(-1)?.type, "agent_settled", "missing stable completion");
  assert.equal(events.at(-1)?.aborted, false, "Pi aborted");
  const finalMessage = events.filter(
    (event) => event.type === "message_end" && event.message?.role === "assistant",
  ).at(-1);
  assert.ok(finalMessage, "missing final assistant message");
  assert.ok(!["error", "aborted"].includes(finalMessage.message?.stopReason ?? ""),
    finalMessage.message?.errorMessage ?? "model request failed");
  const finalText = finalMessage?.message?.content
    ?.filter((block) => block.type === "text")
    .map((block) => block.text ?? "").join("") ?? "";
  assert.ok(finalText.includes(marker), "final response missing hidden child marker");

  const calls = events.filter((event) => event.type === "tool_execution_start");
  for (const call of calls) {
    assert.ok(["subagent", "subagents_enable"].includes(call.toolName ?? ""),
      "unexpected parent tool");
    if (call.toolName === "subagent" && call.args?.action) {
      assert.equal(call.args.action, "status", "only child status inspection is allowed");
    }
  }
  assert.ok(!events.some(
    (event) => event.type === "tool_execution_end" && event.isError,
  ), "a parent tool failed");
  const launches = calls.filter(
    (event) => event.toolName === "subagent" && event.args?.agent === "smoke-marker",
  );
  assert.equal(launches.length, phase === "initial" ? 1 : 0,
    "wrong number of child launches");
  if (phase === "initial") assert.equal(launches[0]?.args?.async, true);
  return { settled: true, markerRecovered: true, childLaunches: launches.length };
}
