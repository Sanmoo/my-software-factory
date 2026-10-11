import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InstanceControl } from "../core/instance-control.js";

// The pause flag lives in <stateDir>/control/state.json. A missing file means not paused;
// an unreadable file is an error, never a silent "not paused" (unknown is not absent).
const FILE = join("control", "state.json");

export function createFileInstanceControl(stateDir: string): InstanceControl {
  const file = join(stateDir, FILE);
  return {
    async isPaused(): Promise<boolean> {
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      const value = JSON.parse(raw) as { paused?: unknown };
      if (typeof value.paused !== "boolean") throw new Error(`estado de controle ilegível: ${FILE}`);
      return value.paused;
    },

    async setPaused(paused: boolean): Promise<void> {
      await mkdir(join(stateDir, "control"), { recursive: true });
      const temporary = `${join(stateDir, FILE)}.tmp`;
      await writeFile(temporary, JSON.stringify({ paused }, null, 2) + "\n");
      await rename(temporary, join(stateDir, FILE));
    },
  };
}
