import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { isWorkIdentity } from "./identity.js";
import {
  JIRA_MEDIATION_VERSION,
  isJiraMediationContract,
  mediationWorkDirOf,
  parseJiraMediationRequest,
  readMediationResponse,
  writeMediationRequest,
  type JiraMediationContract,
  type JiraMediationRequest,
  type JiraMediationResponse,
  type JiraPublicationKind,
  type JiraPublishResponse,
  type JiraReadResponse,
} from "../work-record/jira-mediation.js";

/**
 * The worker side of the mediated tracker interaction.
 *
 * It holds NO tracker credential and reads none from the environment: it
 * writes a request into the Work's own record and waits for the factory's
 * structured answer. The client validates the contract and the request with
 * the SAME validator the factory applies — both sides import the record's
 * schema — so a test helper has no path a production worker does not cross.
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
        version: JIRA_MEDIATION_VERSION,
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
        version: JIRA_MEDIATION_VERSION,
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
    this.readContract();
    const validated = parseJiraMediationRequest(request, id);
    if (!validated.ok) throw new Error(`the Jira request is not valid: ${validated.reason}`);

    const workDir = mediationWorkDirOf(this.contractPath);
    writeMediationRequest(workDir, validated.request);

    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const response = readMediationResponse(workDir, id);
      if (response.state === "invalid") throw new Error(`the factory's answer to ${id} is unusable: ${response.reason}`);
      if (response.state === "ready") return response.value;
      if (Date.now() >= deadline) return this.timedOut(id, validated.request.operation);
      await sleep(this.pollMs);
    }
  }

  private timedOut(id: string, operation: "read" | "publish"): JiraMediationResponse {
    const reason =
      `the factory did not answer within ${this.timeoutMs}ms; the request stays in the work record and may be retried ` +
      `with the same id (${id})`;
    if (operation === "read") {
      return {
        version: JIRA_MEDIATION_VERSION,
        id,
        operation: "read",
        status: "unknown",
        unknown: ["ticket", "comments"],
        reason,
        at: this.now().toISOString(),
      };
    }
    return {
      version: JIRA_MEDIATION_VERSION,
      id,
      operation: "publish",
      status: "unknown",
      reason,
      at: this.now().toISOString(),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
