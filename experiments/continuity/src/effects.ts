/**
 * The simulated external world (the "GitHub" side). It is deliberately dumb:
 * it records every mutation it is asked to perform, keyed by effect, and never
 * dedupes. Duplication is therefore observable rather than prevented, which is
 * what lets the experiment tell a mechanism that repeats external effects from
 * one that reconciles them first.
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface EffectRecord {
	readonly effectId: string;
	readonly mutationId: string;
	readonly step: number;
	readonly attemptId: string;
	readonly at: number;
}

/**
 * `present` — the effect is recorded and readable: the outside world confirmed it.
 * `absent`  — nothing recorded: safe to perform.
 * `ambiguous` — a torn/partial write: the evidence cannot decide, so the contract
 *               forbids guessing (help request), never a blind repeat.
 */
export type EffectEvidence = "present" | "absent" | "ambiguous";

export class ExternalWorld {
	constructor(private readonly path: string) {}

	perform(effectId: string, step: number, attemptId: string): EffectRecord {
		mkdirSync(dirname(this.path), { recursive: true });
		const record: EffectRecord = {
			effectId,
			mutationId: `${effectId}-${step}-${attemptId}-${Date.now()}`,
			step,
			attemptId,
			at: Date.now(),
		};
		appendFileSync(this.path, `${JSON.stringify(record)}\n`);
		return record;
	}

	/** A torn write: a valid line is visible with the effect already applied, and
	 * the record that would confirm it never landed intact. */
	performAmbiguous(effectId: string, step: number, attemptId: string): void {
		mkdirSync(dirname(this.path), { recursive: true });
		appendFileSync(this.path, `${JSON.stringify({ effectId, step, attemptId })}{"trunc`);
	}

	records(): Array<Partial<EffectRecord> & { readonly unreadable?: boolean }> {
		if (!existsSync(this.path)) return [];
		return readFileSync(this.path, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => {
				try {
					return JSON.parse(line) as Partial<EffectRecord>;
				} catch {
					return { unreadable: true }; // a torn write is evidence of something, not of nothing
				}
			});
	}

	/** What the outside world can tell us about one effect. */
	evidence(effectId: string): EffectEvidence {
		const lines = this.rawLines().filter((line) => line.includes(`"${effectId}"`));
		if (lines.length === 0) return "absent";
		const readable = lines.filter((line) => {
			try {
				const parsed = JSON.parse(line) as EffectRecord;
				return parsed.effectId === effectId && typeof parsed.mutationId === "string";
			} catch {
				return false;
			}
		});
		if (readable.length === 0) return "ambiguous";
		return "present";
	}

	/** Every asked-for mutation, including duplicates of the same effect. */
	mutations(effectId: string): Array<Partial<EffectRecord>> {
		return this.records().filter((record) => record.effectId === effectId);
	}

	duplicatedEffects(): string[] {
		const counts = new Map<string, number>();
		for (const record of this.records()) {
			if (!record.effectId) continue;
			counts.set(record.effectId, (counts.get(record.effectId) ?? 0) + 1);
		}
		return [...counts.entries()].filter(([, count]) => count > 1).map(([effectId]) => effectId);
	}

	private rawLines(): string[] {
		if (!existsSync(this.path)) return [];
		return readFileSync(this.path, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0);
	}
}

export function writeExternalWorld(path: string, lines: readonly string[]): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, lines.map((line) => `${line}\n`).join(""));
}
