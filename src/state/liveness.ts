import { execFile as execFileCallback } from "node:child_process";
import { isAbsolute, relative, sep } from "node:path";
import { promisify } from "node:util";

import { parseWorkKey } from "../pool/registry.js";

const execFile = promisify(execFileCallback);

/**
 * The liveness probe (issue 102, ADR 0002): the workers ARE containers, so
 * asking Docker is the only way `msf status` can tell a live worker from a
 * registry dir whose attempt died. Read-only by construction — the probe only
 * lists the worker image's containers and inspects them.
 *
 * The interpretation of Docker's output is a PURE function over the canned
 * strings (parseWorkerContainers); the command shell (dockerWorkerProbe) is
 * the only part that touches the machine, and the composition default — tests
 * inject a fake probe, never a flag.
 */

/** A live worker as the status sees it: its work and how long it has run. */
export interface LiveWorker {
  /** "<repo>#<number>" — the same key the registry uses for the work dir. */
  key: string;
  /** Milliseconds since the container started (the worker's age). */
  ageMs: number;
}

/** Reads the live workers now. Throws when Docker is unreachable. */
export type LivenessProbe = () => Promise<LiveWorker[]>;

export interface DockerProbeOptions {
  /** The worker image — the filter: only factory workers are listed. */
  image: string;
  /** The workspace's works root (<workspace>/trabalhos) the mounts resolve under. */
  worksRoot: string;
}

/**
 * The real probe: the shell the pure parser sits in. `docker ps` on the
 * worker image is the liveness authority (only running containers are
 * listed); `docker inspect` supplies the start time and the mounts.
 */
export function dockerWorkerProbe(options: DockerProbeOptions): LivenessProbe {
  return async () => {
    const listing = await docker(["ps", "--filter", `ancestor=${options.image}`, "--format", "{{.ID}}"]);
    const ids = parseContainerIds(listing);
    // Nothing running: no inspect to pay for, no workers to correlate.
    if (ids.length === 0) return [];
    const inspect = await docker(["inspect", ...ids]);
    return parseWorkerContainers(listing, inspect, options.worksRoot, new Date());
  };
}

/** The container IDs of a `docker ps --format "{{.ID}}"` listing (one per line). */
function parseContainerIds(listing: string): string[] {
  return listing.split(/\s+/).filter((id) => id !== "");
}

async function docker(args: string[]): Promise<string> {
  const { stdout } = await execFile("docker", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/**
 * The pure correlation (issue 102): a container is a worker of the work whose
 * dir it binds — the runtime mounts <works>/<repo>#<n> at /msf-work and its
 * sessao/ dir at the agent's sessions path, so ANY mount resolving under the
 * works root names the work. Mounts outside the works root (the toolchain
 * volume, the profile snapshot) are not the work's identity.
 *
 * The `ps` listing, not the inspect payload, says what is running now: the
 * inspect is intersected with it, so an inspect run that outlived its listing
 * cannot resurrect a dead container.
 */
export function parseWorkerContainers(
  psListing: string,
  inspectJson: string,
  worksRoot: string,
  now: Date,
): LiveWorker[] {
  const listed = parseContainerIds(psListing);
  if (listed.length === 0) return [];

  const containers = parseInspectOutput(inspectJson);
  const workers = new Map<string, LiveWorker>();
  for (const container of containers) {
    if (!listed.some((id) => container.Id.startsWith(id))) continue;
    const key = workKeyOfMounts(container.Mounts ?? [], worksRoot);
    if (key === null) continue;
    const ageMs = ageOf(container, now);
    // One work, one row: the oldest container is the worker that carries it.
    const seen = workers.get(key);
    if (seen === undefined || ageMs > seen.ageMs) workers.set(key, { key, ageMs });
  }
  return [...workers.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Malformed inspect output is a probe failure, never "no workers": the
 *  status degrades to liveness unknown instead of claiming an empty factory. */
function parseInspectOutput(inspectJson: string): InspectedContainer[] {
  try {
    return JSON.parse(inspectJson) as InspectedContainer[];
  } catch {
    throw new Error("docker inspect output is not JSON — liveness unknown");
  }
}

/** A live container's age, from its own start time — an unreadable start is a
 *  probe failure, never a fabricated "0s" the operator would read as "just
 *  started". */
function ageOf(container: InspectedContainer, now: Date): number {
  const startedAt = Date.parse(container.State?.StartedAt ?? "");
  if (Number.isNaN(startedAt)) {
    throw new Error(`container ${container.Id} carries no readable start time — liveness unknown`);
  }
  return Math.max(0, now.getTime() - startedAt);
}

/** The shape of `docker inspect` the correlation reads — nothing more. */
interface InspectedContainer {
  Id: string;
  State?: { StartedAt?: string };
  Mounts?: Array<{ Source?: string }>;
}

/** The work key of the first mount that resolves under the works root. */
function workKeyOfMounts(mounts: Array<{ Source?: string }>, worksRoot: string): string | null {
  for (const mount of mounts) {
    const source = mount.Source;
    if (source === undefined) continue;
    const path = relative(worksRoot, source);
    // Outside the works root: not a work's dir. (".." is absolute-path safe.)
    if (path === "" || path.startsWith("..") || isAbsolute(path)) continue;
    // The sessions bind points at <work dir>/sessao — the work is its parent.
    const name = path.split(sep).join("/").replace(/\/sessao$/, "");
    const parsed = parseWorkKey(name);
    if (parsed !== null) return name;
  }
  return null;
}
