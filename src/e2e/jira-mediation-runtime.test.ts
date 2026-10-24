import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { reservationRecordOf, reserveWork } from "../pool/reservation.js";
import { appendSessionLink } from "../runtime/continuity-artifacts.js";
import { FakeWorkerRuntime } from "../runtime/fake-runtime.js";
import { launchWithJiraMediation } from "../runtime/mediated-launch.js";
import type { WorkRequest } from "../runtime/port.js";
import { githubRepository, jiraTicket, workIdentity, type WorkIdentity } from "../tracker/identity.js";
import { JiraTicketAdapter } from "../tracker/jira-adapter.js";
import { JiraSim } from "../tracker/jira-sim.js";
import { ConfiguredJiraMediation, jiraContractPath } from "../tracker/jira-mediation.js";
import { JiraWorkerClient } from "../tracker/jira-worker-client.js";
import { JIRA_CONTRACT_CONTAINER_PATH } from "../tracker/jira-mediation-protocol.js";
import type { TicketSelection } from "../tracker/expanded-port.js";

/**
 * The mediated Jira interaction through the scriptable runtime (issue 131):
 * the worker's script runs INSIDE a launch of the fake runtime and uses the
 * production worker client against the real factory handler and the real Jira
 * adapter over the simulated REST. What is observed is the session's effect:
 * the Jira conversation the factory read and the comment it published while
 * the session was running.
 */

const REPO = "Sanmoo/my-tasks";
const SESSION = "session-runtime-1";
const ATTEMPT = 1;
const TOKEN_ENV = "MSF_JIRA_RUNTIME_TOKEN";
const SECRET = "runtime-host-only-jira-token";

describe("e2e: a scripted worker session uses factory-mediated Jira (issue 131)", () => {
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
          contractPath: jiraContractPath(request.workDir),
          pollMs: 1,
          timeoutMs: 2000,
        });
        sim.addComment("ABC-1", {
          id: "c-human",
          body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "the staging URL is https://staging.test" }] }] },
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
    assert.equal(
      runtime.launched[0]?.material.jira !== undefined,
      true,
      "the launch carried the mediation contract, not the Jira token",
    );
    assert.equal(JSON.stringify(runtime.launched[0]).includes(SECRET), false);
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
