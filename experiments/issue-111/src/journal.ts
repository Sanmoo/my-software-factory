/**
 * The run journal: append-only evidence. Every observation the report cites is
 * a line here, so a claim can always be traced back to the run that produced it.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface JournalEntry {
	readonly at: number;
	readonly role: string;
	readonly event: string;
	readonly [key: string]: unknown;
}

/** What a caller supplies; the timestamp is the journal's own. */
export type JournalInput = { readonly role: string; readonly event: string } & Record<string, unknown>;

export class Journal {
	constructor(private readonly path: string) {}

	append(entry: JournalInput): JournalEntry {
		mkdirSync(dirname(this.path), { recursive: true });
		const line = { ...entry, at: Date.now() } as JournalEntry;
		appendFileSync(this.path, `${JSON.stringify(line)}\n`);
		return line;
	}

	read(): JournalEntry[] {
		if (!existsSync(this.path)) return [];
		return readFileSync(this.path, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as JournalEntry);
	}

	/** Entries written by one role, in order. */
	byRole(role: string): JournalEntry[] {
		return this.read().filter((entry) => entry.role === role);
	}

	last(event: string): JournalEntry | undefined {
		return this.read()
			.filter((entry) => entry.event === event)
			.at(-1);
	}
}
