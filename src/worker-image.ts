/**
 * The factory's worker image, built from this repo's `docker/Dockerfile`. The
 * tag lives once in package.json (`workerImage`), overridable per checkout with
 * MSF_WORKER_IMAGE; the shared module reads it so the TypeScript build, the
 * status probe and the quality gateway never drift.
 */
export { WORKER_IMAGE } from "../scripts/worker-image.mjs";
