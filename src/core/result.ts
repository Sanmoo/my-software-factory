import { isObject } from "./values.js";

// Result contract of a runner invocation. Only a structurally valid result is a
// success. Absent (no result), ambiguous (more than one) and invalid outputs become
// ParseFailure, which the admission turns into intervention-required.

export interface PrRef {
  repository: string;
  number: number;
}

export type RunResult =
  | { status: "needs_help"; question: string; context: string }
  | { status: "pr_ready"; pr: PrRef }
  | { status: "interrupted"; reason: string };

export type ParsedOutput = { ok: true; result: RunResult } | { ok: false; reason: string };

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

function parsePr(value: unknown): PrRef | undefined {
  if (!isObject(value)) return undefined;
  if (!nonEmptyString(value.repository)) return undefined;
  if (typeof value.number !== "number" || !Number.isSafeInteger(value.number) || value.number <= 0) return undefined;
  return { repository: value.repository, number: value.number };
}

function parseOne(value: unknown): ParsedOutput {
  if (!isObject(value)) return { ok: false, reason: "resultado não é objeto" };
  switch (value.status) {
    case "needs_help":
      if (!nonEmptyString(value.question)) return { ok: false, reason: "pedido de ajuda sem pergunta" };
      return {
        ok: true,
        result: {
          status: "needs_help",
          question: value.question,
          context: typeof value.context === "string" ? value.context : "",
        },
      };
    case "pr_ready": {
      const pr = parsePr(value.pr);
      if (!pr) return { ok: false, reason: "PR pronto sem referência (repository e number)" };
      return { ok: true, result: { status: "pr_ready", pr } };
    }
    case "interrupted":
      if (!nonEmptyString(value.reason)) return { ok: false, reason: "interrupção sem motivo" };
      return { ok: true, result: { status: "interrupted", reason: value.reason } };
    default:
      return { ok: false, reason: `status desconhecido: ${String(value.status)}` };
  }
}

// `results` holds the structured results found in one runner output.
export function parseRunOutput(results: readonly unknown[]): ParsedOutput {
  if (results.length === 0) return { ok: false, reason: "saída ausente: nenhum resultado estruturado" };
  if (results.length > 1) return { ok: false, reason: `saída ambígua: ${results.length} resultados` };
  return parseOne(results[0]);
}
