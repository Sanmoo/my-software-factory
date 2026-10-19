/**
 * The worker: the process that conducts one attempt of the work. It is a
 * separate OS process from the controller so that "the factory died, the worker
 * lives" is a real observation rather than a simulated flag.
 *
 * It never opens persisted state before proving ownership, it heartbeats while
 * it runs, and it dies by SIGKILL at the injected fault point — exactly like an
 * infrastructure interruption, not a graceful shutdown.
 */
import { readFileSync } from "node:fs";
import { ExternalWorld } from "./effects.js";
import { Journal } from "./journal.js";
import { openMechanism, type RunConfig } from "./mechanism.js";
import { Ownership, OwnershipConflict } from "./ownership.js";

const configPath = process.argv[2];
if (!configPath) throw new Error("usage: worker <config.json>");
const config = JSON.parse(readFileSync(configPath, "utf8")) as RunConfig;

const journal = new Journal(config.journalPath);
const world = new ExternalWorld(config.worldPath);
const ownership = new Ownership(config.workDir);
const role = `worker-${config.attemptId}-${config.round}`;

const pause = (reason: string): never => {
	journal.append({ role, event: "worker-paused", reason, attemptId: config.attemptId });
	process.exit(30);
};

const kill = (): never => {
	journal.append({ role, event: "kill-self", attemptId: config.attemptId, round: config.round });
	process.kill(process.pid, "SIGKILL");
	throw new Error("unreachable");
};

async function main(): Promise<number> {
	// The contract before opening persisted state or launching a substitute.
	try {
		ownership.guardBeforeOpen(config.ownerId);
	} catch (error) {
		journal.append({
			role,
			event: "worker-refused",
			reason: error instanceof OwnershipConflict ? error.message : String(error),
		});
		return 20;
	}

	const beat = setInterval(() => {
		try {
			ownership.heartbeatWorker();
		} catch {
			// A missing worker record means the controller released the work; the
			// worker keeps running and the controller's decision sees it live.
		}
	}, 200);

	let mechanism;
	try {
		mechanism = await openMechanism({ config, journal, world, kill, pause });
	} catch (error) {
		// An unusable persisted state is not an attempt failure: it is a help request.
		journal.append({ role, event: "state-unusable", error: error instanceof Error ? error.message : String(error) });
		clearInterval(beat);
		return 4;
	}

	try {
		const facts = await mechanism.resumeFacts();
		journal.append({
			role,
			event: "attempt-opened",
			attemptId: config.attemptId,
			round: config.round,
			alternative: config.alternative,
			confirmed: await mechanism.confirmedSteps(),
			interrupted: await mechanism.interruptedSteps(),
			facts,
		});

		if (config.round > 1 && config.feedback) {
			await mechanism.startRound(config.feedback);
			const present = await feedbackPresent(mechanism, config.feedback);
			journal.append({
				role,
				event: "feedback-in-context",
				round: config.round,
				present,
				feedback: config.feedback,
			});
		} else {
			await mechanism.drive();
		}

		journal.append({
			role,
			event: "attempt-settled",
			attemptId: config.attemptId,
			round: config.round,
			confirmed: await mechanism.confirmedSteps(),
			interrupted: await mechanism.interruptedSteps(),
			// Durable records an interruption itself (an error tool result); the
			// native session only allows inferring it from a missing result.
			interruptedRecorded: config.alternative === "C",
		});
		journal.append({
			role,
			event: "attempt-completed",
			attemptId: config.attemptId,
			round: config.round,
			confirmed: await mechanism.confirmedSteps(),
		});
		return 0;
	} finally {
		clearInterval(beat);
		await mechanism.close().catch(() => undefined);
	}
}

/** Did the new round's context actually carry the human's feedback? */
async function feedbackPresent(
	mechanism: Awaited<ReturnType<typeof openMechanism>>,
	feedback: string,
): Promise<boolean> {
	return (await mechanism.contextText()).includes(feedback);
}

main()
	.then((code) => {
		journal.append({ role, event: "worker-exit", code });
		process.exit(code);
	})
	.catch((error: unknown) => {
		journal.append({ role, event: "worker-failed", error: error instanceof Error ? error.message : String(error) });
		process.exit(1);
	});
