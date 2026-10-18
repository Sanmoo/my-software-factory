import { createHash } from "node:crypto";
import { mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { tryLockExclusive } from "@deepseek-ai/node-addon-system/flock";

/**
 * Local exclusivity of `msf run`, one owner per real configuration path
 * (issue #90).
 *
 * The protected identity is the canonical (symlink-resolved) real path of the
 * config file — never its content, the name given on the command line or the
 * workspace. Copies at distinct real paths are distinct identities. The
 * guarantee is local to the machine and covers every combination of the
 * continuous run and `--once`.
 *
 * The acquisition is atomic across processes: an exclusive, non-blocking
 * POSIX `flock` on a per-identity lock file, held on an open descriptor for
 * the whole run. Contention rejects immediately; there is no timeout, so a
 * slow or hung owner never loses exclusivity. The kernel releases the lock
 * when the process dies — abrupt death included — so a new run needs no
 * manual cleanup.
 */
export interface RunLock {
  /** Release the exclusivity. Normal completion and error paths must call it;
   * a process death releases it without it. */
  close(): Promise<void>;
}

/** Per-user state directory for the lock files. Stable across shell sessions
 * (unlike TMPDIR), so the identity of a run never depends on the environment
 * that happened to start it. */
const LOCK_DIR = join(homedir(), ".local", "state", "msf", "locks");

export async function acquireRunLock(configPath: string): Promise<RunLock> {
  let canonicalConfig: string;
  try {
    canonicalConfig = await realpath(configPath);
  } catch (error) {
    throw new Error(
      `cannot establish run exclusivity: cannot resolve configuration ${configPath}: ${reason(error)}`,
    );
  }

  // The hash keeps the identity (a full path) out of the filename. The lock
  // file is permanent: unlinking a locked inode would let a second process
  // lock a fresh inode under the same name while the first still holds the
  // old one.
  const key = createHash("sha256").update(canonicalConfig).digest("hex");
  const lockPath = join(LOCK_DIR, `${key}.lock`);

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    await mkdir(LOCK_DIR, { recursive: true });
    handle = await open(lockPath, "a+");
  } catch (error) {
    throw new Error(
      `cannot establish run exclusivity for configuration ${canonicalConfig}: ${reason(error)}`,
    );
  }

  try {
    await tryLockExclusive(handle.fd);
  } catch (error) {
    await handle.close().catch(() => {});
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EAGAIN" || code === "EWOULDBLOCK") {
      throw new Error(
        `configuration ${canonicalConfig} already has an active msf run — ` +
          "refusing to start a second one for the same configuration",
      );
    }
    throw new Error(
      `cannot establish run exclusivity for configuration ${canonicalConfig}: ${reason(error)}`,
    );
  }

  return { close: () => handle.close() };
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
