/**
 * The controller: the role the factory plays. It is a separate process from the
 * worker, so that "the factory was stopped while the worker kept running" is a
 * real observation.
 *
 * It never opens the mechanism itself: it proves ownership, launches or attaches
 * to a worker, and applies the recovery decision from controller-policy.ts. The
 * attempt identity and the recovery ledger are the only things it writes.
 */
import { spawn } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	truncateSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decideRecovery, type RecoveryAction } from "./controller-policy.js";
import { ExternalWorld } from "./effects.js";
import { Journal } from "./journal.js";
import type { RunConfig } from "./mechanism.js";
import { Ownership } from "./ownership.js";
import { DEFAULT_RECOVERY_POLICY, RecoveryLedger } from "./recovery.js";
import { NO_FAULT } from "./workload.js";

const here = dirname(fileURLToPath(import.meta.url));
const workerPath = join(here, "worker.js");

const configPath = process.argv[2];
const mode = process.argv[3] ?? "launch";
if (!configPath) throw new Error("usage: controller <config.json> [launch|recover|hold]");

const config = JSON.parse(readFileSync(configPath, "utf8")) as RunConfig;
const journal = new Journal(config.journalPath);
const world = new ExternalWorld(config.worldPath);
const ownership = new Ownership(config.workDir);
const ledger = new RecoveryLedger(join(config.workDir, "recovery.json"), DEFAULT_RECOVERY_POLICY);
const attemptsDir = join(config.workDir, "attempts");
const dropsPath = join(config.workDir, "a-attempt-drops.json");

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Exit {
	readonly code: number | null;
	readonly signal: string | null;
}

function spawnWorker(attemptId: string, round: number, options: { fault?: RunConfig["fault"]; feedback?: string } = {}) {
	mkdirSync(attemptsDir, { recursive: true });
	const attemptConfig: RunConfig = {
		...config,
		attemptId,
		round,
		fault: options.fault ?? config.fault,
		...(options.feedback === undefined ? {} : { feedback: options.feedback }),
	};
	const attemptPath = join(attemptsDir, `attempt-${round}-${Date.now()}-${attemptId}.json`);
	writeFileSync(attemptPath, `${JSON.stringify(attemptConfig, null, 1)}\n`);
	const outFd = openSync(join(attemptsDir, "workers.out"), "a");
	const child = spawn(process.execPath, [workerPath, attemptPath], {
		detached: true,
		stdio: ["ignore", outFd, outFd],
	});
	child.unref();
	const pid = child.pid ?? 0;
	ownership.recordWorker(attemptId, pid);
	journal.append({ role: "controller", event: "worker-spawned", attemptId, round, pid });
	return child;
}

function waitForExit(child: ReturnType<typeof spawnWorker>, timeoutMs = 60_000): Promise<Exit> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("worker did not exit in time")), timeoutMs);
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

/** Did the attempt this worker was running end up complete? */
function attemptCompleted(attemptId: string, round: number): boolean {
	return journal
		.read()
		.some(
			(entry) => entry.event === "attempt-completed" && entry.attemptId === attemptId && entry.round === round,
		);
}

function workerRefused(): boolean {
	return journal.read().some((entry) => entry.event === "worker-refused" && entry.role === lastWorkerRole());
}

function stateUnusable(): boolean {
	return journal.read().some((entry) => entry.event === "state-unusable" && entry.role === lastWorkerRole());
}

function lastWorkerRole(): string {
	const spawned = journal.read().filter((entry) => entry.event === "worker-spawned").at(-1);
	return spawned ? `worker-${spawned.attemptId}-${spawned.round}` : "";
}

function attemptDrops(): number {
	if (!existsSync(dropsPath)) return 0;
	return (JSON.parse(readFileSync(dropsPath, "utf8")) as { drops: number }).drops;
}

function noteAttemptDrop(next: number): void {
	writeFileSync(dropsPath, `${JSON.stringify({ drops: next })}\n`);
}

/** A's rule from the current factory: a no-outcome drop becomes a new attempt. */
function nextAttemptId(): string {
	const drops = attemptDrops();
	noteAttemptDrop(drops + 1);
	return `attempt-${drops + 2}`;
}

/** The fault is a single event unless the exhausted-budget guardrail re-arms it. */
function recoveryFault(): RunConfig["fault"] {
	return config.repeatFault ? config.fault : NO_FAULT;
}

function corruptState(): void {
	if (config.corruptState === "none") return;
	if (config.corruptState === "storage-torn") {
		// A partial last write: the tail of the append-only log never landed.
		const jsonl = join(config.workDir, "storage-jsonl");
		const main = join(jsonl, "main.jsonl");
		if (existsSync(main)) {
			appendFileSync(main, '{"format":1,"type":"commit","seq":9');
			journal.append({ role: "controller", event: "state-corrupted", target: `${main} (tail)` });
		}
		return;
	}
	const pathFile = join(config.workDir, "session-path.txt");
	if (config.corruptState === "session") {
		if (existsSync(pathFile)) {
			const sessionFile = readFileSync(pathFile, "utf8").trim();
			if (existsSync(sessionFile)) truncateSync(sessionFile, 64);
			journal.append({ role: "controller", event: "state-corrupted", target: sessionFile });
		}
		return;
	}
	const sqlite = join(config.workDir, "storage.sqlite");
	const jsonl = join(config.workDir, "storage-jsonl");
	if (existsSync(sqlite)) {
		// Destroy the header and drop the WAL: no SQLite recovery path is left.
		const handle = openSync(sqlite, "r+");
		writeSync(handle, Buffer.alloc(100, 0x7f), 0, 100, 0);
		closeSync(handle);
		rmSync(`${sqlite}-wal`, { force: true });
		rmSync(`${sqlite}-shm`, { force: true });
		journal.append({ role: "controller", event: "state-corrupted", target: sqlite });
	} else if (existsSync(jsonl)) {
		// Destroy the first commit record: the append-only header is unreadable.
		const main = join(jsonl, "main.jsonl");
		if (existsSync(main)) {
			const handle = openSync(main, "r+");
			writeSync(handle, Buffer.alloc(32, 0x7f), 0, 32, 0);
			closeSync(handle);
		}
		journal.append({ role: "controller", event: "state-corrupted", target: jsonl });
	} else if (existsSync(pathFile)) {
		const sessionFile = readFileSync(pathFile, "utf8").trim();
		if (existsSync(sessionFile)) truncateSync(sessionFile, 64);
		journal.append({ role: "controller", event: "state-corrupted", target: sessionFile });
	}
}

function helpAlreadyRequested(): boolean {
	return journal.read().some((entry) => entry.event === "help-requested" || entry.event === "worker-paused");
}

function pauseHelp(reason: string): number {
	journal.append({ role: "controller", event: "help-requested", reason, attemptId: config.attemptId });
	return 30;
}

/** Wait for a worker we did not launch, and report how it ended. */
async function attachToLiveWorker(pid: number): Promise<number> {
	journal.append({ role: "controller", event: "attach-live-worker", pid, attemptId: config.attemptId });
	ownership.guardBeforeOpen(config.ownerId);
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (!isAlive(pid)) {
			const worker = ownership.worker();
			const done = worker ? attemptCompleted(worker.attemptId, 1) : false;
			journal.append({ role: "controller", event: "attached-worker-exited", pid, completed: done });
			return done ? 0 : 31;
		}
		await sleep(50);
	}
	return 31;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * One recovery cycle. Returns the process exit code, or undefined when another
 * cycle should run (the attempt was interrupted again).
 */
async function cycle(round: number): Promise<number | undefined> {
	if (helpAlreadyRequested()) {
		// The worker stopped on purpose: this is a pause, not an interruption to
		// recover from, and it must not consume the recovery budget.
		return 30;
	}
	if (workerRefused()) {
		return pauseHelp("second owner or worker refused the attempt");
	}

	const live = ownership.liveWorker();
	const ownerState = ownership.inspectOwner();
	const anotherOwner = ownerState.state === "live" && ownerState.owner.ownerId !== config.ownerId;

	const action: RecoveryAction = decideRecovery({
		mechanism: config.alternative,
		owner: ownerState,
		liveWorker: live,
		workerRunning: false,
		stateUnusable: stateUnusable(),
		anotherOwner,
		attemptDrops: attemptDrops(),
		budget: ledger.peek("worker-interrupted"),
	});

	if (action.action === "pause-help") return pauseHelp(action.reason);

	// A surviving worker is recognized by B and C, and relaunched-over by A.
	if (action.action === "attach-live-worker") return attachToLiveWorker(action.workerPid);

	if (action.action === "relaunch-new-attempt") {
		// A: the interruption releases a new attempt; branch and artifacts stay.
		const attemptId = nextAttemptId();
		journal.append({
			role: "controller",
			event: "relaunch-new-attempt",
			from: config.attemptId,
			to: attemptId,
			drops: attemptDrops(),
		});
		if (ownership.inspectOwner().state === "stale") ownership.takeover(config.ownerId);
		const child = spawnWorker(attemptId, round, { fault: recoveryFault() });
		const exit = await waitForExit(child);
		journal.append({ role: "controller", event: "worker-exit", ...exit, attemptId });
		if (stateUnusable()) return pauseHelp("persisted state is missing or invalid");
		return attemptCompleted(attemptId, round) ? 0 : nextCycle(attemptId, round);
	}

	// rebuild-from-confirmed: same attempt, from the last intact checkpoint.
	const decision = ledger.consume("worker-interrupted");
	if (decision.decision === "pause-help") return pauseHelp(decision.reason);
	if (ownership.inspectOwner().state === "stale") ownership.takeover(config.ownerId);
	journal.append({
		role: "controller",
		event: "recover-from-confirmed",
		attemptId: config.attemptId,
		waitMs: decision.waitMs,
		consumed: decision.consumed,
	});
	await sleep(decision.waitMs);
	corruptState();
	const child = spawnWorker(config.attemptId, round, { fault: recoveryFault() });
	const exit = await waitForExit(child);
	journal.append({ role: "controller", event: "worker-exit", ...exit, attemptId: config.attemptId });
	if (stateUnusable()) return pauseHelp("persisted state is missing or invalid");
	if (attemptCompleted(config.attemptId, round)) return 0;
	return cycle(round);
}

async function nextCycle(attemptId: string, round: number): Promise<number | undefined> {
	if (attemptCompleted(attemptId, round)) return 0;
	return cycle(round);
}

async function main(): Promise<number> {
	const role = "controller";

	if (mode === "hold") {
		const acquired = ownership.acquire(config.ownerId, config.attemptId);
		journal.append({ role, event: "hold", result: acquired.result });
		await sleep(600_000);
		return 0;
	}

	if (mode === "launch") {
		const acquired = ownership.acquire(config.ownerId, config.attemptId);
		if (acquired.result === "held") {
			journal.append({ role, event: "controller-refused", holder: acquired.owner.ownerId });
			return pauseHelp("another owner holds this execution");
		}
		journal.append({ role, event: "owner-acquired", ownerId: config.ownerId, attemptId: config.attemptId });

		const child = spawnWorker(config.attemptId, 1);
		if (config.killControllerAfterMilestone) {
			// Scenario 1: the factory is hard-stopped while the worker keeps running.
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				if (journal.read().some((entry) => entry.event === "attempt-opened")) break;
				await sleep(25);
			}
			journal.append({ role, event: "controller-killed", pid: process.pid, workerPid: child.pid ?? 0 });
			process.kill(process.pid, "SIGKILL");
			throw new Error("unreachable");
		}
		const exit = await waitForExit(child);
		journal.append({ role: "controller", event: "worker-exit", ...exit, attemptId: config.attemptId });
		if (stateUnusable() && config.alternative !== "A") return pauseHelp("persisted state is missing or invalid");
		if (attemptCompleted(config.attemptId, 1)) {
			return config.feedback ? startFeedbackRound() : 0;
		}
		if (helpAlreadyRequested()) return 30;
		// The attempt was interrupted: decide what recovery means.
		if (config.feedback) {
			journal.append({ role, event: "feedback-arrived", feedback: config.feedback });
			return startFeedbackRound();
		}
		return (await cycle(1)) ?? 0;
	}

	// mode === "recover": the factory has been restarted. The decision (attach,
	// rebuild, relaunch, or help) belongs to cycle(), which consults the policy.
	journal.append({ role, event: "controller-restarted", mode });
	if (attemptCompleted(config.attemptId, 1)) {
		if (config.feedback) return startFeedbackRound();
		// A worker that outlived its controller is recognized, not duplicated.
		const live = ownership.liveWorker();
		if (live) return attachToLiveWorker(live.pid);
		return 0;
	}
	if (config.feedback) {
		journal.append({ role, event: "feedback-arrived", feedback: config.feedback });
		return startFeedbackRound();
	}
	return (await cycle(1)) ?? 0;
}

/** Human feedback starts a new round with updated context. */
async function startFeedbackRound(): Promise<number> {
	const feedback = config.feedback;
	if (!feedback) return 0;
	journal.append({ role: "controller", event: "new-round", round: 2, reason: "human-feedback", feedback });
	if (ownership.inspectOwner().state !== "live") ownership.takeover(config.ownerId);
	const child = spawnWorker(config.attemptId, 2, { fault: NO_FAULT, feedback });
	const exit = await waitForExit(child);
	journal.append({ role: "controller", event: "worker-exit", ...exit, attemptId: config.attemptId });
	return attemptCompleted(config.attemptId, 2) ? 0 : 32;
}

main()
	.then((code) => process.exit(code))
	.catch((error: unknown) => {
		journal.append({
			role: "controller",
			event: "controller-failed",
			error: error instanceof Error ? error.message : String(error),
		});
		process.exit(1);
	});
