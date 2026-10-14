import { appendLog, holdsSlot, transitionJob, type Job, type JobState } from "./job.js";
import { unreadableKeys, type JobStore } from "./job-store.js";
import { Announcements } from "./announcements.js";

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// The single owner of job state, persistence and local capacity.
export class JobRegistry {
  readonly unreadable: readonly string[];
  // Keys of job files that could not be read: their issues stay tracked, never re-admitted.
  readonly unreadableKeys: ReadonlySet<string>;
  private readonly jobs = new Map<string, Job>();

  constructor(
    private readonly store: JobStore,
    private readonly maxConcurrent: number,
    private readonly announcements: Announcements,
    loaded: Job[],
    unreadable: string[],
  ) {
    for (const job of loaded) this.jobs.set(job.key, job);
    this.unreadable = unreadable;
    this.unreadableKeys = new Set(unreadableKeys(unreadable));
  }

  job(key: string): Job | undefined {
    return this.jobs.get(key);
  }

  allJobs(): Job[] {
    return [...this.jobs.values()].sort((a, b) => byKey(a.key, b.key));
  }

  isTracked(key: string): boolean {
    return this.jobs.has(key) || this.unreadableKeys.has(key);
  }

  trackedKeys(): ReadonlySet<string> {
    return new Set([...this.jobs.keys(), ...this.unreadableKeys]);
  }

  // Checks capacity and repository and inserts in memory as one synchronous operation.
  // Returns a refusal without inserting; an accepted reservation still needs persistence.
  // Parallel polls cannot exceed N or start two implementations in one repository.
  tryReserve(job: Job): string | undefined {
    const active = [...this.jobs.values()].filter((other) => holdsSlot(other.state));
    if (active.length >= this.maxConcurrent) return "sem vaga livre";
    if (active.some((other) => other.repository === job.repository)) {
      return `repositório ${job.repository} já tem implementação ativa`;
    }
    this.jobs.set(job.key, job);
    return undefined;
  }

  // `consumed` records feedback taken by this same transition, so the state and the record
  // are written together.
  async apply(
    key: string,
    to: JobState,
    details: { message: string; reason?: string; question?: string; context?: string; pr?: Job["pr"]; consumed?: string[]; invocation?: string },
  ): Promise<Job> {
    const current = this.jobs.get(key);
    if (!current) throw new Error(`trabalho desconhecido: ${key}`);
    const base: Job = details.consumed
      ? { ...current, consumed: [...(current.consumed ?? []), ...details.consumed] }
      : current;
    const next = transitionJob(base, to, details);
    await this.persist(next);
    await this.announcements.announceState(next, details, [...this.jobs.keys()]);
    return next;
  }

  async note(key: string, message: string): Promise<void> {
    const current = this.jobs.get(key);
    if (!current) throw new Error(`trabalho desconhecido: ${key}`);
    await this.persist(appendLog(current, message));
  }

  async update(key: string, changes: Partial<Pick<Job, "workspace">>): Promise<void> {
    const current = this.jobs.get(key);
    if (!current) throw new Error(`trabalho desconhecido: ${key}`);
    await this.persist({ ...current, ...changes });
  }

  async persist(job: Job): Promise<void> {
    this.jobs.set(job.key, job);
    await this.store.save(job);
  }

  async forget(key: string): Promise<void> {
    this.jobs.delete(key);
    await this.store.remove(key);
  }
}
