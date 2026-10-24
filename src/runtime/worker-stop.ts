import { runDocker } from "../docker-cli.js";
import { DEFAULT_PROBE_TIMEOUT_MS, dockerWorkerProbe, type DockerProbeOptions } from "../state/liveness.js";

/**
 * The forced stop of a work's workers — the one place that writes
 * to Docker. ADR 0002 keeps the STATUS path read-only; ending a worker is work
 * the runtime owes the operator's stop, not something status may do, so the
 * write lives here and the read it needs (`dockerWorkerProbe`) stays in the
 * status probe.
 *
 * The contract: remove the containers Docker says carry the work, then prove
 * none is left. Resolves only on the proof; an unreadable daemon or a
 * surviving container rejects with the reason — the factory never calls a stop
 * safe on a guess.
 */
export function dockerWorkerForceStop(options: DockerProbeOptions): (key: string) => Promise<void> {
  const probe = dockerWorkerProbe(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const running = async (key: string): Promise<string[]> =>
    (await probe())
      .filter((worker) => worker.key === key)
      .map((worker) => worker.containerId);

  return async (key: string) => {
    const doomed = await running(key);
    if (doomed.length > 0) {
      try {
        await runDocker(["rm", "-f", ...doomed], timeoutMs);
      } catch {
        // The runtime's own teardown may already be removing the same
        // container ("removal ... already in progress"). The proof is the
        // probe below, never this command's exit status.
      }
    }

    // The proof: the container is gone. A removal already under way needs a
    // moment to leave the listing; anything still there after the grace is a
    // survivor the factory must not call stopped.
    const deadline = Date.now() + 5_000;
    let survivors = await running(key);
    while (survivors.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      survivors = await running(key);
    }
    if (survivors.length > 0) {
      throw new Error(`a worker of ${key} survived the forced stop (${survivors.length} container(s) still running)`);
    }
  };
}
