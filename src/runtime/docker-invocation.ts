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
