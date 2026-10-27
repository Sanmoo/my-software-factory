import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { githubRepository, jiraTicket, workIdentity } from "../tracker/identity.js";
import {
  appendMediationIntent,
  appendMediationResult,
  ensureMediationDirs,
  mediationPaths,
  mediationWorkDirOf,
  parseJiraMediationRequest,
  pendingMediationRequests,
  readMediationContract,
  readMediationLedger,
  readMediationResponse,
  writeMediationContract,
  writeMediationRequest,
  writeMediationResponse,
  type JiraMediationRequest,
} from "./jira-mediation.js";

/**
 * The mediated-tracker part of the Work record: its files, their schemas and
 * the cross-references that bind them. The factory and the worker hold
 * different views of the same record, so these rules are tested where the
 * record keeps them — the interaction at its seam is covered by the tracker's
 * own suite.
 */

const REPO = "Sanmoo/my-tasks";
const SESSION = "session-1";

const work = workIdentity(
  jiraTicket({ site: "acme.atlassian.net", stableId: "10001", key: "ABC-1" }),
  githubRepository(REPO),
);

function request(overrides: Partial<JiraMediationRequest> = {}): JiraMediationRequest {
  return {
    version: 1,
    id: "request-1",
    operation: "read",
    work,
    sessionId: SESSION,
    ...overrides,
  } as JiraMediationRequest;
}

describe("the Work record's mediated-tracker part", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-record-mediation-"));
    ensureMediationDirs(dir);
    writeMediationContract(dir, { version: 1, work, sessionId: SESSION });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a request is refused before the disk when the record holds no contract, or one for another Work or session", () => {
    const other = workIdentity(
      jiraTicket({ site: "other.atlassian.net", stableId: "10001", key: "ABC-1" }),
      githubRepository(REPO),
    );
    assert.throws(() => writeMediationRequest(dir, request({ work: other })), /does not bind/);
    assert.throws(() => writeMediationRequest(dir, request({ sessionId: "session-2" })), /does not bind/);
    assert.equal(existsSync(join(mediationPaths(dir).requests, "request-1.json")), false);

    const contractless = mkdtempSync(join(tmpdir(), "msf-record-nocontract-"));
    try {
      ensureMediationDirs(contractless);
      assert.throws(() => writeMediationRequest(contractless, request()), /no usable mediation contract/);
    } finally {
      rmSync(contractless, { recursive: true, force: true });
    }
  });

  test("a request id is its retry identity: the same id must carry the same content, and a retry clears the previous answer", () => {
    writeMediationRequest(dir, request());
    const answered = {
      version: 1 as const,
      id: "request-1",
      operation: "read" as const,
      status: "ok" as const,
      context: {},
      at: "2026-01-01T00:00:00.000Z",
    };
    writeMediationResponse(dir, answered);
    assert.equal(readMediationResponse(dir, "request-1").state, "ready");

    assert.throws(() =>
      writeMediationRequest(dir, request({ operation: "publish", publication: { kind: "help", text: "x" } })),
    );
    assert.equal(
      readMediationResponse(dir, "request-1").state,
      "ready",
      "a refused retry changes nothing on disk",
    );

    writeMediationRequest(dir, request());
    assert.equal(readMediationResponse(dir, "request-1").state, "absent", "the answer of the earlier occurrence is gone");
    assert.equal(pendingMediationRequests(dir).length, 1, "the retry is pending again");
  });

  test("a request outside the schema reads as invalid, and an answered occurrence is not pending", () => {
    const paths = mediationPaths(dir);
    writeFileSync(join(paths.requests, "bad.json"), `${JSON.stringify({ ...request(), id: "bad", operation: "delete" })}\n`, "utf8");
    writeFileSync(join(paths.requests, "torn.json"), "{", "utf8");
    assert.deepEqual(
      pendingMediationRequests(dir).map((entry) => [entry.id, entry.request.state]),
      [
        ["bad", "invalid"],
        ["torn", "invalid"],
      ],
    );

    writeMediationRequest(dir, request({ id: "answered" }));
    writeMediationResponse(dir, {
      version: 1,
      id: "answered",
      operation: "read",
      status: "ok",
      context: {},
      at: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(
      pendingMediationRequests(dir).some((entry) => entry.id === "answered"),
      false,
      "an answer to this occurrence means there is nothing left to serve",
    );
  });

  test("the ledger keeps intents and results, and a line it cannot parse is reported instead of trusted", () => {
    appendMediationIntent(dir, {
      type: "intent",
      at: "2026-01-01T00:00:00.000Z",
      id: "request-1",
      work: "w",
      sessionId: SESSION,
      attempt: 1,
      kind: "help",
    });
    appendMediationResult(dir, {
      type: "result",
      at: "2026-01-01T00:00:01.000Z",
      id: "request-1",
      work: "w",
      sessionId: SESSION,
      attempt: 1,
      status: "published",
      commentId: "5",
    });
    const intact = readMediationLedger(dir);
    assert.equal(intact.intact, true);
    assert.deepEqual(intact.intents.map((entry) => entry.id), ["request-1"]);
    assert.deepEqual(intact.results.map((entry) => entry.commentId), ["5"]);

    writeFileSync(mediationPaths(dir).operations, `${readFileSync(mediationPaths(dir).operations, "utf8")}{not json\n`, "utf8");
    const damaged = readMediationLedger(dir);
    assert.equal(damaged.intact, false, "a corrupt line makes the ledger untrustworthy, never empty");
    assert.equal(damaged.results.length, 1, "the parsable history is still read");
  });

  test("an answer whose id is not the request it answers is not a fact", () => {
    // A file whose name and content disagree cannot be trusted as an answer.
    writeFileSync(
      join(mediationPaths(dir).responses, "other.json"),
      `${JSON.stringify({
        version: 1,
        id: "request-1",
        operation: "read",
        status: "ok",
        context: {},
        at: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );
    assert.equal(readMediationResponse(dir, "other").state, "invalid");

    const contractPath = mediationPaths(dir).contract;
    assert.equal(mediationWorkDirOf(contractPath), dir, "the contract path is the address the worker holds");
    assert.equal(readMediationContract(dir).state, "ready");
  });

  test("the request validator refuses an operation, a field or a kind outside the contract", () => {
    const cases: Array<Record<string, unknown>> = [
      { ...request(), operation: "delete" },
      { ...request(), target: "ABC-9" },
      { ...request(), operation: "publish", publication: { kind: "assign", text: "take it" } },
      { ...request(), operation: "publish", publication: { kind: "help", text: "" } },
    ];
    for (const [index, value] of cases.entries()) {
      const parsed = parseJiraMediationRequest({ ...value, id: `case-${index}` }, `case-${index}`);
      assert.equal(parsed.ok, false, `case ${index} is outside the contract`);
    }
  });
});
