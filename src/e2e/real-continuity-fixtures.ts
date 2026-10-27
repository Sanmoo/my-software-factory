import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { AgentProvider, PiOptions } from "@ai-hero/sandcastle";

import {
  DEFAULT_LABELS,
  DEFAULT_LIVENESS_POLICY,
  DEFAULT_MODEL_PROVIDER_BUDGET,
  DEFAULT_RECOVERY_BUDGET,
  DEFAULT_RETRO,
  type Config,
} from "../config.js";
import type { WorkspaceLayout } from "../layout.js";
import { GUARDRAIL_CONTAINER_MODULES, SandcastleRuntime } from "../runtime/sandcastle.js";
import { WORKER_IMAGE } from "../worker-image.js";

const ENABLED = process.env["MSF_REQUIRE_DOCKER"] === "1";

interface MissingPrerequisite {
  reason: string;
}

function missingPrerequisite(): MissingPrerequisite | null {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" });
  } catch {
    return { reason: "docker is not reachable — the real continuity proof needs the daemon" };
  }
  try {
    execFileSync("docker", ["image", "inspect", WORKER_IMAGE], { stdio: "ignore" });
  } catch {
    return { reason: `the worker image ${WORKER_IMAGE} is not built — run npm run build:image` };
  }
  try {
    // The tag alone is not the prerequisite: this proof reads the session the
    // in-container guardrail journals, and the runtime refuses to launch an
    // image without it. Check EVERY module the guardrail loads, exactly as the
    // launch preflight does, so a half-staged image reports itself instead of
    // failing mid-proof.
    execFileSync(
      "docker",
      ["run", "--rm", "--network", "none", "--entrypoint", "sh", WORKER_IMAGE, "-c",
        GUARDRAIL_CONTAINER_MODULES.map((path) => `test -f ${path}`).join(" && ")],
      { stdio: "ignore" },
    );
  } catch {
    return {
      reason: `the worker image ${WORKER_IMAGE} is missing a continuity guardrail module (${GUARDRAIL_CONTAINER_MODULES.join(", ")}) — run npm run build:image`,
    };
  }
  return null;
}

export const continuitySkipReason = (() => {
  const missing = missingPrerequisite();
  if (missing === null) return undefined;
  if (ENABLED) throw new Error(`real continuity proof explicitly required but a prerequisite is missing: ${missing.reason}`);
  return `${missing.reason} (the gateway sets MSF_REQUIRE_DOCKER=1, where this proof is mandatory)`;
})();

/** Is this process inside a container? Then host paths and container paths differ. */
function insideContainer(): boolean {
  return existsSync("/.dockerenv") && existsSync("/run/.containerenv") === false;
}

/**
 * The one directory this process and the host daemon see at the SAME absolute
 * path, so the worker's binds need no translation. On the operator's host that
 * is the temp dir; inside a worker container the container's own `/tmp` is not
 * on the host, and the daemon would resolve every path the runtime hands it to
 * an empty root-owned directory (ADR 0003). Sandcastle mounts the repository's
 * git common dir at its own host path in every worker (so git works inside),
 * which makes the scratch tree under it visible to both sides under one name.
 *
 * The function proves the property instead of assuming it: the candidate must
 * be an existing bind whose Source IS its Destination.
 */
export function hostVisibleBase(): string {
  const override = process.env["MSF_CONTINUITY_ROOT"];
  if (override !== undefined && override !== "") return override;
  if (!insideContainer()) return tmpdir();
  const raw = execFileSync("docker", ["inspect", "--format", "{{json .Mounts}}", hostname()], { encoding: "utf8" });
  const mounts = parseDocker<Array<{ Type: string; Source: string; Destination: string }>>(raw);
  const strip = (path: string): string => path.replace(/\/$/, "");
  const identityDirs = mounts
    .filter((mount) => mount.Type === "bind" && strip(mount.Source) === strip(mount.Destination))
    .map((mount) => strip(mount.Source));
  const gitCommonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  }).trim();
  const underIdentity = identityDirs.some((dir) => gitCommonDir === dir || gitCommonDir.startsWith(`${dir}/`));
  for (const candidate of underIdentity ? [gitCommonDir, ...identityDirs] : identityDirs) {
    try {
      const probe = mkdtempSync(join(candidate, "msf-continuity-probe-"));
      rmSync(probe, { recursive: true, force: true });
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(
    "no directory is visible to the host daemon at this process's own path — the proof cannot hand the worker " +
      "a bind the daemon resolves; set MSF_CONTINUITY_ROOT to such a directory (the value must be the host path too)",
  );
}

/** The address a sibling container dials to reach this process. */
export function bridgeAddress(): string {
  if (insideContainer()) {
    const raw = execFileSync("docker", ["inspect", "--format", "{{json .NetworkSettings.Networks}}", hostname()], { encoding: "utf8" });
    const networks = parseDocker<Record<string, { IPAddress?: string }>>(raw);
    const bridge = networks["bridge"] ?? Object.values(networks)[0];
    if (bridge?.IPAddress === undefined || bridge.IPAddress === "") {
      throw new Error("this container has no bridge address — a sibling worker could not reach the deterministic model");
    }
    return bridge.IPAddress;
  }
  const gateway = execFileSync(
    "docker",
    ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"],
    { encoding: "utf8" },
  ).trim();
  if (gateway === "") throw new Error("the docker bridge has no gateway — a sibling worker could not reach the model");
  return gateway;
}


/**
 * Poll the bare remote until the worker pushed the branch, then find its
 * container. The attempt's own event log is watched too: a session that FAILED
 * before the push (a broken image, a refused flag) is reported with its reason
 * instead of waiting out the deadline.
 */
export async function waitForPushThenFindWorker(
  remotePath: string,
  branch: string,
  hostWorkDir: string,
  eventLog: string,
): Promise<string> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const failure = readSessionFailure(eventLog);
    if (failure !== null) throw new Error(`the worker session failed before the push: ${failure}`);
    const pushed = execFileSync("git", ["--git-dir", remotePath, "for-each-ref", `refs/heads/${branch}`], { encoding: "utf8" }).trim();
    if (pushed !== "") {
      const container = findWorkerContainer(hostWorkDir);
      if (container !== null) return container;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the worker never pushed the branch (or its container was not observable)");
}

/** The reason of a `session-failed` event in the attempt's log, if any. */
function readSessionFailure(eventLog: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(eventLog, "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(line) as { event?: string; reason?: string };
      if (entry.event === "session-failed") return entry.reason ?? "no reason recorded";
    } catch {
      continue;
    }
  }
  return null;
}

/** The live container of THIS work: its /msf-work bind points at our work dir. */
function findWorkerContainer(hostWorkDir: string): string | null {
  const ids = execFileSync("docker", ["ps", "-q", "--filter", `ancestor=${WORKER_IMAGE}`], { encoding: "utf8" })
    .split("\n")
    .filter((id) => id !== "");
  for (const id of ids) {
    let raw: string;
    try {
      raw = execFileSync("docker", ["inspect", "--format", "{{json .Mounts}}", id], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      // Other gateway tests remove their containers between ps and inspect.
      if (/no such (object|container)/i.test(String((error as { stderr?: unknown }).stderr))) continue;
      throw error;
    }
    const mounts = parseDocker<Array<{ Source: string; Destination: string }>>(raw);
    if (mounts.some((mount) => mount.Destination === "/msf-work" && mount.Source === hostWorkDir)) return id;
  }
  return null;
}

function parseDocker<T>(raw: string): T {
  try { return JSON.parse(raw) as T; }
  catch { throw new Error("Docker returned invalid JSON in the continuity proof"); }
}

export function killContainer(id: string): void {
  execFileSync("docker", ["kill", id], { stdio: "ignore" });
}

/**
 * The session file of one id under the workspace's sessions dir, or null when
 * the launch left none. The tree is walked for the id, so the provider's own
 * directory layout is not a contract of the proof.
 */
export function findSession(sessionsDir: string, sessionId: string): string | null {
  try {
    const found = execFileSync("find", [sessionsDir, "-type", "f", "-name", `*_${sessionId}.jsonl`], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((entry) => entry !== "");
    return found[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The deterministic provider's agent config, written where the runtime mounts
 * it. No personal Pi profile is snapshotted: the fixture hands over exactly the
 * one file the model needs, and its key is the literal inside it.
 */
export function writeDeterministicModelConfig(hostPath: string, baseUrl: string): void {
  mkdirSync(dirname(hostPath), { recursive: true });
  writeFileSync(
    hostPath,
    JSON.stringify(
      {
        providers: {
          deterministico: {
            name: "Deterministic",
            baseUrl,
            api: "openai-completions",
            apiKey: "no-credits",
            models: [
              {
                id: "roteiro",
                name: "Deterministic script",
                reasoning: false,
                input: ["text"],
                contextWindow: 200000,
                maxTokens: 8192,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

/** The Config a continuity proof's factory runs: one repository, no Jira
 *  selection, no notification, and recovery waits that never sleep. */
export function continuityProofConfig(input: {
  workspace: WorkspaceLayout;
  repo: string;
  configPath: string;
}): Config {
  return {
    workerGhAccount: "bot-do-samuca",
    workerModel: "deterministico/roteiro",
    jira: [],
    repos: [input.repo],
    concurrency: 1,
    workspace: input.workspace.root,
    labels: { ...DEFAULT_LABELS },
    workerAuthFile: null,
    recovery: { ...DEFAULT_RECOVERY_BUDGET, waitsMs: [0, 0, 0] },
    liveness: { ...DEFAULT_LIVENESS_POLICY },
    retro: { ...DEFAULT_RETRO },
    modelProvider: { ...DEFAULT_MODEL_PROVIDER_BUDGET },
    notifications: false,
    configPath: input.configPath,
  };
}

/** The production runtime of a continuity proof: the deterministic model is
 *  supplied EXPLICITLY and no ambient provider variable rides the launch. The
 *  token only satisfies the runtime's precondition — the proof's script uses no
 *  GitHub credential. */
export function continuityProofRuntime(input: {
  workspace: WorkspaceLayout;
  modelsFile: string;
  token: string;
  piProvider?: (model: string, options?: PiOptions) => AgentProvider;
}): SandcastleRuntime {
  return new SandcastleRuntime({
    model: "deterministico/roteiro",
    token: input.token,
    image: WORKER_IMAGE,
    agentFiles: [{ name: "models.json", hostPath: input.modelsFile }],
    authEnv: {},
    workspace: input.workspace.root,
    idleTimeoutSeconds: 120,
    activityPollMs: 100,
    ...(input.piProvider === undefined ? {} : { piProvider: input.piProvider }),
  });
}
