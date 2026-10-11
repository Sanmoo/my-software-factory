import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FailureStore, HistoryRecord, HistoryStore } from "../core/observability.js";

// Local operational history (issue #15): one JSON line per event under <stateDir>/history, in
// a file per job. Events with no job go to the instance file. Files are private to the user:
// they can hold project content and human replies, and never go to Git. Appends are plain
// appends: no fsync, no lock, no promise of reconstructing processes.

const DIRECTORY = "history";
const INSTANCE_FILE = "_instance";

const fileFor = (stateDir: string, job: string | undefined): string =>
  join(stateDir, DIRECTORY, `${job === undefined ? INSTANCE_FILE : encodeURIComponent(job)}.jsonl`);

function isRecord(value: unknown): value is HistoryRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.at === "string" && typeof record.kind === "string" && typeof record.text === "string"
    && typeof record.fields === "object" && record.fields !== null && Array.isArray(record.lines);
}

export function createFileHistory(stateDir: string): HistoryStore {
  return {
    async append(record) {
      await mkdir(join(stateDir, DIRECTORY), { recursive: true, mode: 0o700 });
      await appendFile(fileFor(stateDir, record.job), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    },

    async read(job) {
      let text: string;
      try {
        text = await readFile(fileFor(stateDir, job), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], unreadable: 0 };
        throw error;
      }
      const result = { records: [] as HistoryRecord[], unreadable: 0 };
      for (const line of text.split("\n").filter((entry) => entry.trim() !== "")) {
        try {
          const value: unknown = JSON.parse(line);
          if (isRecord(value)) result.records.push(value);
          else result.unreadable += 1;
        } catch {
          result.unreadable += 1;
        }
      }
      return result;
    },
  };
}

// The sinks that are failing right now, for `status`. A file per instance state directory.
const FAILURE_FILE = join("observability", "failures.json");

export interface RecordedFailure {
  at: string;
  sink: string;
  message: string;
}

export async function readFailures(stateDir: string): Promise<RecordedFailure[]> {
  let text: string;
  try {
    text = await readFile(join(stateDir, FAILURE_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const value: unknown = JSON.parse(text);
  return Array.isArray(value) ? value.filter((entry): entry is RecordedFailure =>
    typeof entry === "object" && entry !== null && typeof entry.sink === "string" && typeof entry.message === "string") : [];
}

export function createFileFailureStore(stateDir: string): FailureStore {
  const write = async (failures: RecordedFailure[]): Promise<void> => {
    await mkdir(join(stateDir, "observability"), { recursive: true, mode: 0o700 });
    const file = join(stateDir, FAILURE_FILE);
    await writeFile(`${file}.tmp`, JSON.stringify(failures, null, 2) + "\n", { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  };
  const current = async (): Promise<RecordedFailure[]> => readFailures(stateDir).catch(() => []);
  return {
    async record(failure) {
      await write([...(await current()).filter((entry) => entry.sink !== failure.sink), failure]);
    },
    async clear(sink) {
      const failures = await current();
      if (failures.some((entry) => entry.sink === sink)) await write(failures.filter((entry) => entry.sink !== sink));
    },
  };
}
