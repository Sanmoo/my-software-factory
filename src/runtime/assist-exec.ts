import { shellQuote } from "../core/observability.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The container recipe of one assisted exec, the production form of the validated proof
// (ticket #52): the Herdr pane only ever hosts the `docker run` client; pi runs interactively
// inside the container with the explicit assist model; the container itself — not the pane, not
// an exit code seen anywhere else — records the real end of the exec in the mounted state dir
// (exit-record channel). Spec #48: never a silent host fallback; the tab does not supervise
// the exec and closing it does not stop anything by itself — proving the tab gone is what makes
// the supervision request the stop of the exec by its container name (ticket #56), never a
// presumed death of the process.
//
// This file is production code; the proof's pure logic (src/experiments/herdr-pi-proof/
// proof-logic.ts) deliberately shares nothing with it. The shapes below follow the recipe the
// proof validated, under the same arguments, and are covered by their own tests.

const NAME_SAFE = /^[a-z0-9-]+$/;

// Host directory with the container scripts the assisted exec mounts read-only as /msf-runtime
// (the same ADR 0002 scripts the implementation runtime uses).
export const runtimeImageDirOf = (): string => join(dirname(fileURLToPath(import.meta.url)), "docker-image");

// Container name of one assisted exec: derived from the session key, so supervision can reclaim
// by name from the record even when the pane/tab are gone (ticket #52's critical finding).
export function assistContainerName(key: string, startedAt: string): string {
  const slug = `${key}-${startedAt.slice(0, 10)}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (key.length === 0 || !NAME_SAFE.test(slug) || slug.length === 0) {
    throw new Error(`nome de container inválido para a sessão "${key}"`);
  }
  return `msf-assist-${slug}`;
}

export interface PiExecArgsInput {
  model: string; // the explicit assistModel; never inherited from the implementation models
  sessionDir: string; // inside the container (/msf-sessions)
  name: string; // `--name` of the pi session: one per exec
  prompt?: string; // first user turn; absent means pi opens idle at its prompt
  resume?: boolean; // continue the previous session of the same session dir (resume, #56)
}

// Interactive pi argv against the operator profile snapshot; never the non-interactive mode.
export function assistPiArgs(input: PiExecArgsInput): string[] {
  return [
    "--model", input.model,
    "--session-dir", input.sessionDir,
    "--name", input.name,
    "--tui-mode", "regular",
    ...(input.resume === true ? ["-c"] : []),
    ...(input.prompt === undefined ? [] : [input.prompt]),
  ];
}

export interface AssistExecCommandInput {
  name: string; // the container name; the supervision record's cleanup/identity key
  image: string;
  model: string;
  agentUidGid: string; // keeps artifacts' ownership with the host agent user
  startedAt: string; // ISO timestamp baked into the exit record
  cloneHostDir: string; // the operator's local clone, mounted writable at /work
  sessionsHostDir: string; // host pi sessions: the structured result channel
  stateHostDir: string; // host state of the exec: the exit-record channel
  snapshotHostDir: string; // profile snapshot, real files only (ADR 0002), read-only
  runtimeHostDir: string; // src/runtime/docker-image, the host-authored scripts, read-only
  // The profile's persistent toolchain (ADR 0004): the Pi package tree and the mise data dir, mounted
  // read-write so the convergence installs once and the next exec installs nothing.
  npmHostDir: string;
  miseHostDir: string;
  // What the convergence must confirm before the agent gets its prompt; a failure stops the exec with
  // its reason (the strict contract of ADR 0004).
  requiredPackages: readonly string[];
  requiredTools: readonly string[];
  prompt?: string;
  resume?: boolean;
}

// One command line, exactly what the flow gives `herdr pane run`: the docker CLI is the host
// client; the container prepares the snapshot per ADR 0002, converges the toolchain once (ADR 0004),
// confirms the required packages and tools, and runs interactive pi. The preparation steps are chained
// with `&&`: a convergence failure stops the invocation with its reason instead of starting the agent
// without what the profile declared. On the real end of the exec the wrapper writes the JSON exit
// record itself: Ctrl+C is delivered to the container's whole foreground group, so without the INT
// trap the wrapper shell dies with pi and the record is never written (observed in the #52 proof).
export function assistExecCommand(input: AssistExecCommandInput): string {
  const piArgs = assistPiArgs({
    model: input.model, sessionDir: "/msf-sessions", name: `msf-${input.name.slice("msf-assist-".length)}`,
    prompt: input.prompt, resume: input.resume,
  });
  const exitFormat = `{"exitCode":%s,"at":"${input.startedAt}"}`;
  // The first failing step decides the recorded exit code; pi only runs when all of them passed.
  const preparation = [
    "sh /msf-runtime/prepare-profile.sh /msf-profile",
    ["sh", "/msf-runtime/converge-profile.sh", "/msf-profile", ...input.requiredTools.map(shellQuote)].join(" "),
    ["sh", "/msf-runtime/check-profile.sh", ...input.requiredPackages.map(shellQuote)].join(" "),
    "pi " + piArgs.map(shellQuote).join(" "),
  ].join(" && ");
  const script = [
    "trap '' INT",
    `${preparation}; code=$?`,
    `printf ${shellQuote(exitFormat)} "$code" > /msf-state/msf-exit.json`,
    `echo "MSF_ASSIST_ENDED code=$code"`,
  ].join("; ");
  // --entrypoint sh: the image's ENTRYPOINT is `sleep infinity` (Sandcastle's docker exec), so a
  // bare `sh -c` would be consumed as sleep arguments (observed in the #52 proof).
  return [
    "docker run --rm -it --entrypoint sh --name", input.name, "--workdir /work --user", input.agentUidGid,
    `-v ${input.cloneHostDir}:/work`,
    `-v ${input.sessionsHostDir}:/msf-sessions`,
    `-v ${input.stateHostDir}:/msf-state`,
    `-v ${input.snapshotHostDir}:/msf-profile:ro`,
    `-v ${input.runtimeHostDir}:/msf-runtime:ro`,
    `-v ${input.npmHostDir}:/home/agent/.pi/agent/npm`,
    `-v ${input.miseHostDir}:/home/agent/.local/share/mise`,
    input.image, "-c", shellQuote(script),
  ].join(" ");
}

// Host file where the container writes the exit record; the only accepted proof that the exec
// inside the container really ended.
export const assistExitRecordPath = (stateHostDir: string): string => join(stateHostDir, "msf-exit.json");

export interface AssistExecExitRecord {
  exitCode: number;
  at: string;
}

// The only accepted proof the exec ended. Terminal text, a closed pane or a bare zero exit code
// seen anywhere else never counts (spec #48: encerrar o Pi não comprova o atendimento).
export function parseAssistExecExitRecord(text: string): AssistExecExitRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("registro de fim de execução assistida inválido: não é JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("registro de fim de execução assistida inválido: não é objeto");
  }
  const { exitCode, at } = parsed as Record<string, unknown>;
  if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    throw new Error("registro de fim de execução assistida inválido: exitCode");
  }
  if (typeof at !== "string" || at.length === 0) {
    throw new Error("registro de fim de execução assistida inválido: carimbo de tempo");
  }
  return { exitCode, at };
}
