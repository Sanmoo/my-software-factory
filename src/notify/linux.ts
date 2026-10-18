import { execFile } from "node:child_process";
import type { Notifier, WorkNotification } from "./port.js";

/**
 * `notify-send` (libnotify): a passive notice, no focus steal or window. Needs
 * a graphical session; a spawn failure rejects and the loop only reports it.
 */
export type SendNotification = (command: string, args: string[]) => Promise<void>;

export interface LinuxNotifierOptions {
  send?: SendNotification;
}

export class LinuxNotifier implements Notifier {
  constructor(private readonly options: LinuxNotifierOptions = {}) {}

  async notify(notification: WorkNotification): Promise<void> {
    const { title, body } = renderNotification(notification);
    const send = this.options.send ?? defaultSend;
    await send("notify-send", ["--app-name=msf", title, body]);
  }
}

/** Composed from the structured kind only — never agent prose. */
export function renderNotification(notification: WorkNotification): { title: string; body: string } {
  const work = `${notification.ref.repo}#${notification.ref.number}`;
  if (notification.kind === "review") {
    return {
      title: `msf: ${work} — review requested`,
      body: `A PR is open and waiting for your review.\n${notification.url}`,
    };
  }
  return {
    title: `msf: ${work} — help requested`,
    body: `This work is blocked and needs your attention on the issue.\n${notification.url}`,
  };
}

function defaultSend(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 5_000 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
