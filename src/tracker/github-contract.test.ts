import assert from "node:assert/strict";
import { describe, test, beforeEach } from "node:test";

import { createGitHubAdapter, type CommandRunner, type GitHubTrackerAdapter } from "./github-adapter.js";
import { GitHubSim, type SimIssue } from "./github-sim.js";
import {
  runTrackerContractSuite,
  type ContractHarness,
  type ContractIssue,
} from "./contract.js";
import {
  CYCLE_ADAPTER_REST_CALLS,
  recheckLateCandidates,
  runSmokeCycle,
} from "./smoke-cycle.js";
import type { Candidate, IssueRef, TrackerPort } from "./port.js";

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
  /** The adapter's gh api calls, recorded as "METHOD path" (budget accounting). */
  calls: string[] = [];
  private sim: GitHubSim = new GitHubSim();
  private adapter: GitHubTrackerAdapter | undefined;

  getAdapter(): GitHubTrackerAdapter {
    if (!this.adapter) throw new Error("harness reset has not run yet");
    return this.adapter;
  }

  async reset(): Promise<void> {
    this.sim = new GitHubSim();
    this.calls = [];
    // the boot check runs over the sim's keyring answer; every gh api call
    // goes through the recorder so the cycle's REST count is asserted offline
    const simRunner = this.sim.runner;
    const runner: CommandRunner = async (file, args, options) => {
      if (file === "gh" && args[0] === "api") {
        const method = args[1] === "-X" ? args[2] ?? "GET" : "GET";
        const path = args.find((a) => a.startsWith("repos/"))?.split("?")[0] ?? "";
        this.calls.push(`${method} ${path}`);
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

runTrackerContractSuite(new SimulatedRepoHarness());

// ---- the smoke's restructured full cycle, offline over the sim ----
//
// The REAL adapter runs the smoke's OWN flow (the full cycle) against the
// simulated repo: eligibility proven by DIRECT reads right after seeding
// (no settle wait — listings lag, direct GETs never do), and ONE non-blocking
// candidates() re-check after the cycle's last operation (the listing's live
// proof; by then it has had the whole cycle to converge). The smoke's REST
// accounting is asserted here too: the adapter-side count is the sim-proof
// of the planned-call breakdown the budget gate is built on.

describe("the smoke's full cycle (restructured op1) — the real adapter over the sim", () => {
  let harness: SimulatedRepoHarness;

  beforeEach(async () => {
    harness = new SimulatedRepoHarness();
    await harness.reset();
  });

  test("runs end to end: op1 proven by direct reads, the late re-check is converged", async () => {
    const report = await runSmokeCycle(harness, harness.getAdapter());
    assert.equal(report.op1DirectProof.readIssue, true, "readIssue proved eligibility");
    assert.equal(report.op1DirectProof.readBlockers, true, "readBlockers proved the blocker closed");
    assert.equal(
      report.op1ListingProof.converged,
      true,
      "on the sim the listing is instant: the late re-check is converged (the closed seeded issue is out)",
    );
    assert.equal(report.op1ListingProof.sawIssue, false);
  });

  test("op1 consults the listing NEVER before the direct reads — no settle wait", async () => {
    await runSmokeCycle(harness, harness.getAdapter());
    const directRead = harness.calls.findIndex((c) => c.endsWith("/dependencies/blocked_by"));
    const firstClaim = harness.calls.findIndex((c) => c.startsWith("POST") && c.endsWith("/assignees"));
    const firstListing = harness.calls.findIndex((c) => c === "GET repos/Sanmoo/sim-repo/issues");
    assert.ok(directRead !== -1, "the direct blockers read happened");
    assert.ok(firstClaim !== -1, "the cycle reached the claim");
    assert.ok(
      firstListing === -1 || firstListing > firstClaim,
      `no listing call before the cycle's first write (op1 is proven by direct reads; first listing at call #${firstListing + 1}, first claim write at #${firstClaim + 1})`,
    );
    // and the whole cycle makes exactly the two listing calls of the new
    // structure: the derivation's and the late re-check — the old settle
    // loop's retries are gone
    const listingCalls = harness.calls.filter((c) => c === "GET repos/Sanmoo/sim-repo/issues").length;
    assert.equal(listingCalls, 2, "exactly derive + the late re-check consult the listing");
  });

  test("the adapter-side REST count of the cycle matches the budget's plan", async () => {
    await runSmokeCycle(harness, harness.getAdapter());
    assert.equal(
      harness.calls.length,
      CYCLE_ADAPTER_REST_CALLS,
      "the cycle's adapter calls = the sim-verified breakdown (see github-smoke.ts PLANNED_REST_CALLS)",
    );
  });

  test("a stale late listing is reported as environmental lag, never a failure", async () => {
    const seeded: Candidate = {
      ref: { repo: harness.repo, number: 100 },
      title: "msf t16 smoke: full cycle",
      createdAt: new Date().toISOString(),
    };
    const staleListing = {
      listCandidates: async () => [seeded],
    } as unknown as TrackerPort;
    const proof = await recheckLateCandidates(staleListing, harness.repo, seeded.ref);
    assert.equal(proof.sawIssue, true, "the stale listing still carries the (closed) issue");
    assert.equal(proof.converged, false);
    assert.match(proof.note, /verified via direct reads/);
    assert.match(proof.note, /listing lag observed \(environmental\)/);
  });

  test("the converged note names the live proof explicitly", async () => {
    const ref: IssueRef = { repo: harness.repo, number: 100 };
    const emptyListing = {
      listCandidates: async () => [] as Candidate[],
    } as unknown as TrackerPort;
    const proof = await recheckLateCandidates(emptyListing, harness.repo, ref);
    assert.equal(proof.sawIssue, false);
    assert.equal(proof.converged, true);
    assert.match(proof.note, /FULLY PROVEN LIVE/);
  });
});
