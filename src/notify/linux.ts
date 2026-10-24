import { execFile } from "node:child_process";
import { formatDuration } from "../format.js";
import { renderTicketIdentity } from "../tracker/identity.js";
import type { Notification, Notifier } from "./port.js";

/** Runs the desktop command; injectable so tests need no desktop. */
export type SendNotification = (command: string, args: string[]) => Promise<void>;

export interface LinuxNotifierOptions {
  send?: SendNotification;
}

/**
 * `notify-send` (libnotify): a passive notice, no focus steal or window. Needs
 * a graphical session; a failure rejects and the loop only reports it.
 */
export class LinuxNotifier implements Notifier {
  constructor(private readonly options: LinuxNotifierOptions = {}) {}

  async notify(notification: Notification): Promise<void> {
    const { title, body } = renderNotification(notification);
    const send = this.options.send ?? defaultSend;
    await send("notify-send", ["--app-name=msf", title, body]);
  }
}

/** Composed from the structured kind only — never agent prose. */
export function renderNotification(notification: Notification): { title: string; body: string } {
  if (notification.kind === "factory-unavailable") {
    // The factory's own occurrence (issue 118): no work is invented, and no
    // issue receives a comment for Docker's silence.
    return {
      title: "msf: factory — Docker unreachable",
      body:
        `Docker has not answered for ${formatDuration(notification.unavailableForMs)}: new launches are suspended. ` +
        "Live workers and reservations are preserved, and the factory resumes on its own when Docker answers again.",
    };
  }
  const work = renderTicketIdentity(notification.work.ticket);
  const link = notification.url === null ? "" : `\n${notification.url}`;
  if (notification.kind === "review") {
    return {
      title: `msf: ${work} — review requested`,
      body: `A PR is open and waiting for your review.${link}`,
    };
  }
  if (notification.kind === "intervention") {
    return {
      title: `msf: ${work} — intervention needed`,
      body:
        "A worker of this work needs your decision: nothing was ended, replaced or chosen " +
        `automatically.${link}`,
    };
  }
  return {
    title: `msf: ${work} — help requested`,
    body: `This work is blocked and needs your attention on its ticket.${link}`,
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
