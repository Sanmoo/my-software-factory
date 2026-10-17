import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createGitHubAdapter,
  defaultCommandRunner,
  ghCliEnv,
  readGhToken,
  type CommandRunner,
} from "./github-adapter.js";
import { runContractChecks, type ContractHarness, type ContractIssue } from "./contract.js";
import { AGENT_MARKER, type IssueRef, type TrackerPort } from "./port.js";
import { derivePool } from "../state/derive.js";
import { DEFAULT_LABELS } from "../config.js";

/**
 * The real smoke of the GitHub adapter (ticket 16), in the empirical-proof
 * pattern of wayfinder ticket 09: against a REAL repo (default
 * `Sanmoo/my-tasks`, the config's example repo) with the bot account, every
 * operation is executed, verified and reverted — nothing stays behind
 * (comments deleted, labels and assignees removed, blockers unlinked, PRs
 * closed, branches deleted, issues closed).
 *
 * Credential-gated: without the bot token in the gh keyring the smoke is
 * SKIPPED with the reason — never faked. Run explicitly:
 *
 *   npm run smoke:github
 *
 * Overrides: MSF_SMOKE_REPO, MSF_SMOKE_ACCOUNT.
 */

const SMOKE_BODY = `seeded by the msf ticket-16 smoke — reverted by its cleanup\n\n${AGENT_MARKER}`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Journal {
  /** Issues created by the harness (issues can't be deleted via the API; they are closed). */
  issues: number[];
  /** PRs created (closed on cleanup — deletion is not offered by GitHub). */
  prs: number[];
  /** Branch refs created here or by the adapter (deleted on cleanup). */
  branches: Set<string>;
  /** Comments created, by their issue/PR number and comment id (deleted on cleanup). */
  comments: { containerNumber: number; commentId: string }[];
  /** Native blockers added (unlinked on cleanup). */
  blockers: { issueNumber: number; blockerNumber: number }[];
  /** Labels created in the repo itself (deleted on cleanup, only if we created them). */
  repoLabelsCreated: string[];
}

class RealGithubHarness implements ContractHarness {
  readonly name = "real (gh CLI)";
  readonly journal: Journal = { issues: [], prs: [], branches: new Set(), comments: [], blockers: [], repoLabelsCreated: [] };
  private readonly runner: CommandRunner;
  private readonly token: string;

  constructor(
    readonly repo: string,
    readonly workerAccount: string,
    readonly claimedLabel: string,
    readonly adapter: TrackerPort,
    token: string,
    runner: CommandRunner = defaultCommandRunner,
  ) {
    this.token = token;
    this.runner = runner;
  }

  getAdapter(): TrackerPort {
    return this.adapter;
  }

  async reset(): Promise<void> {
    // the real repo is shared across checks; cleanup is the only reversion
  }

  // ---- seeding over gh ----

  async createIssue(input: { title: string; labels?: string[]; closed?: boolean }): Promise<ContractIssue> {
    for (const label of input.labels ?? []) {
      await this.ensureRepoLabel(label);
    }
    const labelArgs = (input.labels ?? []).length > 0 ? ["--label", (input.labels ?? []).join(",")] : [];
    const { stdout } = await this.gh([
      "issue", "create", "-R", this.repo,
      "--title", input.title,
      "--body", SMOKE_BODY,
      ...labelArgs,
    ]);
    const ref = { repo: this.repo, number: this.parseNumber(stdout, /\/issues\/(\d+)/, "gh issue create") };
    this.journal.issues.push(ref.number);
    // REST: no search-index involvement, cheap on the GraphQL budget
    const { stdout: createdAt } = await this.gh([
      "api", `repos/${this.repo}/issues/${ref.number}`, "--jq", ".created_at",
    ]);
    if (input.closed) {
      await this.gh(["issue", "close", String(ref.number), "-R", this.repo, "--reason", "completed"]);
    }
    // GitHub's search index lags a few seconds behind creation AND closing:
    // the label-filtered listing (the candidates) must reflect the issue's
    // state before any check reads it. Poll the listing until it does.
    const firstLabel = (input.labels ?? [])[0];
    if (firstLabel !== undefined) {
      if (input.closed) {
        await this.settleOut(ref, firstLabel);
      } else {
        await this.settleIn(ref, firstLabel);
      }
    }
    return createdAt === "" ? { ref } : { ref, createdAt };
  }

  private async settleIn(ref: IssueRef, label: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const numbers = await this.listingNumbers(label);
      if (numbers.includes(ref.number)) return;
      if (Date.now() > deadline) {
        throw new Error(`issue ${this.repo}#${ref.number} did not appear in the "${label}" listing within 30s (search index lag)`);
      }
      await sleep(2_000);
    }
  }

  private async settleOut(ref: IssueRef, label: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const numbers = await this.listingNumbers(label);
      if (!numbers.includes(ref.number)) return;
      if (Date.now() > deadline) {
        throw new Error(`issue ${this.repo}#${ref.number} is closed but still appears in the "${label}" open listing after 30s (search index lag)`);
      }
      await sleep(2_000);
    }
  }

  private async listingNumbers(label: string): Promise<number[]> {
    const { stdout } = await this.gh([
      "issue", "list", "-R", this.repo, "--state", "open", "--label", label, "--json", "number",
    ]);
    return (JSON.parse(stdout) as { number: number }[]).map((item) => item.number);
  }

  async missingRef(): Promise<IssueRef> {
    // the REST listing returns issues only (never PRs), but issues and PRs
    // share the numbering: newest issue number + 1_000_000 is safely missing
    const { stdout } = await this.gh([
      "api", `repos/${this.repo}/issues?state=all&sort=created&direction=desc&per_page=1`, "--jq", ".[0].number",
    ]);
    return { repo: this.repo, number: Number(stdout.trim()) + 1_000_000 };
  }

  async addBlocker(ref: IssueRef, blocker: IssueRef): Promise<void> {
    await this.gh(["issue", "edit", String(ref.number), "-R", this.repo, "--add-blocked-by", String(blocker.number)]);
    this.journal.blockers.push({ issueNumber: ref.number, blockerNumber: blocker.number });
  }

  async addComment(ref: IssueRef, _author: string, body: string): Promise<void> {
    const { stdout } = await this.gh(["issue", "comment", String(ref.number), "-R", this.repo, "--body", body]);
    const commentId = this.parseNumber(stdout, /#issuecomment-(\d+)/, "gh issue comment");
    this.journal.comments.push({ containerNumber: ref.number, commentId: String(commentId) });
  }

  async ensureBranch(branch: string, baseBranch = "main"): Promise<void> {
    const existed = await this.branchExists(branch);
    if (!existed) {
      const { stdout: sha } = await this.gh([
        "api", `repos/${this.repo}/git/ref/heads/${baseBranch}`, "--jq", ".object.sha",
      ]);
      await this.gh(
        ["api", "-X", "POST", `repos/${this.repo}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${sha.trim()}`],
        { tolerate: (stderr) => stderr.includes("Reference already exists") },
      );
      this.journal.branches.add(branch);
    }
    // one commit beyond the base, so a PR can exist
    const path = `msf-smoke/${Date.now()}-${Math.floor(Math.random() * 10_000)}.txt`;
    await this.gh([
      "api", "-X", "PUT", `repos/${this.repo}/contents/${path}`,
      "-f", "message=msf smoke probe commit",
      "-f", `content=${Buffer.from("smoke").toString("base64")}`,
      "-f", `branch=${branch}`,
    ]);
  }

  async createPullRequest(
    issue: IssueRef,
    input?: { headBranch?: string; baseBranch?: string },
  ): Promise<number> {
    const headBranch = input?.headBranch ?? `agent-issue-${issue.number}`;
    const baseBranch = input?.baseBranch ?? (await this.defaultBranch());
    await this.ensureBranch(headBranch, baseBranch);
    const { stdout } = await this.gh([
      "pr", "create", "-R", this.repo,
      "--head", headBranch, "--base", baseBranch,
      "--title", `msf smoke: work #${issue.number}`,
      "--body", `Closes #${issue.number}\n\n${SMOKE_BODY}`,
    ]);
    const prNumber = this.parseNumber(stdout, /\/pull\/(\d+)/, "gh pr create");
    this.journal.prs.push(prNumber);
    return prNumber;
  }

  async branchExists(branch: string): Promise<boolean> {
    try {
      await this.gh(["api", `repos/${this.repo}/branches/${branch}`, "--jq", ".name"]);
      // journal it: a branch the ADAPTER created (pushBranch) must be reverted too
      this.journal.branches.add(branch);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureRepoLabel(label: string): Promise<void> {
    try {
      await this.gh(["label", "create", label, "-R", this.repo]);
      this.journal.repoLabelsCreated.push(label);
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? String(error);
      if (!stderr.includes("already exists")) throw error;
    }
  }

  async defaultBranch(): Promise<string> {
    const { stdout } = await this.gh([
      "api", `repos/${this.repo}`, "--jq", ".default_branch",
    ]);
    return stdout.trim();
  }

  private async gh(
    args: string[],
    options: { input?: string; tolerate?: (stderr: string) => boolean } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      return await this.runner("gh", args, { env: ghCliEnv(this.token), ...(options.input === undefined ? {} : { input: options.input }) });
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      if (options.tolerate && options.tolerate(stderr)) return { stdout: "", stderr };
      throw error;
    }
  }

  private parseNumber(stdout: string, pattern: RegExp, what: string): number {
    const match = stdout.match(pattern);
    if (!match) throw new Error(`${what} did not return the expected URL: ${stdout.trim()}`);
    return Number(match[1]);
  }

  // ---- the reversion: every artifact back out of the repo ----

  async cleanup(): Promise<void> {
    const failures: string[] = [];
    const containers = [...new Set([...this.journal.issues, ...this.journal.prs])];

    // PRs: closed (GitHub offers no PR deletion)
    for (const pr of this.journal.prs) {
      try {
        const { stdout } = await this.gh(["pr", "view", String(pr), "-R", this.repo, "--json", "state", "--jq", ".state"]);
        if (stdout.trim() === "OPEN") {
          await this.gh(["pr", "close", String(pr), "-R", this.repo]);
        }
      } catch (error) {
        failures.push(`pr #${pr}: ${(error as Error).message}`);
      }
    }

    // branches: deleted
    for (const branch of this.journal.branches) {
      try {
        await this.gh(
          ["api", "-X", "DELETE", `repos/${this.repo}/git/refs/heads/${branch}`],
          { tolerate: (stderr) => stderr.includes("does not exist") },
        );
      } catch (error) {
        failures.push(`branch ${branch}: ${(error as Error).message}`);
      }
    }

    // comments: every comment on our issues/PRs (ours from seeding AND from the port) deleted
    for (const container of containers) {
      try {
        const { stdout } = await this.gh(["api", `repos/${this.repo}/issues/${container}/comments`, "--jq", ".[].id"]);
        for (const id of stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "")) {
          await this.gh(["api", "-X", "DELETE", `repos/${this.repo}/issues/comments/${id}`]);
        }
      } catch (error) {
        failures.push(`comments of #${container}: ${(error as Error).message}`);
      }
    }

    // issues: blockers unlinked, assignees and labels removed, then closed
    for (const issue of this.journal.issues) {
      try {
        const { stdout: blockers } = await this.gh([
          "issue", "view", String(issue), "-R", this.repo, "--json", "blockedBy", "--jq", ".blockedBy.nodes[].number",
        ]);
        for (const blocker of blockers.split("\n").map((l) => l.trim()).filter((l) => l !== "")) {
          await this.gh(["issue", "edit", String(issue), "-R", this.repo, "--remove-blocked-by", blocker]);
        }
        await this.gh(["issue", "edit", String(issue), "-R", this.repo, "--remove-assignee", this.workerAccount]);
        const { stdout: labels } = await this.gh([
          "issue", "view", String(issue), "-R", this.repo, "--json", "labels", "--jq", ".labels[].name",
        ]);
        for (const label of labels.split("\n").map((l) => l.trim()).filter((l) => l !== "")) {
          await this.gh(["issue", "edit", String(issue), "-R", this.repo, "--remove-label", label]);
        }
        const { stdout: state } = await this.gh(["issue", "view", String(issue), "-R", this.repo, "--json", "state", "--jq", ".state"]);
        if (state.trim() === "OPEN") {
          await this.gh(["issue", "close", String(issue), "-R", this.repo, "--reason", "not planned"]);
        }
      } catch (error) {
        failures.push(`issue #${issue}: ${(error as Error).message}`);
      }
    }

    // repo labels we created: deleted
    for (const label of [...new Set(this.journal.repoLabelsCreated)]) {
      try {
        await this.gh(["label", "delete", label, "-R", this.repo, "--yes"]);
      } catch (error) {
        failures.push(`repo label ${label}: ${(error as Error).message}`);
      }
    }

    // verification pass: nothing left behind
    for (const issue of this.journal.issues) {
      const { stdout } = await this.gh([
        "issue", "view", String(issue), "-R", this.repo,
        "--json", "state,labels,assignees,comments",
      ]);
      const view = JSON.parse(stdout) as {
        state: string;
        labels: unknown[];
        assignees: unknown[];
        comments: unknown[];
      };
      if (view.state !== "CLOSED") failures.push(`issue #${issue} still open`);
      if (view.comments.length !== 0) failures.push(`issue #${issue} still has comments`);
      if (view.labels.length !== 0) failures.push(`issue #${issue} still has labels`);
      if (view.assignees.length !== 0) failures.push(`issue #${issue} still has assignees`);
    }
    for (const pr of this.journal.prs) {
      const { stdout } = await this.gh(["pr", "view", String(pr), "-R", this.repo, "--json", "state", "--jq", ".state"]);
      if (stdout.trim() !== "CLOSED") failures.push(`pr #${pr} still open`);
    }
    for (const branch of this.journal.branches) {
      if (await this.branchExists(branch)) failures.push(`branch ${branch} still exists`);
    }
    for (const label of [...new Set(this.journal.repoLabelsCreated)]) {
      try {
        await this.gh(["label", "view", label, "-R", this.repo]);
        failures.push(`repo label ${label} still exists`);
      } catch {
        // gone: good
      }
    }

    if (failures.length > 0) {
      throw new Error(`reversion incomplete:\n  - ${failures.join("\n  - ")}`);
    }
    console.log(`  ✔ reverted: ${this.journal.issues.length} issue(s) closed, ${this.journal.prs.length} PR(s) closed, ${this.journal.branches.size} branch(es) deleted, all comments/labels/assignees/blockers removed`);
    this.journal.issues = [];
    this.journal.prs = [];
    this.journal.branches = new Set();
    this.journal.comments = [];
    this.journal.blockers = [];
    this.journal.repoLabelsCreated = [];
  }
}

/** The full cycle of one issue: every operation executed, verified — reverted by cleanup. */
async function fullCycle(harness: RealGithubHarness, adapter: TrackerPort): Promise<void> {
  const repo = harness.repo;
  const account = harness.workerAccount;

  // seed
  const issue = await harness.createIssue({ title: "msf t16 smoke: full cycle", labels: [DEFAULT_LABELS.ready] });
  const blocker = await harness.createIssue({ title: "msf t16 smoke: blocker", closed: true });
  await harness.addBlocker(issue.ref, blocker.ref);
  console.log(`seeded issue ${repo}#${issue.ref.number} with blocker #${blocker.ref.number} (closed)`);

  // 1. candidates: the issue appears, with createdAt for age priority
  const candidates = await adapter.listCandidates(repo, DEFAULT_LABELS.ready);
  const candidate = candidates.find((c) => c.ref.number === issue.ref.number);
  if (!candidate) throw new Error("op1: the seeded issue is not a candidate");
  console.log(`op1 EXECUTED+VERIFIED: listCandidates → ${repo}#${candidate.ref.number} createdAt ${candidate.createdAt}`);

  // 2. read the issue
  const snapshot = await adapter.readIssue(issue.ref);
  if (!snapshot.known || snapshot.value.title !== "msf t16 smoke: full cycle") {
    throw new Error("op2: snapshot mismatch");
  }
  console.log("op2 EXECUTED+VERIFIED: readIssue → title, state, labels, createdAt");

  // 3. native blockers, closed via the API
  const blockers = await adapter.readBlockers(issue.ref);
  if (!blockers.known || blockers.value.length !== 1 || blockers.value[0]?.state !== "closed") {
    throw new Error("op3: blockers mismatch");
  }
  console.log("op3 EXECUTED+VERIFIED: readBlockers → native blocked_by, terminal (closed)");

  // 4. claim
  await adapter.claim(issue.ref, account);
  const claimed = await adapter.readIssue(issue.ref);
  if (!claimed.known || !claimed.value.labels.includes(DEFAULT_LABELS.claimed) || claimed.value.assignees[0] !== account) {
    throw new Error("op4: claim not visible in the re-read");
  }
  console.log(`op4 EXECUTED+VERIFIED: claim → label ${DEFAULT_LABELS.claimed} + assignee ${account}`);

  // 5. release (then claim again for the cycle)
  await adapter.releaseClaim(issue.ref, account);
  const released = await adapter.readIssue(issue.ref);
  if (!released.known || released.value.labels.includes(DEFAULT_LABELS.claimed) || released.value.assignees.length !== 0) {
    throw new Error("op5: release not visible in the re-read");
  }
  console.log("op5 EXECUTED+VERIFIED: releaseClaim → only the claim mark removed");
  await adapter.claim(issue.ref, account);

  // 9c. push the work branch via git, credential helper baked into the clone
  const branch = `agent-issue-${issue.ref.number}`;
  await adapter.pushBranch({ repo, branch });
  if (!(await harness.branchExists(branch))) throw new Error("op9c: branch not on the remote");
  console.log(`op9c EXECUTED+VERIFIED: pushBranch → ${branch} on the remote (git, bot credential)`);
  // the branch needs a commit beyond the base for a PR to exist
  await harness.ensureBranch(branch);

  // 9b. open the PR
  const pr = await adapter.openPr({
    repo,
    issueNumber: issue.ref.number,
    headBranch: branch,
    baseBranch: await harness.defaultBranch(),
    title: `work #${issue.ref.number}`,
  });
  console.log(`op9b EXECUTED: openPr → ${repo}#${pr.number}`);

  // 9a. PR feedback: conversation comment + re-read
  await harness.addComment({ repo, number: pr.number }, "a-human", "smoke: PR feedback");
  const feedback = await adapter.readPrFeedback(issue.ref);
  if (!feedback.known || feedback.value.pr?.number !== pr.number || feedback.value.pr?.state !== "open") {
    throw new Error("op9a: PR feedback mismatch");
  }
  if (!feedback.value.comments.some((c) => c.body === "smoke: PR feedback")) {
    throw new Error("op9a: PR conversation comment missing");
  }
  console.log(`op9a EXECUTED+VERIFIED: readPrFeedback → PR #${feedback.value.pr.number} open, conversation readable`);

  // 7. comment on the issue (the port carries the marker)
  await adapter.comment(issue.ref, "smoke: blocked valve test");
  // 8. read comments back (a seeded "human" one plus ours)
  await harness.addComment(issue.ref, "a-human", "smoke: human note");
  const comments = await adapter.readComments(issue.ref);
  if (!comments.known) throw new Error("op8: comments unknown");
  if (!comments.value.some((c) => c.body === "smoke: human note")) throw new Error("op8: human comment missing");
  if (!comments.value.some((c) => c.body.startsWith(AGENT_MARKER) && c.body.includes("smoke: blocked valve test"))) {
    throw new Error("op7: marked comment missing");
  }
  console.log("op7+op8 EXECUTED+VERIFIED: comment → marker carried; readComments → both readable");

  // derivation over the real adapter: the pool derivation of ticket 11
  const pool = await derivePool(adapter, [repo], DEFAULT_LABELS);
  if (pool.some((entry) => entry.ref.number === issue.ref.number)) {
    throw new Error("derive: the claimed issue must NOT be eligible");
  }
  console.log("extra EXECUTED+VERIFIED: derivePool over the real adapter → claimed issue kept out of the pool");

  // 6. done
  await adapter.markDone(issue.ref);
  const done = await adapter.readIssue(issue.ref);
  if (!done.known || done.value.state !== "closed" || done.value.stateReason !== "completed") {
    throw new Error("op6: done not visible in the re-read");
  }
  console.log("op6 EXECUTED+VERIFIED: markDone → closed as completed");

  // rank: the honest null
  const rank = await adapter.rank(issue.ref);
  if (!rank.known || rank.value !== null) throw new Error("rank: not known-null");
  console.log("rank EXECUTED+VERIFIED: known(null) — priority is age");
}

async function main(): Promise<void> {
  const repo = process.env.MSF_SMOKE_REPO ?? "Sanmoo/my-tasks";
  const account = process.env.MSF_SMOKE_ACCOUNT ?? "bot-do-samuca";

  console.log(`smoke: ticket 16 — the real GitHub adapter, over ${repo} as ${account}`);

  let token: string;
  try {
    token = await readGhToken(account);
  } catch (error) {
    console.log(`SKIPPED: credential unavailable — ${(error as Error).message}`);
    console.log("nothing was executed; nothing to revert");
    return;
  }

  const clonesDir = mkdtempSync(join(tmpdir(), "msf-smoke-clones-"));
  const adapter = await createGitHubAdapter({ account, clonesDir });
  const harness = new RealGithubHarness(repo, account, DEFAULT_LABELS.claimed, adapter, token);

  try {
    console.log("\n== the contract suite (the same the fake satisfies) ==");
    await runContractChecks(harness);

    console.log("\n== full cycle: every operation executed, verified — reverted at the end ==");
    await fullCycle(harness, adapter);
    console.log("\n== reversion ==");
    await harness.cleanup();
    console.log("smoke PASSED: all operations executed and verified; nothing left behind in the repo");
  } catch (error) {
    console.log("\n== reversion (after a failure) ==");
    try {
      await harness.cleanup();
      console.log("reversion completed despite the failure above");
    } catch (cleanupError) {
      console.error(`ADDITIONALLY, reversion failed: ${(cleanupError as Error).message}`);
    }
    throw error;
  } finally {
    rmSync(clonesDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(`smoke FAILED: ${(error as Error).message}`);
  process.exit(1);
});
