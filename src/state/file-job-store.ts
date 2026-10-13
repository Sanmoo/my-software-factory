import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JOB_STATES, type Job } from "../core/job.js";
import type { JobStore, LoadedJobs } from "../core/job-store.js";

// One JSON file per job in the state directory. A save writes a temporary file and
// renames it over the job file, so a reader never sees a half-written job.
// No fsync or replay is promised: this is a simple local state, not a database.

const fileNameFor = (key: string): string => `${encodeURIComponent(key)}.json`;

function isJob(value: unknown): value is Job {
  if (typeof value !== "object" || value === null) return false;
  const job = value as Record<string, unknown>;
  const ref = job.ref as Record<string, unknown> | undefined;
  return typeof job.key === "string"
    && typeof job.repository === "string"
    && typeof job.state === "string"
    && (JOB_STATES as readonly string[]).includes(job.state)
    && typeof ref === "object" && ref !== null
    && typeof ref.tracker === "string" && typeof ref.project === "string" && typeof ref.id === "string"
    && Array.isArray(job.log) && job.log.every((line) => typeof line === "string");
}

export function createFileJobStore(dir: string): JobStore {
  return {
    async load(): Promise<LoadedJobs> {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { jobs: [], unreadable: [] };
        throw error;
      }
      const loaded: LoadedJobs = { jobs: [], unreadable: [] };
      for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
        try {
          const value: unknown = JSON.parse(await readFile(join(dir, name), "utf8"));
          if (isJob(value)) loaded.jobs.push(value);
          else loaded.unreadable.push(name);
        } catch {
          loaded.unreadable.push(name);
        }
      }
      return loaded;
    },

    async save(job: Job): Promise<void> {
      await mkdir(dir, { recursive: true });
      const file = join(dir, fileNameFor(job.key));
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(job, null, 2) + "\n");
      await rename(temporary, file);
    },

    async remove(key: string): Promise<void> {
      await rm(join(dir, fileNameFor(key)), { force: true });
    },
  };
}
