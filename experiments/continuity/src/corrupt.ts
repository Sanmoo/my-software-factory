/**
 * Damage the persisted state of one mechanism, for the "missing or invalid state"
 * guardrail. The orchestrator does this between phases, for every mechanism, so
 * the case is exercised for each alternative rather than only where a recovery
 * branch happens to reach it.
 *
 * `absent` and `torn-tail` matter for the append-only backends: a torn tail is a
 * partial last write, which an append-only log may simply drop (silent loss)
 * instead of refusing.
 */
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, rmSync, truncateSync, writeSync } from "node:fs";
import { join } from "node:path";

import type { Journal } from "./journal.js";
import type { RunConfig } from "./mechanism.js";

export type Corruption = "none" | "session" | "storage" | "torn-tail";

/** Where the mechanism keeps its state, for the given corruption. */
export function corruptState(config: RunConfig, journal: Journal): void {
	if (config.corruptState === "none") return;
	const sessionFile = sessionPath(config);
	const sqlite = join(config.workDir, "storage.sqlite");
	const jsonlMain = join(config.workDir, "storage-jsonl", "main.jsonl");

	if (config.corruptState === "torn-tail") {
		// A partial last write: valid up to the tail, never completed.
		if (config.alternative === "C" && config.storage === "jsonl" && existsSync(jsonlMain)) {
			appendFileSync(jsonlMain, '{"format":1,"type":"commit","seq":9');
			journal.append({ role: "controller", event: "state-corrupted", kind: "torn-tail", target: jsonlMain });
			return;
		}
		if (sessionFile && existsSync(sessionFile)) {
			appendFileSync(sessionFile, '{"type":"message","id":"torn","message":');
			journal.append({ role: "controller", event: "state-corrupted", kind: "torn-tail", target: sessionFile });
		}
		return;
	}

	if (config.alternative === "C") {
		if (existsSync(sqlite)) {
			// Destroy the header and drop the WAL: no SQLite recovery path is left.
			const handle = openSync(sqlite, "r+");
			writeSync(handle, Buffer.alloc(100, 0x7f), 0, 100, 0);
			closeSync(handle);
			rmSync(`${sqlite}-wal`, { force: true });
			rmSync(`${sqlite}-shm`, { force: true });
			journal.append({ role: "controller", event: "state-corrupted", kind: "invalid", target: sqlite });
			return;
		}
		if (existsSync(jsonlMain)) {
			const handle = openSync(jsonlMain, "r+");
			writeSync(handle, Buffer.alloc(32, 0x7f), 0, 32, 0);
			closeSync(handle);
			journal.append({ role: "controller", event: "state-corrupted", kind: "invalid", target: jsonlMain });
			return;
		}
	}

	if (sessionFile && existsSync(sessionFile)) {
		truncateSync(sessionFile, 64);
		journal.append({ role: "controller", event: "state-corrupted", kind: "invalid", target: sessionFile });
	}
}

export function sessionPath(config: RunConfig): string | undefined {
	const pathFile = join(config.workDir, "session-path.txt");
	if (!existsSync(pathFile)) return undefined;
	const path = readFileSync(pathFile, "utf8").trim();
	return path.length > 0 ? path : undefined;
}
