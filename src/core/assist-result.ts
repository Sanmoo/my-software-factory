import { createHash } from "node:crypto";
import { RESULT_PATTERN } from "../runtime/docker-output.js";
import { COMPLETION_SIGNAL } from "../runtime/docker-invocation.js";
import { isObject } from "./values.js";

// The proposal channel of a human-assisted attendance (spec #48 item 4, ticket #55). The agent
// proposes the result as one structured payload inside its last answer, and the answer ends with
// the exact completion line (<promise>MSF-RESULT</promise>). Output zero, a closed pane, or an
// agent declaration anywhere else (terminal, pane echo, a message without the final line) is
// never a proposal; nothing here is ever a human approval either — the result is only registered
// after the operator approves it explicitly.
//
// The channel is the session JSONL the Pi container writes into the host mount (the surface that
// survives the exec, validated by the #52 proof). The parsing below mirrors the validated
// proof-logic word for word; keep the two in the same shape.

// The line the proposal must end with; the same spelling as the completion signal.
export const COMPLETION_LINE = COMPLETION_SIGNAL;

// One proposal of the attendance's own end, as the agent proposed it, with the outcomes the
// spec distinguishes: attendance concluded, external wait, interruption.
export type AssistResult =
  | { status: "concluded"; summary: string; forward?: "ready-for-agent" }
  | { status: "external_wait"; summary: string }
  | { status: "interrupted"; reason: string };

export type RecognizedResult =
  | { kind: "recognized"; result: AssistResult; digest: string; payload: string }
  | { kind: "invalid"; reason: string }
  | { kind: "none"; reason: string };

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

function parsePayload(body: string, why: string): RecognizedResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "invalid", reason: `resultado estruturado ilegível (${why}): não é JSON` };
  }
  if (!isObject(parsed)) return { kind: "invalid", reason: `resultado estruturado ilegível (${why}): não é objeto` };
  const summary = (): string | undefined => typeof parsed.summary === "string" && parsed.summary.trim() !== "" ? parsed.summary : undefined;
  switch (parsed.status) {
    case "concluded": {
      const payload = summary();
      if (payload === undefined) return { kind: "invalid", reason: "resultado ilegível: concluído sem resumo" };
      if (parsed.forward !== undefined && parsed.forward !== "ready-for-agent") {
        return { kind: "invalid", reason: "resultado ilegível: encaminhamento desconhecido" };
      }
      const result: AssistResult = { status: "concluded", summary: payload };
      if (parsed.forward === "ready-for-agent") result.forward = "ready-for-agent";
      return { kind: "recognized", result, digest: assistResultDigest(body), payload: body };
    }
    case "external_wait": {
      const payload = summary();
      if (payload === undefined) return { kind: "invalid", reason: "resultado ilegível: espera externa sem resumo" };
      return { kind: "recognized", result: { status: "external_wait", summary: payload }, digest: assistResultDigest(body), payload: body };
    }
    case "interrupted": {
      if (!nonEmptyString(parsed.reason)) return { kind: "invalid", reason: "resultado ilegível: interrupção sem motivo" };
      return { kind: "recognized", result: { status: "interrupted", reason: parsed.reason }, digest: assistResultDigest(body), payload: body };
    }
    default:
      return { kind: "invalid", reason: `resultado ilegível: status desconhecido (${String(parsed.status)})` };
  }
}

function recognizeOne(text: string): RecognizedResult {
  if (text.split("\n").map((line) => line.trim()).filter((line) => line !== "").at(-1) !== COMPLETION_LINE) {
    return { kind: "none", reason: "resposta do assistente sem a linha final da proposta: ainda é conversa" };
  }
  const heads = [...text.matchAll(RESULT_PATTERN)];
  if (heads.length === 0) return { kind: "none", reason: "resposta do assistente sem resultado estruturado" };
  if (heads.length > 1) {
    return { kind: "invalid", reason: `resultado da proposta ambíguo (${heads.length} payloads na mesma resposta)` };
  }
  return parsePayload(heads[0]![1] ?? "", "payload da proposta");
}

// The proposals found in the session texts: only assistant messages count, and the last one is
// the current proposal. Earlier ones are revisions the operator may have rejected; the approved
// registration never repeats (its dedup is by digest, further down the conclusion flow).
// `jsonlTexts` are the raw session file contents; the caller sorts the files, so the order is
// the caller's.
export function recognizeAssistResult(jsonlTexts: readonly string[]): RecognizedResult {
  let found: RecognizedResult | undefined;
  for (const jsonl of jsonlTexts) {
    for (const text of assistantTexts(jsonl)) {
      const current = recognizeOne(text);
      if (current.kind === "none") continue;
      found = current;
    }
  }
  if (found === undefined) {
    return { kind: "none", reason: "nenhuma proposta de resultado reconhecida na sessão" };
  }
  return found;
}

// Digest of one payload (the same 16-hex scheme the feedback dedup uses). Two deliveries of the
// same payload share the digest, so the registration re-read finds its own comment before repeating.
export function assistResultDigest(payload: string): string {
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// The assistant's texts of one Pi session file; validated shape of the #52 proof (entries of
// type "message" with an assistant role and an array of text parts).
export function assistantTexts(jsonl: string): string[] {
  const texts: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const { type, message } = entry as { type?: unknown; message?: unknown };
    if (type !== "message" || typeof message !== "object" || message === null) continue;
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role !== "assistant" || !Array.isArray(content)) continue;
    texts.push(content
      .filter((part): part is { type: string; text: string } =>
        typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text")
      .map((part) => part.text ?? "")
      .join(""));
  }
  return texts;
}
