import type { Notifier, WorkNotification } from "./port.js";

/**
 * The recording notifier of the tests (issue 93, Testing Decisions): it
 * records the notices the loop delivered or simulates a delivery failure —
 * no desktop, no subprocess. It is the single replaceable delivery seam the
 * behavioral suites inject, alongside the existing tracker/runtime fakes.
 */
export class FakeNotifier implements Notifier {
  /** Every delivered notice, in delivery order. */
  readonly notifications: WorkNotification[] = [];
  /** When set, every delivery rejects with this error — the failure path. */
  failWith?: Error;

  async notify(notification: WorkNotification): Promise<void> {
    if (this.failWith !== undefined) throw this.failWith;
    this.notifications.push(notification);
  }
}
