import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STOP_REQUEST_FILENAME = "parar.json";

export function requestWorkerStop(workDir: string, sessionId: string): void {
  const file = join(workDir, STOP_REQUEST_FILENAME);
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ version: 1, sessionId }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
}

export function clearWorkerStop(workDir: string): void {
  rmSync(join(workDir, STOP_REQUEST_FILENAME), { force: true });
}

export function workerStopRequested(workDir: string, sessionId: string): boolean {
  const file = join(workDir, STOP_REQUEST_FILENAME);
  if (!existsSync(file)) return false;
  try {
    const record = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; sessionId?: unknown };
    return record.version !== 1 || typeof record.sessionId !== "string" || record.sessionId === sessionId;
  } catch {
    // An unreadable stop request cannot license another mutation.
    return true;
  }
}

/** Abort Pi, not Sandcastle: Pi must first persist terminal tool results and
 * cancel its owned delegations. The factory's existing deadline still forces
 * a worker that cannot settle. */
export function watchWorkerStop(workDir: string, sessionId: string, abort: () => void): () => void {
  let stopped = false;
  const check = (): void => {
    if (!stopped && workerStopRequested(workDir, sessionId)) {
      stopped = true;
      clearInterval(timer);
      abort();
    }
  };
  const timer = setInterval(check, 25);
  timer.unref();
  check();
  return () => { stopped = true; clearInterval(timer); };
}
