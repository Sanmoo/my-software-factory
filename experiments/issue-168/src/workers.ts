/**
 * The Workers the harness can start, stop and observe. The registry is the
 * EXPERIMENT's observation of the world — factories never read it; the only
 * coordination medium between them is the tracker. A factory "launching" here
 * is the observable fact a test asserts, not a shared lock.
 */

import type { TicketIdentity } from "./identity.js";
import { ticketKey } from "./identity.js";

export interface WorkerRecord {
  readonly id: string;
  readonly ticket: TicketIdentity;
  readonly factoryId: string;
  readonly attempt: number;
  alive: boolean;
  ended: "interrupted" | null;
}

export class WorkerRegistry {
  private readonly workers: WorkerRecord[] = [];
  private nextId = 1;

  start(ticket: TicketIdentity, factoryId: string, attempt: number): WorkerRecord {
    const worker: WorkerRecord = {
      id: `worker-${this.nextId}`,
      ticket,
      factoryId,
      attempt,
      alive: true,
      ended: null,
    };
    this.nextId += 1;
    this.workers.push(worker);
    return worker;
  }

  liveFor(ticket: TicketIdentity): readonly WorkerRecord[] {
    return this.workers.filter(
      (worker) => worker.alive && ticketKey(worker.ticket) === ticketKey(ticket),
    );
  }

  /**
   * The worker died without an Outcome (an Interruption). It consumes no
   * attempt and transfers nothing: only the registry observes it.
   */
  interrupt(worker: WorkerRecord): void {
    worker.alive = false;
    worker.ended = "interrupted";
  }

  maxLivePerTicket(): number {
    const counts = new Map<string, number>();
    for (const worker of this.workers) {
      if (!worker.alive) continue;
      const key = ticketKey(worker.ticket);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Math.max(0, ...counts.values());
  }
}
