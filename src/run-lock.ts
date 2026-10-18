import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryLockExclusive } from "@deepseek-ai/node-addon-system/flock";

/** Keep the handle alive for the complete run. The lock file is permanent: unlinking
 * a flocked inode could let another process lock a replacement inode. */
export interface RunLock {
  close(): Promise<void>;
}

export async function acquireRunLock(configPath: string): Promise<RunLock> {
  const canonicalConfig = await realpath(configPath);
  const key = createHash("sha256").update(canonicalConfig).digest("hex");
  const lockPath = join(tmpdir(), `msf-run-${process.getuid?.() ?? "user"}-${key}.lock`);
  const handle = await open(lockPath, "a+");
  try {
    await tryLockExclusive(handle.fd);
  } catch (error) {
    await handle.close();
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EAGAIN" || code === "EWOULDBLOCK") {
      throw new Error(`configuration ${canonicalConfig} already has an active msf run`);
    }
    throw new Error(`cannot establish run exclusivity for configuration ${canonicalConfig}: ${error instanceof Error ? error.message : error}`);
  }
  return { close: () => handle.close() };
}
