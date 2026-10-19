/**
 * The factory's worker image, built from this repo's `docker/Dockerfile`.
 * Single-sourced here because two sides read it: the runtime, to run a worker,
 * and the status liveness probe, to filter the containers that ARE workers.
 */
export const WORKER_IMAGE = "msf-v2-worker:local";
