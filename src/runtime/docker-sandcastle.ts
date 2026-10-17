import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { pi, run, type AgentStreamEvent } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { profileSetupCommand, sandboxMounts } from "./docker-invocation.js";
import { parseEvent, type PiEvent } from "./pi-events.js";
import type { SandboxBoundary } from "./docker-runner.js";
import { installConsoleFilter, SandcastleLineFilter } from "./sandcastle-console.js";

// The only place that starts Docker, Pi and Sandcastle. Thin on purpose: the decisions
// live in docker-runner.ts and the pure modules. There is no noSandbox option anywhere.

const execFileAsync = promisify(execFile);
const IMAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "docker-image");
// Converging the profile's toolchain is a cold start on the first invocation of a profile (the Pi
// packages plus the declared mise tools); every later invocation probes and finds it converged.
const PROFILE_SETUP_TIMEOUT_MS = 10 * 60 * 1000;
const sandcastleLines = new SandcastleLineFilter();

async function preflight(input: { image: string; account: string }): Promise<{ token: string }> {
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
  let token: string;
  try {
    // The named project account is the ONLY source of the credential: `GH_TOKEN`/`GITHUB_TOKEN`
    // are removed from the environment of this call (the same hygiene as the tracker's boundary,
    // src/tracker/github.ts), so `gh auth token --user` is answered by the account's stored
    // credential — never by the ambient one — and no fallback to another account is attempted.
    const env = { ...process.env };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    const { stdout } = await execFileAsync("gh", ["auth", "token", "--user", input.account], { encoding: "utf8", env });
    token = stdout.trim();
  } catch {
    throw new Error(`gh has no token for account ${input.account}; the project account is the only source — no fallback to another account.`);
  }
  if (token === "") {
    throw new Error(`gh returned an empty token for account ${input.account}; the project account is the only source — no fallback to another account.`);
  }
  return { token };
}

// Asks the image itself, without starting the agent: the entrypoint is replaced for this one command.
async function imageHas(image: string, command: string): Promise<boolean> {
  try {
    await execFileAsync("docker", ["run", "--rm", "--entrypoint", "sh", image, "-c", `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
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

export function sandcastleBoundary(): SandboxBoundary {
  return {
    preflight,
    imageHas,
    async run(input) {
      await mkdir(input.sessionsDir, { recursive: true });
      const events: PiEvent[] = [];
      // The dependency's own log (setup, its warnings) is one file per invocation and is thrown away
      // at the end; the readable activity is the runner's detailed log, fed by the raw lines below.
      // Its "tail -f" announcement is kept off the terminal while this invocation runs.
      await mkdir(dirname(input.runtimeLogPath), { recursive: true });
      installConsoleFilter(sandcastleLines);
      const unregister = sandcastleLines.register(input.runtimeLogPath);
      const timer = setInterval(() => input.activity.checkIdle(), Math.min(input.idleWarningSeconds, 5) * 1000);
      timer.unref();
      let result;
      try {
        result = await run({
          agent: agentFor(input.model, input.sessionsDir),
          sandbox: docker({
            imageName: input.image,
            env: { GH_TOKEN: input.token },
            mounts: sandboxMounts(input, IMAGE_DIR),          }),
          cwd: input.cwd,
          branchStrategy: { type: "head" },
          prompt: input.request.prompt,
          maxIterations: input.request.maxIterations,
          resumeSession: input.request.resumeSession,
          completionSignal: input.request.completionSignal,
          idleTimeoutSeconds: input.idleTimeoutSeconds,
          hooks: {
            sandbox: {
              onSandboxReady: [{
                command: profileSetupCommand({ requiredPackages: input.requiredPackages, requiredTools: input.requiredTools }),
                timeoutMs: PROFILE_SETUP_TIMEOUT_MS,
              }],
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
        unregister();
        await rm(input.runtimeLogPath, { force: true });
      }
      const sessionId = result.iterations.at(-1)?.sessionId ?? result.iterations[0]?.sessionId;
      return { sessionId, completed: result.completionSignal !== undefined, iterations: result.iterations.length, events };
    },
  };
}
