import { createHash } from "node:crypto";
import { chmod, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
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
 * Two exclusive `flock`s are held on open descriptors for the whole run: one
 * on the config file itself, one on a per-identity marker file. The first
 * follows the file's inode, so it holds whatever environment started the run
 * (a different HOME, an elevated shell, a systemd unit) and even excludes a
 * second OS user who can read the same config. The second is keyed by the
 * real path in the user's state dir (see LOCK_DIR) and survives the file
 * being replaced — the ordinary atomic save of an editor — which gives the
 * next run a new inode. Either one being taken refuses the run.
 *
 * Each acquisition is one non-blocking `flock` — a single syscall, so there is
 * no check-then-create window (a "does the marker exist? then create it" pair
 * would not be atomic). The config file's lock is taken first and is the
 * barrier: any second run of the same config contends on that inode before
 * touching its marker, so a simultaneous dispute admits at most one. (The two
 * differ when both the inode and the state dir differ — a copy of the config
 * under another HOME — which is a different configuration by construction.)
 * Contention rejects immediately; there is no timeout, so a slow or hung owner
 * never loses exclusivity. The kernel releases the locks when the process dies
 * — abrupt death included — so a new run needs no manual cleanup and nothing
 * depends on a signal handler running first.
 *
 * The binding (`@deepseek-ai/node-addon-system`, pinned exact, prebuilt — no
 * install-time compilation) is imported lazily by the package, so an
 * unsupported platform or a missing binary rejects the ACQUISITION, not the
 * module load: `msf status` keeps working and the run refuses to start.
 *
 * Fail closed: any failure to establish the exclusivity — the config cannot
 * be resolved or read, the lock storage cannot be created, flock rejects for
 * an unsupported platform or any errno other than the contention one — ends
 * the run with a diagnostic. There is no unprotected fallback and no
 * `--force`.
 *
 * Scope: the machine and the local filesystem's `flock` semantics. The marker
 * lives in the invoking user's state dir rather than in a shared world-
 * writable place (two OS users are two operators, with separate `gh` keyrings
 * and per-user state), while the config file's own lock is not tied to it.
 * One consequence of locking the inode: two paths hard-linked to the same file
 * count as the same configuration (stricter than required — hard-link aliases
 * need no recognition, and copies are new inodes). Cross-machine coordination
 * is out of scope.
 */
export interface RunLock {
  /** Release the exclusivity. Normal completion and error paths must call it;
   * a process death releases it without it. */
  close(): Promise<void>;
}

/**
 * The per-user state directory of the marker files. A directory this run
 * creates is chmod'ed 0700 (see the acquisition), keeping other OS users out of
 * this user's markers; one that already existed keeps the operator's umask.
 * The directory follows the user's home: the config file's own lock is what
 * makes the guarantee independent of it. Not next to the config file: a
 * deployment can keep `msf.yaml` in a read-only checkout, and the run must not
 * need write access to the directory it reads from.
 */
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

  // The config file's own lock goes first: it is the environment-independent
  // one, and it needs only read access (flock takes an exclusive lock on a
  // descriptor opened read-only, so a deployment's read-only config works).
  let configHandle: FileHandle;
  try {
    configHandle = await open(canonicalConfig, "r");
  } catch (error) {
    throw new Error(
      `cannot establish run exclusivity for configuration ${canonicalConfig}: ${reason(error)}`,
    );
  }
  try {
    await tryLockExclusive(configHandle.fd);
  } catch (error) {
    await configHandle.close().catch(() => {});
    throw lockFailure(canonicalConfig, "config-file", error);
  }

  // The marker keyed by the real path. The hash keeps the identity (a full
  // path) out of the filename. The file is permanent: unlinking a locked inode
  // would let a second process lock a fresh inode under the same name while
  // the first still holds the old one.
  const key = createHash("sha256").update(canonicalConfig).digest("hex");
  const lockPath = join(LOCK_DIR, `${key}.lock`);

  let markerHandle: FileHandle;
  try {
    // The mode only applies to directories THIS call creates and is masked by
    // the umask, so the directory the run owns is chmod'ed explicitly; an
    // existing one keeps whatever the operator's umask already gave it.
    const created = await mkdir(LOCK_DIR, { recursive: true, mode: 0o700 });
    if (created !== undefined) await chmod(LOCK_DIR, 0o700);
    markerHandle = await open(lockPath, "a+");
  } catch (error) {
    await configHandle.close().catch(() => {});
    throw new Error(
      `cannot establish run exclusivity for configuration ${canonicalConfig}: ${reason(error)}`,
    );
  }

  try {
    await tryLockExclusive(markerHandle.fd);
  } catch (error) {
    await markerHandle.close().catch(() => {});
    await configHandle.close().catch(() => {});
    throw lockFailure(canonicalConfig, "marker", error);
  }

  return {
    close: async () => {
      await markerHandle.close().catch(() => {});
      await configHandle.close().catch(() => {});
    },
  };
}

/** One diagnostic for every failed acquisition: contention is the operator's
 * mistake (a second run), anything else is an environment fault that must not
 * be mistaken for it. `via` keeps the contention sentence honest: the config
 * file's flock can also be held by a process that is not an `msf run`. */
function lockFailure(canonicalConfig: string, via: "config-file" | "marker", error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EAGAIN" || code === "EWOULDBLOCK") {
    const holder =
      via === "marker" ? "" : " (its file is flock'ed by another process)";
    return new Error(
      `configuration ${canonicalConfig} already has an active msf run${holder} — ` +
        "refusing to start a second one for the same configuration",
    );
  }
  return new Error(
    `cannot establish run exclusivity for configuration ${canonicalConfig}: ${reason(error)}`,
  );
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
