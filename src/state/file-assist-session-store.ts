import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssistSession, AssistSessionStore, LoadedAssistSessions } from "../core/assist-session.js";
import { isSession } from "../core/assist-session.js";

// One JSON file per assisted session in `state/<instância>/assist-sessions/`. Same discipline
// as the job store (temporary file renamed over the target): a reader never sees a half-written
// session. No fsync or replay is promised: this is a simple local state, not a database.

const fileNameFor = (key: string): string => `${encodeURIComponent(key)}.json`;

export function createFileAssistSessionStore(dir: string): AssistSessionStore {
  return {
    async load(): Promise<LoadedAssistSessions> {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sessions: [], unreadable: [] };
        throw error;
      }
      const loaded: LoadedAssistSessions = { sessions: [], unreadable: [] };
      for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
        try {
          const value: unknown = JSON.parse(await readFile(join(dir, name), "utf8"));
          if (isSession(value)) loaded.sessions.push(value);
          else loaded.unreadable.push(name);
        } catch {
          loaded.unreadable.push(name);
        }
      }
      return loaded;
    },

    async save(session: AssistSession): Promise<void> {
      await mkdir(dir, { recursive: true });
      const file = join(dir, fileNameFor(session.key));
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(session, null, 2) + "\n");
      await rename(temporary, file);
    },

    async remove(key: string): Promise<void> {
      await rm(join(dir, fileNameFor(key)), { force: true });
    },
  };
}
