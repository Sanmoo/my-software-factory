import { isAbsolute, relative, sep } from "node:path";

import { runDocker } from "../docker-cli.js";
import { SESSIONS_SUBDIR, type WorkspaceLayout } from "../layout.js";
import { describeError } from "../format.js";
import { parseWorkKey } from "../pool/registry.js";

/**
 * The liveness probe (issue 102, ADR 0002): the workers ARE containers, so
 * asking Docker is the only way `msf status` can tell a live worker from a
 * registry dir whose attempt died. Every command this module runs only reads.
 * Ending a worker is NOT status work: that write lives in the runtime
 * (runtime/worker-stop.ts).
 *
 * The interpretation of Docker's output is a PURE function over the canned
 * strings (parseWorkerContainers); the command shell (dockerWorkerProbe) is
 * the only part that touches the machine. Tests inject a fake probe, and the
 * shell itself takes a runner — never a CLI flag.
 *
 * The identity is the container's bind of a work dir under the works root,
 * never the configured worker image (issue 160): Docker resolves that image
 * reference to whichever image it points at NOW, so filtering by it silently
 * loses the workers launched before the reference moved.
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
  /** The workspace's works root (<workspace>/trabalhos): the mount identity. */
  worksRoot: string;
  /** The bound of the whole query; defaults to {@link DEFAULT_PROBE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Test-only injection: the Docker command runner; production spawns docker. */
  run?: DockerRunner;
}

/** Runs one `docker` command; production spawns the CLI, tests inject a fake. */
export type DockerRunner = (args: readonly string[], timeoutMs: number) => Promise<string>;

/**
 * The real probe: the shell the pure parser sits in. `docker ps` supplies every
 * running container's bind sources (so a worker is found by its work mount,
 * whatever image it was launched from); `docker inspect` of the candidates
 * supplies the start time and the authoritative mounts.
 *
 * Because the listing is every running container, an empty answer is a
 * reliable zero — no worker hides behind a moved image reference — so an
 * interrupted attempt is still recovered. Unknown stays reserved for Docker's
 * silence and for an identity this workspace cannot name.
 */
export function dockerWorkerProbe(options: DockerProbeOptions): LivenessProbe {
  const run = options.run ?? runDocker;
  return async () => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const listing = await run(
      ["ps", "--no-trunc", "--format", "{{.ID}} {{.Mounts}}"],
      timeoutMs,
    );
    const ids = containersBindingWorksRoot(listing, options.worksRoot);
    // Every running container is listed, whatever image launched it, so an
    // empty worker set is a reliable zero: a moved image reference hides no
    // worker. Unknown stays reserved for Docker's silence and for an identity
    // this workspace cannot name (parseWorkerContainers).
    if (ids.length === 0) return [];
    return parseWorkerContainers(
      ids.join("\n"),
      await inspectContainers(run, ids, timeoutMs),
      options.worksRoot,
      new Date(),
    );
  };
}

/**
 * The running containers that bind a path under this workspace's works root.
 * `docker ps --no-trunc` renders each bind's SOURCE path, so the screen is
 * independent of the container's image (issue 160); `docker inspect` stays the
 * authority for the correlation and the age.
 */
export function containersBindingWorksRoot(psListing: string, worksRoot: string): string[] {
  const underRoot = worksRoot.endsWith(sep) ? worksRoot : `${worksRoot}${sep}`;
  const ids: string[] = [];
  for (const line of psListing.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const [id = ""] = trimmed.split(/\s+/, 1);
    if (id !== "" && trimmed.includes(underRoot)) ids.push(id);
  }
  return ids;
}

/**
 * The production probe of one workspace: every running container, correlated
 * by its work mount — the identity no image reference can move.
 */
export function workspaceLivenessProbe(layout: WorkspaceLayout): LivenessProbe {
  return dockerWorkerProbe({ worksRoot: layout.works });
}

/**
 * `docker inspect` over the listed ids. A container that left between the
 * listing and its inspect is simply not running, so its absence is dropped
 * instead of failing the whole probe — the confirmation of a stop (issue #146)
 * reads liveness exactly while the runtime tears the container down. Any other
 * unreadable answer still fails: the factory never guesses that a worker is
 * gone.
 */
async function inspectContainers(
  run: DockerRunner,
  ids: readonly string[],
  timeoutMs: number,
): Promise<string> {
  try {
    return await run(["inspect", ...ids], timeoutMs);
  } catch (error) {
    if (!vanished(error)) throw error;
  }
  const found: string[] = [];
  for (const id of ids) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await run(["inspect", id], timeoutMs));
    } catch (error) {
      if (vanished(error)) continue;
      throw error;
    }
    if (!Array.isArray(parsed)) throw new Error("docker inspect output is not a list — liveness unknown");
    for (const container of parsed) found.push(JSON.stringify(container));
  }
  return `[${found.join(",")}]`;
}

/** The daemon's answer for an id that no longer exists (`docker inspect`). */
function vanished(error: unknown): boolean {
  return /no such (object|container)/i.test(describeError(error));
}

/** The container IDs of a listing — the shell re-renders the screened rows in
 *  this form, so the pure parser reads one listing shape whatever the screen
 *  selected. */
function parseContainerIds(listing: string): string[] {
  return listing.split(/\s+/).filter((id) => id !== "");
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

/** The correlation verdict (issue 160): the container binds a work this
 *  workspace owns, a work of ANOTHER workspace (a sibling factory on the same
 *  host — a decided "not ours"), an identity under our works root that cannot
 *  be decided, or no work at all. Only the first counts; an inconclusive
 *  correlation fails the probe, because it never authorizes assuming no
 *  relevant worker. */
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
