import { execFile } from "node:child_process";
import type { Notifier, WorkNotification } from "./port.js";

/**
 * The Linux desktop notifier (issue 93): `notify-send` (libnotify) through
 * the running user's notification daemon. It pops a passive notice — no
 * focus stealing, no browser window, no buttons; the desktop decides how
 * long to keep it. It runs on the HOST (the CLI), never inside the worker
 * container.
 *
 * Prerequisites: a Linux desktop session with a notification daemon and the
 * `notify-send` binary (the `libnotify-bin` package on Debian/Ubuntu,
 * `libnotify` on Arch). Without either, the spawn fails and the loop reports
 * it on the terminal — best-effort, never fatal.
 */

/** Runs the desktop command; injectable so the notice text is tested without a desktop. */
export type SendNotification = (command: string, args: string[]) => Promise<void>;

export interface LinuxNotifierOptions {
  /** The desktop command; `notify-send` is the default. */
  command?: string;
  /** Test seam: replaces the subprocess with a recorder. */
  send?: SendNotification;
}

export class LinuxNotifier implements Notifier {
  constructor(private readonly options: LinuxNotifierOptions = {}) {}

  async notify(notification: WorkNotification): Promise<void> {
    const { title, body } = renderNotification(notification);
    const send = this.options.send ?? defaultSend;
    await send(this.options.command ?? "notify-send", ["--app-name=msf", title, body]);
  }
}

/**
 * The notice text: the work, a brief reason and the address to open. The
 * reason is derived from the structured kind — never from agent prose.
 */
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
