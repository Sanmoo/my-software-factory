/**
 * A deterministic OpenAI-compatible model for the continuity proof. It is not
 * an LLM and needs no provider account: it answers from the
 * transcript it receives, so the test proves the RUNTIME behaviour (session
 * persistence, resume selection, in-container guardrail) instead of a model's
 * creativity — exactly the category the issue allows for the mandatory
 * integration proof.
 *
 * The script, by number of assistant messages already in the transcript:
 *   0 → push the work branch and keep the process alive (the interruption
 *       window: the push lands, the result never does);
 *   1 → retry the same push (the guardrail must block it after the resume);
 *   2 → write the outcome record through bash;
 *   3 → print the completion signal and stop.
 *
 * The "refused-call" script proves the journal gap of the reported incident:
 *   0 → run ONE harmless safe call, so the session itself proves what Pi
 *       records for a call that executed (`durationMs`);
 *   1 → issue ONE guarded call a probe extension refuses after the guardrail
 *       journaled its intent (so the journal keeps an intent with no result and
 *       the terminal error records no `durationMs`);
 *   — → the first session ends with NO outcome record: its attempt is
 *       interrupted, and repairing the journal is the factory's job;
 *   resumed    → write the outcome record once, then the completion.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface DeterministicModel {
  /** Base URL a sibling container can reach (no trailing slash). */
  baseUrl: string;
  /** One entry per model call: what the transcript carried into it. */
  requests: Array<{ assistantMessages: number; commands: string[]; resumed: boolean }>;
  close(): Promise<void>;
}

export interface DeterministicModelOptions {
  branch: string;
  attempt: number;
  /** Which proof this model drives; "interruption" (the default) is the kill
   *  test, "refused-call" the journal-gap test. */
  script?: "interruption" | "refused-call" | "delegation-stop" | "delegation-kill";
  /** Address the sibling container dials (the host's bridge address). */
  address: string;
  /** Where the completion signal / outcome path point inside the container. */
  workMount: string;
  /** The fixture remote as the WORKER reaches it (the work dir is its mount):
   *  the push names the repository instead of the clone's host-side `origin`. */
  remoteUrl: string;
}

export const COMPLETION = "<promise>MSF-RESULT</promise>";

/** The harmless command the "refused-call" script runs first: the proof reads
 *  the `durationMs` Pi records for a call that really executed in the container. */
export const SAFE_CALL_COMMAND = "printf 'msf-probe-safe\\n'";

/** The guarded command the "refused-call" script issues next: the probe
 *  extension refuses it BEFORE it runs, after the guardrail journaled its
 *  intent, so Pi stores the error with no `durationMs`. */
export const REFUSED_CALL_COMMAND = "curl -sS https://example.invalid/msf-probe";

/** The heading the factory's prompt uses when it reopens the attempt's own
 *  session (src/runtime/prompt.ts): `## This session CONTINUES attempt <n>`. */
const RESUME_MARKER = "This session CONTINUES attempt";

export async function startDeterministicModel(options: DeterministicModelOptions): Promise<DeterministicModel> {
  const requests: DeterministicModel["requests"] = [];
  const server = createServer((request, response) => {
    void handle(request, response, options, requests);
  });
  await listen(server);
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    baseUrl: `http://${options.address}:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: DeterministicModelOptions,
  requests: DeterministicModel["requests"],
): Promise<void> {
  const body = await readBody(request);
  if (!request.url?.endsWith("/chat/completions")) {
    response.writeHead(404).end();
    return;
  }
  let payload: { messages?: Array<Record<string, unknown>>; stream?: boolean; model?: string };
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    response.writeHead(400).end("invalid json");
    return;
  }

  const messages = payload.messages ?? [];
  const assistantMessages = messages.filter((message) => message["role"] === "assistant").length;
  const commands = messages.flatMap((message) => {
    const calls = message["tool_calls"];
    if (!Array.isArray(calls)) return [];
    return calls.flatMap((call) => {
      const record = call as { function?: { arguments?: string } };
      try {
        const args = JSON.parse(record.function?.arguments ?? "{}") as { command?: string };
        return args.command === undefined ? [] : [args.command];
      } catch {
        return [];
      }
    });
  });
  // The factory's resume prompt is the observable "this session continues the
  // interrupted attempt" (src/runtime/prompt.ts): the model records it, so the
  // test can tell a reopened conversation from a first launch.
  const promptText = messages
    .map((message) => message["content"])
    .map((content) => (typeof content === "string" ? content : JSON.stringify(content ?? "")))
    .join("\n");
  const resumed = promptText.includes(RESUME_MARKER);
  requests.push({ assistantMessages, commands, resumed });

  const reply = options.script === "delegation-stop" || options.script === "delegation-kill"
    ? delegationStopScript({ assistantMessages, commands, resumed }, promptText, options)
    : script({ assistantMessages, commands, resumed }, options);
  if (payload.stream === false) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(completion(payload.model ?? "deterministic", reply)));
    return;
  }

  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  if (reply.kind === "tool") {
    response.write(
      sse({
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                { index: 0, id: `call-${assistantMessages + 1}`, type: "function", function: { name: reply.tool ?? "bash", arguments: JSON.stringify(reply.input ?? { command: reply.command }) } },
              ],
            },
            finish_reason: null,
          },
        ],
        model: payload.model ?? "deterministic",
      }),
    );
    response.write(
      sse({
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        model: payload.model ?? "deterministic",
      }),
    );
  } else {
    response.write(
      sse({
        choices: [{ index: 0, delta: { role: "assistant", content: reply.text }, finish_reason: null }],
        model: payload.model ?? "deterministic",
      }),
    );
    response.write(
      sse({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        model: payload.model ?? "deterministic",
      }),
    );
  }
  response.write(
    sse({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      model: payload.model ?? "deterministic",
    }),
  );
  response.write("data: [DONE]\n\n");
  response.end();
}

type Reply = { kind: "tool"; command: string; tool?: string; input?: Record<string, unknown> } | { kind: "text"; text: string };

/** What the request carries: how far the transcript got, which commands it
 *  already issued, and whether the factory reopened this session. */
interface ScriptState {
  assistantMessages: number;
  commands: string[];
  resumed: boolean;
}

function script(state: ScriptState, options: DeterministicModelOptions): Reply {
  if (options.script === "refused-call") return refusedCallScript(state, options);
  const { assistantMessages } = state;
  if (assistantMessages === 0) {
    // The push lands; the sleep keeps the tool running so the test can kill
    // the container inside the window, before Pi records the result.
    return { kind: "tool", command: `git push -u ${options.remoteUrl} ${options.branch} && sleep 120` };
  }
  if (assistantMessages === 1) {
    return { kind: "tool", command: `git push -u ${options.remoteUrl} ${options.branch}` };
  }
  if (assistantMessages === 2) {
    const record = JSON.stringify({ class: "clean-without-pr", attempt: options.attempt });
    return { kind: "tool", command: `printf '%s\\n' '${record}' > ${options.workMount}/desfecho.json` };
  }
  return { kind: "text", text: COMPLETION };
}

function refusedCallScript(state: ScriptState, options: DeterministicModelOptions): Reply {
  if (!state.resumed) {
    if (state.assistantMessages === 0) return { kind: "tool", command: SAFE_CALL_COMMAND };
    if (state.assistantMessages === 1) return { kind: "tool", command: REFUSED_CALL_COMMAND };
    // The first session ends with no outcome record on purpose: the attempt is
    // interrupted and the factory's recovery must repair the journal from the
    // terminal result Pi persisted for the refused call.
    return { kind: "text", text: COMPLETION };
  }
  // The reopened session writes the record once, then ends its turn.
  if (!state.commands.some((command) => command.includes(`${options.workMount}/desfecho.json`))) {
    const record = JSON.stringify({ class: "clean-without-pr", attempt: options.attempt });
    return { kind: "tool", command: `printf '%s\\n' '${record}' > ${options.workMount}/desfecho.json` };
  }
  return { kind: "text", text: COMPLETION };
}

function delegationStopScript(state: ScriptState, prompt: string, options: DeterministicModelOptions): Reply {
  const child = ["code-reviewer", "spec-reviewer"].find((agent) => prompt.includes(`<active_agent name="${agent}"/>`));
  if (child !== undefined) {
    if (state.assistantMessages === 0) {
      return { kind: "tool", command: options.script === "delegation-kill"
        ? `git push -u ${options.remoteUrl} ${options.branch} && sleep 120`
        : `printf started > ${options.workMount}/delegation-started-${child}; sleep 120` };
    }
    return { kind: "text", text: "review interrupted" };
  }
  if (!state.resumed) {
    if (state.assistantMessages === 0) {
      return {
        kind: "tool", command: "", tool: "subagent",
        input: options.script === "delegation-stop"
          ? { workflow: "parallel", async: false, args: { tasks: [
              { agent: "code-reviewer", task: "Review the disposable fixture", model: "deterministico/roteiro" },
              { agent: "spec-reviewer", task: "Review the disposable fixture", model: "deterministico/roteiro" },
            ] } }
          : { agent: "code-reviewer", task: "Review the disposable fixture", model: "deterministico/roteiro", async: false },
      };
    }
    return { kind: "text", text: COMPLETION };
  }
  if (options.script === "delegation-kill" && !state.commands.some((command) => command.includes("git push"))) {
    return { kind: "tool", command: `git push -u ${options.remoteUrl} ${options.branch}` };
  }
  if (!state.commands.some((command) => command.includes(`${options.workMount}/desfecho.json`))) {
    const record = JSON.stringify({ class: "clean-without-pr", attempt: options.attempt });
    return { kind: "tool", command: `printf '%s\\n' '${record}' > ${options.workMount}/desfecho.json` };
  }
  return { kind: "text", text: COMPLETION };
}

function completion(model: string, reply: Reply): Record<string, unknown> {
  const message =
    reply.kind === "tool"
      ? {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call-1", type: "function", function: { name: reply.tool ?? "bash", arguments: JSON.stringify(reply.input ?? { command: reply.command }) } }],
        }
      : { role: "assistant", content: reply.text };
  return {
    id: "chatcmpl-deterministic",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message, finish_reason: reply.kind === "tool" ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
}

function sse(value: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: "chatcmpl-deterministic", object: "chat.completion.chunk", created: 0, ...value })}\n\n`;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => resolve());
  });
}
