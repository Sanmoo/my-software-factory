import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { reservationRecordOf, reserveWork, RESERVATION_FILENAME } from "../pool/reservation.js";
import { buildWorkerPrompt } from "../runtime/prompt.js";
import type { WorkRequest } from "../runtime/port.js";
import { appendSessionLink } from "../work-record/continuity.js";
import { JiraTicketAdapter, type JiraTransport } from "./jira-adapter.js";
import { JiraSim } from "./jira-sim.js";
import { ConfiguredJiraMediation, JiraMediator } from "./jira-mediation.js";
import {
  JIRA_CONTRACT_CONTAINER_PATH,
  mediationPaths,
  type JiraMediatedContext,
  type JiraMediationRequest,
  type JiraMediationResponse,
  type JiraReadResponse,
} from "../work-record/jira-mediation.js";
import { JiraWorkerClient } from "./jira-worker-client.js";
import { githubRepository, jiraTicket, workIdentity, type WorkIdentity } from "./identity.js";
import type { TicketSelection } from "./expanded-port.js";

/**
 * The mediated Jira interaction at its agreed seam: the worker client and the
 * REAL factory handler, with the production Jira adapter over the simulated
 * REST. What is observed is the client's structured answers, the Jira requests
 * the factory really made, the conversation the site received, and the
 * artifacts on disk — never a private call sequence.
 */

const REPO = "Sanmoo/my-tasks";
const SESSION = "session-1";
const ATTEMPT = 1;
const TOKEN_ENV = "MSF_JIRA_MEDIATION_TOKEN";
const SECRET = "host-only-jira-api-token";

const DESCRIPTION = {
  type: "doc",
  version: 1,
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Context" }] },
    { type: "paragraph", content: [{ type: "text", text: "The login flow must survive a restart." }] },
    {
      type: "bulletList",
      content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "keep the session" }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "never log the token" }] }] },
      ],
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "See the runbook", marks: [{ type: "link", attrs: { href: "https://example.test/runbook" } }] },
      ],
    },
  ],
};

const HUMAN_COMMENT_ADF = {
  type: "doc",
  version: 1,
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Human note: " },
        { type: "text", text: "keep the retry bounded", marks: [{ type: "strong" }] },
        { type: "text", text: " and mention @Ana." },
      ],
    },
  ],
};

interface Harness {
  dir: string;
  sim: JiraSim;
  adapter: JiraTicketAdapter;
  selection: TicketSelection;
  work: WorkIdentity;
  workDir: string;
  mediator: JiraMediator;
  client: JiraWorkerClient;
  close(): void;
}

describe("Jira mediation: the worker client and the real factory handler", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = setup();
  });

  afterEach(() => {
    harness.close();
    rmSync(harness.dir, { recursive: true, force: true });
    delete process.env[TOKEN_ENV];
  });

  test("an extra read returns the ticket's usable ADF content and its conversation, with structured factory evidence", async () => {
    // A human and the factory share the acting account: only the comment
    // property separates them, never the author login.
    harness.sim.addComment("ABC-1", { id: "c-human", body: HUMAN_COMMENT_ADF });
    harness.sim.addComment("ABC-1", {
      id: "c-factory",
      body: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: "the factory asked a question" }] }],
      },
      properties: [
        {
          key: "msf.factory",
          value: { version: 1, correlationId: "request-old", kind: "help", work: "w", sessionId: SESSION, attempt: ATTEMPT },
        },
      ],
    });

    const before = harness.sim.requests.length;
    const response = await harness.client.read();

    assert.equal(response.status, "ok");
    const context = contextOf(response);
    assert.equal(context.ticket?.key, "ABC-1");
    assert.match(String(context.ticket?.body), /Context/);
    assert.match(String(context.ticket?.body), /- keep the session/);
    assert.match(String(context.ticket?.body), /See the runbook \(https:\/\/example\.test\/runbook\)/);
    assert.deepEqual(
      context.comments?.map((comment) => [comment.id, comment.factory, comment.correlationId]),
      [
        ["c-human", false, null],
        ["c-factory", true, "request-old"],
      ],
      "the property, not the shared author account, says which comment is factory speech",
    );
    assert.ok(
      harness.sim.requests.slice(before).some((request) => request.path === "/rest/api/3/issue/10001/comment"),
      "the extra read really asked Jira for the conversation",
    );
    assert.match(harness.sim.requests.at(-1)?.authorization ?? "", /^Basic /);
  });

  test("a publication is an authorized factory comment with ADF meaning and a correlation the factory recovers", async () => {
    const response = await harness.client.publish({
      kind: "help",
      text: "I need the staging URL.\nThe check cannot run without it.",
    });
    assert.ok(response.status === "ok");
    assert.ok(response.commentId !== "");
    assert.equal(response.reconciled, false);

    const comment = harness.sim.issues[0]?.comments?.at(-1);
    assert.equal(comment?.author?.emailAddress, harness.sim.account.emailAddress, "the Acting account publishes");
    assert.deepEqual(comment?.properties?.map((property) => property.key), ["msf.factory"]);
    const property = comment?.properties?.[0]?.value as Record<string, unknown>;
    assert.equal(property["kind"], "help");
    assert.equal(typeof property["correlationId"], "string");
    assert.equal(property["sessionId"], SESSION);
    // The body is ADF: the line break is a hardBreak, not HTML or Markdown.
    const content = (comment?.body as { content: Array<{ content: Array<{ type: string }> }> }).content;
    assert.equal(content[0]?.content[0]?.type, "text");
    assert.equal(content[0]?.content[1]?.type, "hardBreak");
    assert.equal(content[0]?.content[2]?.type, "text");

    const read = await harness.client.read();
    const published = contextOf(read).comments?.find((entry) => entry.id === response.commentId);
    assert.equal(published?.factory, true);
    assert.equal(published?.correlationId, response.id);
    assert.match(String(published?.body), /I need the staging URL\.\nThe check cannot run without it\./);
  });

  test("a request for another Work, another site, another session or an operation outside the contract is rejected without a Jira call", async () => {
    const otherWork = workIdentity(
      jiraTicket({ site: harness.sim.site, stableId: "20002", key: "ABC-2" }),
      githubRepository(REPO),
    );
    const cases: Array<[string, JiraMediationRequest]> = [
      ["another work", request({ work: otherWork })],
      [
        "another site",
        request({
          work: workIdentity(
            jiraTicket({ site: "other.atlassian.net", stableId: "10001", key: "ABC-1" }),
            githubRepository(REPO),
          ),
        }),
      ],
      ["another session", request({ sessionId: "session-2" })],
      [
        "an operation outside the contract",
        { ...request(), operation: "delete" } as unknown as JiraMediationRequest,
      ],
      [
        "an unauthorized publication kind",
        {
          ...request(),
          operation: "publish",
          publication: { kind: "assign", text: "take the ticket" },
        } as unknown as JiraMediationRequest,
      ],
      [
        "an arbitrary field (a target the contract never authorized)",
        { ...request(), target: "ABC-9" } as unknown as JiraMediationRequest,
      ],
    ];

    const before = harness.sim.requests.length;
    for (const [index, [label, value]] of cases.entries()) {
      const response = await sendRaw(harness, `bad-${index}`, value);
      assert.equal(response.status, "rejected", label);
      assert.match(String(response.reason), /not|another|outside|unknown/, label);
    }
    assert.equal(harness.sim.requests.length, before, "a rejected request touches no Jira endpoint");
  });

  test("a reservation that names another Work, or a session that was never recorded, is rejected", async () => {
    const otherWork = workIdentity(
      jiraTicket({ site: harness.sim.site, stableId: "20002", key: "ABC-2" }),
      githubRepository(REPO),
    );
    writeFileSync(
      join(harness.workDir, RESERVATION_FILENAME),
      `${JSON.stringify({ ...reservationRecordOf(otherWork), presentation: {} })}\n`,
      "utf8",
    );
    const mismatch = await sendRaw(harness, "bad-reservation", request());
    assert.equal(mismatch.status, "rejected");
    assert.match(String(mismatch.reason), /reservation|Work/);

    // Restore the reservation, but ask from a session the Work never recorded.
    writeFileSync(
      join(harness.workDir, RESERVATION_FILENAME),
      `${JSON.stringify({ ...reservationRecordOf(harness.work), presentation: {} })}\n`,
      "utf8",
    );
    const unrecorded = await sendRaw(harness, "bad-session", request({ sessionId: "session-never-recorded" }));
    assert.equal(unrecorded.status, "rejected");
    assert.match(String(unrecorded.reason), /session/);
  });

  test("a publication whose response is ambiguous is reconciled by correlation, never duplicated", async () => {
    // The site creates the comment, then the response is lost. The handler must
    // find the comment by its property and answer ok — not publish again.
    harness.close();
    let dropped = false;
    const transport: JiraTransport = async (url, init) => {
      const response = await harness.sim.transport(url, init);
      if (!dropped && init.method === "POST" && url.endsWith("/comment")) {
        dropped = true;
        throw new Error("socket hang up after the write");
      }
      return response;
    };
    const adapter = new JiraTicketAdapter({
      site: harness.sim.site,
      account: harness.sim.account.emailAddress,
      tokenEnv: TOKEN_ENV,
      env: { [TOKEN_ENV]: SECRET },
      transport,
    });
    const mediator = new JiraMediator({
      work: harness.work,
      workDir: harness.workDir,
      attempt: ATTEMPT,
      sessionId: SESSION,
      selection: harness.selection,
      tickets: adapter,
      pollMs: 1,
    });
    mediator.start();
    try {
      const client = new JiraWorkerClient({ contractPath: mediationPaths(harness.workDir).contract, pollMs: 1, timeoutMs: 2000 });
      const response = await client.publish({ kind: "update", text: "the migration is ready" });
      assert.ok(response.status === "ok");
      assert.equal(response.reconciled, true);
      assert.equal(harness.sim.issues[0]?.comments?.length, 1, "exactly one comment exists");
      const comment = harness.sim.issues[0]?.comments?.[0];
      assert.equal((comment?.properties?.[0]?.value as Record<string, unknown>)["correlationId"], response.id);
    } finally {
      mediator.close();
    }
  });

  test("an unknown read is reported as such, never as an empty conversation", async () => {
    harness.sim.faults.commentRead = { status: 503, messages: ["Jira is unavailable"] };
    const partial = await harness.client.read();
    assert.ok(partial.status === "partial");
    assert.deepEqual(partial.unknown, ["comments"]);
    assert.equal(contextOf(partial).ticket?.key, "ABC-1", "the known fact is still delivered");
    assert.match(String(partial.reason), /comments/);

    harness.sim.faults.issue = { status: 503, messages: ["Jira is unavailable"] };
    const unknown = await harness.client.read();
    assert.ok(unknown.status === "unknown");
    assert.deepEqual(unknown.unknown.sort(), ["comments", "ticket"]);
  });

  test("an ambiguous publication is unknown after a retry, with no invented success and no duplicate", async () => {
    harness.sim.faults.commentCreate = { status: 503, messages: ["Jira is unavailable"] };
    const response = await harness.client.publish({ kind: "help", text: "please unblock" });
    assert.equal(response.status, "unknown");
    assert.equal(harness.sim.issues[0]?.comments?.length ?? 0, 0);
  });

  test("a retry with the same request id completes an unknown publication without a second comment", async () => {
    harness.sim.faults.commentCreate = { status: 503, messages: ["Jira is unavailable"] };
    const first = await harness.client.publish({ kind: "help", text: "please unblock", requestId: "retry-one" });
    assert.equal(first.status, "unknown");

    delete harness.sim.faults.commentCreate;
    const retried = await harness.client.publish({ kind: "help", text: "please unblock", requestId: "retry-one" });
    assert.equal(retried.status, "ok");
    assert.equal(retried.reconciled, false, "the failed write never landed, so the retry really published once");
    assert.equal(harness.sim.issues[0]?.comments?.length, 1);
  });

  test("the Jira token present in the host environment reaches no worker artifact or request", async () => {
    process.env[TOKEN_ENV] = SECRET;
    const read = await harness.client.read();
    assert.equal(read.status, "ok");

    const paths = mediationPaths(harness.workDir);
    const requestFile = join(paths.requests, `${read.id}.json`);
    const responseFile = join(paths.responses, `${read.id}.json`);
    const prompt = buildWorkerPrompt(launchRequest(harness.work, harness.workDir), { blockedLabel: "agent-blocked" });
    for (const artifact of [
      readFileSync(requestFile, "utf8"),
      readFileSync(responseFile, "utf8"),
      readFileSync(mediationPaths(harness.workDir).contract, "utf8"),
      prompt,
    ]) {
      assert.equal(artifact.includes(SECRET), false, "the host token never rides a worker artifact");
    }
  });

  test("the worker CLI, run with the Jira token in its OWN environment, still reads none of it", async () => {
    process.env[TOKEN_ENV] = SECRET;
    const cli = new URL("./jira-client-cli.js", import.meta.url).pathname;
    const output = await runProcess(process.execPath, [
      cli,
      "read",
      "--contract",
      mediationPaths(harness.workDir).contract,
      "--timeout-ms",
      "5000",
    ]);
    const response = JSON.parse(output.stdout) as JiraMediationResponse;
    assert.equal(response.status, "ok");
    assert.equal(`${output.stdout}${output.stderr}`.includes(SECRET), false, "the client never prints the token");
  });

  test("one selection serves exactly one Work; an unconfigured source has no handler", () => {
    const composition = new ConfiguredJiraMediation([{ selection: harness.selection, tickets: harness.adapter }]);
    const unconfigured = workIdentity(
      jiraTicket({ site: "other.atlassian.net", stableId: "10001", key: "ABC-1" }),
      githubRepository(REPO),
    );
    assert.equal(
      composition.open({ work: unconfigured, workDir: harness.workDir, attempt: ATTEMPT, sessionId: SESSION }),
      null,
    );
  });
});

function request(overrides: Partial<JiraMediationRequest> = {}): JiraMediationRequest {
  return {
    version: 1,
    id: "request-1",
    operation: "read",
    work: overrides.work ?? WORK,
    sessionId: overrides.sessionId ?? SESSION,
  };
}

// The tests replace `work` in a request that already carries the harness's own
// Work, so a module-level placeholder is enough and never reaches a valid
// request unchanged.
const WORK = workIdentity(
  jiraTicket({ site: "acme.atlassian.net", stableId: "10001", key: "ABC-1" }),
  githubRepository(REPO),
);

function setup(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "msf-jira-mediation-"));
  const sim = new JiraSim({ token: SECRET });
  sim.addIssue({ id: "10001", key: "ABC-1", summary: "Fix login", description: DESCRIPTION });
  sim.addIssue({ id: "20002", key: "ABC-2", summary: "Other work", description: null });
  process.env[TOKEN_ENV] = SECRET;
  const adapter = new JiraTicketAdapter({
    site: sim.site,
    account: sim.account.emailAddress,
    tokenEnv: TOKEN_ENV,
    env: { [TOKEN_ENV]: SECRET },
    transport: sim.transport,
  });
  const work = workIdentity(
    jiraTicket({
      site: sim.site,
      stableId: "10001",
      key: "ABC-1",
      url: `https://${sim.site}/browse/ABC-1`,
    }),
    githubRepository(REPO),
  );
  const reserved = reserveWork(join(dir, "ws"), reservationRecordOf(work));
  appendSessionLink(reserved.dir, {
    version: 1,
    work,
    attempt: ATTEMPT,
    round: 1,
    sessionId: SESSION,
    at: "2026-01-01T00:00:00.000Z",
  });
  const selection: TicketSelection = {
    source: { provider: "jira", site: sim.site },
    destination: githubRepository(REPO),
    jql: "project = ABC",
  };
  const mediator = new JiraMediator({
    work,
    workDir: reserved.dir,
    attempt: ATTEMPT,
    sessionId: SESSION,
    selection,
    tickets: adapter,
    pollMs: 1,
  });
  mediator.start();
  const client = new JiraWorkerClient({
    contractPath: mediationPaths(reserved.dir).contract,
    pollMs: 1,
    timeoutMs: 2000,
  });
  return {
    dir,
    sim,
    adapter,
    selection,
    work,
    workDir: reserved.dir,
    mediator,
    client,
    close: () => mediator.close(),
  };
}

async function sendRaw(
  harness: Harness,
  id: string,
  value: JiraMediationRequest | Record<string, unknown>,
): Promise<JiraMediationResponse> {
  const paths = mediationPaths(harness.workDir);
  const requestFile = join(paths.requests, `${id}.json`);
  const responseFile = join(paths.responses, `${id}.json`);
  writeFileSync(requestFile, `${JSON.stringify({ ...value, id })}\n`, "utf8");
  // The harness's own mediator is serving; wait for its response file.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(responseFile)) {
      return JSON.parse(readFileSync(responseFile, "utf8")) as JiraMediationResponse;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`no response for ${id}`);
}

function runProcess(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code }));
  });
}

function contextOf(response: JiraReadResponse): JiraMediatedContext {
  if (response.status !== "ok" && response.status !== "partial") {
    throw new Error(`no context in a ${response.status} answer`);
  }
  return response.context;
}

function launchRequest(work: WorkIdentity, workDir: string): WorkRequest {
  return {
    work,
    workDir,
    branch: "agent-issue-1",
    repoDir: "/clones/repo",
    baseBranch: "main",
    attempt: ATTEMPT,
    session: { mode: "new", sessionId: SESSION },
    material: {
      ticket: { title: "Fix login", body: "The login flow must survive a restart." },
      diff: "",
      jira: { contractPath: JIRA_CONTRACT_CONTAINER_PATH },
    },
  };
}
