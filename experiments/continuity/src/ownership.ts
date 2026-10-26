/**
 * Ownership exclusion, scoped to this harness (the factory's global
 * concurrency problem is out of scope here).
 *
 * Two independent facts are tracked:
 *   owner.lock — who is conducting this work (the processing role).
 *   worker.json — the worker process, when one was launched.
 *
 * They are separate because the contract distinguishes them: the controller can
 * die while its worker survives, and the surviving worker must be recognized and
 * attached to, not duplicated. Both records carry a heartbeat, and liveness is
 * read from the OS (signal 0), never inferred from the file alone.
 *
 * This is an O_EXCL + pid-liveness protocol, not a kernel lock: a pid can be
 * recycled, so a stale record is a decision to take over, not a proof that
 * nothing is running. The report states that limit explicitly.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface OwnerRecord {
	readonly ownerId: string;
	readonly controllerPid: number;
	readonly attemptId: string;
	readonly startedAt: number;
	readonly heartbeatAt: number;
}

export interface WorkerRecord {
	readonly pid: number;
	readonly attemptId: string;
	readonly startedAt: number;
	readonly heartbeatAt: number;
}

export type OwnerState =
	| { readonly state: "free" }
	| { readonly state: "live"; readonly owner: OwnerRecord }
	| { readonly state: "stale"; readonly owner: OwnerRecord };

export type AcquireResult =
	| { readonly result: "acquired"; readonly owner: OwnerRecord }
	| { readonly result: "held"; readonly owner: OwnerRecord };

/** A second owner or a live worker already conducting the same execution. */
export class OwnershipConflict extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OwnershipConflict";
	}
}

export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export class Ownership {
	private readonly ownerPath: string;
	private readonly workerPath: string;

	constructor(
		private readonly dir: string,
		private readonly now: () => number = Date.now,
		private readonly alive: (pid: number) => boolean = isProcessAlive,
	) {
		this.ownerPath = join(dir, "owner.lock");
		this.workerPath = join(dir, "worker.json");
	}

	/** The owner record, without judging liveness. */
	owner(): OwnerRecord | undefined {
		return this.readJson<OwnerRecord>(this.ownerPath);
	}

	inspectOwner(): OwnerState {
		const owner = this.owner();
		if (!owner) return { state: "free" };
		return this.alive(owner.controllerPid) ? { state: "live", owner } : { state: "stale", owner };
	}

	acquire(ownerId: string, attemptId: string): AcquireResult {
		const current = this.inspectOwner();
		if (current.state !== "free") return { result: "held", owner: current.owner };
		mkdirSync(this.dir, { recursive: true });
		const at = this.now();
		const owner: OwnerRecord = {
			ownerId,
			controllerPid: process.pid,
			attemptId,
			startedAt: at,
			heartbeatAt: at,
		};
		writeFileSync(this.ownerPath, `${JSON.stringify(owner)}\n`, { flag: "wx" });
		return { result: "acquired", owner };
	}

	/**
	 * Take over a stale record after a crash. The attempt identity is carried over:
	 * an infrastructure interruption does not start a new attempt.
	 */
	takeover(ownerId: string): OwnerRecord {
		const current = this.owner();
		if (current && this.alive(current.controllerPid)) {
			throw new OwnershipConflict(`owner ${current.ownerId} is still alive (pid ${current.controllerPid})`);
		}
		mkdirSync(this.dir, { recursive: true });
		const at = this.now();
		const owner: OwnerRecord = {
			ownerId,
			controllerPid: process.pid,
			attemptId: current?.attemptId ?? ownerId,
			startedAt: current?.startedAt ?? at,
			heartbeatAt: at,
		};
		writeFileSync(this.ownerPath, `${JSON.stringify(owner)}\n`);
		return owner;
	}

	heartbeat(at: number = this.now()): void {
		const owner = this.owner();
		if (!owner) throw new OwnershipConflict("cannot heartbeat without an owner record");
		writeFileSync(this.ownerPath, `${JSON.stringify({ ...owner, heartbeatAt: at })}\n`);
	}

	release(): void {
		rmSync(this.ownerPath, { force: true });
	}

	/**
	 * The gate the contract requires before opening persisted state or launching a
	 * substitute. Two independent refusals: another live owner, and a live worker
	 * this process is not — a surviving worker whose controller died leaves a stale
	 * owner record, which is exactly when a substitute must not start.
	 */
	guardBeforeOpen(ownerId: string): void {
		const state = this.inspectOwner();
		if (state.state === "live" && state.owner.ownerId !== ownerId) {
			throw new OwnershipConflict(`live owner ${state.owner.ownerId} is conducting this execution`);
		}
		const worker = this.worker();
		if (worker && this.alive(worker.pid) && worker.pid !== process.pid && state.state !== "live") {
			throw new OwnershipConflict(`live worker ${worker.pid} is still conducting this execution`);
		}
	}

	recordWorker(attemptId: string, pid: number): WorkerRecord {
		mkdirSync(this.dir, { recursive: true });
		const at = this.now();
		const previous = this.worker();
		const worker: WorkerRecord = {
			pid,
			attemptId,
			startedAt: previous?.startedAt ?? at,
			heartbeatAt: at,
		};
		writeFileSync(this.workerPath, `${JSON.stringify(worker)}\n`);
		return worker;
	}

	worker(): WorkerRecord | undefined {
		return this.readJson<WorkerRecord>(this.workerPath);
	}

	/** A worker that outlived its controller: recover means recognize it. */
	liveWorker(): WorkerRecord | undefined {
		const worker = this.worker();
		return worker && this.alive(worker.pid) ? worker : undefined;
	}

	heartbeatWorker(at: number = this.now()): void {
		const worker = this.worker();
		if (!worker) throw new OwnershipConflict("cannot heartbeat without a worker record");
		writeFileSync(this.workerPath, `${JSON.stringify({ ...worker, heartbeatAt: at })}\n`);
	}

	clearWorker(): void {
		rmSync(this.workerPath, { force: true });
	}

	private readJson<T>(path: string): T | undefined {
		if (!existsSync(path)) return undefined;
		try {
			return JSON.parse(readFileSync(path, "utf8").trim()) as T;
		} catch {
			return undefined;
		}
	}
}
