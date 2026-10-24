/**
 * The three alternatives, each using its real resume mechanism:
 *
 *  A — baseline: every launch opens a NEW Pi session over a preserved `sessao/`
 *      directory with reconstructed context. The session files survive, but no
 *      launch selects one to continue, so nothing at step granularity is reused.
 *      (This is the factory's launch path as observed in src/runtime/sandcastle.ts
 *      and src/loop.ts; the deviations are Docker/Sandcastle and a real model.)
 *  B — native Pi session resume: `SessionManager.open` on the session file the
 *      previous process was writing, so confirmed tool results come back.
 *  C — pi durable: the same conversation reopened over persisted storage, where
 *      each tool call is a durable task whose intent is committed before it runs
 *      and whose replay policy decides what happens after a crash.
 *
 * Everything else — workload, model, tool body, step executor, fault injection,
 * guardrails — is identical across the three, so a difference in reused work is
 * attributable to the mechanism.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";

import type { MechanismKind } from "./controller-policy.js";
import type { ExternalWorld } from "./effects.js";
import type { Journal } from "./journal.js";
import { runStep, type StepRunHooks } from "./steps.js";
import { type FaultSpec, WORKLOAD, type Step, stepAt } from "./workload.js";

export interface RunConfig {
	readonly runId: string;
	/** The configuration label, for citing this run in the report. */
	readonly label: string;
	readonly scenario: string;
	readonly alternative: MechanismKind;
	readonly guardrails: boolean;
	readonly replaySafe: boolean;
	readonly storage: "sqlite" | "jsonl";
	readonly fault: FaultSpec;
	readonly round: number;
	readonly feedback?: string;
	/** Corrupt the mechanism's persisted state before the next recovery. */
	readonly corruptState: "none" | "session" | "storage" | "torn-tail";
	/** Scenario 1: hard-stop the controller once the worker has opened the attempt. */
	readonly killControllerAfterMilestone: boolean;
	/** Re-arm the fault on every recovery (the exhausted-budget guardrail). */
	readonly repeatFault: boolean;
	/** Time each step takes, so a worker is still running while a controller restarts. */
	readonly stepDelayMs: number;
	readonly workDir: string;
	readonly sessionsDir: string;
	readonly agentDir: string;
	readonly journalPath: string;
	readonly worldPath: string;
	readonly ownerId: string;
	readonly attemptId: string;
	readonly reconstructedContext: string;
}

export interface Mechanism {
	readonly kind: MechanismKind;
	/** Which steps the mechanism itself already records as confirmed. */
	confirmedSteps(): Promise<number[]>;
	/** Step indices whose tool call was interrupted and never confirmed. */
	interruptedSteps(): Promise<number[]>;
	/** How this mechanism reports an interruption: a recorded fact, or an
	 * inference from a call left without a result. */
	interruptedFactKind(): "recorded" | "inferred";
	/** A list of what the resume left in place, for the report. */
	resumeFacts(): Promise<Record<string, unknown>>;
	/** The text the model would see next, so a new round's context can be checked. */
	contextText(): Promise<string>;
	/** Run the agent until the workload completes or the injected point kills this process. */
	drive(): Promise<void>;
	/** Human feedback begins a new round with updated context. */
	startRound(feedback: string): Promise<void>;
	close(): Promise<void>;
}

export interface MechanismDeps {
	readonly config: RunConfig;
	readonly journal: Journal;
	readonly world: ExternalWorld;
	readonly kill: () => never;
	/** Stop the worker and ask for help. */
	readonly pause: (reason: string) => never;
}

/**
 * The two libraries hand back different message unions (Pi's session entries
 * carry `AgentMessage`, durable carries pi-ai's `Message`), so the readers work
 * structurally on both and narrow at runtime.
 */
function toolCallsOf(message: unknown): ToolCall[] {
	const candidate = message as { role?: unknown; content?: unknown } | undefined;
	if (!candidate || candidate.role !== "assistant" || !Array.isArray(candidate.content)) return [];
	return candidate.content.filter(
		(block): block is ToolCall =>
			typeof block === "object" && block !== null && (block as { type?: unknown }).type === "toolCall",
	);
}

function toolResultOf(message: unknown): ToolResultMessage | undefined {
	const candidate = message as { role?: unknown; toolCallId?: unknown; isError?: unknown } | undefined;
	if (!candidate || candidate.role !== "toolResult" || typeof candidate.toolCallId !== "string") return undefined;
	return candidate as ToolResultMessage;
}

function stepArgument(call: ToolCall): number | undefined {
	const step = (call.arguments as { step?: unknown }).step;
	return typeof step === "number" ? step : undefined;
}

/** Confirmed steps, and calls left without a result. */
interface StepFacts {
	readonly confirmed: number[];
	/** Steps that were requested but never confirmed. */
	readonly unconfirmed: number[];
}

function factsFromMessages(messages: readonly unknown[]): StepFacts {
	const calls = new Map<string, number>();
	const settled = new Set<string>();
	const confirmed: number[] = [];
	for (const message of messages) {
		for (const call of toolCallsOf(message)) {
			const step = stepArgument(call);
			if (step !== undefined) calls.set(call.id, step);
		}
		const result = toolResultOf(message);
		if (result) {
			settled.add(result.toolCallId);
			const step = calls.get(result.toolCallId);
			if (step !== undefined && !result.isError) confirmed.push(step);
		}
	}
	return {
		confirmed,
		unconfirmed: [...calls.entries()].filter(([id]) => !settled.has(id)).map(([, step]) => step),
	};
}

/**
 * The deterministic model script: one tool call per unconfirmed step, with the
 * `between-steps` fault injected at the response that would start the target
 * step, so every earlier result is already recorded when the process dies.
 */
function scriptFor(deps: MechanismDeps, remaining: readonly Step[], faux: ReturnType<typeof fauxProvider>): void {
	const { fault } = deps.config;
	const queue = [...remaining];
	faux.setResponses([
		...queue.map(() => () => {
			const step = queue.shift();
			if (!step) return fauxAssistantMessage("work complete");
			if (fault.point === "between-steps" && fault.atStep === step.index) {
				deps.journal.append({ role: "worker", event: "kill-between-steps", step: step.index });
				deps.kill();
			}
			return fauxAssistantMessage(fauxToolCall("record_step", { step: step.index }), { stopReason: "toolUse" });
		}),
		fauxAssistantMessage("work complete"),
	]);
}

function remainingSteps(confirmed: ReadonlySet<number>): Step[] {
	return WORKLOAD.filter((step) => !confirmed.has(step.index));
}

function messageText(message: unknown): string {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (typeof block === "string") return block;
			const text = (block as { text?: unknown }).text;
			return typeof text === "string" ? text : "";
		})
		.join("\n");
}

function stepHooks(deps: MechanismDeps, confirmed: ReadonlySet<number>): StepRunHooks {
	return {
		attemptId: deps.config.attemptId,
		guardrails: deps.config.guardrails,
		journal: deps.journal,
		world: deps.world,
		fault: deps.config.fault,
		confirmed,
		kill: deps.kill,
		stepDelayMs: deps.config.stepDelayMs,
		round: deps.config.round,
		pause: deps.pause,
	};
}

/* ------------------------------------------------------------------ A and B */

const sessionPathFile = (config: RunConfig) => join(config.workDir, "session-path.txt");

async function openPi(deps: MechanismDeps): Promise<Mechanism> {
	const { config } = deps;
	const faux = fauxProvider();
	const runtime = await ModelRuntime.create({
		allowModelNetwork: false,
		refreshOnCreate: false,
		authPath: join(config.agentDir, "auth.json"),
		modelsPath: null,
	});
	runtime.registerNativeProvider(faux.provider);

	// A never selects a stored session; B continues the one on disk when present.
	const pathFile = sessionPathFile(config);
	const storedPath = existsSync(pathFile) ? readFileSync(pathFile, "utf8").trim() : "";
	const resuming = config.alternative === "B" && storedPath.length > 0;
	let manager = resuming
		? SessionManager.open(storedPath)
		: SessionManager.create(config.workDir, config.sessionsDir);
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"];

	async function openSession(sessionManager: SessionManager): Promise<void> {
		const resourceLoader = new DefaultResourceLoader({
			cwd: config.workDir,
			agentDir: config.agentDir,
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "record_step",
						label: "Record step",
						description: "Perform one workload step",
						parameters: Type.Object({ step: Type.Number() }),
						execute: async (_id, params) => {
							const facts = factsFromMessages(branchMessages(manager));
							const result = await runStep(stepAt(params.step), stepHooks(deps, new Set(facts.confirmed)));
							return {
								content: [{ type: "text", text: result.text }],
								details: { disposition: result.disposition },
							};
						},
					});
				},
			],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "You perform workload steps, one step per turn.",
		});
		await resourceLoader.reload();
		const created = await createAgentSession({
			cwd: config.workDir,
			agentDir: config.agentDir,
			modelRuntime: runtime,
			model: faux.getModel(),
			thinkingLevel: "off",
			resourceLoader,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
			sessionManager,
		});
		session = created.session;
		if (session.sessionFile) writeFileSync(pathFile, `${session.sessionFile}\n`);
	}

	function branchMessages(current: SessionManager): unknown[] {
		return current.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message as unknown] : []));
	}

	await openSession(manager);
	deps.journal.append({
		role: "worker",
		event: "session-opened",
		alternative: config.alternative,
		mode: resuming ? "resume" : "new",
		storedSessionPresent: storedPath.length > 0,
	});

	const confirmed = (): number[] =>
		// A's launch path reads no previous session, so it confirms nothing, even
		// though the session files are still on disk.
		config.alternative === "A" ? [] : factsFromMessages(branchMessages(manager)).confirmed;

	async function drive(): Promise<void> {
		const known = new Set(confirmed());
		const remaining = remainingSteps(known);
		scriptFor(deps, remaining, faux);
		deps.journal.append({
			role: "worker",
			event: "drive",
			confirmed: [...known].sort((a, b) => a - b),
			remaining: remaining.map((step) => step.index),
		});
		await session.prompt(config.reconstructedContext);
		deps.journal.append({ role: "worker", event: "drive-returned" });
	}

	return {
		kind: config.alternative,
		confirmedSteps: async () => confirmed(),
		interruptedSteps: async () =>
			config.alternative === "A" ? [] : factsFromMessages(branchMessages(manager)).unconfirmed,
		// The native session has no interrupted marker: a call without a result is
		// all it offers, so anything read from it is an inference.
		interruptedFactKind: () => "inferred",
		resumeFacts: async () => ({
			mechanism: config.alternative,
			sessionFile: session.sessionFile ?? null,
			resumedSameFile: resuming,
			storedSessionsOnDisk: existsSync(pathFile),
			confirmed: confirmed(),
		}),
		contextText: async () => branchMessages(manager).map(messageText).join("\n"),
		drive,
		async startRound(feedback) {
			// A new round with updated context is a new session, never a blind resume.
			session.dispose();
			manager = SessionManager.create(config.workDir, config.sessionsDir);
			await openSession(manager);
			scriptFor(deps, remainingSteps(new Set()), faux);
			deps.journal.append({ role: "worker", event: "round-started", round: config.round, feedback });
			await session.prompt(feedback);
		},
		async close() {
			session.dispose();
		},
	};
}

/* ------------------------------------------------------------------------ C */

async function openDurable(deps: MechanismDeps): Promise<Mechanism> {
	const { config } = deps;
	const storage =
		config.storage === "sqlite"
			? await openNodeSqliteStorage(join(config.workDir, "storage.sqlite"))
			: await openNodeJsonlStorage(join(config.workDir, "storage-jsonl"), BACKGROUND_CONTEXT, { fsync: true });

	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);

	const tool = defineTool({
		name: "record_step",
		description: "Perform one workload step",
		parameters: Type.Object({ step: Type.Number() }),
		// The effect steps mutate the outside world, so `unsafe` is the honest
		// declaration; the safe variant exists only to measure what it costs.
		replay: config.replaySafe ? "safe" : "unsafe",
		execute: async (args: { step: number }, api) => {
			const known = new Set(await confirmed());
			deps.journal.append({
				role: "worker",
				event: "tool-task",
				step: args.step,
				callId: api.callId,
				taskId: api.taskId,
				replay: config.replaySafe ? "safe" : "unsafe",
			});
			const result = await runStep(stepAt(args.step), stepHooks(deps, known));
			return { output: [{ type: "text" as const, text: result.text }] };
		},
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "workload", tools: [tool] }));

	const harness = await Harness.open(
		storage,
		{ models, registry, env: () => new NodeExecutionEnv({ cwd: config.workDir }) },
		BACKGROUND_CONTEXT,
	);
	const root = await harness.root(BACKGROUND_CONTEXT, {
		agent: { model: { provider: "faux", modelId: "faux-1" } },
	});
	const submissionPath = join(config.workDir, "submission.txt");

	async function messages(): Promise<unknown[]> {
		const view = await root.context(BACKGROUND_CONTEXT);
		return [...view.messages];
	}

	async function confirmed(): Promise<number[]> {
		return factsFromMessages(await messages()).confirmed;
	}

	async function interrupted(): Promise<number[]> {
		// Durable records the interruption itself: the tool result exists and is an
		// error, so this is a fact rather than an inference from a missing result.
		const view = await root.context(BACKGROUND_CONTEXT);
		const calls = new Map<string, number>();
		const interruptedSteps: number[] = [];
		for (const entry of view.entries) {
			const message = entry.model?.[0];
			for (const call of toolCallsOf(message)) {
				const step = stepArgument(call);
				if (step !== undefined) calls.set(call.id, step);
			}
			const result = toolResultOf(message);
			if (result?.isError) {
				const step = calls.get(result.toolCallId);
				if (step !== undefined) interruptedSteps.push(step);
			}
		}
		return interruptedSteps;
	}

	function writeSubmission(id: unknown): void {
		writeFileSync(submissionPath, `${String(id)}\n`);
	}

	async function drive(): Promise<void> {
		const known = new Set(await confirmed());
		const remaining = remainingSteps(known);
		scriptFor(deps, remaining, faux);
		deps.journal.append({
			role: "worker",
			event: "drive",
			confirmed: [...known].sort((a, b) => a - b),
			remaining: remaining.map((step) => step.index),
		});

		const previous = existsSync(submissionPath) ? readFileSync(submissionPath, "utf8").trim() : "";
		const submission = previous ? await harness.submission(previous as never, BACKGROUND_CONTEXT) : undefined;
		harness.resume();
		if (submission) {
			const settled = await submission.wait(BACKGROUND_CONTEXT);
			deps.journal.append({
				role: "worker",
				event: "submission-settled",
				status: settled.status,
				reacquired: true,
			});
		} else {
			const created = await root.submit({ type: "input", content: config.reconstructedContext }, BACKGROUND_CONTEXT);
			writeSubmission(created.id);
			const settled = await created.wait(BACKGROUND_CONTEXT);
			deps.journal.append({
				role: "worker",
				event: "submission-settled",
				status: settled.status,
				reacquired: false,
			});
		}
		deps.journal.append({ role: "worker", event: "drive-returned" });
	}

	return {
		kind: "C",
		confirmedSteps: confirmed,
		interruptedSteps: interrupted,
		// Durable commits an error tool result for the interrupted call: a fact.
		interruptedFactKind: () => "recorded",
		resumeFacts: async () => {
			const inspection = await harness.inspect(BACKGROUND_CONTEXT);
			return {
				mechanism: "C",
				storage: config.storage,
				replay: config.replaySafe ? "safe" : "unsafe",
				conversation: root.id,
				liveTasks: Object.keys(inspection.tasks ?? {}).length,
				confirmed: await confirmed(),
				interrupted: await interrupted(),
			};
		},
		contextText: async () => (await messages()).map(messageText).join("\n"),
		drive,
		async startRound(feedback) {
			// Durable's own mechanism for a new round: a reset carrying the feedback as
			// the handoff message, so the old execution is not blindly continued.
			await root.reset(feedback, BACKGROUND_CONTEXT);
			deps.journal.append({ role: "worker", event: "round-started", round: config.round, feedback });
			scriptFor(deps, remainingSteps(new Set(await confirmed())), faux);
			const created = await root.submit({ type: "input", content: feedback }, BACKGROUND_CONTEXT);
			writeSubmission(created.id);
			const settled = await created.wait(BACKGROUND_CONTEXT);
			deps.journal.append({ role: "worker", event: "submission-settled", status: settled.status, reacquired: false });
		},
		async close() {
			await harness.close(BACKGROUND_CONTEXT);
		},
	};
}

export async function openMechanism(deps: MechanismDeps): Promise<Mechanism> {
	mkdirSync(deps.config.workDir, { recursive: true });
	return deps.config.alternative === "C" ? openDurable(deps) : openPi(deps);
}
