import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AssistAreaFs, ExitRecordVerdict } from "../core/assist-flow.js";
import type { AssistSession } from "../core/assist-session.js";
import { messageOf } from "../core/values.js";
import { assistExitRecordPath, parseAssistExecExitRecord } from "../runtime/assist-exec.js";

// The real fs authority of the assisted session areas (spec #48): every host file of an
// assisted attendance is read or written only here, so the core flow carries no node runtime
// imports. Same discipline as the other state stores: this is simple local state, not a
// database — no fsync, no locking beyond the core's single-writer saves.
export function createFileAssistAreaFs(): AssistAreaFs {
  return {
    async readExitRecord(path: string): Promise<ExitRecordVerdict> {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "running" };
        return { kind: "unknown", reason: `registro de fim de execução ilegível: ${messageOf(error)}` };
      }
      try {
        return { kind: "ended", record: parseAssistExecExitRecord(text) };
      } catch (error) {
        return { kind: "unknown", reason: messageOf(error) };
      }
    },

    async listSessionTexts(dir: string): Promise<string[]> {
      const walk = async (path: string): Promise<string[]> => {
        const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
        const files: string[] = [];
        for (const entry of entries) {
          if (entry.isDirectory()) files.push(...await walk(join(path, entry.name)));
          else if (entry.name.endsWith(".jsonl")) files.push(join(path, entry.name));
        }
        return files.sort();
      };
      return Promise.all((await walk(dir)).map(async (file) => readFile(file, "utf8").catch(() => "")));
    },

    async listDir(path: string): Promise<string[]> {
      return readdir(path);
    },

    async ensureDirs(paths: string[]): Promise<void> {
      for (const path of paths) await mkdir(path, { recursive: true });
    },

    async removeExitRecord(session: AssistSession): Promise<boolean> {
      try {
        await rm(assistExitRecordPath(session.execStateDir ?? ""));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },

    async exists(path: string): Promise<boolean> {
      return stat(path).then(() => true, () => false);
    },

    attemptUuid(): string {
      return randomUUID().slice(0, 8);
    },
  };
}
