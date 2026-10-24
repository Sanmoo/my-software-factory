import assert from "node:assert/strict";
import { describe, test, beforeEach } from "node:test";

import { runGitHubOnlySuite, runGitHubContractSuite } from "./github-contract-suite.js";
import { SimulatedRepoHarness } from "./github-sim-harness.js";
import {
  CYCLE_ADAPTER_REST_CALLS,
  recheckLateOpenIssues,
  runSmokeCycle,
} from "./smoke-cycle.js";
import type { IssueRef, OpenIssue, TrackerPort } from "./port.js";

/**
 * The proof the fake cannot give: the REAL GitHub adapter satisfying
 * the SAME port contract suite, offline — the gh/process boundary is the
 * in-memory REST simulator (`github-sim.ts`). The command-line shapes are
 * asserted separately in `github-adapter.test.ts`; here what is proven is the
 * adapter's BEHAVIOR: REST payloads go in, port results come out, writes land
 * in the (simulated) repo state.
 */

runGitHubContractSuite(new SimulatedRepoHarness());
runGitHubOnlySuite(new SimulatedRepoHarness());

// ---- the smoke's full cycle, offline over the sim ----
//
// The REAL adapter runs the smoke's OWN flow (the full cycle) against the
// simulated repo: eligibility proven by DIRECT reads right after seeding
// (no settle wait — listings lag, direct GETs never do), and ONE non-blocking
// open-issues() re-check after the cycle's last operation (the listing's live
// proof; by then it has had the whole cycle to converge). The smoke's REST
// accounting is asserted here too: the adapter-side count is the sim-proof
// of the planned-call breakdown the budget gate is built on.

describe("the smoke's full cycle — the real adapter over the sim", () => {
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
    const seeded: OpenIssue = {
      ref: { repo: harness.repo, number: 100 },
      title: "msf t16 smoke: full cycle",
      createdAt: new Date().toISOString(),
      labels: [],
      assignees: [],
      hasOpenPr: false,
    };
    const staleListing = {
      listOpenIssues: async () => [seeded],
    } as unknown as TrackerPort;
    const proof = await recheckLateOpenIssues(staleListing, harness.repo, seeded.ref);
    assert.equal(proof.sawIssue, true, "the stale listing still carries the (closed) issue");
    assert.equal(proof.converged, false);
    assert.match(proof.note, /verified via direct reads/);
    assert.match(proof.note, /listing lag observed \(environmental\)/);
  });

  test("the converged note names the live proof explicitly", async () => {
    const ref: IssueRef = { repo: harness.repo, number: 100 };
    const emptyListing = {
      listOpenIssues: async () => [] as OpenIssue[],
    } as unknown as TrackerPort;
    const proof = await recheckLateOpenIssues(emptyListing, harness.repo, ref);
    assert.equal(proof.sawIssue, false);
    assert.equal(proof.converged, true);
    assert.match(proof.note, /FULLY PROVEN LIVE/);
  });
});
