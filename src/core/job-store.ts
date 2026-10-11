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
