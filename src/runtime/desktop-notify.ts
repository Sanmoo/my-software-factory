import { exec, execFile } from "node:child_process";
import type { AttentionBoundary, AttentionNotification } from "../core/attention.js";
import { shellQuote } from "../core/observability.js";

// The best-effort desktop notification channel (spec #48, ticket #59). A real OS command runs
// (platform-chosen, or an operator-configured command from local settings); a fault or an
// unavailable channel is thrown to the caller — the pending stays, only the attempt is
// recorded. The channel NEVER goes through Herdr: the technical proof (issue #52) found no
// notification command in herdr 0.9.3 (`herdr show`: `unknown command: show`), so carrying a
// would-be "Herdr notification" here would presume a delivery that cannot even be attempted.

export interface DesktopNotifyOptions {
  // Platform name: `darwin`, `linux`, anything else is an unsupported channel (documented
  // absence, not a silent guess).
  platform?: string;
  // Operator-provided shell command (local settings), where `{title}` and `{body}` are
  // substituted by shell-quoted values. When present it wins over the platform default.
  command?: string;
  // Injectable command runner (tests never fire a real OS notification). Default: execFile/execNode.
  run?: (command: string, args: readonly string[]) => Promise<void>;
  // Injectable raw runner for the configured shell command.
  runShell?: (commandLine: string) => Promise<void>;
  // Timeout of one attempt, so a hanging channel never stalls a polling cycle.
  timeoutMs?: number;
}

// Platform defaults (chosen per OS; none of them steals focus):
//   darwin: `osascript -e display notification ...`
//   linux:  `notify-send <title> <body>`
export const desktopNotifyCommand = (platform: string, title: string, body: string): { command: string; args: readonly string[] } | undefined => {
  const titleQ = quoteApple(title);
  const bodyQ = quoteApple(body);
  if (platform === "darwin") return { command: "osascript", args: ["-e", `display notification ${bodyQ} with title ${titleQ}`] };
  if (platform === "linux") return { command: "notify-send", args: [title, body] };
  return undefined;
};

// AppleScript string literal: double quotes, backslash and quote escaped.
const quoteApple = (value: string): string =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;

export function createDesktopNotifier(raw: DesktopNotifyOptions = {}): AttentionBoundary {
  const options = { platform: process.platform, ...raw };
  const timeoutMs = options.timeoutMs ?? 5000;
  const defaultRun = (commandName: string, args: readonly string[]): Promise<void> =>
    new Promise((resolvePromise, rejectPromise) => {
      execFile(commandName, [...args], { timeout: timeoutMs }, (error) => {
        if (error) rejectPromise(error);
        else resolvePromise();
      });
    });
  const defaultRunShell = (commandLine: string): Promise<void> =>
    new Promise((resolvePromise, rejectPromise) => {
      exec(commandLine, { timeout: timeoutMs }, (error) => {
        if (error) rejectPromise(error);
        else resolvePromise();
      });
    });
  const run = options.run ?? defaultRun;
  const runShell = options.runShell ?? defaultRunShell;
  return {
    async notify(notification: AttentionNotification): Promise<string> {
      if (options.command !== undefined) {
        const line = options.command
          .replace(/\{title\}/g, () => shellQuote(notification.title))
          .replace(/\{body\}/g, () => shellQuote(notification.body));
        await runShell(line);
        return `comando configurado: ${options.command}`;
      }
      const chosen = desktopNotifyCommand(options.platform, notification.title, notification.body);
      if (chosen === undefined) throw new Error(`sem canal de notificação de plataforma para ${options.platform}`);
      await run(chosen.command, chosen.args);
      return chosen.command;
    },
  };
}
