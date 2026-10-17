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
// The converged toolchain, persistent across invocations (ADR 0004): the Pi package tree installed from
// the operator's lock (per profile) and the mise data dir — installs, downloads, cache and state — which
// is SHARED by every profile of the `--home` (spec #74).
export const SANDBOX_NPM_DIR = "/home/agent/.pi/agent/npm";
export const SANDBOX_MISE_DATA_DIR = "/home/agent/.local/share/mise";
// The operator's mise declaration rides the read-only profile snapshot: the image reads it from
// <snapshot>/mise (MISE_CONFIG_DIR), so nothing of the host is mounted for it.
export const PROFILE_NPM_STAMP = ".msf-stamp";

// The directory name of the shared mise data dir under the toolchains root.
export const SHARED_MISE_DIR = "mise";

// Where the persistent toolchain lives on the host, under the factory's `--home` (ADR 0004, spec #74).
// It has two lifetimes, deliberately:
// - the Pi package tree is PER PROFILE (`<toolchains>/<perfil>/npm`), keyed by the profile name and
//   shared by every instance and job that names that profile: profiles declare different packages;
// - the mise data dir (installs, downloads, cache and state) is SHARED by all profiles
//   (`<toolchains>/mise`), one dir for the whole `--home`: the tools converge once for every profile
//   that declares them, and the same flock serializes the convergence of all of them.
// The container mounts these as binds (never a named volume: a fresh named volume is root-owned).
export interface ProfileToolchain {
  // The profile's own directory: the package tree lives here and nowhere else.
  base: string;
  npm: string;
  // Shared by every profile of this `--home`; never under `base`.
  mise: string;
}

export function profileToolchain(toolchainsDir: string, profile: string): ProfileToolchain {
  const base = join(toolchainsDir, encodeURIComponent(profile));
  return { base, npm: join(base, "npm"), mise: join(toolchainsDir, SHARED_MISE_DIR) };
}

// What the container mounts (ADR 0002, ADR 0004): the profile snapshot and the image scripts read-only,
// the Pi session read-write, and the persistent toolchain read-write — the profile's package tree and the
// mise data dir shared by every profile. The work area is the cwd Sandcastle bind-mounts. The operator's
// profile directory, the roots its links lead to, and anything installed on the host are not mounted.
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

// The ordered preparation steps of one profile inside the container, from the read-only snapshot to the
// confirmed toolchain. ONE builder, because the autonomous runner appends nothing and the assisted exec
// appends `pi`: a renamed script or a changed argument order has to be edited here only, and both public
// commands keep composing over the same steps (they chain them with `&&`).
export function profilePreparationSteps(input: { requiredPackages: readonly string[]; requiredTools: readonly string[] }): string[] {
  return [
    `sh ${SANDBOX_RUNTIME_DIR}/prepare-profile.sh ${SANDBOX_PROFILE_DIR}`,
    // The declaration is read from the read-only snapshot itself (<snapshot>/mise as MISE_CONFIG_DIR).
    ["sh", `${SANDBOX_RUNTIME_DIR}/converge-profile.sh`, SANDBOX_PROFILE_DIR, ...input.requiredTools.map(shellQuote)].join(" "),
    ["sh", `${SANDBOX_RUNTIME_DIR}/check-profile.sh`, ...input.requiredPackages.map(shellQuote)].join(" "),
  ];
}

// One command, because Sandcastle runs the hooks of a sandbox concurrently: the snapshot is copied into
// the writable Pi directory first, then the toolchain converges once (Pi packages from the lock, mise
// tools from the operator's declaration) and the required packages and tools are confirmed. Every step
// is strict: a failure stops the invocation with its reason before the agent receives the prompt.
export function profileSetupCommand(input: { requiredPackages: readonly string[]; requiredTools: readonly string[] }): string {
  return profilePreparationSteps(input).join(" && ");
}
