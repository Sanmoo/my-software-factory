import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { pi, run, type AgentStreamEvent } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { parseEvent, type PiEvent } from "./pi-events.js";
import type { SandboxBoundary, SandboxRun } from "./docker-runner.js";

// The only place that starts Docker, Pi and Sandcastle (R06). Thin on purpose: the decisions
// live in docker-runner.ts and the pure modules. There is no noSandbox option anywhere.

const execFileAsync = promisify(execFile);
const IMAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "docker-image");
const SANDBOX_SESSIONS_DIR = "/home/agent/.pi/agent/sessions";
const SANDBOX_PROFILE_SCRIPT = "/msf-runtime/prepare-profile.sh";
const exists = (path: string) => access(path).then(() => true, () => false);

async function preflight(input: { image: string; profileDir: string; account: string }): Promise<{ token: string }> {
  try {
    await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"]);
  } catch {
    throw new Error("Docker is unavailable (docker info failed). Refusing to run outside the sandbox.");
  }
  try {
    await execFileAsync("docker", ["image", "inspect", input.image]);
  } catch {
    throw new Error(`Image ${input.image} is missing. Build it with: docker build --build-arg AGENT_UID=$(id -u) --build-arg AGENT_GID=$(id -g) -t ${input.image} src/runtime/docker-image`);
  }
  if (!(await exists(join(input.profileDir, "auth.json"))) || !(await exists(join(input.profileDir, "settings.json")))) {
    throw new Error(`Operator Pi profile is incomplete at ${input.profileDir} (auth.json or settings.json missing); refusing to run.`);
  }
  let token: string;
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token", "--user", input.account], { encoding: "utf8" });
    token = stdout.trim();
  } catch {
    throw new Error(`gh has no token for account ${input.account}; the active gh account is not changed to fix this.`);
  }
  if (token === "") throw new Error(`gh returned an empty token for account ${input.account}`);
  return { token };
}

// Pi with the flags the spike proved (print mode, no MCP, the tools /implement needs). The
// Pi session is written to the host through the sessionStorage mount, outside the container.
function agentFor(model: string, sessionsDir: string) {
  const base = pi(model, {
    thinking: "minimal",
    captureSessions: false,
    env: { PI_CODING_AGENT_DIR: "/home/agent/.pi/agent" },
    sessionStorage: { hostSessionsDir: sessionsDir },
  });
  return {
    ...base,
    buildPrintCommand(options: Parameters<typeof base.buildPrintCommand>[0]) {
      const command = base.buildPrintCommand(options);
      return {
        ...command,
        command: command.command
          + " --approve --no-context-files --no-prompt-templates --no-mcp"
          + " --tools read,bash,edit,write,subagent,subagents_enable"
          + " --exclude-tools 'mcp__*,mcp'",
      };
    },
  };
}

// Mounts: the operator's Pi profile and agents root read-only at their host paths (the profile's
// symlinks resolve identically), the runner image scripts read-only, and the session directory
// read-write. The work area is the cwd Sandcastle bind-mounts. Work-account roots are not mounted.
async function mountsFor(input: SandboxRun) {
  const mounts = [
    { hostPath: input.profileDir, sandboxPath: input.profileDir, readonly: true },
    { hostPath: IMAGE_DIR, sandboxPath: "/msf-runtime", readonly: true },
    { hostPath: input.sessionsDir, sandboxPath: SANDBOX_SESSIONS_DIR, readonly: false },
  ];
  const agentsRoot = join(homedir(), ".agents");
  if (await exists(agentsRoot)) mounts.push({ hostPath: agentsRoot, sandboxPath: agentsRoot, readonly: true });
  return mounts;
}

export function sandcastleBoundary(): SandboxBoundary {
  return {
    preflight,
    async run(input) {
      await mkdir(input.sessionsDir, { recursive: true });
      const events: PiEvent[] = [];
      // The dependency's own log (setup, its warnings) is one file per invocation; the readable
      // activity is the runner's detailed log, fed by the raw lines below.
      await mkdir(dirname(input.runtimeLogPath), { recursive: true });
      const timer = setInterval(() => input.activity.checkIdle(), Math.min(input.idleWarningSeconds, 5) * 1000);
      timer.unref();
      let result;
      try {
        result = await run({
          agent: agentFor(input.model, input.sessionsDir),
          sandbox: docker({
            imageName: input.image,
            env: { GH_TOKEN: input.token },
            mounts: await mountsFor(input),
          }),
          cwd: input.cwd,
          branchStrategy: { type: "head" },
          prompt: input.request.prompt,
          maxIterations: input.request.maxIterations,
          resumeSession: input.request.resumeSession,
          completionSignal: input.request.completionSignal,
          idleTimeoutSeconds: input.idleTimeoutSeconds,
          hooks: {
            sandbox: {
              onSandboxReady: [{ command: `sh ${SANDBOX_PROFILE_SCRIPT} ${input.profileDir}` }],
            },
          },
          logging: {
            type: "file",
            path: input.runtimeLogPath,
            onAgentStreamEvent(event: AgentStreamEvent) {
              if (event.type !== "raw") return;
              input.activity.line(event.line);
              const parsed = parseEvent(event.line);
              if (parsed) events.push(parsed);
            },
          },
        });
      } finally {
        clearInterval(timer);
        // The dependency writes its own log as it likes; once the run is over, known credentials are
        // taken out of it too. It is not redacted while the run is live (a limit of the dependency).
        try {
          const text = await readFile(input.runtimeLogPath, "utf8");
          const clean = input.redact(text);
          if (clean !== text) await writeFile(input.runtimeLogPath, clean, { mode: 0o600 });
        } catch {
          // No runtime log (the run failed before it): nothing to clean.
        }
      }
      const sessionId = result.iterations.at(-1)?.sessionId ?? result.iterations[0]?.sessionId;
      return { sessionId, completed: result.completionSignal !== undefined, iterations: result.iterations.length, events };
    },
  };
}
