import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installGhShim,
  installJiraFetchShim,
  installUnreachableDocker,
  runCli,
  type GhShim,
  type JiraFetchShim,
} from "./cli-harness.js";

/**
 * `msf status` and `msf run` at the hermetic CLI seam over the REAL Jira
 * adapter (issues 128-129): the spawned binary reads the configured selections
 * through a canned Jira REST channel (fetch preload), with an isolated HOME and
 * no ambient credential. Status presents ONE site's candidates in native Rank
 * order across destinations and pages, without claiming anything; a selection
 * without its local credential is unknown while other sites still list; `run`
 * refuses a Jira configuration before any claim, launch or workspace write.
 */

const ALPHA = "acme.atlassian.net";
const BETA = "beta.atlassian.net";
const REPO = "Sanmoo/my-tasks";

describe("e2e: Jira Cloud selections at the CLI seam (read-only, issues 128-129)", () => {
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
   *  transition or other tracker write. */
  function assertReadOnlyJira(): void {
    const calls = jira.calls();
    assert.ok(calls.length > 0, "the status read reached the tracker");
    for (const call of calls) {
      assert.match(call, /^(GET \/rest\/api\/3\/myself|POST \/rest\/api\/3\/search\/jql)$/);
    }
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
      /2\. ABC-2 \(jira:acme\.atlassian\.net\) → Sanmoo\/my-tasks — Fix logout \(subtask\)$/m,
    );
    assert.ok(
      result.stdout.indexOf("1. ABC-1") < result.stdout.indexOf("2. ABC-2"),
      "the returned Rank order is presented as-is, never re-sorted by creation age",
    );
    assert.match(result.stdout, new RegExp(`${BETA} \\(1 selection\\) → ${REPO}: unknown`));
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
    assert.match(result.stderr, /Jira execution is not implemented yet/);
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
