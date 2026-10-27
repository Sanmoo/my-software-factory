import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { WORK_MOUNT_PATH } from "../layout.js";
import { isWorkIdentity, workIdentityKey, type WorkIdentity } from "../tracker/identity.js";
import { appendDurable, readIfExists, writeAtomic } from "./fs.js";

/**
 * The Work record's mediated-tracker part: the contract the factory hands the
 * worker, the worker's requests, the factory's structured answers and the
 * append-only operation ledger that keeps a retried publication from
 * duplicating. One module owns those files, their schemas and the
 * cross-references that bind them — a request names the Work and the session
 * that issued it, an answer names the request it answers, a ledger entry names
 * the Work, attempt and session of the operation it records.
 *
 * The worker holds no tracker credential, so this part of the record IS the
 * channel: the container side (the worker client) and the host side (the
 * factory's handler) reach this same module, and neither has a looser
 * validator than the other. An answer is a FACT — `ok`, `partial`, `rejected`,
 * `failed` or `unknown` — and only `ok` says a publication landed.
 *
 * Disk names stay PT-BR with the rest of the registry:
 *   <work dir>/mediacao-jira/contrato.json — who the worker may speak for
 *   <work dir>/mediacao-jira/pedidos/<id>.json — the worker's requests
 *   <work dir>/mediacao-jira/respostas/<id>.json — the factory's answers
 *   <work dir>/mediacao-jira/operacoes.jsonl — intents and results of the
 *     publications, so an ambiguous write is reconciled instead of repeated
 */

export const JIRA_MEDIATION_VERSION = 1;

export const JIRA_MEDIATION_DIRNAME = "mediacao-jira";
export const JIRA_REQUESTS_DIRNAME = "pedidos";
export const JIRA_RESPONSES_DIRNAME = "respostas";
export const JIRA_OPERATIONS_FILENAME = "operacoes.jsonl";
export const JIRA_CONTRACT_FILENAME = "contrato.json";

/** The contract file as the worker reads it inside its container: the work
 *  dir is bound there, so the record's own disk layout is the address. */
export const JIRA_CONTRACT_CONTAINER_PATH = `${WORK_MOUNT_PATH}/${JIRA_MEDIATION_DIRNAME}/${JIRA_CONTRACT_FILENAME}`;

/** The operations the contract authorizes. Anything else is outside it. */
export type JiraMediationOperation = "read" | "publish";

/** The authorized publication kinds: a help request, or an update on the work. */
export type JiraPublicationKind = "help" | "update";

export const JIRA_PUBLICATION_KINDS: readonly JiraPublicationKind[] = ["help", "update"];

/** The upper bound of a publication: a comment, not a document dump. */
export const JIRA_PUBLICATION_MAX_CHARS = 20_000;

export interface JiraMediationRequestBase {
  version: 1;
  /** Unique per request; a retry reuses it so the factory can reconcile. */
  id: string;
  /** The Work the request is for, as identity facts — never a guessed key. */
  work: WorkIdentity;
  /** The session that issued it; the factory binds it to the recorded launch. */
  sessionId: string;
}

export interface JiraReadRequest extends JiraMediationRequestBase {
  operation: "read";
}

export interface JiraPublishRequest extends JiraMediationRequestBase {
  operation: "publish";
  publication: {
    kind: JiraPublicationKind;
    /** Plain text: the factory renders it as ADF, never as HTML or Markdown. */
    text: string;
  };
}

export type JiraMediationRequest = JiraReadRequest | JiraPublishRequest;

/** The ticket's current content and conversation, in usable text. */
export interface JiraMediatedTicket {
  key: string;
  url: string | null;
  title: string;
  /** The description's ADF meaning rendered as text. */
  body: string;
  labels: string[];
  assignees: string[];
  createdAt: string;
}

export interface JiraMediatedComment {
  id: string;
  author: string;
  /** The comment's ADF meaning rendered as text. */
  body: string;
  createdAt: string;
  /** Structured evidence from the tracker: a factory comment property, not the author. */
  factory: boolean;
  /** The factory operation this comment carries, when it carries one. */
  correlationId: string | null;
}

export interface JiraMediatedContext {
  ticket?: JiraMediatedTicket;
  comments?: JiraMediatedComment[];
}

export type JiraUnknownFact = "ticket" | "comments";

export interface JiraMediationResponseBase {
  version: 1;
  id: string;
  at: string;
}

export interface JiraReadOk extends JiraMediationResponseBase {
  operation: "read";
  status: "ok";
  context: JiraMediatedContext;
}

export interface JiraReadPartial extends JiraMediationResponseBase {
  operation: "read";
  status: "partial";
  context: JiraMediatedContext;
  unknown: JiraUnknownFact[];
  reason: string;
}

export interface JiraReadUnknown extends JiraMediationResponseBase {
  operation: "read";
  status: "unknown";
  unknown: JiraUnknownFact[];
  reason: string;
}

export interface JiraPublishOk extends JiraMediationResponseBase {
  operation: "publish";
  status: "ok";
  commentId: string;
  url: string | null;
  /** True when a retry/reconciliation proved the earlier publication landed. */
  reconciled: boolean;
}

export interface JiraPublishFailed extends JiraMediationResponseBase {
  operation: "publish";
  status: "failed";
  reason: string;
}

export interface JiraPublishUnknown extends JiraMediationResponseBase {
  operation: "publish";
  status: "unknown";
  reason: string;
}

/** The factory refused the request before calling the tracker. */
export interface JiraMediationRejected extends JiraMediationResponseBase {
  operation: JiraMediationOperation | "unknown";
  status: "rejected";
  reason: string;
}

export type JiraReadResponse = JiraReadOk | JiraReadPartial | JiraReadUnknown | JiraMediationRejected;
export type JiraPublishResponse = JiraPublishOk | JiraPublishFailed | JiraPublishUnknown | JiraMediationRejected;
export type JiraMediationResponse = JiraReadResponse | JiraPublishResponse;

/** The file the worker client reads: who it may speak for, and where. */
export interface JiraMediationContract {
  version: 1;
  work: WorkIdentity;
  sessionId: string;
}

/** One publication's intent, written BEFORE the write it protects. */
export interface JiraOperationIntent {
  type: "intent";
  at: string;
  id: string;
  work: string;
  sessionId: string;
  attempt: number;
  kind: JiraPublicationKind;
}

/** The publication that landed: the correlation a later request reconciles with. */
export interface JiraOperationResult {
  type: "result";
  at: string;
  id: string;
  work: string;
  sessionId: string;
  attempt: number;
  status: "published";
  commentId: string;
  /** The inspectable link, absent when the site named none. */
  url?: string;
}

export type JiraOperationLine = JiraOperationIntent | JiraOperationResult;

/**
 * What a record file reads as: `absent` is nothing to act on, `invalid` is a
 * file that cannot be trusted as this schema (never silently repaired).
 */
export type MediationFileRead<T> =
  | { state: "absent" }
  | { state: "ready"; value: T }
  | { state: "invalid"; reason: string };

export interface MediationPaths {
  dir: string;
  requests: string;
  responses: string;
  contract: string;
  operations: string;
}

export function mediationPaths(workDir: string): MediationPaths {
  const dir = join(workDir, JIRA_MEDIATION_DIRNAME);
  return {
    dir,
    requests: join(dir, JIRA_REQUESTS_DIRNAME),
    responses: join(dir, JIRA_RESPONSES_DIRNAME),
    contract: join(dir, JIRA_CONTRACT_FILENAME),
    operations: join(dir, JIRA_OPERATIONS_FILENAME),
  };
}

/** The Work dir a contract path belongs to. The contract is this record's own
 *  file, so the worker — which holds only the mounted contract path — reaches
 *  the requests and answers beside it without being told the Work's host path. */
export function mediationWorkDirOf(contractPath: string): string {
  return dirname(dirname(contractPath));
}

// ---- validation: the one rule both sides apply ----

const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function isJiraRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID.test(value) && value !== "." && value !== "..";
}

export function isJiraMediationResponse(value: unknown): value is JiraMediationResponse {
  if (!isRecord(value) || value["version"] !== JIRA_MEDIATION_VERSION) return false;
  if (!isJiraRequestId(value["id"])) return false;
  if (typeof value["at"] !== "string") return false;
  const status = value["status"];
  if (status === "rejected") return typeof value["reason"] === "string";
  if (value["operation"] === "read") {
    if (status === "unknown") return Array.isArray(value["unknown"]) && typeof value["reason"] === "string";
    if (status === "partial") {
      return isMediatedContext(value["context"]) && Array.isArray(value["unknown"]) && typeof value["reason"] === "string";
    }
    if (status === "ok") return isMediatedContext(value["context"]);
    return false;
  }
  if (value["operation"] === "publish") {
    if (status === "ok") return typeof value["commentId"] === "string" && typeof value["reconciled"] === "boolean";
    if (status === "failed" || status === "unknown") return typeof value["reason"] === "string";
    return false;
  }
  return false;
}

export function isJiraMediationContract(value: unknown): value is JiraMediationContract {
  return (
    isRecord(value) &&
    value["version"] === JIRA_MEDIATION_VERSION &&
    isWorkIdentity(value["work"]) &&
    typeof value["sessionId"] === "string" &&
    value["sessionId"] !== ""
  );
}

/** The whole validation a request must pass before the factory acts on it: the
 *  shape, the id bound to its own file name, and the closed set of operations
 *  with their exact fields. The worker client applies it before writing, and
 *  the factory applies it again before calling the tracker. */
export function parseJiraMediationRequest(
  value: unknown,
  expectedId: string,
): { ok: true; request: JiraMediationRequest } | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: "the request is not an object" };
  if (!isJiraRequestId(expectedId)) return { ok: false, reason: "the request file name is not a request id" };
  if (value["version"] !== JIRA_MEDIATION_VERSION) return { ok: false, reason: "unsupported request version" };
  if (value["id"] !== expectedId) return { ok: false, reason: "the request id does not match its file name" };
  if (!isWorkIdentity(value["work"])) return { ok: false, reason: "the request carries no Work identity" };
  if (typeof value["sessionId"] !== "string" || value["sessionId"] === "") {
    return { ok: false, reason: "the request carries no session id" };
  }
  const operation = value["operation"];
  if (operation === "read") {
    if (!onlyKeys(value, ["version", "id", "operation", "work", "sessionId"])) {
      return { ok: false, reason: "a read request carries an unknown field" };
    }
    return {
      ok: true,
      request: {
        version: 1,
        id: expectedId,
        operation: "read",
        work: value["work"],
        sessionId: value["sessionId"],
      },
    };
  }
  if (operation === "publish") {
    if (!onlyKeys(value, ["version", "id", "operation", "work", "sessionId", "publication"])) {
      return { ok: false, reason: "a publish request carries an unknown field" };
    }
    const publication = value["publication"];
    if (!isRecord(publication) || !onlyKeys(publication, ["kind", "text"])) {
      return { ok: false, reason: "the publication is not an authorized {kind, text} object" };
    }
    const kind = publication["kind"];
    if (!JIRA_PUBLICATION_KINDS.includes(kind as JiraPublicationKind)) {
      return { ok: false, reason: "the publication kind is outside the contract" };
    }
    const text = publication["text"];
    if (typeof text !== "string" || text.trim() === "") {
      return { ok: false, reason: "the publication carries no text" };
    }
    if (text.length > JIRA_PUBLICATION_MAX_CHARS) {
      return { ok: false, reason: `the publication exceeds ${JIRA_PUBLICATION_MAX_CHARS} characters` };
    }
    return {
      ok: true,
      request: {
        version: 1,
        id: expectedId,
        operation: "publish",
        work: value["work"],
        sessionId: value["sessionId"],
        publication: { kind: kind as JiraPublicationKind, text },
      },
    };
  }
  return { ok: false, reason: "the operation is outside the contract" };
}

function isMediatedContext(value: unknown): value is JiraMediatedContext {
  if (!isRecord(value)) return false;
  return Object.keys(value).every((key) => key === "ticket" || key === "comments");
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---- the files ----

/** The record's mediation dirs, created once the factory starts serving: the
 *  worker may write its first request before any other artifact exists. */
export function ensureMediationDirs(workDir: string): void {
  const paths = mediationPaths(workDir);
  mkdirSync(paths.requests, { recursive: true });
  mkdirSync(paths.responses, { recursive: true });
}

/** The contract, written before the session starts. */
export function writeMediationContract(workDir: string, contract: JiraMediationContract): void {
  writeAtomic(mediationPaths(workDir).contract, contract);
}

export function readMediationContract(workDir: string): MediationFileRead<JiraMediationContract> {
  return readJson<JiraMediationContract>(
    mediationPaths(workDir).contract,
    (value) => (isJiraMediationContract(value) ? null : "not a mediation contract of this version"),
  );
}

/**
 * One request, durable before the worker waits for its answer. A request id is
 * its retry identity: the same id must carry the same content, so a retry can
 * never become a different request under the same correlation. The request also
 * has to belong to the contract on disk — the Work and the session the factory
 * wrote — before it is persisted: a request that would break that reference is
 * refused here, not answered later.
 */
export function writeMediationRequest(workDir: string, request: JiraMediationRequest): void {
  const contract = readMediationContract(workDir);
  if (contract.state !== "ready") {
    throw new Error(
      `the record holds no usable mediation contract (${contract.state}); a request cannot be issued`,
    );
  }
  if (
    workIdentityKey(contract.value.work) !== workIdentityKey(request.work) ||
    contract.value.sessionId !== request.sessionId
  ) {
    throw new Error("the request names a Work or a session the record's contract does not bind");
  }
  const path = join(mediationPaths(workDir).requests, `${request.id}.json`);
  const existing = readIfExists(path);
  if (existing !== null && canonical(existing) !== JSON.stringify(request)) {
    throw new Error(
      `request ${request.id} already exists with different content; a retry must reuse the same request`,
    );
  }
  // A retry with the same id re-writes the request (same bytes, newer mtime)
  // and drops the answer the previous occurrence already had: the factory
  // answers THIS occurrence, and the ledger keeps the publication from
  // duplicating.
  rmSync(join(mediationPaths(workDir).responses, `${request.id}.json`), { force: true });
  writeAtomic(path, request);
}

/** The requests still waiting for an answer: an answer older than its request
 *  is the previous occurrence, not the answer to this one. */
export function pendingMediationRequests(workDir: string): Array<{
  id: string;
  request: MediationFileRead<JiraMediationRequest>;
}> {
  const paths = mediationPaths(workDir);
  if (!existsSync(paths.requests)) return [];
  const pending: Array<{ id: string; request: MediationFileRead<JiraMediationRequest> }> = [];
  for (const name of readdirSync(paths.requests).sort()) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!isJiraRequestId(id)) continue;
    const requestFile = join(paths.requests, name);
    const responseFile = join(paths.responses, name);
    if (existsSync(responseFile) && statSync(responseFile).mtimeMs >= statSync(requestFile).mtimeMs) continue;
    pending.push({
      id,
      request: readJson<JiraMediationRequest>(requestFile, (value) => {
        const parsed = parseJiraMediationRequest(value, id);
        return parsed.ok ? null : parsed.reason;
      }),
    });
  }
  return pending;
}

/** The factory's answer to one request occurrence. */
export function writeMediationResponse(workDir: string, response: JiraMediationResponse): void {
  writeAtomic(join(mediationPaths(workDir).responses, `${response.id}.json`), response);
}

export function readMediationResponse(
  workDir: string,
  id: string,
): MediationFileRead<JiraMediationResponse> {
  const read = readJson<JiraMediationResponse>(join(mediationPaths(workDir).responses, `${id}.json`), (value) =>
    isJiraMediationResponse(value) ? null : "not a mediation response of this version",
  );
  if (read.state === "ready" && read.value.id !== id) {
    return { state: "invalid", reason: `the answer names request ${read.value.id}, not ${id}` };
  }
  return read;
}

export interface MediationLedger {
  /** False when a line did not parse: a corrupt line cannot authorize anything. */
  intact: boolean;
  intents: JiraOperationIntent[];
  results: JiraOperationResult[];
}

/** The operation ledger: an intent is on disk BEFORE the write it protects, so
 *  an interruption leaves the correlation the next request reconciles with.
 *  A corrupt line is history that authorizes nothing; the comment property
 *  remains the authoritative evidence. */
export function readMediationLedger(workDir: string): MediationLedger {
  const raw = readIfExists(mediationPaths(workDir).operations);
  if (raw === null) return { intact: true, intents: [], results: [] };
  const intents: JiraOperationIntent[] = [];
  const results: JiraOperationResult[] = [];
  let intact = true;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      intact = false;
      continue;
    }
    if (isOperationLine(parsed)) {
      if (parsed.type === "intent") intents.push(parsed);
      else results.push(parsed);
    } else {
      intact = false;
    }
  }
  return { intact, intents, results };
}

export function appendMediationIntent(workDir: string, intent: JiraOperationIntent): void {
  appendDurable(mediationPaths(workDir).operations, intent);
}

export function appendMediationResult(workDir: string, result: JiraOperationResult): void {
  appendDurable(mediationPaths(workDir).operations, result);
}

function isOperationLine(value: unknown): value is JiraOperationLine {
  if (!isRecord(value)) return false;
  if (typeof value["at"] !== "string" || !isJiraRequestId(value["id"])) return false;
  if (
    typeof value["work"] !== "string" ||
    typeof value["sessionId"] !== "string" ||
    typeof value["attempt"] !== "number"
  ) {
    return false;
  }
  if (value["type"] === "intent") {
    return JIRA_PUBLICATION_KINDS.includes(value["kind"] as JiraPublicationKind);
  }
  if (value["type"] === "result") {
    return (
      value["status"] === "published" &&
      typeof value["commentId"] === "string" &&
      (value["url"] === undefined || typeof value["url"] === "string")
    );
  }
  return false;
}

function readJson<T>(path: string, problem: (value: unknown) => string | null): MediationFileRead<T> {
  const raw = readIfExists(path);
  if (raw === null) return { state: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { state: "invalid", reason: "the file is not JSON" };
  }
  const reason = problem(parsed);
  return reason === null ? { state: "ready", value: parsed as T } : { state: "invalid", reason };
}
/** The canonical form of a request already on disk: the comparison a retry
 *  makes, independent of how the file was formatted. */
function canonical(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw) as unknown);
  } catch {
    return raw;
  }
}
