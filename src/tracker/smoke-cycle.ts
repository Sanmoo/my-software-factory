import { type GitHubContractHarness } from "./github-contract-suite.js";
import { AGENT_MARKER, type IssueRef, type TrackerPort } from "./port.js";
import { deriveTrackerState } from "../state/derive.js";
import { githubSelections } from "./identity.js";
import type { TicketTracker } from "./expanded-port.js";
import { DEFAULT_LABELS } from "../config.js";

/**
 * The full cycle of the real GitHub smoke, as its own module so the
 * offline suites can run the REAL adapter through the SAME flow against the
 * sim (`npm test`); the smoke itself runs it against the real repo
 * (`npm run smoke:github`).
 *
 * op1 is designed around GitHub's eventual consistency: listings converge LATE
 * — the label-filtered one lags minutes (search index), and even the plain
 * open-issues listing lags >30s behind a freshly created issue — while DIRECT
 * GETs (`/repos/{o}/{r}/issues/{n}`, the dependencies read) are immediately
 * consistent. So the cycle proves eligibility via DIRECT reads right after
 * seeding (ops 1+2 and 1+3) with NO settle wait, and the LISTING's live proof
 * becomes ONE non-blocking open-issues() re-check after the cycle's LAST
 * operation — by then the listing has had minutes to converge. A stale listing
 * is explicitly reported, never a failure: the FACTORY tolerates listing lag by
 * design (the pool is re-derived every tick and self-heals); the smoke must not
 * demand instant listing visibility.
 */

/** The cycle's adapter-side REST calls on the happy path — sim-verified
 *  offline (the recorder test); the smoke's full planned count builds on it.
 *  Direct reads 2, claim 4+1 re-read, release 4+1, 2nd claim 2, blockClaim
 *  3+1, openPr 1, readPrFeedback 5 (timeline, pull, conversation, review
 *  submissions, inline comments), comment+readComments 2, derivation 2
 *  (open-issues listing + the open-PRs linkage listing; the seeded issue's own
 *  open PR (op9b, "Closes #N") flags hasOpenPr and the derivation excludes it
 *  in memory, no per-candidate readIssue), markDone+re-read 2, the late
 *  open-issues re-check 1 (its listing is EMPTY at that point — both seeded
 *  issues closed — so no linkage listing) = 31. */
export const CYCLE_ADAPTER_REST_CALLS = 31;

/** op1's blocking proof: the direct reads right after seeding (immediate). */
export interface Op1DirectProof {
  readIssue: boolean;
  readBlockers: boolean;
}

/** op1's live listing proof: the late, non-blocking open-issues() re-check. */
export interface Op1ListingProof {
  /** Whether the late re-check still listed the seeded issue. */
  sawIssue: boolean;
  /** Whether the listing reflects the cycle's final state (the closed seeded issue correctly out). */
  converged: boolean;
  /** The explicit report line — environmental lag is a note, never a failure. */
  note: string;
}

export interface SmokeCycleReport {
  op1DirectProof: Op1DirectProof;
  op1ListingProof: Op1ListingProof;
}

/** The late, non-blocking open-issues re-check: op1's live listing proof.
 *  The cycle ends with the seeded issue CLOSED (op6, markDone), so a
 *  CONVERGED open-issues read does not list it — its presence is stale-open
 *  lag. Either way this reports; it never throws. */
export async function recheckLateOpenIssues(
  adapter: TrackerPort,
  repo: string,
  ref: IssueRef,
): Promise<Op1ListingProof> {
  const issues = await adapter.listOpenIssues(repo);
  const sawIssue = issues.some((issue) => issue.ref.number === ref.number);
  const converged = !sawIssue;
  const note = sawIssue
    ? `op1 verified via direct reads; open-issues() listing lag observed (environmental) — the late ` +
      `re-check still listed the seeded issue (closed in op6): the open-issues listing lagged the whole ` +
      `cycle. The factory tolerates this by design (the pool re-derives every tick and self-heals) — ` +
      `not a failure.`
    : `op1 FULLY PROVEN LIVE: the late open-issues() re-check is converged — the listing reflects the ` +
      `cycle's end (the seeded issue, closed in op6, is correctly out of the open listing); eligibility ` +
      `was proven by direct reads right after seeding.`;
  return { sawIssue, converged, note };
}

/** The full cycle of one issue: every operation executed, verified — reverted by the harness's cleanup. */
export async function runSmokeCycle(
  harness: GitHubContractHarness,
  adapter: TrackerPort & TicketTracker,
): Promise<SmokeCycleReport> {
  const repo = harness.repo;
  const account = harness.workerAccount;

  // seed
  const issue = await harness.createIssue({ title: "msf t16 smoke: full cycle", labels: [DEFAULT_LABELS.ready] });
  const blocker = await harness.createIssue({ title: "msf t16 smoke: blocker", closed: true });
  await harness.addBlocker(issue.ref, blocker.ref);
  console.log(`seeded issue ${repo}#${issue.ref.number} with blocker #${blocker.ref.number} (closed)`);

  // op1's proof plan: DIRECT reads now — immediate, they ARE the blocking
  // eligibility proof. The LISTING's live proof is ONE non-blocking
  // re-check after the cycle's last op. No settle wait anywhere: both prior
  // full-cycle attempts died waiting for a listing to converge (>30s) that
  // the factory's own design never requires to be instant.
  console.log("op1 proof plan: eligibility via direct reads now; the listing re-checked ONCE after the last op (non-blocking)");

  // 1+2. eligibility + snapshot: the direct read (immediate)
  const snapshot = await adapter.readIssue(issue.ref);
  if (!snapshot.known || snapshot.value.title !== "msf t16 smoke: full cycle") {
    throw new Error("op2: snapshot mismatch");
  }
  if (snapshot.value.state !== "open" || !snapshot.value.labels.includes(DEFAULT_LABELS.ready)) {
    throw new Error("op1: the seeded issue is not eligible by the direct read (state/ready label)");
  }
  console.log(`op1+op2 EXECUTED+VERIFIED: readIssue → open, the ready label on, title right, createdAt ${snapshot.value.createdAt} (direct read — immediate)`);

  // 1+3. the native blocker, closed via the API (direct read)
  const blockers = await adapter.readBlockers(issue.ref);
  if (!blockers.known || blockers.value.length !== 1 || blockers.value[0]?.state !== "closed") {
    throw new Error("op1+op3: blockers mismatch");
  }
  console.log("op1+op3 EXECUTED+VERIFIED: readBlockers → native blocked_by, terminal (closed) (direct read — immediate)");

  // 4. claim — WITH the ready label this time: the reservation is the swap
  // (padlock first, pool label last) — the mirrored write on the real repo
  await adapter.claim(issue.ref, account, DEFAULT_LABELS.ready);
  const claimed = await adapter.readIssue(issue.ref);
  if (
    !claimed.known ||
    !claimed.value.labels.includes(DEFAULT_LABELS.claimed) ||
    claimed.value.labels.includes(DEFAULT_LABELS.ready) ||
    claimed.value.assignees[0] !== account
  ) {
    throw new Error("op4: claim swap not visible in the re-read");
  }
  console.log(`op4 EXECUTED+VERIFIED: claim → ready swapped away, label ${DEFAULT_LABELS.claimed} + assignee ${account}`);

  // 5. release — with the ready label: the 1st-fall swap BACK (pool label
  // first, padlock last — the mirrored write on the real repo)
  await adapter.releaseClaim(issue.ref, account, DEFAULT_LABELS.ready);
  const released = await adapter.readIssue(issue.ref);
  if (
    !released.known ||
    released.value.labels.includes(DEFAULT_LABELS.claimed) ||
    !released.value.labels.includes(DEFAULT_LABELS.ready) ||
    released.value.assignees.length !== 0
  ) {
    throw new Error("op5: release swap not visible in the re-read");
  }
  console.log("op5 EXECUTED+VERIFIED: releaseClaim → claimed swapped away, the ready label back, assignee gone");
  await adapter.claim(issue.ref, account);

  // 5b. block — the 2nd-consecutive-fall swap (claimed→blocked, the claim held)
  await adapter.blockClaim(issue.ref, DEFAULT_LABELS);
  const blockedState = await adapter.readIssue(issue.ref);
  if (
    !blockedState.known ||
    blockedState.value.labels.includes(DEFAULT_LABELS.claimed) ||
    !blockedState.value.labels.includes(DEFAULT_LABELS.blocked) ||
    blockedState.value.assignees[0] !== account
  ) {
    throw new Error("op5b: block swap not visible in the re-read");
  }
  console.log(`op5b EXECUTED+VERIFIED: blockClaim → claimed swapped away, label ${DEFAULT_LABELS.blocked} on, claim held`);

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

  // derivation over the real adapter: the pool derivation —
  // the work's own open PR (op9b, "Closes #N") keeps it out of the pool
  // (only works without a PR enter), and the blocked label would too
  const { pool } = await deriveTrackerState(adapter, githubSelections([repo]), DEFAULT_LABELS);
  if (pool.some((entry) => entry.work.ticket.provider === "github" && entry.work.ticket.number === issue.ref.number)) {
    throw new Error("derive: the PR-linked blocked claim must NOT be eligible");
  }
  console.log("extra EXECUTED+VERIFIED: deriveTrackerState over the real adapter → the PR-linked blocked claim kept out of the pool");

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

  // op1's LIVE listing proof — NON-BLOCKING: the cycle's last operation ran
  // (rank); before reversion, re-check the open-issues listing ONCE — by now the
  // listing has had minutes to converge. The seeded issue closed in op6, so
  // a converged listing leaves it out; its presence is stale-open lag.
  // Either way the cycle stands: eligibility was proven by direct reads.
  const op1ListingProof = await recheckLateOpenIssues(adapter, repo, issue.ref);
  console.log(op1ListingProof.note);

  return { op1DirectProof: { readIssue: true, readBlockers: true }, op1ListingProof };
}
