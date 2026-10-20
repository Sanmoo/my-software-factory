import { readFileSync } from "node:fs";

/**
 * The factory's worker image tag, single-sourced from package.json's
 * `workerImage`. Shared by the runtime, the status probe and the gateway; the
 * gateway and the TypeScript build both import this module.
 */
function readWorkerImage() {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    if (typeof pkg.workerImage !== "string") throw new Error("`workerImage` is missing or not a string");
    return pkg.workerImage;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read the worker image from package.json: ${reason}`);
  }
}

export const WORKER_IMAGE = readWorkerImage();
