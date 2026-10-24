import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Serialize check + intent across native async child processes as well as
 * foreground sessions. A killed writer holds only this reconciliation's
 * generation: the next launch gets a new one, never an unsafe stale-lock reset. */
export function tryJournalLock(workDir: string, generation: string): (() => void) | null {
  const dir = join(workDir, "delegations", "guardrails", createHash("sha256").update(generation).digest("hex"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "journal.lock");
  let fd: number;
  try { fd = openSync(path, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return null; throw error; }
  return () => { closeSync(fd); rmSync(path); };
}
