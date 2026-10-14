// Pure logic of the Herdr + Pi-in-Docker assisted-session proof (ticket #52). The live half of
// the proof runs against real Docker and a real Herdr session; the rules here are the contract
// the live half must satisfy, under TDD. Spec decisions: #48 item 7 — this is a technical proof,
// not production code, and nothing in production imports from this module.

import { shellQuote } from "../../core/observability.js";

const NAME_SAFE = /^[a-z0-9-]+$/;

export function containerName(input: { slug: string; phase: string }): string {
  for (const [label, value] of [["slug", input.slug], ["fase", input.phase]] as const) {
    if (!NAME_SAFE.test(value)) throw new Error(`nome de container: ${label} inválido: "${value}"`);
  }
  return `msf-proof-${input.slug}-${input.phase}`;
}

export interface PiRunArgsInput {
  model: string;
  sessionDir: string; // inside the container (/msf-sessions)
  name: string; // pi session --name, one per exec
  prompt?: string; // first user turn; absent means pi opens idle at its prompt
  resume?: boolean; // continue the previous session of the same session dir
}

// Interactive pi argv, against the operator profile snapshot; never the non-interactive mode.
// Tools stay off so the marker replies cannot drift into approvals or tool plans.
export function piRunArgs(input: PiRunArgsInput): string[] {
  return [
    "--model", input.model,
    "--session-dir", input.sessionDir,
    "--name", input.name,
    "--tui-mode", "regular",
    "--no-tools", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-extensions",
    ...(input.resume === true ? ["-c"] : []),
    ...(input.prompt === undefined ? [] : [input.prompt]),
  ];
}

export interface ContainerCommandInput {
  name: string; // msf-proof-<slug>-<phase>: the cleanup key
  image: string;
  model: string; // the one explicit provider/model of the exec
  agentUidGid: string; // the host user the image was built for (keeps artifacts' ownership)
  phase: string;
  now: string; // ISO timestamp baked into the exit record
  cloneHostDir: string;
  sessionsHostDir: string;
  stateHostDir: string;
  snapshotHostDir: string; // profile snapshot, real files only (ADR 0002)
  runtimeHostDir: string; // src/runtime/docker-image, the host-authored scripts
  prompt?: string;
  resume?: boolean;
}

// One command line, exactly what `herdr pane run` types into the disposable tab: the docker CLI
// is the host client; the container runs the profile recipe and then interactive pi; and the
// container itself — not the pane, not a leftover exit code nor terminal text — records the real
// end of the exec in /msf-state/msf-exit-<phase>.json on the host mount.
export function containerCommand(input: ContainerCommandInput): string {
  const piArgs = piRunArgs({
    model: input.model, sessionDir: "/msf-sessions", name: `proof-${input.phase}`,
    prompt: input.prompt, resume: input.resume,
  });
  const exitFormat = `{"phase":"${input.phase}","exitCode":%s,"at":"${input.now}"}`;
  // Ctrl+C is delivered to the container's whole foreground group: without the INT trap the
  // wrapper shell dies with pi and the exit record is never written (observed 2026-10-13).
  const script = [
    "trap '' INT",
    "sh /msf-runtime/prepare-profile.sh /msf-profile",
    "sh /msf-runtime/check-profile.sh",
    "pi " + piArgs.map(shellQuote).join(" "),
    "code=$?",
    `printf ${shellQuote(exitFormat)} "$code" > /msf-state/msf-exit-${input.phase}.json`,
    `echo "PI_ENDED_${input.phase} code=$code"`,
  ].join("; ");
  // --entrypoint sh: the image's ENTRYPOINT is `sleep infinity` (Sandcastle's docker exec), so the
  // raw `sh -c` would be consumed as sleep arguments (observed 2026-10-13: sleep: invalid option).
  return [
    "docker run --rm -it --entrypoint sh --name", input.name, "--workdir /work --user", input.agentUidGid,
    `-v ${input.cloneHostDir}:/work`,
    `-v ${input.sessionsHostDir}:/msf-sessions`,
    `-v ${input.stateHostDir}:/msf-state`,
    `-v ${input.snapshotHostDir}:/msf-profile:ro`,
    `-v ${input.runtimeHostDir}:/msf-runtime:ro`,
    input.image, "-c", shellQuote(script),
  ].join(" ");
}

// Host file where the container writes the exit record; verified with parseExecExitRecord.
export function exitFileHostPath(stateHostDir: string, phase: string): string {
  return `${stateHostDir}/msf-exit-${phase}.json`;
}

export interface ExecExitRecord {
  phase: string;
  exitCode: number;
  at: string;
}

// The only accepted proof that the exec inside the container really ended: the JSON line the
// container wrote to the mounted state dir. Terminal text, a closed pane or a raw zero exit
// code seen anywhere else never counts (spec #48: encerrar o Pi não comprova o atendimento).
export function parseExecExitRecord(text: string): ExecExitRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("registro de fim de execução inválido: não é JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("registro de fim de execução inválido: não é objeto");
  }
  const { phase, exitCode, at } = parsed as Record<string, unknown>;
  if (typeof phase !== "string" || phase.length === 0 || !NAME_SAFE.test(phase)) {
    throw new Error("registro de fim de execução inválido: fase");
  }
  if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    throw new Error("registro de fim de execução inválido: exitCode");
  }
  if (typeof at !== "string" || at.length === 0) {
    throw new Error("registro de fim de execução inválido: carimbo de tempo");
  }
  return { phase, exitCode, at };
}

export function writeExecExitRecord(input: ExecExitRecord): string {
  return JSON.stringify(input);
}

// Identity of one assisted exec, written to disk so supervision can end (machine restart, lost
// pane) and the same exec can still be rediscovered: same session, same area, same container.
export interface ExecSupervisionRecord {
  slug: string;
  phase: string;
  label: string; // the disposable tab's label
  workspaceId: string;
  tabId: string;
  paneId: string;
  containerName: string;
  containerId?: string;
  image: string;
  model: string;
  clientPid?: number;
  clientCmdline?: string;
  sessionsDir: string; // host side, holds the Pi session JSONL
  cloneDir: string; // the disposable clone on the host
  exitFileHostPath: string;
  startedAt: string;
}

export interface ExecObservation {
  tabExists: boolean;
  paneExists: boolean;
  containerRunning: boolean;
  containerIdMatches: boolean | null; // null: could not observe
  piInsideContainer: boolean | null; // null: could not observe
  dockerClientInPane: boolean | null; // null: could not observe
}

export type ExecState = "live-exec" | "exec-ended" | "supervision-mismatch";

export interface ExecVerdict {
  state: ExecState;
  orphaned: boolean; // live but no pane/tab knows about it: the recovery case
  reasons: string[];
}

// Classification of one exec from its record plus fresh observation. This is the state of the
// exec, never the state of the work: ending the exec does not conclude the attendance.
export function classifyExec(record: ExecSupervisionRecord, observed: ExecObservation): ExecVerdict {
  if (!observed.containerRunning) {
    return {
      state: "exec-ended",
      orphaned: false,
      reasons: [
        "o container não está mais em execução; é a observação do docker, por identidade, que termina o exec; " +
        "estado de pane, texto do terminal ou código de saída avulso não provam nada",
      ],
    };
  }
  if (observed.containerIdMatches !== true || record.containerId === undefined) {
    return {
      state: "supervision-mismatch",
      orphaned: false,
      reasons: ["a identidade do container em execução não confere com o registro; pedir intervenção"],
    };
  }
  if (observed.piInsideContainer === null) {
    return {
      state: "supervision-mismatch",
      orphaned: false,
      reasons: ["não foi possível observar o processo do pi dentro do container"],
    };
  }
  if (observed.piInsideContainer === false) {
    return {
      state: "exec-ended",
      orphaned: false,
      reasons: ["container em execução sem o processo do pi: execução encerrada, resultado ainda por verificar"],
    };
  }
  const knownToPane = observed.tabExists && observed.paneExists && observed.dockerClientInPane === true;
  return {
    state: "live-exec",
    orphaned: !knownToPane,
    reasons: knownToPane
      ? ["execução viva acompanhada pela aba/pane e pelo cliente docker"]
      : ["execução viva sem aba/pane a acompanhar: o caso de perdida supervisão e de execução órfã"],
  };
}

// Every assistant message of the Pi session file, in order, as the container wrote it into the
// read-only host mount. This is the structured surface that survives the exec's death, unlike
// pane text, and it is machine-readable.
export function assistantTexts(jsonl: string): string[] {
  const texts: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const { type, message } = entry as { type?: unknown; message?: unknown };
    if (type !== "message" || typeof message !== "object" || message === null) continue;
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role !== "assistant" || !Array.isArray(content)) continue;
    texts.push(content
      .filter((part): part is { type: string; text: string } =>
        typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text")
      .map((part) => part.text ?? "")
      .join("\n"));
  }
  return texts;
}

// The structured result surface: the last assistant message of the Pi session file.
export function lastAssistantText(jsonl: string): string {
  return assistantTexts(jsonl).at(-1) ?? "";
}
