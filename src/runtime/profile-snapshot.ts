import { cpSync, existsSync, mkdirSync, readdirSync, lstatSync, statSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * The profile snapshot (ticket 17) — the host resolves the operator's Pi
 * profile into a portrait of REAL files that the container mounts read-only
 * and copies into its own writable agent dir (the v1's proven ADR 0002
 * pattern). The operator's real profile is never mounted and never written.
 *
 * Why not mount the real profile read-only: the Pi agent dir is a chain of
 * links (personal/work frontiers entangled) and the agent MUST write there —
 * OAuth renewal rewrites auth.json, sessions are written by default. The
 * snapshot resolves links once, on the host, and hands the container a plain
 * directory of real files.
 *
 * Rules, fail fast (the v1's admission, minimal for the v2):
 *   - a symlink INSIDE the profile is dereferenced — real content at the
 *     link's path, nothing follows a link inside the container;
 *   - a symlink into a DECLARED allowed root is dereferenced too (the
 *     operator names the roots the profile legitimately reaches);
 *   - any other symlink (escape or dangling) BLOCKS the launch naming the
 *     link — never silent context loss;
 *   - a link leading back above itself is a cycle — blocked, never walked;
 *   - `sessions` and `npm` are skipped by default: the session storage and
 *     the package tree have their own mounts, and copying them would clobber
 *     the live bind.
 */

export class ProfileSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileSnapshotError";
  }
}

export const DEFAULT_SNAPSHOT_SKIP: readonly string[] = ["sessions", "npm"];

export interface SnapshotOptions {
  /** Roots the profile may legitimately reach through links; the profile's
   * own real path is always allowed. Given as absolute (or tilde-resolved
   * by the caller) paths. */
  allowedRoots?: readonly string[];
  /** Top-level entries not copied. Defaults to sessions and npm. */
  skip?: readonly string[];
}

export async function snapshotProfile(
  source: string,
  destination: string,
  options: SnapshotOptions = {},
): Promise<void> {
  const resolvedSource = resolve(source);
  if (!existsSync(resolvedSource)) {
    throw new ProfileSnapshotError(`profile source does not exist: ${resolvedSource}`);
  }
  const realSource = realpathSync(resolvedSource);

  const allowedRoots = new Set<string>([realSource]);
  for (const root of options.allowedRoots ?? []) {
    allowedRoots.add(realpathSync(resolve(root)));
  }
  const skip = new Set(options.skip ?? DEFAULT_SNAPSHOT_SKIP);

  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });

  const walk: Walk = { allowedRoots, skip, visited: new Set([realSource]), sourceRoot: realSource };
  copyDirInto(realSource, destination, walk);
}

interface Walk {
  allowedRoots: Set<string>;
  skip: Set<string>;
  /** Real paths already copied — duplicates are skipped, cycles detected. */
  visited: Set<string>;
  /** The real path of the profile root — the level where `skip` applies. */
  sourceRoot: string;
}

/** Recursively copy the real files of one directory into the destination. */
function copyDirInto(sourceDir: string, destinationDir: string, walk: Walk): void {
  mkdirSync(destinationDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const childPath = join(sourceDir, entry.name);
    if (sourceDir === walk.sourceRoot && walk.skip.has(entry.name)) continue;

    const target = resolveEntry(childPath, walk);
    const stats = statSync(target);
    if (stats.isDirectory()) {
      const realDir = realpathSync(target);
      if (walk.visited.has(realDir)) continue; // already copied through another link
      walk.visited.add(realDir);
      copyDirInto(target, join(destinationDir, entry.name), walk);
    } else if (stats.isFile()) {
      cpSync(target, join(destinationDir, entry.name));
    } else {
      throw new ProfileSnapshotError(
        `unsupported profile entry (not a file, directory or link): ${target}`,
      );
    }
  }
}

/** Resolve one path to a real file or directory, failing fast on bad links. */
function resolveEntry(path: string, walk: Walk): string {
  const stats = lstatSync(path);
  if (!stats.isSymbolicLink()) return path;

  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new ProfileSnapshotError(`profile link is dangling: ${linkPath(path, walk)}`);
  }
  if (!isAllowed(real, walk)) {
    throw new ProfileSnapshotError(
      `profile link escapes the snapshot roots: ${linkPath(path, walk)} → ${real} ` +
        `(declare the root in the runtime's allowedRoots, or remove the link)`,
    );
  }
  if (leadsBackAboveItself(real, path)) {
    throw new ProfileSnapshotError(`profile link is part of a cycle: ${linkPath(path, walk)}`);
  }
  return real;
}

/** True when the link's real target is the link itself or an ancestor of it. */
function leadsBackAboveItself(real: string, linkPath_: string): boolean {
  const back = relative(real, linkPath_);
  return back !== "" && !back.startsWith("..");
}

function isAllowed(real: string, walk: Walk): boolean {
  for (const root of walk.allowedRoots) {
    const into = relative(root, real);
    if (into === "" || !into.startsWith("..")) return true;
  }
  return false;
}

/** Links are reported by their path inside the profile, not the absolute one. */
function linkPath(path: string, walk: Walk): string {
  return isAbsolute(path) ? relative(walk.sourceRoot, path) : path;
}
