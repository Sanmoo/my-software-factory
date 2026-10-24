/**
 * The observable Worker runtime of the experiment. A Worker is started only
 * after the factory obtained confirmed authority; it stays alive until
 * something explicitly ends it. There is no supervision, no health check and
 * no automatic substitute — the harness's only witnesses are these handles.
 */
export interface WorkerHandle {
  id: string;
  factory: string;
  ticket: string;
  attempt: number;
  startedAt: number;
  alive: boolean;
}

export class WorkerRuntime {
  private readonly workers: WorkerHandle[] = [];
  private seq = 0;

  start(input: { factory: string; ticket: string; attempt: number; at: number }): WorkerHandle {
    this.seq += 1;
    const worker: WorkerHandle = {
      id: `worker-${this.seq}`,
      factory: input.factory,
      ticket: input.ticket,
      attempt: input.attempt,
      startedAt: input.at,
      alive: true,
    };
    this.workers.push(worker);
    return worker;
  }

  end(workerId: string): void {
    const worker = this.workers.find((candidate) => candidate.id === workerId);
    if (worker === undefined) throw new Error(`unknown worker ${workerId}`);
    worker.alive = false;
  }

  aliveFor(ticket: string): WorkerHandle[] {
    return this.workers.filter((worker) => worker.alive && worker.ticket === ticket);
  }

  all(): readonly WorkerHandle[] {
    return this.workers;
  }

  aliveCount(): number {
    return this.workers.filter((worker) => worker.alive).length;
  }
}
