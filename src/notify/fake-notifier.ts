import type { Notifier, WorkNotification } from "./port.js";

/** Recording notifier for tests; `failWith` simulates a delivery failure. */
export class FakeNotifier implements Notifier {
  readonly notifications: WorkNotification[] = [];
  failWith?: Error;

  async notify(notification: WorkNotification): Promise<void> {
    if (this.failWith !== undefined) throw this.failWith;
    this.notifications.push(notification);
  }
}
