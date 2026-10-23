import { createHash } from "node:crypto";
import { chmod, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { tryLockExclusive } from "@deepseek-ai/node-addon-system/flock";
import { describeError } from "./log.js";

/**
 * Local exclusivity of `msf run`, one owner per real configuration path
 * (issue #90).
 *
 * The protected identity is the canonical (symlink-resolved) real path of the
 * config file — never its content, the name given on the command line or the
 * workspace. Copies at distinct real paths are distinct identities.
 *
 * Two exclusive `flock`s are held on open descriptors for the whole run: one
 * on the config file itself, one on a per-identity marker file. The config
 * file's lock follows its inode, so the guarantee holds whatever environment
 * started the run (a different HOME, an elevated shell) and even excludes a
 * second OS user who can read the config. The marker is keyed by the real
 * path in the user's state dir (see LOCK_DIR) and survives the file being
 * replaced — the ordinary atomic save of an editor, which gives the next run
 * a new inode. Either one being taken refuses the run.
 *
 * Each acquisition is one non-blocking `flock`: a single syscall, so there is
 * no check-then-create window a "does the marker exist? then create it" pair
 * would open. Both are taken in a fixed order (config file first), and
 * contention rejects immediately — no timeout, so a slow or hung owner never
 * loses exclusivity. The kernel releases the locks when the process dies,
 * abrupt death included, so a new run needs no manual cleanup and nothing
 * depends on a signal handler running first.
 *
 * The binding (`@deepseek-ai/node-addon-system`) loads lazily, so an
 * unsupported platform or a missing binary rejects the ACQUISITION, not the
 * module load: `msf status` keeps working and the run refuses to start.
 *
 * Fail closed: any failure to establish the exclusivity ends the run with a
 * diagnostic. There is no unprotected fallback and no `--force`.
 *
 * Scope: this machine's local filesystem. A cross-machine guarantee is not
 * attempted.
 */
export interface RunLock {
  /** Release the exclusivity. Normal completion and error paths must call it;
   * a process death releases it without it. */
  close(): Promise<void>;
}

/**
 * The marker files' directory in the user's state dir (XDG_STATE_HOME when
 * set). A directory this run creates is chmod'ed 0700 — see the acquisition —
 * keeping other OS users out; an existing one keeps the operator's umask. Not
 * next to the config file: a deployment can keep `msf.yaml` in a read-only
 * checkout, and the run must not need write access to the directory it reads.
 */
const LOCK_DIR = join(
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
  "msf",
  "locks",
);

export async function acquireRunLock(configPath: string): Promise<RunLock> {
  let canonicalConfig: string;
  try {
    canonicalConfig = await realpath(configPath);
  } catch (error) {
    throw new Error(
      `cannot establish run exclusivity: cannot resolve configuration ${configPath}: ${describeError(error)}`,
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
      `cannot establish run exclusivity for configuration ${canonicalConfig}: ${describeError(error)}`,
    );
  }
  try {
    await tryLockExclusive(configHandle.fd);
  } catch (error) {
    await closeQuietly(configHandle);
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
    await closeQuietly(configHandle);
    throw new Error(
      `cannot establish run exclusivity for configuration ${canonicalConfig}: ${describeError(error)}`,
    );
  }

  try {
    await tryLockExclusive(markerHandle.fd);
  } catch (error) {
    await closeQuietly(markerHandle, configHandle);
    throw lockFailure(canonicalConfig, "marker", error);
  }

  return { close: () => closeQuietly(markerHandle, configHandle) };
}

/** One diagnostic for every failed acquisition: contention is the operator's
 * mistake (a second run), anything else is an environment fault that must not
 * be mistaken for it. `via` keeps the contention sentence honest: the config
 * file's flock can also be held by a process that is not an `msf run`. */
function lockFailure(canonicalConfig: string, via: "config-file" | "marker", error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "EAGAIN" && code !== "EWOULDBLOCK") {
    return new Error(
      `cannot establish run exclusivity for configuration ${canonicalConfig}: ${describeError(error)}`,
    );
  }
  const refusing = `configuration ${canonicalConfig} already has an active msf run`;
  const tail = "refusing to start a second one for the same configuration";
  if (via === "marker") return new Error(`${refusing} — ${tail}`);
  return new Error(`${refusing} (its file is flock'ed by another process) — ${tail}`);
}

/** Close what was opened, ignoring a close that has nothing left to do. */
async function closeQuietly(...handles: FileHandle[]): Promise<void> {
  for (const handle of handles) await handle.close().catch(() => {});
}

