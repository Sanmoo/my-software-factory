import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandBody, CommandQueue, OperatorCommand } from "../core/commands.js";

// One JSON file per command under <stateDir>/commands. The name starts with the wall
// clock and a per-process sequence, so sorting the names gives the queue order.
const DIRECTORY = "commands";
let sequence = 0;

const TYPES = ["reply", "resume", "release", "approve", "pause", "unpause"];

function isCommand(value: unknown): value is OperatorCommand {
  if (typeof value !== "object" || value === null) return false;
  const command = value as Record<string, unknown>;
  if (typeof command.id !== "string" || typeof command.type !== "string" || !TYPES.includes(command.type)) return false;
  if (command.type === "pause" || command.type === "unpause") return true;
  if (typeof command.job !== "string") return false;
  if (command.type === "reply") return typeof command.message === "string";
  return true;
}

export function createFileCommandQueue(stateDir: string): CommandQueue {
  const dir = join(stateDir, DIRECTORY);
  return {
    async enqueue(body: CommandBody): Promise<string> {
      await mkdir(dir, { recursive: true });
      sequence += 1;
      const id = `${String(Date.now()).padStart(15, "0")}-${String(sequence).padStart(9, "0")}-${randomUUID()}`;
      // Written under a temporary name and renamed, so a reader never sees a partial command.
      const file = join(dir, `${id}.json`);
      const temporary = `${file}.tmp`;
      await writeFile(temporary, JSON.stringify({ id, ...body }, null, 2) + "\n");
      await rename(temporary, file);
      return id;
    },

    async pending() {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { commands: [], unreadable: [] };
        throw error;
      }
      const result: { commands: OperatorCommand[]; unreadable: string[] } = { commands: [], unreadable: [] };
      for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
        try {
          const value: unknown = JSON.parse(await readFile(join(dir, name), "utf8"));
          if (isCommand(value)) result.commands.push(value);
          else result.unreadable.push(name);
        } catch {
          result.unreadable.push(name);
        }
      }
      return result;
    },

    async done(id: string): Promise<void> {
      await rm(join(dir, `${id}.json`), { force: true });
    },
  };
}
