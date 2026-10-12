import type { Job } from "./job.js";

// Persistence port for job state (P01). Each job is saved as a whole; a save replaces
// the previous state of that job.
export interface LoadedJobs {
  jobs: Job[];
  // Files that could not be read or validated. They never hide the other jobs.
  unreadable: string[];
}

export interface JobStore {
  load(): Promise<LoadedJobs>;
  save(job: Job): Promise<void>;
  remove(key: string): Promise<void>;
}

// Job files are named after their key (see file-job-store), so an unreadable file still tells which
// issue it belongs to.
function keyFromFileName(name: string): string[] {
  try {
    return [decodeURIComponent(name.replace(/\.json$/, ""))];
  } catch {
    return [];
  }
}

// The issues the script already tracks: those with a job file, readable or not. Admission and
// `status` evaluate eligibility against this same set.
export const unreadableKeys = (unreadable: readonly string[]): string[] => unreadable.flatMap(keyFromFileName);

export function trackedKeys(loaded: LoadedJobs): ReadonlySet<string> {
  return new Set([...loaded.jobs.map((job) => job.key), ...unreadableKeys(loaded.unreadable)]);
}
