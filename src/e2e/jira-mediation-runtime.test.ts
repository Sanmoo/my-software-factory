import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { reservationRecordOf, reserveWork } from "../pool/reservation.js";
import { FakeWorkerRuntime } from "../runtime/fake-runtime.js";
import { launchWithJiraMediation } from "../runtime/mediated-launch.js";
import type { WorkRequest } from "../runtime/port.js";
import { appendSessionLink } from "../work-record/continuity.js";
import { githubRepository, jiraTicket, workIdentity, type WorkIdentity } from "../tracker/identity.js";
import { JiraTicketAdapter } from "../tracker/jira-adapter.js";
import { JiraSim } from "../tracker/jira-sim.js";
import { ConfiguredJiraMediation } from "../tracker/jira-mediation.js";
import { JiraWorkerClient } from "../tracker/jira-worker-client.js";
import {
  JIRA_CONTRACT_CONTAINER_PATH,
  JIRA_MEDIATION_DIRNAME,
  mediationPaths,
  readMediationResponse,
} from "../work-record/jira-mediation.js";
import type { TicketSelection } from "../tracker/expanded-port.js";

/**
 * The mediated Jira interaction through the scriptable runtime: the worker's
 * script runs INSIDE a launch of the fake runtime and uses the production
 * worker client against the real factory handler and the real Jira adapter
 * over the simulated REST. What is observed is the session's effect — the
 * conversation the factory read and the comment it published while the session
 * was running — plus what the launch left in the work dir.
 */

const REPO = "Sanmoo/my-tasks";
const SESSION = "session-runtime-1";
const ATTEMPT = 1;
const TOKEN_ENV = "MSF_JIRA_RUNTIME_TOKEN";
const SECRET = "runtime-host-only-jira-token";

describe("e2e: a scripted worker session asks the factory for Jira", () => {
  let dir: string;
  let sim: JiraSim;
  let adapter: JiraTicketAdapter;
  let selection: TicketSelection;
  let work: WorkIdentity;
  let workDir: string;
  let composition: ConfiguredJiraMediation;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-jira-runtime-"));
    process.env[TOKEN_ENV] = SECRET;
    sim = new JiraSim({ token: SECRET });
    sim.addIssue({
      id: "10001",
      key: "ABC-1",
      summary: "Fix login",
      description: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: "The login flow must survive a restart." }] }],
      },
    });
    adapter = new JiraTicketAdapter({
      site: sim.site,
      account: sim.account.emailAddress,
      tokenEnv: TOKEN_ENV,
      env: { [TOKEN_ENV]: SECRET },
      transport: sim.transport,
    });
    selection = {
      source: { provider: "jira", site: sim.site },
      destination: githubRepository(REPO),
      jql: "project = ABC",
    };
    work = workIdentity(jiraTicket({ site: sim.site, stableId: "10001", key: "ABC-1" }), githubRepository(REPO));
    const reserved = reserveWork(join(dir, "ws"), reservationRecordOf(work));
    workDir = reserved.dir;
    appendSessionLink(workDir, {
      version: 1,
      work,
      attempt: ATTEMPT,
      round: 1,
      sessionId: SESSION,
      at: "2026-01-01T00:00:00.000Z",
    });
    composition = new ConfiguredJiraMediation([{ selection, tickets: adapter }], { pollMs: 1 });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env[TOKEN_ENV];
  });

  test("the running session reads extra context and publishes an authorized help request; the factory makes both Jira calls", async () => {
    const observed: string[] = [];
    const runtime = new FakeWorkerRuntime({
      outcomes: ["clean-without-pr"],
      hold: async (request) => {
        const client = new JiraWorkerClient({
          // The worker reads the contract at its container path; the test
          // process reaches the same file through the host work dir.
          contractPath: mediationPaths(request.workDir).contract,
          pollMs: 1,
          timeoutMs: 2000,
        });
        sim.addComment("ABC-1", {
          id: "c-human",
          body: {
            type: "doc",
            version: 1,
            content: [
              { type: "paragraph", content: [{ type: "text", text: "the staging URL is https://staging.test" }] },
            ],
          },
        });
        const read = await client.read();
        assert.equal(read.status, "ok");
        observed.push(`read:${read.status}`);
        const comments = read.status === "ok" ? read.context.comments : [];
        assert.deepEqual(comments?.map((comment) => [comment.id, comment.factory]), [["c-human", false]]);

        const published = await client.publish({
          kind: "help",
          text: "Which staging environment should the check use?",
        });
        assert.ok(published.status === "ok");
        observed.push(`publish:${published.status}`);
        assert.equal(request.material.jira?.contractPath, JIRA_CONTRACT_CONTAINER_PATH);
      },
    });

    const result = await launchWithJiraMediation(runtime, requestFor(work, workDir), composition);

    assert.equal(result.outcome, "clean-without-pr");
    assert.deepEqual(observed, ["read:ok", "publish:ok"]);
    const comment = sim.issues[0]?.comments?.at(-1);
    assert.equal(comment?.author?.emailAddress, sim.account.emailAddress, "the Acting account published");
    assert.equal((comment?.properties?.[0]?.value as Record<string, unknown>)["kind"], "help");
    assert.equal(runtime.launched[0]?.material.jira !== undefined, true, "the launch carried the mediation contract");
    assert.equal(JSON.stringify(runtime.launched[0]).includes(SECRET), false, "the token never rides the launch");
    assert.equal(
      JSON.stringify(runtime.launched[0]).includes(mediationPaths(workDir).contract),
      false,
      "the worker is told the container path, never a host path",
    );
  });

  test("a Jira Work without a configured mediation is refused before any worker starts", async () => {
    const runtime = new FakeWorkerRuntime({ outcomes: ["clean-without-pr"] });
    await assert.rejects(
      launchWithJiraMediation(runtime, requestFor(work, workDir), undefined),
      /factory-mediated Jira access/,
    );
    assert.equal(runtime.launched.length, 0);
  });

  test("a Jira Work whose source is not configured is refused before any worker starts", async () => {
    const other = new ConfiguredJiraMediation([], { pollMs: 1 });
    const runtime = new FakeWorkerRuntime({ outcomes: ["clean-without-pr"] });
    await assert.rejects(
      launchWithJiraMediation(runtime, requestFor(work, workDir), other),
      /no configured Jira selection/,
    );
    assert.equal(runtime.launched.length, 0);
    assert.equal(sim.requests.length, 0, "a refused launch calls no Jira endpoint");
  });

  test("an unknown publication is reported as unknown in the worker's answer and in the artifacts it leaves", async () => {
    let status = "";
    const runtime = new FakeWorkerRuntime({
      outcomes: ["blocked-self-report"],
      hold: async (request) => {
        const client = new JiraWorkerClient({ contractPath: mediationPaths(request.workDir).contract, pollMs: 1 });
        sim.faults.commentCreate = { status: 503, messages: ["Jira is unavailable"] };
        const answer = await client.publish({ kind: "help", text: "the migration needs the staging URL" });
        status = answer.status;
      },
    });

    await launchWithJiraMediation(runtime, requestFor(work, workDir), composition);

    assert.equal(status, "unknown", "an ambiguous publication is reported as unknown, never as success");
    assert.equal(sim.issues[0]?.comments?.length ?? 0, 0);
    const artifacts = readdirSync(join(workDir, JIRA_MEDIATION_DIRNAME), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));
    assert.ok(artifacts.length > 0);
    assert.ok(
      artifacts.some((artifact) => artifact.includes("the migration needs the staging URL")),
      "the worker's own request is on disk, not invented by the factory",
    );
    assert.ok(
      artifacts.some((artifact) => /"status":\s*"unknown"/.test(artifact)),
      "the answer the worker read is the fact on disk",
    );
    for (const artifact of artifacts) {
      assert.equal(artifact.includes(SECRET), false, "no artifact of the mediation carries the token");
    }
  });

  test("a request the launched session forges for another Work is rejected without a Jira call", async () => {
    let answer = "";
    const runtime = new FakeWorkerRuntime({
      outcomes: ["blocked-self-report"],
      hold: async (session) => {
        // A worker that writes the record's file itself is not the client: the
        // factory validates what it reads, not what the client promised.
        const paths = mediationPaths(session.workDir);
        const elsewhere = workIdentity(
          jiraTicket({ site: sim.site, stableId: "10002", key: "ABC-2" }),
          githubRepository("Sanmoo/other"),
        );
        writeFileSync(
          join(paths.requests, "forged-1.json"),
          `${JSON.stringify({
            version: 1,
            id: "forged-1",
            operation: "publish",
            work: elsewhere,
            sessionId: SESSION,
            publication: { kind: "update", text: "ship it" },
          })}\n`,
          "utf8",
        );
        for (let attempt = 0; attempt < 2_000; attempt += 1) {
          const response = readMediationResponse(session.workDir, "forged-1");
          if (response.state === "ready") {
            answer = response.value.status;
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.fail("the factory never answered the forged request");
      },
    });

    await launchWithJiraMediation(runtime, requestFor(work, workDir), composition);

    assert.equal(answer, "rejected", "the factory answers the forged request as rejected");
    assert.equal(sim.issues[0]?.comments?.length ?? 0, 0, "a rejected request publishes nothing");
    assert.equal(
      sim.requests.some((request) => request.path.includes("10002")),
      false,
      "nor does it read the Work it was not asked for",
    );
  });

  test("an ambiguous publication is settled by repeating the same request, never by a second write of its own", async () => {
    let statuses: string[] = [];
    let reconciled: boolean | null = null;
    const runtime = new FakeWorkerRuntime({
      outcomes: ["clean-without-pr"],
      hold: async (session) => {
        const client = new JiraWorkerClient({
          contractPath: mediationPaths(session.workDir).contract,
          pollMs: 1,
          timeoutMs: 2000,
        });
        sim.faults.commentCreate = { status: 503, messages: ["Jira is unavailable"] };
        const first = await client.publish({ kind: "update", text: "the check is ready", requestId: "retry-runtime" });
        delete sim.faults.commentCreate;
        const retried = await client.publish({ kind: "update", text: "the check is ready", requestId: "retry-runtime" });
        statuses = [first.status, retried.status];
        reconciled = retried.status === "ok" ? retried.reconciled : null;
      },
    });

    await launchWithJiraMediation(runtime, requestFor(work, workDir), composition);

    assert.deepEqual(statuses, ["unknown", "ok"], "the unknown is a fact the worker acts on, not a phantom success");
    assert.equal(reconciled, false, "the retried request is the write that landed");
    assert.equal(sim.issues[0]?.comments?.length, 1, "one publication for one request, however often it is asked");
    const landings = sim.requests.filter((request) => request.method === "POST" && request.path.endsWith("/comment"));
    assert.equal(landings.length, 2, "the failed write and the retried one — the factory adds no write of its own");
  });
});

function requestFor(work: WorkIdentity, workDir: string): WorkRequest {
  return {
    work,
    workDir,
    branch: "agent-issue-1",
    repoDir: join(workDir, "repo"),
    baseBranch: "main",
    attempt: ATTEMPT,
    session: { mode: "new", sessionId: SESSION },
    material: {
      ticket: { title: "Fix login", body: "The login flow must survive a restart." },
      diff: "",
    },
  };
}
