import type { PiEvent } from "./pi-events.js";
import type { RunModels } from "./docker-config.js";
import type { RunnerOutput } from "./runner.js";
import { isObject } from "../core/values.js";

// Turns the Pi event stream of one invocation into the runner's output (R07, R08, R09).
// Fail-closed: anything that cannot be reconciled is an interruption, never a success.

export const RESULT_PATTERN = /<msf-result>([\s\S]*?)<\/msf-result>/g;
const NOTIFY_PATTERN = /Background task completed: \*\*([^*]+)\*\*/g;
const ROLES = ["implementer", "reviewer-standards", "reviewer-spec", "default"] as const;
type Role = (typeof ROLES)[number];

export interface InterpretInput {
  events: PiEvent[];
  // True when Sandcastle matched the completion signal; otherwise the iterations ran out.
  completed: boolean;
  models: RunModels;
  baseSha: string;
  headSha: string;
  diffSha256: string;
  specSha256: string;
  standardsSha256: string;
}

export interface Interpretation {
  output: RunnerOutput;
  // Human-readable lines for the run's audit log: subagent models, default uses, the limit outcome.
  audit: string[];
}

interface Launch {
  toolCallId: string;
  agent: string;
  async: boolean;
  model: string | undefined;
}

const interrupted = (reason: string, audit: string[]): Interpretation => ({
  output: { kind: "finished", results: [{ status: "interrupted", reason }] },
  audit,
});

export function interpretOutput(input: InterpretInput): Interpretation {
  const audit: string[] = [];
  const { events } = input;
  const last = events.at(-1);
  if (last?.type !== "agent_settled" || last.aborted !== false) {
    return interrupted("agente não chegou a estado assentado (agent_settled ausente)", audit);
  }

  const launches = subagentLaunches(events);
  for (const launch of launches) {
    if (launch.model === undefined) {
      return interrupted(`subagente ${launch.agent} sem modelo explícito; sem fallback`, audit);
    }
    const roles = rolesFor(input.models, launch.model);
    if (roles.length === 0) {
      return interrupted(`modelo ${launch.model} do subagente ${launch.agent} não é um dos papéis configurados`, audit);
    }
    if (roles.includes("default")) audit.push(`default usado por ${launch.agent} (${launch.model})`);
    audit.push(`subagente ${launch.agent}: papel ${roles.join(" ou ")} (${launch.model})`);
  }

  const missing = unreconciledChild(events, launches);
  if (missing !== undefined) {
    return interrupted(`filho ${missing} sem desfecho registrado (reconciliação do parent)`, audit);
  }

  if (!input.completed) {
    audit.push("limite de iterações sem sinal de conclusão: nenhum resultado válido");
    return { output: { kind: "finished", results: [] }, audit };
  }

  const bodies = [...lastAssistantText(events).matchAll(RESULT_PATTERN)].map((match) => match[1] ?? "");
  const results = bodies.map(parseBody);
  const [only] = results;
  if (results.length === 1 && isObject(only) && only.status === "pr_ready") {
    const gap = reviewGap(only, input);
    if (gap !== undefined) return interrupted(gap, audit);
  }
  return { output: { kind: "finished", results }, audit };
}

function subagentLaunches(events: PiEvent[]): Launch[] {
  return events.flatMap((event): Launch[] => {
    if (event.type !== "tool_execution_start" || event.toolName !== "subagent") return [];
    const agent = typeof event.args?.agent === "string" ? event.args.agent : "(sem nome)";
    const model = typeof event.args?.model === "string" && event.args.model !== "" ? event.args.model : undefined;
    return [{
      toolCallId: event.toolCallId ?? "",
      agent,
      async: event.args?.async === true,
      model,
    }];
  });
}

// Every configured role whose model equals the launch's model. A shared model is reported
// with all its roles, so a use of `default` is never hidden behind a reviewer role.
function rolesFor(models: RunModels, model: string): Role[] {
  return ROLES.filter((role) => models[role] === model);
}

// An async child is reconciled only by its completion report; a synchronous child by its tool
// result. The parent's agent_settled alone does not prove that every child finished.
function unreconciledChild(events: PiEvent[], launches: Launch[]): string | undefined {
  const reported = new Map<string, number>();
  for (const event of events) {
    if (event.message?.customType !== "subagent-notify" || typeof event.message.content !== "string") continue;
    for (const match of event.message.content.matchAll(NOTIFY_PATTERN)) {
      const agent = match[1] ?? "";
      reported.set(agent, (reported.get(agent) ?? 0) + 1);
    }
  }
  const ended = new Set(events.filter((event) => event.type === "tool_execution_end").map((event) => event.toolCallId));
  for (const launch of launches) {
    if (launch.async) {
      const count = reported.get(launch.agent) ?? 0;
      if (count === 0) return launch.agent;
      reported.set(launch.agent, count - 1);
    } else if (!ended.has(launch.toolCallId)) {
      return launch.agent;
    }
  }
  return undefined;
}

function lastAssistantText(events: PiEvent[]): string {
  const last = events.filter((event) => event.type === "message_end" && event.message?.role === "assistant").at(-1);
  const content = last?.message?.content;
  if (typeof content === "string") return content;
  return (content ?? []).map((block) => block.text ?? "").join("");
}

// A body that is not a JSON object is passed on as text; the result contract then reports it as invalid.
type ResultBody = Record<string, unknown> | string;
function parseBody(body: string): ResultBody {
  try {
    const value: unknown = JSON.parse(body);
    return isObject(value) ? value : body;
  } catch {
    return body;
  }
}

// A PR is ready only with an approved review on each axis, bound to the final base, head and
// digests, by the configured reviewer model. A review without the material does not count.
function reviewGap(result: Record<string, unknown>, input: InterpretInput): string | undefined {
  const reviews: unknown[] = Array.isArray(result.reviews) ? result.reviews : [];
  const missing: string[] = [];
  for (const axis of ["standards", "spec"] as const) {
    const approved = reviews.some((review) => isObject(review)
      && review.axis === axis
      && review.model === input.models[`reviewer-${axis}`]
      && review.verdict === "approved"
      && review.base === input.baseSha
      && review.head === input.headSha
      && review.diffSha256 === input.diffSha256
      && review.specSha256 === input.specSha256
      && review.standardsSha256 === input.standardsSha256);
    if (!approved) missing.push(axis);
  }
  return missing.length === 0
    ? undefined
    : `pr_ready sem revisão aprovada nos eixos ${missing.join(", ")} com o material final`;
}
