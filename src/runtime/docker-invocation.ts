import { join } from "node:path";
import { shellQuote } from "../core/observability.js";
import type { RunKind } from "./runner.js";

// Invocation rules of the Docker runner. Kept pure so the limits and the Sandcastle
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
// The converged toolchain of the profile, persistent across invocations (ADR 0004): the Pi package
// tree installed from the operator's lock, and the mise data dir (installs, cache and state).
export const SANDBOX_NPM_DIR = "/home/agent/.pi/agent/npm";
export const SANDBOX_MISE_DATA_DIR = "/home/agent/.local/share/mise";
// The operator's mise declaration rides the read-only profile snapshot: the image reads it from
// <snapshot>/mise (MISE_CONFIG_DIR), so nothing of the host is mounted for it.
export const PROFILE_NPM_STAMP = ".msf-stamp";

// Where the persistent toolchain of one runtime profile lives on the host: under the factory's `--home`,
// keyed by the profile name and shared by every instance and job that names that profile. The container
// mounts these as binds (never a named volume: a fresh named volume is root-owned, ADR 0004).
export interface ProfileToolchain {
  base: string;
  npm: string;
  mise: string;
}

export function profileToolchain(toolchainsDir: string, profile: string): ProfileToolchain {
  const base = join(toolchainsDir, encodeURIComponent(profile));
  return { base, npm: join(base, "npm"), mise: join(base, "mise") };
}

// What the container mounts (ADR 0002, ADR 0004): the profile snapshot and the image scripts read-only,
// the Pi session read-write, and the profile's persistent toolchain (package tree and mise data dir)
// read-write. The work area is the cwd Sandcastle bind-mounts. The operator's profile directory, the
// roots its links lead to, and anything installed on the host are not mounted.
export function sandboxMounts(
  input: { snapshotDir: string; sessionsDir: string; npmDir: string; miseDir: string },
  imageDir: string,
) {
  return [
    { hostPath: input.snapshotDir, sandboxPath: SANDBOX_PROFILE_DIR, readonly: true },
    { hostPath: imageDir, sandboxPath: SANDBOX_RUNTIME_DIR, readonly: true },
    { hostPath: input.sessionsDir, sandboxPath: SANDBOX_SESSIONS_DIR, readonly: false },
    { hostPath: input.npmDir, sandboxPath: SANDBOX_NPM_DIR, readonly: false },
    { hostPath: input.miseDir, sandboxPath: SANDBOX_MISE_DATA_DIR, readonly: false },
  ];
}

// One command, because Sandcastle runs the hooks of a sandbox concurrently: the snapshot is copied into
// the writable Pi directory first, then the toolchain converges once (Pi packages from the lock, mise
// tools from the operator's declaration) and the required packages and tools are confirmed. Every step
// is strict: a failure stops the invocation with its reason before the agent receives the prompt.
export function profileSetupCommand(input: { requiredPackages: readonly string[]; requiredTools: readonly string[] }): string {
  const prepare = `sh ${SANDBOX_RUNTIME_DIR}/prepare-profile.sh ${SANDBOX_PROFILE_DIR}`;
  // The declaration is read from the read-only snapshot itself (<snapshot>/mise as MISE_CONFIG_DIR).
  const converge = ["sh", `${SANDBOX_RUNTIME_DIR}/converge-profile.sh`, SANDBOX_PROFILE_DIR, ...input.requiredTools.map(shellQuote)].join(" ");
  const check = ["sh", `${SANDBOX_RUNTIME_DIR}/check-profile.sh`, ...input.requiredPackages.map(shellQuote)].join(" ");
  return `${prepare} && ${converge} && ${check}`;
}
