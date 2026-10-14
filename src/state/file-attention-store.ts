import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AttentionPending, AttentionStore, LoadedAttention } from "../core/attention.js";
import { isPending } from "../core/attention.js";

// One JSON file per pending in `state/<instância>/pendencias/`. Same discipline as the job and
// assist-session stores (temporary file renamed over the target): a reader never sees a
// half-written pending. The id contains `|`, so the file name encodes it. No fsync or event
// sourcing is promised: this is local operable state, not a database.

const fileNameFor = (id: string): string => `${encodeURIComponent(id)}.json`;

export function createFileAttentionStore(dir: string): AttentionStore {
  return {
    async load(): Promise<LoadedAttention> {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { pendings: [], unreadable: [] };
        throw error;
      }
      const loaded: LoadedAttention = { pendings: [], unreadable: [] };
      for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
        try {
          const value: unknown = JSON.parse(await readFile(join(dir, name), "utf8"));
          if (isPending(value)) loaded.pendings.push(value);
          else loaded.unreadable.push(name);
        } catch {
          loaded.unreadable.push(name);
        }
      }
      return loaded;
    },

    async save(pending: AttentionPending): Promise<void> {
      await mkdir(dir, { recursive: true });
      const file = join(dir, fileNameFor(pending.id));
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(pending, null, 2) + "\n");
      await rename(temporary, file);
    },

    async remove(id: string): Promise<void> {
      await rm(join(dir, fileNameFor(id)), { force: true });
    },
  };
}
