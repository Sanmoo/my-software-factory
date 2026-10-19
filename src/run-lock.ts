import { createHash } from "node:crypto";
import { chmod, mkdir, open, realpath } from "node:fs/promises";
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
 *
 * Why this mechanism: `flock` makes the kernel the arbiter and the releaser.
 * The check-and-acquire is ONE syscall, so a simultaneous dispute can never
 * admit two runs (a ``does the marker exist? then create it'' pair would not
 * be atomic); no lock state lives on disk that could go stale or need a
 * timeout; and the kernel drops the lock when the last descriptor of the
 * process goes away, so nothing depends on a signal handler running first.
 * The binding (`@deepseek-ai/node-addon-system`, pinned exact, prebuilt — no
 * install-time compilation) is imported lazily by the package, so an
 * unsupported platform or a missing binary rejects the ACQUISITION, not the
 * module load: `msf status` keeps working and the run refuses to start.
 *
 * Fail closed: any failure to establish the exclusivity — the config cannot
 * be resolved, the lock storage cannot be created, flock rejects for an
 * unsupported platform or any errno other than the contention one — ends the
 * run with a diagnostic. There is no unprotected fallback and no `--force`.
 *
 * Scope: local to the machine and to the OS user running it. The lock state
 * lives in the user's state dir (see LOCK_DIR) rather than in a shared
 * world-writable place, because two OS users are two operators: they carry
 * separate `gh` keyrings and all the factory's operational state is per-user.
 * Cross-machine coordination is out of scope: the guarantee is the `flock`
 * semantics of the local filesystem.
 */
export interface RunLock {
  /** Release the exclusivity. Normal completion and error paths must call it;
   * a process death releases it without it. */
  close(): Promise<void>;
}

/** Per-user state directory for the lock files, created with mode 0700 (see
 * the chmod at the acquisition: the identity of a run is the operator's
 * business). Stable across shell sessions (unlike TMPDIR), so the identity of
 * a run never depends on the environment that happened to start it. Not next
 * to the config file: a deployment can keep `msf.yaml` in a read-only
 * checkout, and the run must not need write access to the directory it reads
 * from. */
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
    // The mode only applies to directories THIS call creates and is masked by
    // the umask, so the directory the run owns is chmod'ed explicitly; an
    // existing one keeps whatever the operator's umask already gave it.
    const created = await mkdir(LOCK_DIR, { recursive: true, mode: 0o700 });
    if (created !== undefined) await chmod(LOCK_DIR, 0o700);
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
