import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { githubRepository, jiraTicket, type TicketIdentity } from "./identity.js";
import type { TicketSelection } from "./expanded-port.js";
import { JiraTicketAdapter, type JiraTransport } from "./jira-adapter.js";
import { basic, JiraSim, type SimJiraAccount } from "./jira-sim.js";

/**
 * The real Jira adapter over the simulated REST (issue 128): native Rank
 * ordering across token-paginated pages, a selection that is exactly the
 * operator's JQL (no hidden assignee/status/type/subtask filters), the
 * authenticated Acting account, ADF content in usable form, and diagnostics
 * that never leak the token or fall back to another account or ordering.
 */

const REPO = "Sanmoo/my-tasks";
const TOKEN_ENV = "MSF_JIRA_TEST_TOKEN";

function adapterFor(sim: JiraSim, overrides: Partial<ConstructorParameters<typeof JiraTicketAdapter>[0]> = {}) {
  return new JiraTicketAdapter({
    site: sim.site,
    account: sim.account.emailAddress,
    tokenEnv: TOKEN_ENV,
    env: { [TOKEN_ENV]: sim.token },
    transport: sim.transport,
    ...overrides,
  });
}

function selectionFor(sim: JiraSim, jql: string): TicketSelection {
  return {
    source: { provider: "jira", site: sim.site },
    destination: githubRepository(REPO),
    jql,
  };
}

function ticketOf(sim: JiraSim, stableId: string): TicketIdentity {
  const issue = sim.issues.find((entry) => entry.id === stableId);
  assert.ok(issue, `the sim seeds ticket ${stableId}`);
  return jiraTicket({ site: sim.site, stableId, key: issue.key });
}

const HUMAN: SimJiraAccount = {
  accountId: "human-1",
  emailAddress: "ana@acme.example",
  displayName: "Ana Silva",
};

describe("Jira adapter: native Rank selection over the simulated REST (issue 128)", () => {
  test("the query is read in Rank ascending order and /myself identifies the Acting account", async () => {
    const sim = new JiraSim();
    sim.addIssue({ id: "10001", key: "ABC-1", summary: "First in Rank", created: "2026-03-01T00:00:00.000+0000" });
    sim.addIssue({ id: "10002", key: "ABC-2", summary: "Second in Rank", created: "2026-01-01T00:00:00.000+0000" });
    const adapter = adapterFor(sim);

    const listed = await adapter.listOpenTickets(selectionFor(sim, "project = ABC"));

    assert.deepEqual(
      listed.map((entry) => entry.ticket.key),
      ["ABC-1", "ABC-2"],
      "the sim's Rank order is preserved, never re-sorted by creation date",
    );
    assert.deepEqual(
      sim.requests.map((request) => `${request.method} ${request.path}`),
      ["GET /rest/api/3/myself", "POST /rest/api/3/search/jql"],
      "one identity read, then the native search",
    );
    const search = sim.requests.at(-1);
    assert.match(String(search?.jql), /^project = ABC ORDER BY Rank ASC$/);
    assert.equal(search?.authorization, basic(sim.account.emailAddress, sim.token), "API-token Basic auth");
    assert.deepEqual(await adapter.actingAccount(), {
      accountId: sim.account.accountId,
      emailAddress: sim.account.emailAddress,
      displayName: sim.account.displayName,
    });
  });

  test("the identity is read once, not per listing", async () => {
    const sim = new JiraSim();
    sim.addIssue({ key: "ABC-1", summary: "One" });
    const adapter = adapterFor(sim);

    await adapter.listOpenTickets(selectionFor(sim, "project = ABC"));
    await adapter.listOpenTickets(selectionFor(sim, "project = ABC"));

    assert.equal(
      sim.requests.filter((request) => request.path === "/rest/api/3/myself").length,
      1,
      "the authenticated account is identified once per adapter",
    );
  });

  test("the JQL is the whole selection: a person's ticket, an unassigned ticket and a subtask all appear", async () => {
    const sim = new JiraSim();
    sim.addIssue({ id: "10001", key: "ABC-1", summary: "Assigned to a human", assignee: HUMAN });
    sim.addIssue({ id: "10002", key: "ABC-2", summary: "Nobody owns it", assignee: null });
    sim.addIssue({
      id: "10003",
      key: "ABC-3",
      summary: "A subtask",
      issueType: "Sub-task",
      parentKey: "ABC-1",
      assignee: HUMAN,
    });
    const adapter = adapterFor(sim);

    const jql = "project = ABC AND status not in (Done) AND labels = ready";
    const listed = await adapter.listOpenTickets(selectionFor(sim, jql));

    assert.deepEqual(
      listed.map((entry) => entry.ticket.key),
      ["ABC-1", "ABC-2", "ABC-3"],
      "no unassigned, open-only, readiness or subtask filter is added to the operator's query",
    );
    assert.deepEqual(listed[0]?.assignees, ["Ana Silva"]);
    assert.deepEqual(listed[1]?.assignees, [], "unassigned is presented, not filtered out");
    const search = sim.requests.at(-1);
    assert.equal(search?.jql, `${jql} ORDER BY Rank ASC`, "the query body is the operator's JQL plus the ordering");
  });

  test("native pagination keeps the site-wide Rank order across pages", async () => {
    const sim = new JiraSim();
    sim.pageSize = 2;
    for (const number of [1, 2, 3, 4, 5]) {
      sim.addIssue({
        id: String(10000 + number),
        key: `ABC-${number}`,
        summary: `Ticket ${number}`,
        created: `2026-0${number}-01T00:00:00.000+0000`,
      });
    }
    const adapter = adapterFor(sim);

    const listed = await adapter.listOpenTickets(selectionFor(sim, "project in (ABC, DEF)"));

    assert.deepEqual(
      listed.map((entry) => entry.ticket.key),
      ["ABC-1", "ABC-2", "ABC-3", "ABC-4", "ABC-5"],
      "the pages concatenate in Rank order, not by per-page age",
    );
    const searches = sim.requests.filter((request) => request.path === "/rest/api/3/search/jql");
    assert.equal(searches.length, 3, "three native pages");
    assert.deepEqual(
      searches.map((request) => request.nextPageToken),
      [null, "2", "4"],
      "the opaque nextPageToken chain is followed",
    );
  });

  test("every ticket carries provider, site, stable id, readable key and browse URL", async () => {
    const sim = new JiraSim();
    sim.addIssue({ id: "10001", key: "ABC-1", summary: "One", labels: ["ready"], created: "2026-02-01T00:00:00.000+0000" });
    const adapter = adapterFor(sim);

    const [listed] = await adapter.listOpenTickets(selectionFor(sim, "project = ABC"));

    assert.deepEqual(listed?.ticket, {
      provider: "jira",
      site: sim.site,
      stableId: "10001",
      key: "ABC-1",
      url: `https://${sim.site}/browse/ABC-1`,
    });
    assert.equal(listed?.title, "One");
    assert.equal(listed?.createdAt, "2026-02-01T00:00:00.000+0000");
    assert.deepEqual(listed?.labels, ["ready"]);
  });

  test("a differently authenticated account is refused instead of silently acting as it", async () => {
    const sim = new JiraSim({
      account: { accountId: "other", emailAddress: "other@acme.example", displayName: "Other" },
    });
    sim.addIssue({ key: "ABC-1", summary: "One" });
    const adapter = adapterFor(sim, { account: "bot@acme.example" });

    await assert.rejects(adapter.listOpenTickets(selectionFor(sim, "project = ABC")), /never falls back/);
    assert.deepEqual(
      sim.requests.map((request) => request.path),
      ["/rest/api/3/myself"],
      "no search runs under the wrong identity",
    );
  });

  test("an unidentified authenticated account is refused, never relabelled as the configured one", async () => {
    const sim = new JiraSim();
    sim.addIssue({ key: "ABC-1", summary: "One" });
    // A site that authenticates the token but does not report which account it is.
    const transport: JiraTransport = async (url, init) => {
      const response = await sim.transport(url, init);
      if (url.endsWith("/rest/api/3/myself")) {
        return { status: 200, text: JSON.stringify({ accountId: "someone-else", active: true }) };
      }
      return response;
    };
    const adapter = adapterFor(sim, { transport });

    await assert.rejects(
      adapter.listOpenTickets(selectionFor(sim, "project = ABC")),
      /accepted the credential but did not report which account/,
    );
    assert.deepEqual(
      sim.requests.map((request) => request.path),
      ["/rest/api/3/myself"],
      "no listing runs under an identity the config cannot verify",
    );
  });

  test("a missing local credential is named, nothing is sent and no other account is tried", async () => {
    const sim = new JiraSim();
    sim.addIssue({ key: "ABC-1", summary: "One" });
    const adapter = adapterFor(sim, { env: {} });

    await assert.rejects(adapter.listOpenTickets(selectionFor(sim, "project = ABC")), (error: Error) => {
      assert.match(error.message, new RegExp(TOKEN_ENV));
      assert.match(error.message, /not set/);
      assert.ok(!error.message.includes(sim.token), "the token value never reaches the diagnostic");
      return true;
    });
    assert.equal(sim.requests.length, 0, "no HTTP request is made without a credential");
  });

  test("a rejected credential is diagnosed without the secret and without an account fallback", async () => {
    const sim = new JiraSim();
    sim.addIssue({ key: "ABC-1", summary: "One" });
    const adapter = adapterFor(sim, { env: { [TOKEN_ENV]: "wrong-token-value" } });

    await assert.rejects(adapter.listOpenTickets(selectionFor(sim, "project = ABC")), (error: Error) => {
      assert.match(error.message, /rejected the credential/);
      assert.match(error.message, new RegExp(sim.site));
      assert.ok(!error.message.includes("wrong-token-value"));
      return true;
    });
  });

  test("insufficient permissions are diagnosed as such", async () => {
    const sim = new JiraSim();
    sim.faults.myself = { status: 403, messages: ["You do not have permission to browse this site."] };
    const adapter = adapterFor(sim);

    await assert.rejects(adapter.listOpenTickets(selectionFor(sim, "project = ABC")), /insufficient Jira permissions/);
  });

  test("invalid JQL is named, never an empty selection", async () => {
    const sim = new JiraSim();
    sim.faults.search = {
      status: 400,
      messages: ["Error in the JQL Query: Expecting operator but got '=' at position 20."],
    };
    const adapter = adapterFor(sim);

    await assert.rejects(adapter.listOpenTickets(selectionFor(sim, "project = = ABC")), /invalid JQL/);
  });

  test("unavailable Rank is diagnosed and never falls back to age or Priority", async () => {
    const sim = new JiraSim();
    sim.faults.search = { status: 400, messages: ["Field 'Rank' does not exist or is not searchable."] };
    const adapter = adapterFor(sim);

    await assert.rejects(adapter.listOpenTickets(selectionFor(sim, "project = ABC")), (error: Error) => {
      assert.match(error.message, /native Rank is unavailable/);
      assert.match(error.message, /never falls back/);
      return true;
    });
  });

  test("a server failure is a read failure, never an empty list", async () => {
    const sim = new JiraSim();
    sim.faults.search = { status: 503, messages: ["The service is unavailable"] };
    const adapter = adapterFor(sim);

    await assert.rejects(adapter.listOpenTickets(selectionFor(sim, "project = ABC")), /could not read Jira site/);
  });

  test("a GitHub selection or another Jira site is refused by this adapter", async () => {
    const sim = new JiraSim();
    const adapter = adapterFor(sim);

    await assert.rejects(
      adapter.listOpenTickets({ source: { provider: "github", site: "github.com" }, destination: githubRepository(REPO) }),
      /cannot list github tickets/,
    );
    await assert.rejects(
      adapter.listOpenTickets({
        source: { provider: "jira", site: "beta.atlassian.net" },
        destination: githubRepository(REPO),
        jql: "project = ABC",
      }),
      /cannot list jira tickets/,
    );
    assert.equal(sim.requests.length, 0, "the wrong source never reaches the network");
  });

  test("a selection without JQL is refused instead of listing everything", async () => {
    const sim = new JiraSim();
    const adapter = adapterFor(sim);

    await assert.rejects(
      adapter.listOpenTickets({
        source: { provider: "jira", site: sim.site },
        destination: githubRepository(REPO),
      }),
      /carries no JQL/,
    );
    assert.equal(sim.requests.length, 0);
  });

  test("a conflicting ordering is refused by the adapter too", async () => {
    const sim = new JiraSim();
    const adapter = adapterFor(sim);

    await assert.rejects(
      adapter.listOpenTickets(selectionFor(sim, "project = ABC ORDER BY created ASC")),
      /conflicts with the native Rank ascending order/,
    );
    assert.equal(sim.requests.length, 0);
  });

  test("the ticket's ADF description is usable text, neither JSON nor HTML/Markdown", async () => {
    const sim = new JiraSim();
    sim.addIssue({
      id: "10001",
      key: "ABC-1",
      summary: "Fix login",
      description: {
        type: "doc",
        version: 1,
        content: [
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Problem" }] },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Users " },
              { type: "text", text: "cannot", marks: [{ type: "strong" }] },
              { type: "text", text: " sign in. See " },
              { type: "text", text: "the report", marks: [{ type: "link", attrs: { href: "https://acme.example/report" } }] },
            ],
          },
          {
            type: "bulletList",
            content: [
              { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "expired cookie" }] }] },
              { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "bad redirect" }] }] },
            ],
          },
          {
            type: "codeBlock",
            attrs: { language: "text" },
            content: [{ type: "text", text: "HTTP 401\nat /login" }],
          },
        ],
      },
    });
    const adapter = adapterFor(sim);

    const snapshot = await adapter.readTicket(ticketOf(sim, "10001"));

    if (!snapshot.known) assert.fail("the ticket is readable");
    const body = snapshot.value.body;
    assert.match(body, /Problem/);
    assert.match(body, /Users cannot sign in/);
    assert.match(body, /the report \(https:\/\/acme\.example\/report\)/);
    assert.match(body, /- expired cookie/);
    assert.match(body, /HTTP 401/);
    assert.match(body, /at \/login/);
    assert.ok(!body.includes('"type"'), "the ADF tree is rendered, never dumped as JSON");
    assert.ok(!body.includes("<p>"), "ADF is not treated as HTML");
    assert.deepEqual(snapshot.value.ticket, {
      provider: "jira",
      site: sim.site,
      stableId: "10001",
      key: "ABC-1",
      url: `https://${sim.site}/browse/ABC-1`,
    });
  });

  test("the single-ticket read uses the immutable id, so a renamed key still reads", async () => {
    const sim = new JiraSim();
    sim.addIssue({ id: "10001", key: "ABC-1", summary: "One" });
    const adapter = adapterFor(sim);

    const snapshot = await adapter.readTicket(ticketOf(sim, "10001"));

    assert.match(String(sim.requests.at(-1)?.path), /\/rest\/api\/3\/issue\/10001$/);
    if (!snapshot.known) assert.fail("the ticket is readable");
    assert.equal(snapshot.value.title, "One");
    assert.equal(snapshot.value.state, "open", "Jira's Done category is not this port's GitHub issue completion");
  });

  test("a missing ticket is unknown, never absent", async () => {
    const sim = new JiraSim();
    const adapter = adapterFor(sim);

    const snapshot = await adapter.readTicket(jiraTicket({ site: sim.site, stableId: "99999", key: "ABC-99" }));

    assert.equal(snapshot.known, false);
  });

  test("every operation this slice does not implement is refused before any write", async () => {
    const sim = new JiraSim();
    const adapter = adapterFor(sim);
    const ticket = jiraTicket({ site: sim.site, stableId: "10001", key: "ABC-1" });

    const refused: Array<[string, () => Promise<unknown>]> = [
      ["dependency read", () => adapter.readTicketBlockers(ticket)],
      ["claim", () => adapter.claimTicket(ticket, "bot@acme.example")],
      ["claim release", () => adapter.releaseTicketClaim(ticket, "bot@acme.example")],
      ["block", () => adapter.blockTicketClaim(ticket, { ready: "ready", claimed: "claimed", blocked: "blocked" })],
      ["resume", () => adapter.resumeTicketClaim(ticket, { ready: "ready", claimed: "claimed", blocked: "blocked" })],
      ["mark done", () => adapter.markTicketDone(ticket)],
      ["comment", () => adapter.commentOnTicket(ticket, "hello")],
      ["comment read", () => adapter.readTicketComments(ticket)],
      ["rank read", () => adapter.rankTicket(ticket)],
    ];
    for (const [operation, call] of refused) {
      await assert.rejects(call(), new RegExp(`Jira ${operation} is not implemented yet`), operation);
    }
    assert.equal(sim.requests.length, 0, "nothing reaches the tracker, no write is attempted");
  });
});
