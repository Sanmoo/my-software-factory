/**
 * The pool is everything that does not survive a restart: `y` slots in
 * memory; what survives (desfecho, logs, session, branch) is a disk artifact
 * read by the registry. Slots exist only in process.
 */
export class Slots {
  private readonly running: Set<string> = new Set();

  constructor(readonly capacity: number) {}

  get inFlight(): number {
    return this.running.size;
  }

  /** The keys of the works currently in flight (the derivation filters them). */
  get workKeys(): string[] {
    return [...this.running];
  }

  get free(): number {
    return Math.max(this.capacity - this.running.size, 0);
  }

  get full(): boolean {
    return this.running.size >= this.capacity;
  }

  /** Take a slot for a work; false when full or already in flight. */
  tryAcquire(workKey: string): boolean {
    if (this.full || this.running.has(workKey)) return false;
    this.running.add(workKey);
    return true;
  }

  /** Free the slot of a collected work. Unknown works are a no-op. */
  release(workKey: string): void {
    this.running.delete(workKey);
  }
}
