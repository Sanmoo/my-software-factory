import { readFileSync } from "node:fs";

/**
 * The factory's worker image, built from this repo's `docker/Dockerfile`. The
 * tag lives once in package.json (`workerImage`) because three sides read it:
 * the runtime (to run a worker), the status liveness probe (to filter the
 * containers that ARE workers) and the quality gateway (to require the image).
 */
function workerImageTag(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      workerImage?: unknown;
    };
    if (typeof pkg.workerImage !== "string") {
      throw new Error("`workerImage` is missing or not a string");
    }
    return pkg.workerImage;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read the worker image from package.json: ${reason}`);
  }
}

export const WORKER_IMAGE: string = workerImageTag();
