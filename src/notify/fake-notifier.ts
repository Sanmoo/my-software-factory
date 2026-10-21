import type { Notification, Notifier } from "./port.js";

/** Recording notifier for tests; `failWith` simulates a delivery failure. */
export class FakeNotifier implements Notifier {
  readonly notifications: Notification[] = [];
  failWith?: Error;

  async notify(notification: Notification): Promise<void> {
    if (this.failWith !== undefined) throw this.failWith;
    this.notifications.push(notification);
  }
}
