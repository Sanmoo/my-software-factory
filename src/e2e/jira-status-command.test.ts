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
 * adapter (issue 128): the spawned binary reads a Cloud source through a
 * canned Jira REST channel (fetch preload), with an isolated HOME and no
 * ambient credential. Status presents the JQL candidates in the native Rank
 * order without claiming anything; a source without its local credential is
 * unknown while the healthy one still lists; `run` refuses a Jira
 * configuration before any claim, launch or workspace write.
 */

const ALPHA = "acme.atlassian.net";
const BETA = "beta.atlassian.net";
const REPO = "Sanmoo/my-tasks";

describe("e2e: a Jira Cloud source at the CLI seam (read-only, issue 128)", () => {
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
   *  independent source must not be treated as absent. */
  function writeConfig(overrides: { alphaJql?: string; alphaSecret?: string } = {}): void {
    const alphaSecretLine =
      overrides.alphaSecret === undefined
        ? "    token-env: MSF_JIRA_ALPHA_TOKEN"
        : overrides.alphaSecret;
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
        alphaSecretLine,
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
      [`POST /rest/api/3/search/jql`]: {
        body: {
          isLast: true,
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
            {
              id: "10002",
              key: "ABC-2",
              fields: {
                summary: "Fix logout",
                labels: [],
                created: "2026-01-01T00:00:00.000+0000",
                assignee: null,
              },
            },
          ],
        },
      },
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

    const result = runCli(dir, ["status"], cliEnv());

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /jira candidates \(read-only[^)]*native Rank order[^)]*nothing is claimed, commented or launched\)/);
    assert.match(result.stdout, new RegExp(`${ALPHA} → ${REPO}: 2`));
    assert.match(
      result.stdout,
      new RegExp(`1\\. ABC-1 \\(jira:${ALPHA.replace(/\./g, "\\.")}\\) → ${REPO} — Fix login \\[assignee: Ana Silva\\]`),
    );
    assert.match(result.stdout, /2\. ABC-2 \(jira:acme\.atlassian\.net\) → Sanmoo\/my-tasks — Fix logout$/m);
    assert.ok(
      result.stdout.indexOf("1. ABC-1") < result.stdout.indexOf("2. ABC-2"),
      "the returned Rank order is presented as-is, never re-sorted by creation age",
    );
    assert.match(result.stdout, new RegExp(`${BETA} → ${REPO}: unknown`));
    assert.match(result.stdout, /MSF_JIRA_BETA_TOKEN/, "the missing credential is diagnosed by its variable name");
    assert.match(result.stdout, /pool \(eligible\): none/, "a Jira candidate is never offered as an eligible Work");

    assert.deepEqual(
      jira.calls(),
      ["GET /rest/api/3/myself", "POST /rest/api/3/search/jql"],
      "one identity read and one native search: no claim, comment or transition",
    );
    assert.deepEqual(gh.restCalls(), [], "repos: [] means no GitHub Issues REST call");
    assert.equal(existsSync(workspace), false, "status created no execution workspace");
  });

  test("the API token is refused as a YAML value before any read, and never echoed", () => {
    const secret = "ATATT3xFfGF0cli-secret";
    writeConfig({ alphaSecret: `    token: ${secret}` });
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
});
