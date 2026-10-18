import { createGitHubAdapter, type GitHubTrackerAdapter } from "./github-adapter.js";
import { GitHubSim, type SimIssue } from "./github-sim.js";
import {
  runTrackerContractSuite,
  type ContractHarness,
  type ContractIssue,
} from "./contract.js";
import type { IssueRef } from "./port.js";

/**
 * The ticket-16 proof the fake cannot give: the REAL GitHub adapter satisfying
 * the SAME port contract suite, offline — the gh/process boundary is the
 * in-memory REST simulator (`github-sim.ts`). The command-line shapes are
 * asserted separately in `github-adapter.test.ts`; here what is proven is the
 * adapter's BEHAVIOR: REST payloads go in, port results come out, writes land
 * in the (simulated) repo state.
 */

class SimulatedRepoHarness implements ContractHarness {
  readonly name = "real (gh CLI) over the simulated REST repo";
  readonly repo = "Sanmoo/sim-repo";
  readonly workerAccount = "bot-do-samuca";
  readonly claimedLabel = "agent-claimed";
  private sim: GitHubSim = new GitHubSim();
  private adapter: GitHubTrackerAdapter | undefined;

  getAdapter(): GitHubTrackerAdapter {
    if (!this.adapter) throw new Error("harness reset has not run yet");
    return this.adapter;
  }

  async reset(): Promise<void> {
    this.sim = new GitHubSim();
    // the boot check runs over the sim's keyring answer
    this.adapter = await createGitHubAdapter({
      account: this.workerAccount,
      runner: this.sim.runner,
      clonesDir: "/tmp/msf-sim-clones",
    });
  }

  async createIssue(input: {
    title: string;
    labels?: string[];
    closed?: boolean;
  }): Promise<ContractIssue> {
    const issue: SimIssue = this.sim.createIssue(input);
    return { ref: { repo: this.repo, number: issue.number }, createdAt: issue.createdAt };
  }

  async missingRef(): Promise<IssueRef> {
    return { repo: this.repo, number: this.sim.missingNumber() };
  }

  async addBlocker(ref: IssueRef, blocker: IssueRef): Promise<void> {
    this.sim.addBlocker(ref.number, blocker.number);
  }

  async addComment(ref: IssueRef, author: string, body: string): Promise<void> {
    this.sim.addComment(ref.number, author, body);
  }

  async ensureBranch(branch: string, _baseBranch?: string): Promise<void> {
    this.sim.branches.add(branch);
  }

  async createPullRequest(issue: IssueRef, input?: { headBranch?: string; baseBranch?: string }): Promise<number> {
    const headBranch = input?.headBranch ?? `agent-issue-${issue.number}`;
    const baseBranch = input?.baseBranch ?? this.sim.defaultBranch;
    this.sim.branches.add(headBranch);
    // through the same runner the adapter uses: the "Closes #N" linkage is
    // recorded by the simulated cross-reference, exactly like real GitHub
    const { stdout } = await this.sim.runner("gh", [
      "api", "-X", "POST", `repos/${this.repo}/pulls`, "--input", "-",
    ], {
      env: {},
      input: JSON.stringify({
        title: `msf sim: work #${issue.number}`,
        head: headBranch,
        base: baseBranch,
        body: `Closes #${issue.number}`,
      }),
    });
    const pr = JSON.parse(stdout) as { number: number };
    return pr.number;
  }

  async branchExists(branch: string): Promise<boolean> {
    return this.sim.branches.has(branch);
  }

  async closePullRequest(issue: IssueRef, prNumber: number): Promise<void> {
    await this.sim.runner("gh", [
      "api", "-X", "PATCH", `repos/${this.repo}/pulls/${prNumber}`, "--input", "-",
    ], { env: {}, input: JSON.stringify({ state: "closed", issue_number: issue.number }) });
  }

  async cleanup(): Promise<void> {
    // the sim is per-test state; reset starts fresh — nothing to revert
    this.sim = new GitHubSim();
  }
}

runTrackerContractSuite(new SimulatedRepoHarness());
