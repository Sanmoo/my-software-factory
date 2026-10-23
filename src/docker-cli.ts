import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/**
 * One shell for the Docker CLI, bounded: every call ends or fails within its
 * timeout, so a hung daemon never stalls the factory. The callers keep their
 * own intent — `state/liveness.ts` only reads, `runtime/worker-stop.ts` is the
 * one place that writes — and share the mechanics.
 */
export async function runDocker(
  args: readonly string[],
  timeoutMs: number,
): Promise<string> {
  const { stdout } = await execFile("docker", [...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return stdout;
}
