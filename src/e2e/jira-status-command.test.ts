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
 * adapter: the spawned binary reads the configured selections
 * through a canned Jira REST channel (fetch preload), with an isolated HOME and
 * no ambient credential. Status presents the JQL candidates in the native Rank
 * order without claiming anything; a selection without its local credential is
 * unknown while the healthy one still lists; `run` refuses a Jira
 * configuration before any claim, launch or workspace write.
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

  test("status presents the Jira candidates in native Rank order and never claims or launches", () => {
    writeConfig();
    installJiraAnswers();
    const ready = join(dir, "status-boot-check-ran");

    const result = runCli(dir, ["status"], cliEnv({ ready }));

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /jira candidates \(read-only[^)]*native Rank order[^)]*nothing is claimed, commented or launched\): 2 selections$/m,
      "the header counts the configured selections it lists below, not the tickets they hold",
    );
    assert.match(result.stdout, new RegExp(`${ALPHA} → ${REPO}: 2`));
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
    assert.match(result.stdout, new RegExp(`${BETA} → ${REPO}: unknown`));
    assert.match(result.stdout, /MSF_JIRA_BETA_TOKEN/, "the missing credential is diagnosed by its variable name");
    assert.match(result.stdout, /pool \(eligible\): none/, "a Jira candidate is never offered as an eligible Work");

    assert.deepEqual(
      jira.calls(),
      [
        "GET /rest/api/3/myself",
        "POST /rest/api/3/search/jql",
        "POST /rest/api/3/search/jql",
      ],
      "one identity read and the native pages: no claim, comment or transition",
    );
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

  test("one Jira project feeds two destinations through two explicit selections and one identity", () => {
    // Two selections on the SAME site: one account, one credential, one /myself.
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
        "    jql: project = ABC AND labels = backend",
        "    destination: Sanmoo/backend",
      ].join("\n"),
      "utf8",
    );
    jira = installJiraFetchShim(dir, {
      [`GET /rest/api/3/myself`]: {
        body: { accountId: "acct-1", emailAddress: "bot@acme.example", displayName: "Factory Bot", active: true },
      },
      [`POST /rest/api/3/search/jql :: project = ABC AND labels = frontend ORDER BY Rank ASC`]: {
        body: {
          isLast: true,
          issues: [{ id: "10010", key: "ABC-10", fields: { summary: "Frontend fix", labels: ["frontend"], created: "2026-02-01T00:00:00.000+0000", assignee: null } }],
        },
      },
      [`POST /rest/api/3/search/jql :: project = ABC AND labels = backend ORDER BY Rank ASC`]: {
        body: {
          isLast: true,
          issues: [{ id: "10020", key: "ABC-20", fields: { summary: "Backend fix", labels: ["backend"], created: "2026-01-01T00:00:00.000+0000", assignee: null } }],
        },
      },
    });

    const result = runCli(dir, ["status"], cliEnv());

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /acme\.atlassian\.net → Sanmoo\/frontend: 1/);
    assert.match(result.stdout, /1\. ABC-10 \(jira:acme\.atlassian\.net\) → Sanmoo\/frontend — Frontend fix/);
    assert.match(result.stdout, /acme\.atlassian\.net → Sanmoo\/backend: 1/);
    assert.match(result.stdout, /1\. ABC-20 \(jira:acme\.atlassian\.net\) → Sanmoo\/backend — Backend fix/);
    assert.match(result.stdout, /pool \(eligible\): none/, "still read-only: no candidate is executable work");
    assert.deepEqual(
      jira.calls(),
      ["GET /rest/api/3/myself", "POST /rest/api/3/search/jql", "POST /rest/api/3/search/jql"],
      "one identity for the site and one native read per selection",
    );
    assert.deepEqual(gh.restCalls(), [], "no GitHub Issues read");
    assert.equal(existsSync(workspace), false, "no execution workspace");
  });

  test("a ticket two selections promise to different destinations is held, not listed as a candidate", () => {
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
      body: {
        isLast: true,
        issues: [
          {
            id: "10030",
            key: "ABC-30",
            fields: {
              summary: "Shared across layers",
              labels: ["frontend", "shared"],
              created: "2026-01-01T00:00:00.000+0000",
              assignee: null,
            },
          },
        ],
      },
    };
    jira = installJiraFetchShim(dir, {
      [`GET /rest/api/3/myself`]: {
        body: { accountId: "acct-1", emailAddress: "bot@acme.example", displayName: "Factory Bot", active: true },
      },
      [`POST /rest/api/3/search/jql :: project = ABC AND labels = frontend ORDER BY Rank ASC`]: shared,
      [`POST /rest/api/3/search/jql :: project = ABC AND labels = shared ORDER BY Rank ASC`]: shared,
    });

    const result = runCli(dir, ["status"], cliEnv());

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /acme\.atlassian\.net → Sanmoo\/frontend: 0 candidates, 1 held as ambiguous/);
    assert.match(result.stdout, /acme\.atlassian\.net → Sanmoo\/backend: 0 candidates, 1 held as ambiguous/);
    assert.match(result.stdout, /ambiguous \(more than one destination — held, no destination chosen\): 1/);
    assert.match(
      result.stdout,
      /1\. ABC-30 \(jira:acme\.atlassian\.net\) — Shared across layers → Sanmoo\/frontend, Sanmoo\/backend/,
    );
    assert.match(result.stdout, /pool \(eligible\): none/);
    assert.deepEqual(
      jira.calls(),
      ["GET /rest/api/3/myself", "POST /rest/api/3/search/jql", "POST /rest/api/3/search/jql"],
      "one identity and one native read per selection, no claim or write",
    );
    assert.equal(existsSync(workspace), false, "no execution workspace");
  });
});
