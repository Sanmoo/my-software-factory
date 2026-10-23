import { execFile as execFileCallback } from "node:child_process";
import { isAbsolute, relative, sep } from "node:path";
import { promisify } from "node:util";

import { SESSIONS_SUBDIR, WORKSPACE_SUBPATHS } from "../layout.js";
import { describeError } from "../log.js";
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

/** A live worker as the factory sees it: its work, its container and how long
 *  it has run. The container id is the identity (issue 118): two containers of
 *  the same work are two workers, never one row. */
export interface LiveWorker {
  /** "<repo>#<number>" — the same key the registry uses for the work dir. */
  key: string;
  /** The container that carries it — the identity the counting de-duplicates on. */
  containerId: string;
  /** Milliseconds since the container started (the worker's age). */
  ageMs: number;
}

/** Reads the live workers now. Throws when Docker is unreachable. */
export type LivenessProbe = () => Promise<LiveWorker[]>;

/**
 * The probe's answer (issue 118): the live containers, one entry each, or the
 * honest unknown. A failure, a timeout or an invalid answer is NEVER an empty
 * list — the operator's "no worker" and "cannot tell" are different facts.
 */
export type LivenessObservation =
  | { state: "known"; workers: LiveWorker[] }
  | { state: "unknown"; reason: string };

/** Every probe query ends or fails within this bound; a hung Docker call must
 *  not stall the cycles and the diagnostics forever. */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/**
 * Ask the probe, bounded: the live containers or the unknown (a rejection, a
 * timeout or an unparseable answer). Never throws, so every caller shares the
 * same interpretation of Docker's silence.
 */
export async function probeLiveness(
  probe: LivenessProbe,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<LivenessObservation> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const workers = await Promise.race([
      probe(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`the probe did not answer within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return { state: "known", workers };
  } catch (error) {
    return { state: "unknown", reason: describeError(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The containers of each work, as the operational decisions count them. */
export function workersByWork(workers: readonly LiveWorker[]): Map<string, LiveWorker[]> {
  const byWork = new Map<string, LiveWorker[]>();
  for (const worker of workers) {
    const seen = byWork.get(worker.key);
    if (seen === undefined) byWork.set(worker.key, [worker]);
    else seen.push(worker);
  }
  return byWork;
}

/** A work carried by more than one live container — the duplicate anomaly. */
export interface DuplicateWorkers {
  key: string;
  containers: number;
}

/** The duplicate anomaly, from the same facts status and the cycle read. */
export function duplicateWorkers(workers: readonly LiveWorker[]): DuplicateWorkers[] {
  return [...workersByWork(workers)]
    .filter(([, containers]) => containers.length > 1)
    .map(([key, containers]) => ({ key, containers: containers.length }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * The slots the live workforce occupies (issue 118): every distinct container
 * counts once, and a local launch Docker already shows is not counted again —
 * a worker seen by both is still ONE worker. A local launch Docker does not
 * show yet (the container is starting) occupies its slot until collection.
 */
export function occupiedSlots(
  workers: readonly LiveWorker[],
  localWorkKeys: ReadonlySet<string>,
): number {
  const shown = new Set(workers.map((worker) => worker.key));
  let localOnly = 0;
  for (const key of localWorkKeys) if (!shown.has(key)) localOnly += 1;
  return workers.length + localOnly;
}

/** How many slots the live workforce exceeds the configured concurrency by
 *  (0 = within the limit): distinct containers, a local launch Docker already
 *  shows counted once. */
export function capacityExcess(
  workers: readonly LiveWorker[],
  localWorkKeys: ReadonlySet<string>,
  concurrency: number,
): number {
  return Math.max(0, occupiedSlots(workers, localWorkKeys) - concurrency);
}

export interface DockerProbeOptions {
  /** The worker image — the filter: only factory workers are listed. */
  image: string;
  /** The workspace's works root (<workspace>/trabalhos) the mounts resolve under. */
  worksRoot: string;
  /** The bound of the whole query; defaults to {@link DEFAULT_PROBE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * The real probe: the shell the pure parser sits in. `docker ps` on the
 * worker image is the liveness authority (only running containers are
 * listed); `docker inspect` supplies the start time and the mounts.
 */
export function dockerWorkerProbe(options: DockerProbeOptions): LivenessProbe {
  return async () => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const listing = await docker(
      ["ps", "--filter", `ancestor=${options.image}`, "--format", "{{.ID}}"],
      timeoutMs,
    );
    const ids = parseContainerIds(listing);
    // Nothing running: no inspect to pay for, no workers to correlate.
    if (ids.length === 0) return [];
    const inspect = await docker(["inspect", ...ids], timeoutMs);
    return parseWorkerContainers(listing, inspect, options.worksRoot, new Date());
  };
}

/** The container IDs of a `docker ps --format "{{.ID}}"` listing (one per line). */
function parseContainerIds(listing: string): string[] {
  return listing.split(/\s+/).filter((id) => id !== "");
}

async function docker(args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFile("docker", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  });
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
 *
 * One entry PER CONTAINER (issue 118): the container id is the identity, so
 * two containers carrying the same work stay visible as two workers — the
 * operational counting and the duplicate diagnosis depend on it.
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
  const workers: LiveWorker[] = [];
  for (const container of containers) {
    if (!listed.some((id) => container.Id.startsWith(id))) continue;
    const correlation = correlateWork(container.Mounts ?? [], worksRoot);
    // A container of the worker image without a work mount is not a worker; a
    // work of ANOTHER workspace is a decided "not ours". An identity that
    // cannot be decided is UNKNOWN, never "no worker" (issue 118) — it may
    // still be one of ours.
    if (correlation.kind === "foreign" || correlation.kind === "not-a-worker") continue;
    if (correlation.kind === "inconclusive") {
      throw new Error(
        `worker-image container ${container.Id} carries no work this workspace can name — ` +
          "its identity is inconclusive, liveness unknown",
      );
    }
    workers.push({ key: correlation.key, containerId: container.Id, ageMs: ageOf(container, now) });
  }
  return workers.sort(
    (a, b) =>
      a.key.localeCompare(b.key) || b.ageMs - a.ageMs || a.containerId.localeCompare(b.containerId),
  );
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

/**
 * What a worker-image container's mounts say about its work (issue 118): the
 * work this workspace owns, a work of ANOTHER workspace (a sibling factory on
 * the same host — a decided "not ours"), or an identity that cannot be
 * decided. Only the first counts; the last fails the probe, because an
 * inconclusive correlation never authorizes assuming no relevant worker.
 */
type WorkCorrelation =
  | { kind: "ours"; key: string }
  | { kind: "foreign" }
  | { kind: "inconclusive" }
  | { kind: "not-a-worker" };

/**
 * A mount that points at a work dir — <anywhere>/<repo>#<n>[/sessao]. A
 * container of the worker image without one carries no work: it is an
 * auxiliary container (a probe, a debug run), not a worker.
 */
const WORK_SHAPED_MOUNT = /(?:^|\/)[^/]+#\d+(?:\/${SESSIONS_SUBDIR})?$/;

function correlateWork(mounts: Array<{ Source?: string }>, worksRoot: string): WorkCorrelation {
  // The verdict is mount-ORDER independent: a named work of ours wins; a bind
  // under OUR works root that names no work may be a moved work of ours (never
  // "not ours"); a work-shaped mount under another works root belongs to
  // another workspace; a container with no work mount anywhere is not a worker.
  let ours: string | null = null;
  let undecidable = false;
  let foreign = false;
  for (const mount of mounts) {
    const source = mount.Source;
    if (source === undefined) continue;
    const path = relative(worksRoot, source);
    if (path !== "" && !path.startsWith("..") && !isAbsolute(path)) {
      // The sessions bind points at <work dir>/sessao — the work is its parent.
      const name = path.split(sep).join("/").replace(new RegExp(`/${SESSIONS_SUBDIR}$`), "");
      if (parseWorkKey(name) !== null) ours ??= name;
      else undecidable = true;
    } else if (WORK_SHAPED_MOUNT.test(source.split(sep).join("/"))) {
      foreign = true;
    }
  }
  if (ours !== null) return { kind: "ours", key: ours };
  if (undecidable) return { kind: "inconclusive" };
  if (foreign) return { kind: "foreign" };
  return { kind: "not-a-worker" };
}
