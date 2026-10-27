import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_LINK_TYPES } from "../tracker/jira-sim.js";
import {
  installGhShim,
  installJiraFetchShim,
  installUnreachableDocker,
  runCli,
  type GhShim,
  type JiraFetchShim,
  type JiraRestAnswer,
} from "./cli-harness.js";

/**
 * `msf status` and `msf run` at the hermetic CLI seam over the REAL Jira
 * adapter: the spawned binary reads the configured selections
 * through a canned Jira REST channel (fetch preload), with an isolated HOME and
 * no ambient credential. Status presents ONE site's candidates in native Rank
 * order across destinations and pages, without claiming anything; a selection
 * without its local credential is unreadable while other sites still list; `run`
 * refuses a Jira configuration before any claim, launch or workspace write.
 */

const ALPHA = "acme.atlassian.net";
const BETA = "beta.atlassian.net";
const REPO = "Sanmoo/my-tasks";

describe("e2e: Jira Cloud selections at the CLI seam (read-only)", () => {
  let dir: string;
  let gh: GhShim;
  let jira: JiraFetchShim;
  let workspace: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-jira-"));
    workspace = join(dir, "ws");
    gh = installGhShim(dir);
    installUnreachableDocker(gh.binDir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Two sites, one healthy and one whose local credential is missing: the
   *  independent selection must not be treated as absent. */
  function writeConfig(overrides: { alphaJql?: string; alphaCredentialLine?: string } = {}): void {
    const alphaCredentialLine =
      overrides.alphaCredentialLine === undefined
        ? "    token-env: MSF_JIRA_ALPHA_TOKEN"
        : overrides.alphaCredentialLine;
    writeFileSync(
      join(dir, "msf.yaml"),
      [
        "worker-gh-account: bot-do-samuca",
        "worker-model: opencode-go/glm-5.3-flash",
        "repos: []",
        `workspace: ${workspace}`,
        "jira:",
        `  - site: ${ALPHA}`,
        "    account: bot@acme.example",
        alphaCredentialLine,
        `    jql: ${overrides.alphaJql ?? "project = ABC AND assignee = currentUser()"}`,
        `    destination: ${REPO}`,
        `  - site: ${BETA}`,
        "    account: bot@beta.example",
        "    token-env: MSF_JIRA_BETA_TOKEN",
        "    jql: project = BETA",
        `    destination: ${REPO}`,
      ].join("\n"),
      "utf8",
    );
  }

  function installJiraAnswers(): void {
    jira = installJiraFetchShim(dir, {
      [`GET /rest/api/3/myself`]: {
        body: {
          accountId: "acct-1",
          emailAddress: "bot@acme.example",
          displayName: "Factory Bot",
          active: true,
        },
      },
      // Two native pages, exactly as Jira returns them: the adapter follows the
      // opaque nextPageToken and keeps Rank order across the boundary.
      [`POST /rest/api/3/search/jql`]: [
        {
          body: {
            isLast: false,
            nextPageToken: "page-2",
            issues: [
              {
                id: "10001",
                key: "ABC-1",
                fields: {
                  summary: "Fix login",
                  labels: ["ready"],
                  // Created LATER than ABC-2: the display order is Rank's, not age.
                  created: "2026-02-01T00:00:00.000+0000",
                  assignee: { accountId: "human-1", displayName: "Ana Silva" },
                },
              },
            ],
          },
        },
        {
          body: {
            isLast: true,
            issues: [
              {
                id: "10002",
                key: "ABC-2",
                fields: {
                  summary: "Fix logout (subtask)",
                  labels: [],
                  created: "2026-01-01T00:00:00.000+0000",
                  assignee: null,
                  issuetype: { name: "Sub-task", subtask: true },
                  parent: { key: "ABC-1" },
                },
              },
            ],
          },
        },
      ],
    });
  }

  function cliEnv(markers: { ready?: string } = {}): NodeJS.ProcessEnv {
    return {
      ...gh.env(markers),
      ...jira.env,
      MSF_JIRA_ALPHA_TOKEN: "alpha-local-token",
      // The beta site's credential is DELIBERATELY absent (empty = not set).
      MSF_JIRA_BETA_TOKEN: "",
    };
  }

  /** Only the identity read and searches left the CLI; no claim, comment,
   *  transition or other tracker write. The number of searches is the site
   *  read's own business (one per selection plus the site's ordered read), so
   *  it is not pinned here; the identity read IS one per site, and that is. */
  function assertReadOnlyJira(): void {
    const calls = jira.calls();
    assert.ok(calls.length > 0, "the status read reached the tracker");
    for (const call of calls) {
      assert.match(call, /^(GET \/rest\/api\/3\/myself|POST \/rest\/api\/3\/search\/jql)$/);
    }
    // A site authenticates once, whatever it reads; here only ALPHA can, so the
    // whole report makes one identity read.
    assert.equal(
      calls.filter((call) => call.startsWith("GET /rest/api/3/myself")).length,
      1,
      "one identity read for the site that authenticated",
    );
  }

  test("status presents the Jira candidates in native Rank order and never claims or launches", () => {
    writeConfig();
    installJiraAnswers();
    const ready = join(dir, "status-boot-check-ran");

    const result = runCli(dir, ["status"], cliEnv({ ready }));

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /jira candidates \(read-only[^)]*one native Rank order[^)]*nothing is claimed, commented or launched\): 2 sites$/m,
      "the header counts sites: candidates of different sites are never one comparable order",
    );
    assert.match(result.stdout, new RegExp(`${ALPHA} \\(1 selection\\) → ${REPO}: 2 candidates`));
    assert.match(
      result.stdout,
      new RegExp(`1\\. ABC-1 \\(jira:${ALPHA.replace(/\./g, "\\.")}\\) → ${REPO} — Fix login \\[assignee: Ana Silva\\]`),
    );
    assert.match(
      result.stdout,
      /2\. ABC-2 \(jira:acme\.atlassian\.net\) → Sanmoo\/my-tasks — Fix logout \(subtask\) — prerequisites: none configured for this selection$/m,
    );
    assert.ok(
      result.stdout.indexOf("1. ABC-1") < result.stdout.indexOf("2. ABC-2"),
      "the returned Rank order is presented as-is, never re-sorted by creation age",
    );
    assert.match(result.stdout, new RegExp(`${BETA} \\(1 selection\\) → ${REPO}: unreadable`));
    assert.match(result.stdout, /MSF_JIRA_BETA_TOKEN/, "the missing credential is diagnosed by its variable name");
    assert.match(result.stdout, /pool \(eligible\): none/, "a Jira candidate is never offered as an eligible Work");

    assertReadOnlyJira();
    assert.deepEqual(gh.restCalls(), [], "repos: [] means no GitHub Issues REST call");
    assert.equal(existsSync(ready), true, "the GitHub identity boot check still runs: a Jira-only factory verifies it too");
    assert.equal(existsSync(workspace), false, "status created no execution workspace");
  });

  test("the API token is refused as a YAML value before any read, and never echoed", () => {
    const secret = "ATATT3xFfGF0cli-secret";
    writeConfig({ alphaCredentialLine: `    token: ${secret}` });
    installJiraAnswers();

    const result = runCli(dir, ["status"], cliEnv());

    assert.equal(result.status, 1);
    assert.match(result.stderr, /token-env/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(secret), "the token value never reaches a message");
    assert.deepEqual(jira.calls(), [], "the invalid config is refused before the network");
  });

  test("a conflicting ordering is refused at config time with the JQL field named", () => {
    writeConfig({ alphaJql: "project = ABC ORDER BY created ASC" });
    installJiraAnswers();

    const result = runCli(dir, ["status"], cliEnv());

    assert.equal(result.status, 1);
    assert.match(result.stderr, /jira\[0\]\.jql/);
    assert.match(result.stderr, /conflicting ordering/);
    assert.deepEqual(jira.calls(), [], "no query is sent with an ordering the factory would override");
  });

  test("run refuses a Jira configuration before the keyring read, any claim or a launch", () => {
    writeConfig();
    installJiraAnswers();
    const ready = join(dir, "boot-check-ran");

    const result = runCli(dir, ["run", "--once"], cliEnv({ ready }));

    assert.equal(result.status, 1);
    assert.match(result.stderr, /a sweep does not bring Jira work in yet/);
    assert.match(result.stderr, new RegExp(`${ALPHA} → ${REPO}`));
    assert.match(result.stderr, /refusing before any claim, comment or launch/);
    assert.equal(existsSync(ready), false, "the refusal happens before the GitHub keyring boot check");
    assert.deepEqual(jira.calls(), [], "no Jira read, write or launch is attempted");
    assert.equal(existsSync(workspace), false, "no execution workspace is created");
  });

  test("two selections on one site produce one native Rank order across destinations and pages", () => {
    // The backend selection is declared FIRST; the site's Rank puts frontend
    // first. The report must follow Jira, never the declaration order.
    writeFileSync(
      join(dir, "msf.yaml"),
      [
        "worker-gh-account: bot-do-samuca",
        "worker-model: opencode-go/glm-5.3-flash",
        "repos: []",
        `workspace: ${workspace}`,
        "jira:",
        `  - site: ${ALPHA}`,
        "    account: bot@acme.example",
        "    token-env: MSF_JIRA_ALPHA_TOKEN",
        "    jql: project = ABC AND labels = backend",
        "    destination: Sanmoo/backend",
        `  - site: ${ALPHA}`,
        "    account: bot@acme.example",
        "    token-env: MSF_JIRA_ALPHA_TOKEN",
        "    jql: project = ABC AND labels = frontend",
        "    destination: Sanmoo/frontend",
      ].join("\n"),
      "utf8",
    );
    const frontend = {
      id: "10010",
      key: "ABC-10",
      fields: { summary: "Frontend fix", labels: ["frontend"], created: "2026-02-01T00:00:00.000+0000", assignee: null },
    };
    const backend = {
      id: "10020",
      key: "ABC-20",
      fields: { summary: "Backend fix", labels: ["backend"], created: "2026-01-01T00:00:00.000+0000", assignee: null },
    };
    jira = installJiraFetchShim(dir, {
      [`GET /rest/api/3/myself`]: {
        body: { accountId: "acct-1", emailAddress: "bot@acme.example", displayName: "Factory Bot", active: true },
      },
      [`POST /rest/api/3/search/jql :: project = ABC AND labels = backend ORDER BY Rank ASC`]: {
        body: { isLast: true, issues: [backend] },
      },
      [`POST /rest/api/3/search/jql :: project = ABC AND labels = frontend ORDER BY Rank ASC`]: {
        body: { isLast: true, issues: [frontend] },
      },
      // The site-wide union is the only source of the order: two native pages.
      [`POST /rest/api/3/search/jql`]: [
        { body: { isLast: false, nextPageToken: "page-2", issues: [frontend] } },
        { body: { isLast: true, issues: [backend] } },
      ],
    });

    const result = runCli(dir, ["status"], cliEnv());

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /jira candidates \(read-only[^)]*one native Rank order[^)]*\): 1 site$/m);
    assert.match(
      result.stdout,
      /acme\.atlassian\.net \(2 selections\) → Sanmoo\/backend, Sanmoo\/frontend: 2 candidates$/m,
      "one site, two explicit destinations: one ordered set",
    );
    const first = result.stdout.indexOf("1. ABC-10");
    const second = result.stdout.indexOf("2. ABC-20");
    assert.ok(first >= 0 && first < second, "the site's Rank wins over the order the destinations were declared in");
    assert.match(result.stdout, /1\. ABC-10 \(jira:acme\.atlassian\.net\) → Sanmoo\/frontend — Frontend fix/);
    assert.match(result.stdout, /2\. ABC-20 \(jira:acme\.atlassian\.net\) → Sanmoo\/backend — Backend fix/);
    assert.match(result.stdout, /pool \(eligible\): none/, "still read-only: no candidate is executable work");
    assertReadOnlyJira();
    assert.deepEqual(gh.restCalls(), [], "no GitHub Issues read");
    assert.equal(existsSync(workspace), false, "no execution workspace");
  });

  test("a conflicting ticket is held alone while its sibling candidate remains usable", () => {
    writeFileSync(
      join(dir, "msf.yaml"),
      [
        "worker-gh-account: bot-do-samuca",
        "worker-model: opencode-go/glm-5.3-flash",
        "repos: []",
        `workspace: ${workspace}`,
        "jira:",
        `  - site: ${ALPHA}`,
        "    account: bot@acme.example",
        "    token-env: MSF_JIRA_ALPHA_TOKEN",
        "    jql: project = ABC AND labels = frontend",
        "    destination: Sanmoo/frontend",
        `  - site: ${ALPHA}`,
        "    account: bot@acme.example",
        "    token-env: MSF_JIRA_ALPHA_TOKEN",
        "    jql: project = ABC AND labels = shared",
        "    destination: Sanmoo/backend",
      ].join("\n"),
      "utf8",
    );
    const shared = {
      id: "10030",
      key: "ABC-30",
      fields: {
        summary: "Shared across layers",
        labels: ["frontend", "shared"],
        created: "2026-01-01T00:00:00.000+0000",
        assignee: null,
      },
    };
    const frontendOnly = {
      id: "10031",
      key: "ABC-31",
      fields: { summary: "Frontend only", labels: ["frontend"], created: "2026-02-01T00:00:00.000+0000", assignee: null },
    };
    jira = installJiraFetchShim(dir, {
      [`GET /rest/api/3/myself`]: {
        body: { accountId: "acct-1", emailAddress: "bot@acme.example", displayName: "Factory Bot", active: true },
      },
      [`POST /rest/api/3/search/jql :: project = ABC AND labels = frontend ORDER BY Rank ASC`]: {
        body: { isLast: true, issues: [frontendOnly, shared] },
      },
      [`POST /rest/api/3/search/jql :: project = ABC AND labels = shared ORDER BY Rank ASC`]: {
        body: { isLast: true, issues: [shared] },
      },
      [`POST /rest/api/3/search/jql`]: {
        body: { isLast: true, issues: [frontendOnly, shared] },
      },
    });

    const result = runCli(dir, ["status"], cliEnv());

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /acme\.atlassian\.net \(2 selections\) → Sanmoo\/backend, Sanmoo\/frontend: 1 candidate, 1 held as ambiguous/,
    );
    assert.match(result.stdout, /1\. ABC-31 \(jira:acme\.atlassian\.net\) → Sanmoo\/frontend — Frontend only/);
    assert.match(result.stdout, /ambiguous \(more than one destination — held, no destination chosen\): 1/);
    assert.match(
      result.stdout,
      /1\. ABC-30 \(jira:acme\.atlassian\.net\) — Shared across layers → Sanmoo\/backend, Sanmoo\/frontend/,
    );
    assert.doesNotMatch(result.stdout, /→ Sanmoo\/(frontend|backend) — Shared across layers/, "the conflict is never a candidate");
    assert.match(result.stdout, /pool \(eligible\): none/);
    assertReadOnlyJira();
    assert.equal(existsSync(workspace), false, "no execution workspace");
  });

  test("a ticket two selections share for one destination is deduplicated", () => {
    writeFileSync(
      join(dir, "msf.yaml"),
      [
        "worker-gh-account: bot-do-samuca",
        "worker-model: opencode-go/glm-5.3-flash",
        "repos: []",
        `workspace: ${workspace}`,
        "jira:",
        `  - site: ${ALPHA}`,
        "    account: bot@acme.example",
        "    token-env: MSF_JIRA_ALPHA_TOKEN",
        "    jql: project = ABC",
        "    destination: Sanmoo/frontend",
        `  - site: ${ALPHA}`,
        "    account: bot@acme.example",
        "    token-env: MSF_JIRA_ALPHA_TOKEN",
        "    jql: project = ABC AND labels = ready",
        "    destination: Sanmoo/frontend",
      ].join("\n"),
      "utf8",
    );
    const ticket = {
      id: "10040",
      key: "ABC-40",
      fields: { summary: "One Work, two selections", labels: ["ready"], created: "2026-01-01T00:00:00.000+0000", assignee: null },
    };
    jira = installJiraFetchShim(dir, {
      [`GET /rest/api/3/myself`]: {
        body: { accountId: "acct-1", emailAddress: "bot@acme.example", displayName: "Factory Bot", active: true },
      },
      [`POST /rest/api/3/search/jql :: project = ABC ORDER BY Rank ASC`]: { body: { isLast: true, issues: [ticket] } },
      [`POST /rest/api/3/search/jql :: project = ABC AND labels = ready ORDER BY Rank ASC`]: {
        body: { isLast: true, issues: [ticket] },
      },
      [`POST /rest/api/3/search/jql`]: {
        body: { isLast: true, issues: [ticket] },
      },
    });

    const result = runCli(dir, ["status"], cliEnv());

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /acme\.atlassian\.net \(2 selections\) → Sanmoo\/frontend: 1 candidate$/m);
    assert.equal((result.stdout.match(/ABC-40/g) ?? []).length, 1, "the same Work is listed once");
    assert.doesNotMatch(result.stdout, /held as ambiguous/, "one destination is not a conflict");
    assertReadOnlyJira();
    assert.equal(existsSync(workspace), false, "no execution workspace");
  });

});

// ---- configured prerequisites and Jira's Done status category ----

describe("e2e: Jira candidates wait for their configured prerequisites", () => {
  let dir: string;
  let gh: GhShim;
  let workspace: string;

  const SITE = "acme.atlassian.net";
  const REPO = "Sanmoo/my-tasks";
  const TOKEN_ENV = "MSF_JIRA_ALPHA_TOKEN";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-jira-deps-"));
    workspace = join(dir, "ws");
    gh = installGhShim(dir);
    installUnreachableDocker(gh.binDir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** One selection on one site; `prerequisites` is the block under test. */
  function writeConfig(prerequisites: string[] = ["    prerequisites:", "      - type: Blocks", "        direction: inward"]): void {
    writeFileSync(
      join(dir, "msf.yaml"),
      [
        "worker-gh-account: bot-do-samuca",
        "worker-model: opencode-go/glm-5.3-flash",
        "repos: []",
        `workspace: ${workspace}`,
        "jira:",
        `  - site: ${SITE}`,
        "    account: bot@acme.example",
        `    token-env: ${TOKEN_ENV}`,
        "    jql: project = ABC",
        `    destination: ${REPO}`,
        ...prerequisites,
      ].join("\n"),
      "utf8",
    );
  }

  /** One ticket of the JQL result. */
  function ticket(id: string, key: string, summary: string): unknown {
    return { id, key, fields: { summary, labels: [], created: "2026-01-01T00:00:00.000+0000", assignee: null } };
  }

  /** One link as Jira lists it on the ticket: the type, the side and the state. */
  function link(
    type: string,
    side: "inward" | "outward",
    other: {
      id: string;
      key: string;
      status?: string;
      category?: "new" | "indeterminate" | "done";
      resolution?: string;
      shown?: boolean;
    },
  ): unknown {
    const identity = { id: other.id, key: other.key, self: `https://${SITE}/rest/api/3/issue/${other.id}` };
    const linked =
      other.shown === false
        ? identity
        : {
            ...identity,
            fields: {
              summary: `prerequisite ${other.key}`,
              status: { name: other.status, statusCategory: { key: other.category } },
              ...(other.resolution === undefined ? {} : { resolution: { name: other.resolution } }),
            },
          };
    return {
      id: `link-${other.id}`,
      type: { name: type },
      [side === "inward" ? "inwardIssue" : "outwardIssue"]: linked,
    };
  }

  /** The `issuelinks` read of one ticket. */
  function links(id: string, key: string, entries: unknown[]): JiraRestAnswer {
    return { body: { id, key, fields: { issuelinks: entries } } };
  }

  /** The whole site answer: identity, its link types, the selection's page and
   *  the link reads. */
  function site(
    issues: unknown[],
    reads: Record<string, JiraRestAnswer>,
    linkTypes: readonly string[] = DEFAULT_LINK_TYPES,
  ): Record<string, JiraRestAnswer> {
    return {
      "GET /rest/api/3/myself": {
        body: { accountId: "acct-1", emailAddress: "bot@acme.example", displayName: "Factory Bot", active: true },
      },
      "GET /rest/api/3/issueLinkType": {
        body: { issueLinkTypes: linkTypes.map((name, index) => ({ id: String(index + 1), name })) },
      },
      "POST /rest/api/3/search/jql :: project = ABC ORDER BY Rank ASC": { body: { isLast: true, issues } },
      ...reads,
    };
  }

  function cliEnv(jira: JiraFetchShim): NodeJS.ProcessEnv {
    return { ...gh.env(), ...jira.env, [TOKEN_ENV]: "alpha-local-token" };
  }

  test("a candidate waits for every configured prerequisite in Done, and advances once they land", () => {
    writeConfig();
    const issues = [ticket("10001", "ABC-1", "Ship the API"), ticket("10002", "ABC-2", "Independent fix")];
    const first = site(issues, {
      "GET /rest/api/3/issue/10001": links("10001", "ABC-1", [
        link("Blocks", "inward", { id: "10005", key: "ABC-5", status: "In Review", category: "indeterminate" }),
        link("Blocks", "inward", { id: "10006", key: "ABC-6", status: "Cancelled", category: "done" }),
      ]),
      "GET /rest/api/3/issue/10002": links("10002", "ABC-2", []),
    });
    let jira = installJiraFetchShim(dir, first);

    const blocked = runCli(dir, ["status"], cliEnv(jira));

    assert.equal(blocked.status, 0, blocked.stderr);
    assert.match(blocked.stdout, /acme\.atlassian\.net \(1 selection\) → Sanmoo\/my-tasks: 2 candidates, 1 held by prerequisites/);
    assert.match(
      blocked.stdout,
      /1\. ABC-1 \(jira:acme\.atlassian\.net\) → Sanmoo\/my-tasks — Ship the API — held by prerequisites: prerequisite ABC-5 \("In Review", outside the Done status category\)/,
      "one unfinished prerequisite holds the candidate, even though ABC-6 is already in Done",
    );
    assert.match(
      blocked.stdout,
      /2\. ABC-2 \(jira:acme\.atlassian\.net\) → Sanmoo\/my-tasks — Independent fix — prerequisites: none on the ticket/,
      "a candidate with nothing to wait for keeps its place in Rank order",
    );
    assert.match(blocked.stdout, /pool \(eligible\): none/, "a Jira candidate is still never executable work");
    assert.deepEqual(
      jira.calls(),
      [
        "GET /rest/api/3/myself",
        "POST /rest/api/3/search/jql",
        "GET /rest/api/3/issueLinkType",
        "GET /rest/api/3/issue/10001",
        "GET /rest/api/3/issue/10002",
      ],
      "the site's link types once, then one link read per candidate — no claim, no comment, no transition",
    );
    assert.equal(existsSync(workspace), false, "status stays read-only");

    // ABC-5 lands in Done — under the name the team uses; the dependent advances.
    jira = installJiraFetchShim(
      dir,
      site(issues, {
        "GET /rest/api/3/issue/10001": links("10001", "ABC-1", [
          link("Blocks", "inward", { id: "10005", key: "ABC-5", status: "Cancelled", category: "done" }),
          link("Blocks", "inward", { id: "10006", key: "ABC-6", status: "Cancelled", category: "done" }),
        ]),
        "GET /rest/api/3/issue/10002": links("10002", "ABC-2", []),
      }),
    );

    const advanced = runCli(dir, ["status"], cliEnv(jira));

    assert.equal(advanced.status, 0, advanced.stderr);
    assert.match(advanced.stdout, /2 candidates$/m, "nothing is held once every prerequisite is Done");
    assert.match(
      advanced.stdout,
      /1\. ABC-1 .* — prerequisites in the Done status category: ABC-5, ABC-6/,
      "Cancelled inside the Done category satisfies the prerequisite — the policy, not an error",
    );
    assert.equal(existsSync(workspace), false, "still read-only");
  });

  test("the factory's archived history and a business resolution do not satisfy a prerequisite still in QA", () => {
    writeConfig();
    // The prerequisite's ticket is in QA and even carries a business resolution;
    // the factory already delivered and archived a Work of this destination. A
    // resolution is the team's business fact, the archive is the factory's own
    // history: neither is the Jira ticket's Done status category (ADR 0004). The
    // merged-PR case has its own test in status.test.ts, where the GitHub tracker
    // can carry a real merge.
    mkdirSync(join(workspace, "arquivo", `${REPO}#42-2026-02-01`), { recursive: true });
    const jira = installJiraFetchShim(
      dir,
      site([ticket("10001", "ABC-1", "Ship the API")], {
        "GET /rest/api/3/issue/10001": links("10001", "ABC-1", [
          link("Blocks", "inward", {
            id: "10005",
            key: "ABC-5",
            status: "In Review",
            category: "indeterminate",
            resolution: "Done",
          }),
        ]),
      }),
    );

    const result = runCli(dir, ["status"], cliEnv(jira));

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /1\. ABC-1 .* — held by prerequisites: prerequisite ABC-5 \("In Review", outside the Done status category\)/,
      "a prerequisite in QA keeps its dependents waiting, whatever the factory delivered",
    );
    assert.match(result.stdout, /archived \(dones\): 1/, "the factory's own delivered history is right there");
    assert.match(result.stdout, /Sanmoo\/my-tasks#42-2026-02-01/);
    assert.deepEqual(
      gh.restCalls(),
      [],
      "no GitHub PR or merge fact is consulted: only the Jira status category decides",
    );
  });

  test("an unreadable link or prerequisite state holds only the affected candidate", () => {
    writeConfig();
    const jira = installJiraFetchShim(
      dir,
      site(
        [ticket("10001", "ABC-1", "Unreadable links"), ticket("10002", "ABC-2", "Unknown prerequisite"), ticket("10003", "ABC-3", "Free")],
        {
          "GET /rest/api/3/issue/10001": { status: 503, body: { errorMessages: ["The service is unavailable"] } },
          "GET /rest/api/3/issue/10002": links("10002", "ABC-2", [
            link("Blocks", "inward", { id: "10005", key: "ABC-5", shown: false }),
          ]),
          "GET /rest/api/3/issue/10003": links("10003", "ABC-3", []),
        },
      ),
    );

    const result = runCli(dir, ["status"], cliEnv(jira));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /acme\.atlassian\.net \(1 selection\) → Sanmoo\/my-tasks: 3 candidates, 2 held by prerequisites/);
    assert.match(
      result.stdout,
      /1\. ABC-1 .* — held by prerequisites: the prerequisite links could not be read \(could not read Jira site "acme\.atlassian\.net": HTTP 503: The service is unavailable\)/,
      "a failed link read is diagnosed on the candidate, never read as zero prerequisites",
    );
    assert.match(
      result.stdout,
      /2\. ABC-2 .* — held by prerequisites: prerequisite ABC-5 \(its status could not be read\)/,
      "a listed link whose issue state is hidden is unknown, never satisfied",
    );
    assert.match(result.stdout, /3\. ABC-3 .* — prerequisites: none on the ticket/, "the healthy candidate still advances");
  });

  test("the JQL still selects the types; a parent link and an unconfigured link are no prerequisite", () => {
    writeConfig();
    const subtask = {
      ...(ticket("10001", "ABC-1", "A subtask") as Record<string, unknown>),
      fields: {
        ...((ticket("10001", "ABC-1", "A subtask") as { fields: unknown }).fields as object),
        issuetype: { name: "Sub-task", subtask: true },
        parent: { key: "ABC-9" },
      },
    };
    const jira = installJiraFetchShim(
      dir,
      site([subtask], {
        "GET /rest/api/3/issue/10001": links("10001", "ABC-1", [
          // The epic/parent relation above is no prerequisite, and neither is a
          // link type or side the selection did not configure.
          link("Relates", "inward", { id: "10007", key: "ABC-7", status: "In Progress", category: "indeterminate" }),
          link("Blocks", "outward", { id: "10008", key: "ABC-8", status: "To Do", category: "new" }),
          link("Blocks", "inward", { id: "10005", key: "ABC-5", status: "Done", category: "done" }),
        ]),
      }),
    );

    const result = runCli(dir, ["status"], cliEnv(jira));

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /1\. ABC-1 \(jira:acme\.atlassian\.net\) → Sanmoo\/my-tasks — A subtask — prerequisites in the Done status category: ABC-5/,
      "only the configured direct link counts: not the parent, not the outward side, not another type",
    );
    assert.deepEqual(
      jira.calls(),
      [
        "GET /rest/api/3/myself",
        "POST /rest/api/3/search/jql",
        "GET /rest/api/3/issueLinkType",
        "GET /rest/api/3/issue/10001",
      ],
      "the subtask was selected by the JQL itself and no transitive prerequisite was read",
    );
  });

  test("a search page that does not state its end is unknown, never zero prerequisites", () => {
    writeConfig();
    const jira = installJiraFetchShim(dir, {
      "GET /rest/api/3/myself": {
        body: { accountId: "acct-1", emailAddress: "bot@acme.example", displayName: "Factory Bot", active: true },
      },
      // A half answer: neither the end of the result nor a token for the next page.
      "POST /rest/api/3/search/jql :: project = ABC ORDER BY Rank ASC": {
        body: { issues: [ticket("10001", "ABC-1", "Ship the API")] },
      },
    });

    const result = runCli(dir, ["status"], cliEnv(jira));

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /acme\.atlassian\.net \(1 selection\) → Sanmoo\/my-tasks: unreadable \(.*neither ends the result nor carries a page token.*\)/,
      "an incomplete listing says unknown instead of reporting a candidate list with no dependencies",
    );
    assert.doesNotMatch(result.stdout, /→ Sanmoo\/my-tasks: none/, "a truncated page is never an empty selection");
  });

  test("a configured link type the site does not have holds the candidate with the diagnosis", () => {
    writeConfig(["    prerequisites:", "      - type: Blokcs", "        direction: inward"]);
    const jira = installJiraFetchShim(
      dir,
      site([ticket("10001", "ABC-1", "Ship the API")], {
        "GET /rest/api/3/issue/10001": links("10001", "ABC-1", [
          link("Blocks", "inward", { id: "10005", key: "ABC-5", status: "Done", category: "done" }),
        ]),
      }),
    );

    const result = runCli(dir, ["status"], cliEnv(jira));

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /1\. ABC-1 .* — held by prerequisites: the prerequisite links could not be read \(the selection configures the link type "Blokcs", which Jira site "acme\.atlassian\.net" does not have/,
      "a rule the site cannot evaluate holds the candidate instead of reading zero prerequisites",
    );
    assert.match(result.stdout, /its link types: Blocks, Cloners, Duplicate, Relates/, "the diagnosis offers the site's vocabulary");
  });

  test("a site whose link types cannot be read holds every affected candidate with the diagnosis", () => {
    writeConfig();
    const jira = installJiraFetchShim(
      dir,
      site(
        [ticket("10001", "ABC-1", "Ship the API"), ticket("10002", "ABC-2", "Ship the UI")],
        {
          "GET /rest/api/3/issueLinkType": { status: 503, body: { errorMessages: ["The service is unavailable"] } },
        },
      ),
    );

    const result = runCli(dir, ["status"], cliEnv(jira));

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /acme\.atlassian\.net \(1 selection\) → Sanmoo\/my-tasks: 2 candidates, 2 held by prerequisites/);
    assert.match(
      result.stdout,
      /1\. ABC-1 .* — held by prerequisites: the prerequisite links could not be read \(could not read Jira site "acme\.atlassian\.net": HTTP 503/,
      "the rule's own vocabulary is unreadable, so the candidate is held instead of advancing",
    );
    assert.match(result.stdout, /2\. ABC-2 .* — held by prerequisites: the prerequisite links could not be read/);
    assert.equal(
      jira.calls().filter((call) => call.startsWith("GET /rest/api/3/issue/")).length,
      0,
      "no ticket link is read when the site cannot even name its link types",
    );
  });

  test("a malformed prerequisite rule fails before any Jira read", () => {
    writeConfig(["    prerequisites:", "      - type: Blocks", "        direction: sideways"]);
    const jira = installJiraFetchShim(dir, {});

    const result = runCli(dir, ["status"], cliEnv(jira));

    assert.equal(result.status, 1);
    assert.match(result.stderr, /jira\[0\]\.prerequisites\[0\]\.direction/);
    assert.match(result.stderr, /inward.*outward/);
    assert.deepEqual(jira.calls(), [], "the invalid config never reaches the tracker");
  });
});
