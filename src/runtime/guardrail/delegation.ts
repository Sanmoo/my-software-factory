export interface ChildGuardrailRegistration {
  dispose(): void;
}

export type RegisterChildGuardrail = (sessionId: string) => ChildGuardrailRegistration;

/** Only the image-owned reviewers and native, declarative launches have no
 * setup hooks or workflow script whose effects escape the child guardrail. */
export function guardedDelegation(input: Record<string, unknown>): boolean {
  const task = (value: unknown): boolean => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const entry = value as Record<string, unknown>;
    return (entry["agent"] === "code-reviewer" || entry["agent"] === "spec-reviewer") &&
      typeof entry["task"] === "string" &&
      Object.keys(entry).every((key) => ["agent", "task", "cwd", "model", "output", "worktree"].includes(key));
  };
  if (input["async"] !== false) return false;
  if (input["workflow"] === "parallel") {
    const args = input["args"];
    if (args === null || typeof args !== "object" || Array.isArray(args)) return false;
    const record = args as Record<string, unknown>;
    return Object.keys(input).every((key) => ["workflow", "args", "async", "cwd", "model", "output", "worktree"].includes(key)) &&
      Object.keys(record).every((key) => key === "tasks") &&
      Array.isArray(record["tasks"]) && record["tasks"].length > 0 && record["tasks"].every(task);
  }
  const { async: _async, ...single } = input;
  return task(single);
}

export async function childGuardrailRegistrar(): Promise<RegisterChildGuardrail> {
  // This is a public API of the immutable pi-subagents version in the image,
  // not an ambient host dependency or a process-global registry we fabricate.
  const apiPath = "/home/agent/.pi/agent/extensions/node_modules/pi-subagents/src/api/required-child-extensions.js";
  const api = await import(apiPath) as {
    registerRequiredChildExtensions(input: {
      sessionId: string; extensions: Array<{ id: string; path: string }>; requireForAllRunners: boolean;
    }): ChildGuardrailRegistration;
  };
  return (sessionId) => api.registerRequiredChildExtensions({
    sessionId,
    extensions: [{ id: "factory-continuity", path: new URL("./extension.js", import.meta.url).pathname }],
    requireForAllRunners: true,
  });
}
