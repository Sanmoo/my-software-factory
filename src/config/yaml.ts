import { isScalar, LineCounter, parseAllDocuments, stringify, visit } from "yaml";

// The one way a configuration file is turned into data (ticket #72): YAML 1.2 only. The
// restrictions are the configuration's, not YAML's: comments and anchors are welcome, while the
// features that would make a file mean something other than what it shows are refused —
// duplicate keys, more than one document, custom tags, merge keys (`<<`) and alias expansion
// beyond a small limit. Errors name the reason and the position and never echo a value, so a
// malformed file cannot leak what it configured.

// How many aliases one document may contain and how far a value may expand. Anchors are for
// avoiding repetition in a hand-edited file, not for generating data.
const MAX_ALIASES = 100;
const MAX_NODES = 100_000;

const MULTIPLE_DOCUMENTS = "mais de um documento YAML";

export type YamlResult = { ok: true; value: unknown } | { ok: false; message: string };

// Every rejection is phrased here, from the error code only: the parser's own message carries a
// snippet of the document, which must not reach the operator's output.
const SAFE_REASONS: Record<string, string> = {
  ALIAS_PROPS: "alias com propriedades não é suportado",
  BAD_ALIAS: "âncora do alias inválida",
  BAD_DIRECTIVE: "diretiva YAML não suportada",
  BLOCK_AS_IMPLICIT_KEY: "mapa em bloco usado como chave implícita",
  DUPLICATE_KEY: "chave duplicada no mesmo mapa",
  FLOW_AS_BLOCK_KEY: "sequência em fluxo usada como chave em bloco",
  KEY_OVER_1024_CHARS: "chave longa demais",
  MISSING_CHAR: "documento incompleto",
  MULTILINE_IMPLICIT_KEY: "chave implícita em várias linhas",
  MULTIPLE_DOCS: MULTIPLE_DOCUMENTS,
  TAB_AS_INDENT: "tabulador usado como indentação",
  TAG_RESOLVE_FAILED: "tag personalizada ou desconhecida não é suportada",
  UNEXPECTED_TOKEN: "token inesperado",
  UNKNOWN_ANCHOR: "âncora desconhecida",
};

type Position = readonly [number, number];

interface Located {
  code: string;
  linePos?: Array<{ line: number; col: number } | undefined>;
}

const withPosition = (reason: string, position: Position | undefined): string =>
  position === undefined ? reason : `${reason} (linha ${position[0]}, coluna ${position[1]})`;

function describe(error: Located): string {
  const reason = SAFE_REASONS[error.code] ?? "YAML inválido";
  const start = error.linePos?.[0];
  return withPosition(reason, start === undefined ? undefined : [start.line, start.col]);
}

// A value that references itself cannot be represented as configuration (or written out again):
// anchors may be shared, but a cycle is refused. The walk is iterative and bounded by the node
// count, so a deliberately expansive document fails here instead of in the caller.
function walkBounded(root: unknown): YamlResult {
  const path = new Set<object>();
  let nodes = 0;
  type Step = { value: unknown; leaving: boolean };
  const stack: Step[] = [{ value: root, leaving: false }];
  while (stack.length > 0) {
    const { value, leaving } = stack.pop()!;
    if (value === null || typeof value !== "object") continue;
    if (leaving) { path.delete(value); continue; }
    if (path.has(value)) return { ok: false, message: "âncora referencia o próprio nó: ciclo no documento" };
    nodes += 1;
    if (nodes > MAX_NODES) return { ok: false, message: "expansão de âncoras grande demais" };
    path.add(value);
    stack.push({ value, leaving: true });
    const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    for (const child of children) stack.push({ value: child, leaving: false });
  }
  return { ok: true, value: root };
}

// The features this parser refuses on sight, with the reason and position reported to the operator.
function refuse(document: ReturnType<typeof parseAllDocuments>[number], lineCounter: LineCounter): string | undefined {
  // Warnings are rejections too: an unresolved tag (`!foo`) arrives here, not as an error.
  const rejected = ([...document.errors, ...document.warnings][0] as Located | undefined);
  if (rejected !== undefined) return describe(rejected);
  const version = document.directives?.yaml?.version;
  if (version !== undefined && version !== "1.2") return `versão YAML ${version} não é suportada; use 1.2`;
  let aliases = 0;
  let mergeKey: { position: Position | undefined } | undefined;
  visit(document, {
    Alias() { aliases += 1; },
    Pair(_key, pair) {
      if (mergeKey !== undefined || !isScalar(pair.key) || pair.key.value !== "<<") return;
      const start = pair.key.range?.[0];
      const position = start === undefined ? undefined : lineCounter.linePos(start);
      mergeKey = { position: position === undefined ? undefined : [position.line, position.col] };
    },
  });
  if (mergeKey !== undefined) return withPosition("merge key (<<) não é suportada", mergeKey.position);
  if (aliases > MAX_ALIASES) return `mais de ${MAX_ALIASES} aliases no documento`;
  return undefined;
}

export function parseYamlDocument(text: string): YamlResult {
  const lineCounter = new LineCounter();
  const documents = parseAllDocuments(text, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    merge: false,
    lineCounter,
  });
  if (documents.length === 0) return { ok: true, value: undefined };
  if (documents.length > 1) return { ok: false, message: MULTIPLE_DOCUMENTS };
  const document = documents[0]!;
  const refusal = refuse(document, lineCounter);
  if (refusal !== undefined) return { ok: false, message: refusal };
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: MAX_ALIASES });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("Excessive alias count")) return { ok: false, message: "expansão de âncoras excede o limite" };
    if (message.startsWith("Unresolved alias")) return { ok: false, message: "alias sem âncora anterior no documento" };
    return { ok: false, message: "YAML inválido" };
  }
  return walkBounded(value);
}

// The document the migration writes: YAML 1.2, block style, no aliases (the data is written out).
export function stringifyYaml(value: unknown): string {
  return stringify(value, { version: "1.2", aliasDuplicateObjects: false, lineWidth: 0 });
}

// Whether two parsed values are the same data, ignoring object identity (an alias may share one).
export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => sameData(entry, b[index]));
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && sameData(left[key], right[key]));
}
