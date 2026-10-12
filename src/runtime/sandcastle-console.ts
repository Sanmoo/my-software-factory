import { format, stripVTControlCharacters } from "node:util";
import { relative } from "node:path";

// Sandcastle announces every file-logged run with two console.log lines: "[Agent] Started…" and
// "tail -f <its runtime.log>". The second one points at a file with nothing to follow (the activity
// is the runner's detailed log), so it misleads. Only those two lines are dropped, and only while an
// invocation has registered its runtime log; everything else passes untouched. If Sandcastle changes
// the text, the line simply shows up again.

const STARTED = /^\[Agent\] Started\b/;

export class SandcastleLineFilter {
  private readonly active = new Map<string, number>();

  // Registers the runtime log of one invocation; the returned function ends it. Concurrent
  // invocations have distinct paths, and a repeated path stays filtered until every holder is done.
  register(runtimeLogPath: string): () => void {
    this.active.set(runtimeLogPath, (this.active.get(runtimeLogPath) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const left = (this.active.get(runtimeLogPath) ?? 1) - 1;
      if (left <= 0) this.active.delete(runtimeLogPath);
      else this.active.set(runtimeLogPath, left);
    };
  }

  drops(args: unknown[]): boolean {
    if (this.active.size === 0) return false;
    const line = stripVTControlCharacters(format(...args)).trim();
    if (STARTED.test(line)) return true;
    for (const path of this.active.keys()) {
      // Sandcastle shows the path relative to the cwd when the repository is the cwd.
      if (line === `tail -f ${path}` || line === `tail -f ${relative(process.cwd(), path)}`) return true;
    }
    return false;
  }
}

const installed = new WeakSet<object>();

// Wraps target.log once per target; calling it again is a no-op.
export function installConsoleFilter(filter: SandcastleLineFilter, target: Pick<Console, "log"> = console): void {
  if (installed.has(target)) return;
  installed.add(target);
  const original = target.log.bind(target);
  target.log = (...args: unknown[]) => {
    if (!filter.drops(args)) original(...args);
  };
}
