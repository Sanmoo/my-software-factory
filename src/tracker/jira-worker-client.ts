import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { isWorkIdentity, workIdentityKey } from "./identity.js";
import {
  JIRA_CONTRACT_FILENAME,
  JIRA_MEDIATION_DIRNAME,
  JIRA_REQUESTS_DIRNAME,
  JIRA_RESPONSES_DIRNAME,
  isJiraMediationContract,
  isJiraMediationResponse,
  parseJiraMediationRequest,
  type JiraMediationContract,
  type JiraMediationRequest,
  type JiraMediationResponse,
  type JiraPublicationKind,
  type JiraPublishResponse,
  type JiraReadResponse,
} from "./jira-mediation-protocol.js";

/**
 * The worker side of the mediated Jira interaction.
 *
 * It holds NO Jira credential and reads none from the environment: it writes a
 * request into the Work's own directory and waits for the factory's structured
 * answer. The client validates the contract and the request with the SAME
 * validator the factory applies, so a test helper has no path a production
 * worker does not cross.
 *
 * A timeout is `unknown`, never success and never a fabricated rejection: the
 * request stays on disk and can be retried with the same id, which is what
 * makes an ambiguous publication reconcilable instead of duplicated.
 */

export interface JiraWorkerClientOptions {
  /** The contract file the factory wrote into the work dir. */
  contractPath: string;
  /** How long to wait for the factory's answer. */
  timeoutMs?: number;
  /** The response polling tick. */
  pollMs?: number;
  /** The clock, injectable for deterministic tests. */
  now?: () => Date;
}

export class JiraWorkerClient {
  private readonly contractPath: string;
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly now: () => Date;
  private contract: JiraMediationContract | null = null;

  constructor(options: JiraWorkerClientOptions) {
    this.contractPath = options.contractPath;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.pollMs = options.pollMs ?? 10;
    this.now = options.now ?? (() => new Date());
  }

  /** The contract the factory wrote before the session started. */
  readContract(): JiraMediationContract {
    if (this.contract !== null) return this.contract;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.contractPath, "utf8")) as unknown;
    } catch (error) {
      throw new Error(
        `no readable Jira mediation contract at ${this.contractPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isJiraMediationContract(parsed) || !isWorkIdentity(parsed.work)) {
      throw new Error(`the Jira mediation contract at ${this.contractPath} is not a contract of this version`);
    }
    if (parsed.work.ticket.provider !== "jira") {
      throw new Error("the Jira mediation contract does not name a Jira ticket");
    }
    this.contract = parsed;
    return parsed;
  }

  /** Read the ticket's current content and conversation again. */
  async read(options: { requestId?: string } = {}): Promise<JiraReadResponse> {
    const contract = this.readContract();
    const id = options.requestId ?? randomUUID();
    const response = await this.exchange(
      {
        version: 1,
        id,
        operation: "read",
        work: contract.work,
        sessionId: contract.sessionId,
      },
      id,
    );
    if (response.operation !== "read") {
      throw new Error(`the factory answered a read request with a ${response.operation} response`);
    }
    return response;
  }

  /**
   * Publish an authorized factory comment. `requestId` is the retry identity:
   * repeating an unknown publication with the same id lets the factory
   * reconcile instead of creating a duplicate.
   */
  async publish(input: {
    kind: JiraPublicationKind;
    text: string;
    requestId?: string;
  }): Promise<JiraPublishResponse> {
    const contract = this.readContract();
    const id = input.requestId ?? randomUUID();
    const response = await this.exchange(
      {
        version: 1,
        id,
        operation: "publish",
        work: contract.work,
        sessionId: contract.sessionId,
        publication: { kind: input.kind, text: input.text },
      },
      id,
    );
    if (response.operation !== "publish") {
      throw new Error(`the factory answered a publish request with a ${response.operation} response`);
    }
    return response;
  }

  /** One request/response exchange; the only file-protocol implementation. */
  private async exchange(request: JiraMediationRequest, id: string): Promise<JiraMediationResponse> {
    const contract = this.readContract();
    if (workIdentityKey(request.work) !== workIdentityKey(contract.work)) {
      throw new Error("the request names a Work other than the contract's");
    }
    if (request.sessionId !== contract.sessionId) {
      throw new Error("the request names a session other than the contract's");
    }
    const validated = parseJiraMediationRequest(request, id);
    if (!validated.ok) throw new Error(`the Jira request is not valid: ${validated.reason}`);

    const directory = dirname(this.contractPath);
    const requestFile = join(directory, JIRA_REQUESTS_DIRNAME, `${id}.json`);
    const responseFile = join(directory, JIRA_RESPONSES_DIRNAME, `${id}.json`);
    // This call REPEATS a request id: clear the previous answer so the factory
    // answers this occurrence (its ledger still reconciles the operation).
    if (existsSync(requestFile)) rmSync(responseFile, { force: true });
    writeRequest(requestFile, validated.request);

    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const response = readResponse(responseFile);
      if (response !== null) {
        if (response.id !== id) {
          throw new Error(`the factory answered request ${id} with the id ${response.id}`);
        }
        return response;
      }
      if (Date.now() >= deadline) {
        return this.timedOut(id, validated.request.operation);
      }
      await sleep(this.pollMs);
    }
  }

  private timedOut(id: string, operation: "read" | "publish"): JiraMediationResponse {
    const reason =
      `the factory did not answer within ${this.timeoutMs}ms; the request stays at ` +
      `${join(dirname(this.contractPath), JIRA_REQUESTS_DIRNAME, `${id}.json`)} and may be retried with the same id`;
    if (operation === "read") {
      return {
        version: 1,
        id,
        operation: "read",
        status: "unknown",
        unknown: ["ticket", "comments"],
        reason,
        at: this.now().toISOString(),
      };
    }
    return {
      version: 1,
      id,
      operation: "publish",
      status: "unknown",
      reason,
      at: this.now().toISOString(),
    };
  }
}

/** The contract file of a host work dir (the worker's own view is the mount). */
export function jiraContractPath(workDir: string): string {
  return join(workDir, JIRA_MEDIATION_DIRNAME, JIRA_CONTRACT_FILENAME);
}

function writeRequest(file: string, request: JiraMediationRequest): void {
  mkdirSync(dirname(file), { recursive: true });
  const content = `${JSON.stringify(request)}\n`;
  if (existsSync(file) && readFileSync(file, "utf8") !== content) {
    throw new Error(`request ${request.id} already exists with different content; a retry must reuse the same request`);
  }
  // A retry with the same id re-writes the request (same bytes, newer mtime):
  // the factory then answers THIS occurrence instead of the cached answer of
  // the previous one, and its ledger keeps the publication from duplicating.
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
}

function readResponse(file: string): JiraMediationResponse | null {
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return null; // a half-written answer is not an answer; the next tick reads it
  }
  if (!isJiraMediationResponse(parsed)) {
    throw new Error(`the factory's answer at ${file} is not a response of this version`);
  }
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
