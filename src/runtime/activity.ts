import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Verifiable activity of a worker session (issue 112): the files the agents
 * THEMSELVES write under the dirs the container binds — the session dir (pi's
 * transcripts, the worker's own and its reviewer subagents') and the work dir
 * (the artifacts the session produces). Sandcastle's idle timeout only sees
 * the agent's stdout, so a worker waiting on two reviewer subagents looks idle
 * for as long as it takes them: measuring what the agents write is the
 * difference between a live worker and a hung one.
 *
 * The factory's OWN writes are excluded on purpose. The attempt's event log
 * and Sandcastle's output log are derived from the agent's stdout lines, so
 * counting them would turn an unconditional heartbeat into "proof of work" —
 * exactly the protection this must not weaken. Without verifiable activity the
 * effective idle limit still fires.
 */

/** The two host dirs whose files prove the session's work, plus what to ignore. */
export interface ActivityDirs {
  /** Every dir to watch (absolute); the same paths the container binds. */
  dirs: readonly string[];
  /** Absolute paths the factory itself writes — never activity. */
  exclude: readonly string[];
}

/**
 * One observation of the watched tree: every file's path, size and mtime. Two
 * equal stamps mean nothing was written between them.
 */
export async function readActivityStamp(input: ActivityDirs): Promise<string> {
  const excluded = new Set(input.exclude);
  const entries: string[] = [];
  for (const dir of input.dirs) await collect(dir, dir, excluded, entries);
  return entries.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join("\n");
}

async function collect(
  root: string,
  dir: string,
  excluded: ReadonlySet<string>,
  entries: string[],
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // A dir that does not exist yet (or cannot be read) has no files to prove
    // activity — never a reason to fail the launch.
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    if (excluded.has(path)) continue;
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      await collect(root, path, excluded, entries);
    } else if (info.isFile()) {
      entries.push(`${path.slice(root.length)}:${info.size}:${info.mtimeMs}`);
    }
  }
}

export interface ActivityWatchOptions extends ActivityDirs {
  /** No verifiable activity for this long ends the session. */
  idleMs: number;
  /** How often the watched tree is read. */
  pollMs: number;
  /** Called once when the idle limit is reached (the caller aborts the run). */
  onIdle: (idleMs: number) => void;
  /** The clock; tests inject one only to assert the arithmetic. */
  now?: () => number;
}

/** A running observation, stopped by the caller when the session ends. */
export interface ActivityWatch {
  /** Stop observing — idempotent; the session's end is not an idle. */
  stop(): void;
}

/**
 * Observe the watched tree and call {@link ActivityWatchOptions.onIdle} ONCE
 * when no verifiable activity happened for `idleMs`. The first observation is
 * the baseline: a fresh session has its whole budget ahead of it.
 */
export function startActivityWatch(options: ActivityWatchOptions): ActivityWatch {
  const now = options.now ?? (() => Date.now());
  let lastActivityAt = now();
  let lastStamp: string | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async (): Promise<void> => {
    const stamp = await readActivityStamp(options);
    if (stopped) return;
    if (lastStamp !== null && stamp !== lastStamp) lastActivityAt = now();
    lastStamp = stamp;
    const idleMs = now() - lastActivityAt;
    if (idleMs >= options.idleMs) {
      stopped = true;
      options.onIdle(idleMs);
      return;
    }
    timer = setTimeout(() => void tick(), options.pollMs);
  };

  // The baseline is the tree as it is when the session starts: the artifacts a
  // previous attempt left are not this session's activity. A session that
  // stopped before the baseline resolved arms nothing.
  void readActivityStamp(options).then((stamp) => {
    if (stopped) return;
    lastStamp = stamp;
    timer = setTimeout(() => void tick(), options.pollMs);
  });

  return {
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
