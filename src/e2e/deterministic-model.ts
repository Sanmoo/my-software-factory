/**
 * A deterministic OpenAI-compatible model for the continuity proof (issue
 * 119). It is not an LLM and needs no provider account: it answers from the
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
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface DeterministicModel {
  /** Base URL a sibling container can reach (no trailing slash). */
  baseUrl: string;
  requests: Array<{ assistantMessages: number; commands: string[] }>;
  close(): Promise<void>;
}

export interface DeterministicModelOptions {
  branch: string;
  attempt: number;
  /** Address the sibling container dials (the host's bridge address). */
  address: string;
  /** Where the completion signal / outcome path point inside the container. */
  workMount: string;
  /** The fixture remote as the WORKER reaches it (the work dir is its mount):
   *  the push names the repository instead of the clone's host-side `origin`. */
  remoteUrl: string;
}

export const COMPLETION = "<promise>MSF-RESULT</promise>";

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
    close: () => new Promise((resolve) => server.close(() => resolve())),
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
  const toolResults = messages
    .filter((message) => message["role"] === "tool")
    .map((message) => (typeof message["content"] === "string" ? message["content"] : ""));
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
  requests.push({ assistantMessages, commands });

  const reply = script(assistantMessages, options);
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
                { index: 0, id: `call-${assistantMessages + 1}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: reply.command }) } },
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
  void toolResults;
}

type Reply = { kind: "tool"; command: string } | { kind: "text"; text: string };

function script(assistantMessages: number, options: DeterministicModelOptions): Reply {
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

function completion(model: string, reply: Reply): Record<string, unknown> {
  const message =
    reply.kind === "tool"
      ? {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: reply.command }) } }],
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
