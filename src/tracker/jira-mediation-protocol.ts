import { WORK_MOUNT_PATH } from "../layout.js";
import { isWorkIdentity, type WorkIdentity } from "./identity.js";

/**
 * The contract of the factory-mediated Jira interaction: the worker holds no
 * Jira credential, so it writes ONE request into the Work's own directory and
 * reads the factory's structured answer back. This module is the shared
 * vocabulary of both sides — the factory handler validates every request with
 * it, and the worker client can only produce a request this same validator
 * accepts, so a test helper has no second, looser path.
 *
 * A response is a FACT, never prose: `ok`, `partial`, `rejected`, `failed` or
 * `unknown`. Only `ok` says a publication landed. An `unknown` or `partial`
 * answer names what is unknown and is never read as authorization or state.
 */

export const JIRA_MEDIATION_VERSION = 1;

/** Disk names stay PT-BR with the rest of the registry. */
export const JIRA_MEDIATION_DIRNAME = "mediacao-jira";
export const JIRA_REQUESTS_DIRNAME = "pedidos";
export const JIRA_RESPONSES_DIRNAME = "respostas";
export const JIRA_OPERATIONS_FILENAME = "operacoes.jsonl";
export const JIRA_CONTRACT_FILENAME = "contrato.json";

/** The compiled worker client, relative to `dist/` and to the image's /opt/msf. */
export const JIRA_CLIENT_ENTRY_MODULE = "tracker/jira-client-cli.js";

/** The worker client the image carries; the prompt names it, not a host path. */
export const JIRA_CLIENT_CONTAINER_FILE = `/opt/msf/${JIRA_CLIENT_ENTRY_MODULE}`;

/** The contract file the worker client reads, at the path the runtime mounts
 *  the work dir on. */
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
  /** Structured evidence from Jira: a factory comment property, not the author. */
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

/** The factory refused the request before calling Jira. */
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

/** The whole validation a request file must pass before the factory acts on
 *  it: the shape, the id bound to its own file name, and the closed set of
 *  operations with their exact fields. */
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
