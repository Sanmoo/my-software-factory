import { shellQuote } from "../core/observability.js";
import type { RunKind } from "./runner.js";

// Invocation rules of the Docker runner (R08). Kept pure so the limits and the Sandcastle
// options can be tested without Docker.

// Completion signal emitted after the structured result (see docker-output.ts).
export const COMPLETION_SIGNAL = "<promise>MSF-RESULT</promise>";

// A new invocation may run up to the configured Sandcastle iterations. A resume or a
// correction is always one iteration: Sandcastle 0.12.0 requires one iteration with resumeSession.
export function effectiveIterationLimit(kind: RunKind, configured: number): number {
  if (!Number.isSafeInteger(configured) || configured < 1) {
    throw new RangeError(`maxIterations deve ser inteiro positivo, recebido ${configured}`);
  }
  return kind === "new" ? configured : 1;
}

export interface SandcastleRequest {
  readonly prompt: string;
  readonly maxIterations: number;
  readonly resumeSession?: string;
  readonly completionSignal: string;
}

export function sandcastleRequest(input: {
  kind: RunKind;
  prompt: string;
  configuredLimit: number;
  sessionId?: string;
}): SandcastleRequest {
  const maxIterations = effectiveIterationLimit(input.kind, input.configuredLimit);
  if (input.kind === "new") {
    if (input.sessionId !== undefined) throw new Error("invocação nova não retoma sessão existente");
    return { prompt: input.prompt, maxIterations, completionSignal: COMPLETION_SIGNAL };
  }
  if (input.sessionId === undefined) {
    throw new Error("retomada sem sessão Pi registrada: não iniciar conversa nova");
  }
  return {
    prompt: input.prompt,
    maxIterations,
    resumeSession: input.sessionId,
    completionSignal: COMPLETION_SIGNAL,
  };
}

// Where things are inside the container.
export const SANDBOX_PROFILE_DIR = "/msf-profile";
export const SANDBOX_RUNTIME_DIR = "/msf-runtime";
export const SANDBOX_SESSIONS_DIR = "/home/agent/.pi/agent/sessions";

// What the container mounts (ADR 0002): the profile snapshot and the image scripts read-only, the Pi session
// read-write. The work area is the cwd Sandcastle bind-mounts. The operator's profile directory and the roots
// its links lead to are not mounted: what they held was resolved on the host.
export function sandboxMounts(input: { snapshotDir: string; sessionsDir: string }, imageDir: string) {
  return [
    { hostPath: input.snapshotDir, sandboxPath: SANDBOX_PROFILE_DIR, readonly: true },
    { hostPath: imageDir, sandboxPath: SANDBOX_RUNTIME_DIR, readonly: true },
    { hostPath: input.sessionsDir, sandboxPath: SANDBOX_SESSIONS_DIR, readonly: false },
  ];
}

// One command, because Sandcastle runs the hooks of a sandbox concurrently: the snapshot is copied into the
// writable Pi directory first, then the packages are installed and the required ones confirmed. A failure
// stops the invocation with its reason before the agent receives the prompt.
export function profileSetupCommand(requiredPackages: readonly string[]): string {
  const check = ["sh", `${SANDBOX_RUNTIME_DIR}/check-profile.sh`, ...requiredPackages.map(shellQuote)].join(" ");
  return `sh ${SANDBOX_RUNTIME_DIR}/prepare-profile.sh ${SANDBOX_PROFILE_DIR} && ${check}`;
}
