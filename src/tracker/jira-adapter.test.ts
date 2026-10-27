import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { githubRepository, jiraTicket, workIdentity, type TicketIdentity } from "./identity.js";
import type { PrerequisiteLink, TicketSelection } from "./expanded-port.js";
import {
  FACTORY_COMMENT_PROPERTY,
  FACTORY_EVIDENCE_VERSION,
  JiraTicketAdapter,
  type JiraTransport,
} from "./jira-adapter.js";
import { basic, JiraSim, type SimJiraAccount, type SimJiraIssue, type SimJiraLink } from "./jira-sim.js";
import { humanCommentsAfterLastFactorySpeech } from "./speech.js";

/**
 * The real Jira adapter over the simulated REST: native Rank
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

describe("Jira adapter: native Rank selection over the simulated REST ", () => {
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

  test("several selections on one site are read as one native Rank-ordered result across pages", async () => {
    const sim = new JiraSim();
    sim.pageSize = 2;
    sim.addIssue({ id: "10001", key: "ABC-1", summary: "Frontend first", labels: ["frontend"], created: "2026-05-01T00:00:00.000+0000" });
    sim.addIssue({ id: "10002", key: "DEF-1", summary: "Backend first", labels: ["backend"], created: "2026-01-01T00:00:00.000+0000" });
    sim.addIssue({ id: "10003", key: "ABC-2", summary: "Frontend second", labels: ["frontend"], created: "2026-03-01T00:00:00.000+0000" });
    const adapter = adapterFor(sim);
    const frontend = { ...selectionFor(sim, "project in (ABC, DEF) AND labels = frontend"), destination: githubRepository("Sanmoo/frontend") };
    const backend = { ...selectionFor(sim, "project in (ABC, DEF) AND labels = backend"), destination: githubRepository("Sanmoo/backend") };

    const listed = await adapter.listSiteTickets([backend, frontend]);

    assert.deepEqual(
      listed.map((entry) => entry.ticket.key),
      ["ABC-1", "DEF-1", "ABC-2"],
      "the site's native Rank order crosses selections and pages, never the declaration order",
    );
    const searches = sim.requests.filter((request) => request.path === "/rest/api/3/search/jql");
    assert.equal(searches.length, 2, "two pages of the one site read");
    assert.deepEqual(
      searches.map((request) => request.nextPageToken),
      [null, "2"],
      "the site's own page token chain is followed, not a page per selection",
    );
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

  test("a page that does not state its own end is a read failure, never a short selection", async () => {
    const sim = new JiraSim();
    sim.addIssue({ id: "10001", key: "ABC-1", summary: "One" });
    // A proxy stripped `isLast` and the token: the page is half an answer.
    const transport: JiraTransport = async (url, init) => {
      const response = await sim.transport(url, init);
      if (!url.endsWith("/rest/api/3/search/jql")) return response;
      return { status: 200, text: JSON.stringify({ issues: JSON.parse(response.text).issues }) };
    };
    const adapter = adapterFor(sim, { transport });

    await assert.rejects(adapter.listOpenTickets(selectionFor(sim, "project = ABC")), (error: Error) => {
      assert.match(error.message, /neither ends the result nor carries a page token/);
      return true;
    });
  });

  test("a page that says it is not the last and carries no token is a read failure too", async () => {
    const sim = new JiraSim();
    sim.addIssue({ id: "10001", key: "ABC-1", summary: "One" });
    const transport: JiraTransport = async (url, init) => {
      const response = await sim.transport(url, init);
      if (!url.endsWith("/rest/api/3/search/jql")) return response;
      return { status: 200, text: JSON.stringify({ issues: JSON.parse(response.text).issues, isLast: false }) };
    };
    const adapter = adapterFor(sim, { transport });

    await assert.rejects(
      adapter.listOpenTickets(selectionFor(sim, "project = ABC")),
      /neither ends the result nor carries a page token/,
    );
  });

  test("a page that ends and also carries a page token is a read failure, never a silent stop", async () => {
    const sim = new JiraSim();
    sim.addIssue({ id: "10001", key: "ABC-1", summary: "One" });
    const transport: JiraTransport = async (url, init) => {
      const response = await sim.transport(url, init);
      if (!url.endsWith("/rest/api/3/search/jql")) return response;
      return {
        status: 200,
        text: JSON.stringify({ issues: JSON.parse(response.text).issues, isLast: true, nextPageToken: "more" }),
      };
    };
    const adapter = adapterFor(sim, { transport });

    await assert.rejects(
      adapter.listOpenTickets(selectionFor(sim, "project = ABC")),
      /ends the result and also carries a page token/,
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
      ["native blocked_by read", () => adapter.readTicketBlockers(ticket)],
      ["claim", () => adapter.claimTicket(ticket, "bot@acme.example")],
      ["claim release", () => adapter.releaseTicketClaim(ticket, "bot@acme.example")],
      ["block", () => adapter.blockTicketClaim(ticket, { ready: "ready", claimed: "claimed", blocked: "blocked" })],
      ["resume", () => adapter.resumeTicketClaim(ticket, { ready: "ready", claimed: "claimed", blocked: "blocked" })],
      ["mark done", () => adapter.markTicketDone(ticket)],
      ["unmediated comment", () => adapter.commentOnTicket(ticket, "hello")],
      ["rank read", () => adapter.rankTicket(ticket)],
    ];
    for (const [operation, call] of refused) {
      await assert.rejects(call(), new RegExp(`Jira ${operation} is not implemented for`), operation);
    }
    assert.equal(sim.requests.length, 0, "nothing reaches the tracker, no write is attempted");
  });
});

// ---- configured prerequisite links and the Done status category ----

describe("Jira adapter: direct prerequisites come from the configured links and Jira's Done category", () => {
  const BLOCKS_INWARD: PrerequisiteLink[] = [{ type: "Blocks", direction: "inward" }];

  function dependent(sim: JiraSim, links: SimJiraLink[], id = "10001", key = "ABC-1"): SimJiraIssue {
    return sim.addIssue({ id, key, summary: "The dependent", assignee: null, links });
  }

  test("only the configured link type and side names a prerequisite", async () => {
    const sim = new JiraSim();
    dependent(sim, [
      { type: "Blocks", side: "inward", key: "ABC-5" },
      { type: "Blocks", side: "outward", key: "ABC-6" },
      { type: "Relates", side: "inward", key: "ABC-7" },
    ]);
    sim.addIssue({ id: "10005", key: "ABC-5", summary: "Waits for review", status: { name: "In Review", categoryKey: "indeterminate" } });
    sim.addIssue({ id: "10006", key: "ABC-6", summary: "Blocked by the dependent" });
    sim.addIssue({ id: "10007", key: "ABC-7", summary: "Merely related" });
    const adapter = adapterFor(sim);

    const read = await adapter.readTicketPrerequisites(ticketOf(sim, "10001"), BLOCKS_INWARD);

    if (!read.known) assert.fail("the link read succeeded");
    assert.deepEqual(
      read.value.map((entry) => [entry.ticket.key, entry.status, entry.completion]),
      [["ABC-5", "In Review", "not-done"]],
      "the outward side and the unconfigured type are no prerequisite, whatever their text",
    );
    assert.equal(
      sim.requests.at(-1)?.path,
      "/rest/api/3/issue/10001",
      "the immutable id reads the links; the key is presentation only",
    );

    const outward = await adapter.readTicketPrerequisites(ticketOf(sim, "10001"), [
      { type: "Blocks", direction: "outward" },
    ]);
    if (!outward.known) assert.fail("the link read succeeded");
    assert.deepEqual(
      outward.value.map((entry) => [entry.ticket.key, entry.status, entry.completion]),
      [["ABC-6", "To Do", "not-done"]],
      "the configured side decides: the outward link is the prerequisite, and the inward one is not",
    );
  });

  test("the Done status CATEGORY decides — a status name or a resolution never does", async () => {
    const sim = new JiraSim();
    dependent(sim, [
      { type: "Blocks", side: "inward", key: "ABC-5" },
      { type: "Blocks", side: "inward", key: "ABC-6" },
    ]);
    // Cancelled inside the Done category satisfies the prerequisite (ADR 0004).
    sim.addIssue({ id: "10005", key: "ABC-5", summary: "Withdrawn", status: { name: "Cancelled", categoryKey: "done" } });
    // A status literally called "Done", or a business resolution, outside the
    // category does not.
    sim.addIssue({
      id: "10006",
      key: "ABC-6",
      summary: "Claimed done",
      status: { name: "Done", categoryKey: "indeterminate" },
      resolution: "Done",
    });
    const adapter = adapterFor(sim);

    const read = await adapter.readTicketPrerequisites(ticketOf(sim, "10001"), BLOCKS_INWARD);

    if (!read.known) assert.fail("the link read succeeded");
    assert.deepEqual(
      read.value.map((entry) => [entry.ticket.key, entry.status, entry.completion]),
      [
        ["ABC-5", "Cancelled", "done"],
        ["ABC-6", "Done", "not-done"],
      ],
    );
  });

  test("a prerequisite whose state the site does not show is unknown, never satisfied", async () => {
    const sim = new JiraSim();
    dependent(sim, [{ type: "Blocks", side: "inward", key: "ABC-5" }]);
    sim.addIssue({ id: "10005", key: "ABC-5", summary: "Restricted", status: { name: "Done", categoryKey: "done" } });
    sim.hidden.add("ABC-5");
    const adapter = adapterFor(sim);

    const read = await adapter.readTicketPrerequisites(ticketOf(sim, "10001"), BLOCKS_INWARD);

    if (!read.known) assert.fail("the link itself was read");
    assert.deepEqual(
      read.value.map((entry) => [entry.ticket.key, entry.status, entry.completion]),
      [["ABC-5", null, null]],
      "the link is listed, its completion is unknown — not done, not absent",
    );
  });

  test("a status whose category Jira's completion model does not define is unknown, never satisfied", async () => {
    const sim = new JiraSim();
    dependent(sim, [{ type: "Blocks", side: "inward", key: "ABC-5" }]);
    sim.addIssue({ id: "10005", key: "ABC-5", summary: "Uncategorised" });
    // The site names the status but sends no category the adapter can read.
    const transport: JiraTransport = async (url, init) => {
      const response = await sim.transport(url, init);
      if (!url.includes("/rest/api/3/issue/10001")) return response;
      return {
        status: 200,
        text: JSON.stringify({
          id: "10001",
          key: "ABC-1",
          fields: {
            issuelinks: [
              { id: "1", type: { name: "Blocks" }, inwardIssue: { id: "10005", key: "ABC-5", fields: { status: { name: "Waiting" } } } },
            ],
          },
        }),
      };
    };
    const adapter = adapterFor(sim, { transport });

    const read = await adapter.readTicketPrerequisites(ticketOf(sim, "10001"), BLOCKS_INWARD);

    if (!read.known) assert.fail("the link read succeeded");
    assert.deepEqual(
      read.value.map((entry) => [entry.ticket.key, entry.status, entry.completion]),
      [["ABC-5", "Waiting", null]],
      "the status name was read, its category was not — an unread completion, never done",
    );
  });

  test("a link the site cannot identify is a read failure, never zero prerequisites", async () => {
    const sim = new JiraSim();
    dependent(sim, [{ type: "Blocks", side: "inward", key: "ABC-404" }]);
    const adapter = adapterFor(sim);

    await assert.rejects(
      adapter.readTicketPrerequisites(ticketOf(sim, "10001"), BLOCKS_INWARD),
      /names no identifiable issue/,
    );
  });

  test("an issue without the requested links field is a read failure too", async () => {
    const sim = new JiraSim();
    dependent(sim, [{ type: "Blocks", side: "inward", key: "ABC-5" }]);
    sim.addIssue({ id: "10005", key: "ABC-5", summary: "Blocker" });
    const transport: JiraTransport = async (url, init) => {
      const response = await sim.transport(url, init);
      if (!url.includes("/rest/api/3/issue/10001")) return response;
      return { status: 200, text: JSON.stringify({ id: "10001", key: "ABC-1", fields: {} }) };
    };
    const adapter = adapterFor(sim, { transport });

    await assert.rejects(
      adapter.readTicketPrerequisites(ticketOf(sim, "10001"), BLOCKS_INWARD),
      /carries no issuelinks array/,
    );
  });

  test("a configured link type the site does not have holds the candidate instead of reading zero prerequisites", async () => {
    const sim = new JiraSim();
    dependent(sim, []);
    const adapter = adapterFor(sim);

    await assert.rejects(
      adapter.readTicketPrerequisites(ticketOf(sim, "10001"), [{ type: "Blokcs", direction: "inward" }]),
      (error: Error) => {
        assert.match(error.message, /does not have/);
        assert.match(error.message, /"Blokcs"/, "the mistyped rule is named");
        assert.match(error.message, /Blocks/, "the site's own vocabulary is offered");
        return true;
      },
    );
    assert.deepEqual(
      sim.requests.map((request) => `${request.method} ${request.path}`),
      ["GET /rest/api/3/myself", "GET /rest/api/3/issueLinkType"],
      "the ticket's links are not read for a rule the site cannot evaluate",
    );
  });

  test("the site's link types are read once per adapter, and a failed read is a read failure", async () => {
    const sim = new JiraSim();
    dependent(sim, [{ type: "Blocks", side: "inward", key: "ABC-5" }]);
    sim.addIssue({ id: "10005", key: "ABC-5", summary: "Blocker" });
    const adapter = adapterFor(sim);

    await adapter.readTicketPrerequisites(ticketOf(sim, "10001"), BLOCKS_INWARD);
    await adapter.readTicketPrerequisites(ticketOf(sim, "10001"), BLOCKS_INWARD);
    assert.equal(
      sim.requests.filter((request) => request.path === "/rest/api/3/issueLinkType").length,
      1,
      "the site's vocabulary is one fact per adapter",
    );

    const failing = new JiraSim();
    failing.addIssue({ id: "10001", key: "ABC-1", summary: "The dependent", links: [] });
    failing.faults.linkTypes = { status: 503, messages: ["The service is unavailable"] };
    const recovering = adapterFor(failing);
    await assert.rejects(
      recovering.readTicketPrerequisites(ticketOf(failing, "10001"), BLOCKS_INWARD),
      /could not read Jira site/,
    );

    // The site comes back: the failed vocabulary is not remembered, so the next
    // read asks again instead of holding the candidate on a stale failure.
    delete failing.faults.linkTypes;
    const read = await recovering.readTicketPrerequisites(ticketOf(failing, "10001"), BLOCKS_INWARD);
    if (!read.known) assert.fail("the retried read succeeded");
    assert.deepEqual(read.value, [], "the recovered read answers for the ticket's own links");
  });

  test("a failed link read propagates; a missing ticket is unknown", async () => {
    const sim = new JiraSim();
    dependent(sim, []);
    sim.faults.issue = { status: 503, messages: ["The service is unavailable"] };
    const adapter = adapterFor(sim);

    await assert.rejects(
      adapter.readTicketPrerequisites(ticketOf(sim, "10001"), BLOCKS_INWARD),
      /could not read Jira site/,
    );
    delete sim.faults.issue;
    assert.equal(
      (await adapter.readTicketPrerequisites(jiraTicket({ site: sim.site, stableId: "99999", key: "ABC-99" }), BLOCKS_INWARD))
        .known,
      false,
      "a ticket the site does not expose is unknown, never without prerequisites",
    );
  });
});

/**
 * The conversation and the factory's own publication, over the same simulated
 * REST: the ADF meaning of every comment is rendered, and factory speech is
 * recognised by Jira's structured evidence alone — a human and the factory can
 * share the acting account.
 */
describe("Jira adapter: the conversation and the mediated factory comment", () => {
  const TICKET_ADF = {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "keep the retry bounded", marks: [{ type: "strong" }] },
          { type: "text", text: " — see " },
          { type: "text", text: "the runbook", marks: [{ type: "link", attrs: { href: "https://example.test/rb" } }] },
        ],
      },
    ],
  };

  function workOf(sim: JiraSim) {
    return workIdentity(ticketOf(sim, "10001"), githubRepository(REPO));
  }

  test("comments are read page by page, rendered from ADF, and only the property makes a comment factory speech", async () => {
    const sim = new JiraSim();
    sim.addIssue({ id: "10001", key: "ABC-1", summary: "One" });
    sim.pageSize = 1;
    sim.addComment("ABC-1", { id: "c1", body: TICKET_ADF });
    sim.addComment("ABC-1", {
      id: "c2",
      body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "factory" }] }] },
      properties: [{ key: FACTORY_COMMENT_PROPERTY, value: { version: FACTORY_EVIDENCE_VERSION, correlationId: "req-1" } }],
    });

    const comments = await adapterFor(sim).readTicketComments(ticketOf(sim, "10001"));

    if (!comments.known) assert.fail("the conversation is readable");
    assert.deepEqual(
      comments.value.map((comment) => [comment.id, comment.agentSpeech, comment.agentCorrelation ?? null]),
      [
        ["c1", false, null],
        ["c2", true, "req-1"],
      ],
      "the author is the shared acting account for both; only the property speaks",
    );
    assert.match(comments.value[0]!.body, /keep the retry bounded — see the runbook \(https:\/\/example\.test\/rb\)/);
    assert.equal(comments.value[0]!.author, sim.account.displayName);
    assert.ok(
      sim.requests.filter((request) => request.path === "/rest/api/3/issue/10001/comment").length >= 2,
      "the conversation really came from Jira, one page at a time",
    );
  });

  test("the factory comment is published as ADF carrying the correlation as a Jira comment property", async () => {
    const sim = new JiraSim();
    sim.addIssue({ id: "10001", key: "ABC-1", summary: "One" });
    const adapter = adapterFor(sim);

    const published = await adapter.publishFactoryComment(ticketOf(sim, "10001"), {
      kind: "help",
      text: "Which staging URL?",
      correlationId: "req-2",
      work: workOf(sim),
      sessionId: "session-1",
      attempt: 1,
    });

    const comment = sim.issues[0]?.comments?.at(-1);
    assert.equal(published.commentId, comment?.id);
    assert.match(published.url, /focusedCommentId=/);
    assert.equal(comment?.author?.emailAddress, sim.account.emailAddress);
    const property = comment?.properties?.[0];
    assert.equal(property?.key, FACTORY_COMMENT_PROPERTY);
    assert.equal((property?.value as Record<string, unknown>)["correlationId"], "req-2");
    assert.deepEqual((comment?.body as { type: string }).type, "doc");
  });

  test("a factory property this version cannot read stays factory speech with an unknown correlation — never a human answer", async () => {
    const sim = new JiraSim();
    sim.addIssue({ id: "10001", key: "ABC-1", summary: "One" });
    sim.addComment("ABC-1", { id: "c-human", body: TICKET_ADF });
    sim.addComment("ABC-1", {
      id: "c-damaged",
      body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "factory" }] }] },
      properties: [{ key: FACTORY_COMMENT_PROPERTY, value: { version: FACTORY_EVIDENCE_VERSION + 1, correlationId: "req-9" } }],
    });
    sim.addComment("ABC-1", {
      id: "c-no-id",
      body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "factory" }] }] },
      properties: [{ key: FACTORY_COMMENT_PROPERTY, value: { version: FACTORY_EVIDENCE_VERSION } }],
    });

    const comments = await adapterFor(sim).readTicketComments(ticketOf(sim, "10001"));

    if (!comments.known) assert.fail("the conversation is readable");
    assert.deepEqual(
      comments.value.map((comment) => [comment.id, comment.agentSpeech, comment.agentCorrelation ?? null]),
      [
        ["c-human", false, null],
        ["c-damaged", true, null],
        ["c-no-id", true, null],
      ],
      "only the absence of the property makes a comment human speech",
    );
    assert.deepEqual(
      humanCommentsAfterLastFactorySpeech(comments.value).map((comment) => comment.id),
      [],
      "a human answer cannot be read into a comment the factory owns",
    );
  });

  test("a write failure is either a definite refusal or an ambiguity, never a silent retry", async () => {
    const sim = new JiraSim();
    sim.addIssue({ id: "10001", key: "ABC-1", summary: "One" });
    const adapter = adapterFor(sim);
    const publication = {
      kind: "update" as const,
      text: "ready",
      correlationId: "req-3",
      work: workOf(sim),
      sessionId: "session-1",
      attempt: 1,
    };

    sim.faults.commentCreate = { status: 400, messages: ["the body is not a valid document"] };
    await assert.rejects(adapter.publishFactoryComment(ticketOf(sim, "10001"), publication), /refused the comment/);

    sim.faults.commentCreate = { status: 403, messages: ["no permission"] };
    await assert.rejects(
      adapter.publishFactoryComment(ticketOf(sim, "10001"), publication),
      /insufficient Jira permissions/,
      "a permission failure is a definite refusal: nothing was published",
    );

    sim.faults.commentCreate = { status: 503, messages: ["unavailable"] };
    await assert.rejects(
      adapter.publishFactoryComment(ticketOf(sim, "10001"), publication),
      /may or may not have landed/,
    );

    delete sim.faults.commentCreate;
    // The site is reachable, but the answer to the write never arrives: the
    // adapter must call that unknown, not failure and not success.
    const unreachable = new JiraTicketAdapter({
      site: sim.site,
      account: sim.account.emailAddress,
      tokenEnv: TOKEN_ENV,
      env: { [TOKEN_ENV]: sim.token },
      transport: (url, init) =>
        init.method === "POST" ? Promise.reject(new Error("socket hang up")) : sim.transport(url, init),
    });
    await assert.rejects(
      unreachable.publishFactoryComment(ticketOf(sim, "10001"), publication),
      /may or may not have landed/,
    );
  });
});
