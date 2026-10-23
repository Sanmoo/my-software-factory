import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/**
 * One shell for the Docker CLI, bounded: every call ends or fails within its
 * timeout, so a hung daemon never stalls the factory. The callers keep their
 * own intent — `state/liveness.ts` only reads, `runtime/worker-stop.ts` is the
 * one place that writes — and share the mechanics.
 *
 * A failure rejects with the daemon's OWN words on ONE line: execFile wraps
 * the command and its stderr in several lines, and every consumer (the log,
 * the stop evidence on disk, `msf status`) shows a single line.
 */
export async function runDocker(
  args: readonly string[],
  timeoutMs: number,
): Promise<string> {
  try {
    const { stdout } = await execFile("docker", [...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return stdout;
  } catch (error) {
    throw new Error(dockerReason(error));
  }
}

/** The most specific line of a failed Docker call: the last non-empty one of
 *  the daemon's stderr, or of execFile's message when there is no stderr. */
function dockerReason(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const source = typeof stderr === "string" && stderr.trim() !== "" ? stderr : errorMessage(error);
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.at(-1) ?? source;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
