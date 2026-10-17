import { watch, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { messageOf } from "../core/values.js";

// The wake source of the instance loop (issue #77, spec #74). Until now the loop only slept the
// configured interval, so the end of an assisted execution was perceived at the NEXT scan — up to
// `pollIntervalSeconds` after the container wrote its end record (measured at 300 s in the real
// operation, and the reason `t` right after Ctrl-C found the session still "open"). This seam
// makes the loop WAIT on the end-record channel instead: it resolves as soon as an
// `msf-exit.json` appears under `<stateDir>/assist` (recursive watch, the container wrapper writes
// it on the real end of the exec), and the plain timeout otherwise. An event that arrives while
// the loop is polling (not waiting) is not lost either: it wakes the NEXT wait at once. The
// periodic scan stays as the net: a watcher that cannot be installed (platform without recursive
// watch, an unreadable directory, a closed descriptor) degrades to the timeout alone — the loop
// never fails because of the watcher, it only loses the early wake.
//
// The seam is deliberately small and public (the spec asks for ONE new seam, tested like the
// execution-loop test: public, no admission, real tmpdir). It knows nothing about sessions or
// containers: it watches one directory for one file name, which keeps it honest and easy to test.

// The file name the container wrapper writes on the real end of an assisted exec
// (`runtime/assist-exec.ts`): unique enough to be recognized by name inside the watched tree.
export const EXIT_RECORD_NAME = "msf-exit.json";

// Why the wait ended: the record appeared, or the interval elapsed (including an aborted wait,
// which is just the loop's own signal ending the sleep — the caller checks `aborted` itself).
export type WakeReason = "record" | "timeout";

export interface WakeSource {
  // Waits at most `timeoutMs` for a record to appear; resolves immediately on abort (never
  // rejects), so the caller needs no try/catch around the sleep it replaces.
  wait(timeoutMs: number, signal: AbortSignal): Promise<WakeReason>;
  // Releases every watcher. Idempotent: a closed source only ever times out.
  close(): void;
}

export interface ExitRecordWakeOptions {
  // The instance state dir; the assisted areas live under `<stateDir>/assist` (the default watch).
  stateDir: string;
  // The directories to watch, when the caller wants to name them (default: `<stateDir>/assist`).
  dirs?: readonly string[];
  // Where a degradation is reported (the caller prints it in the main log). Absent: silent.
  onError?: (reason: string) => void;
}

const RECORD_SUFFIX = `/${EXIT_RECORD_NAME}`;

// Whether one watcher event names the end record. `fs.watch` gives the path relative to the
// watched dir (recursive watches included).
const namesRecord = (filename: string): boolean =>
  filename === EXIT_RECORD_NAME || filename.endsWith(RECORD_SUFFIX);

export async function createExitRecordWake(options: ExitRecordWakeOptions): Promise<WakeSource> {
  const dirs = options.dirs ?? [join(options.stateDir, "assist")];
  const watchers: FSWatcher[] = [];
  let wake: (() => void) | undefined;
  // A record event that arrived while the loop was POLLING (not waiting) is not lost: the next
  // wait resolves at once instead of sleeping the whole interval. The container writes the record
  // with a shell redirect (create + write), so the event may well land during the poll that the
  // first event itself triggered.
  let recordSeen = false;

  for (const dir of dirs) {
    try {
      // The assisted directory may not exist yet (a fresh state dir: it is born with the first
      // session area), so it is ensured before watching — otherwise the first execution would
      // never get its early wake.
      await mkdir(dir, { recursive: true });
      const watcher = watch(dir, { recursive: true }, (_event, filename) => {
        if (typeof filename !== "string") {
          // A platform that does not report the name: wake the waiter, but never leave a sticky
          // wake (that could turn every cycle into a busy loop).
          wake?.();
          return;
        }
        if (!namesRecord(filename)) return;
        recordSeen = true;
        wake?.();
      });
      // A watcher that dies later (descriptor exhaustion, directory removed) degrades the same
      // way as one that never started: reported once, the timeout remains.
      watcher.on("error", (error: unknown) => options.onError?.(messageOf(error)));
      watchers.push(watcher);
    } catch (error) {
      options.onError?.(messageOf(error));
    }
  }

  return {
    wait(timeoutMs: number, signal: AbortSignal): Promise<WakeReason> {
      return new Promise<WakeReason>((resolve) => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        function settle(reason: WakeReason): void {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          if (wake === onWake) wake = undefined;
          resolve(reason);
        }
        const onWake = (): void => { settle("record"); };
        const onAbort = (): void => { settle("timeout"); };
        if (signal.aborted) { settle("timeout"); return; }
        // The event of this very cycle (arrived while polling): resolve at once, once.
        if (recordSeen) { recordSeen = false; settle("record"); return; }
        timer = setTimeout(() => { settle("timeout"); }, timeoutMs);
        wake = onWake;
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
    close(): void {
      wake = undefined;
      recordSeen = false;
      for (const watcher of watchers.splice(0)) {
        try {
          watcher.close();
        } catch {
          // An already broken watcher has nothing to release.
        }
      }
    },
  };
}
