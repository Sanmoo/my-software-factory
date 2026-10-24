import { createGitHubAdapter, type CommandRunner, type GitHubTrackerAdapter } from "./github-adapter.js";
import { GitHubSim, type SimIssue } from "./github-sim.js";
import type { GitHubContractFaults, GitHubContractHarness, GitHubContractIssue } from "./github-contract-suite.js";
import type { IssueRef, ReadCost, TrackerPort } from "./port.js";
import type { TicketTracker } from "./expanded-port.js";

/**
 * The real adapter over the in-memory REST simulator, shared by the contract
 * and expanded-contract suites. Both boundaries use the SAME recorder/fault
 * seam, so a runner change cannot drift between them.
 */
export class SimulatedRepoHarness implements GitHubContractHarness {
  readonly name = "real (gh CLI) over the simulated REST repo";
  readonly repo = "Sanmoo/sim-repo";
  readonly workerAccount = "bot-do-samuca";
  readonly claimedLabel = "agent-claimed";
  /** The adapter's gh api calls, recorded as "METHOD path" (budget accounting). */
  calls: string[] = [];
  /** The sim itself, for tests that need the seeded state. */
  sim: GitHubSim = new GitHubSim();
  /** The next real server failure to inject, when armed. */
  private armedFailure: { method: string; pathIncludes: string } | null = null;
  private adapter: GitHubTrackerAdapter | undefined;

  /** Injects the failure at this harness's runner seam, never at live GitHub. */
  faults(): GitHubContractFaults {
    return {
      failRemovingLabel: (label: string) => {
        this.failNext("DELETE", `/labels/${label}`);
      },
    };
  }

  /** Arm one real server failure at the next matching gh api call. */
  failNext(method: string, pathIncludes: string): void {
    this.armedFailure = { method, pathIncludes };
  }

  /** The adapter itself (the expanded ticket/PR contracts). */
  getExpandedAdapter(): GitHubTrackerAdapter {
    if (!this.adapter) throw new Error("harness reset has not run yet");
    return this.adapter;
  }

  /** The adapter itself: it serves the legacy port and the expanded contract. */
  getAdapter(): TrackerPort & TicketTracker {
    return this.getExpandedAdapter();
  }

  /** The REST-based read cost, counted from the recorded `gh api` calls. */
  readCost(): ReadCost {
    const getPaths = this.calls
      .filter((call) => call.startsWith("GET "))
      .map((call) => call.slice("GET ".length));
    const count = (pattern: RegExp): number => getPaths.filter((path) => pattern.test(path)).length;
    return {
      issueListings: count(/\/issues$/),
      pullListings: count(/\/pulls$/),
      issueReads: count(/\/issues\/\d+$/),
    };
  }

  async reset(): Promise<void> {
    this.sim = new GitHubSim();
    this.calls = [];
    this.armedFailure = null;
    // the boot check runs over the sim's keyring answer; every gh api call
    // goes through the recorder so the cycle's REST count is asserted offline
    const simRunner = this.sim.runner;
    const runner: CommandRunner = async (file, args, options) => {
      if (file === "gh" && args[0] === "api") {
        const method = args[1] === "-X" ? args[2] ?? "GET" : "GET";
        const path = args.find((a) => a.startsWith("repos/"))?.split("?")[0] ?? "";
        this.calls.push(`${method} ${path}`);
        const armed = this.armedFailure;
        if (armed !== null && armed.method === method && path.includes(armed.pathIncludes)) {
          this.armedFailure = null;
          // gh-shaped: the adapter's tolerances read stderr; this failure is
          // deliberately not the tolerated absent-label case.
          const injected = new Error("gh: injected server failure (HTTP 500)");
          Object.assign(injected, { stderr: "gh: injected server failure (HTTP 500)" });
          throw injected;
        }
      }
      return simRunner(file, args, options);
    };
    this.adapter = await createGitHubAdapter({
      account: this.workerAccount,
      runner,
      clonesDir: "/tmp/msf-sim-clones",
    });
  }

  async createIssue(input: {
    title: string;
    labels?: string[];
    closed?: boolean;
  }): Promise<GitHubContractIssue> {
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
    const pr = (() => {
      try {
        return JSON.parse(stdout) as { number: number };
      } catch (error) {
        throw new Error(`sim: invalid PR response: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    return pr.number;
  }

  async branchExists(branch: string): Promise<boolean> {
    return this.sim.branches.has(branch);
  }

  async defaultBranch(): Promise<string> {
    return this.sim.defaultBranch;
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
