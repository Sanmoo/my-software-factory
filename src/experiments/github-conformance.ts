// Conformance check of the GitHub Issues adapter.
//
// Creates ONE disposable "[msf-test] conformance <date>" issue and ONE disposable
// "[msf-test] blocker <date>" issue in Sanmoo/my-software-factory, exercises the
// tracker port against them, and closes both as completed. A guard refuses any write
// to an issue number other than the two created here, so no other issue is touched.
//
// Run (creates and closes two issues; requires explicit confirmation):
//   npx tsx src/experiments/github-conformance.ts --confirm
//
// Tokens are read by the adapter boundary (gh auth token --user ACCOUNT) and are never
// printed; the report contains issue numbers, outcomes and REST paths only.

import { coreRules, evaluateEligibility } from "../core/eligibility.js";
import { postFactoryComment } from "../core/markers.js";
import {
  createGhCliBoundary,
  GitHubTracker,
  type GitHubBoundary,
  type GitHubRequest,
  type GitHubResponse,
} from "../tracker/github.js";
import type { IssueRef, IssueSnapshot } from "../tracker/port.js";

const REPO = "Sanmoo/my-software-factory";
const ACCOUNT = "Sanmoo";
const READY_LABEL = "ready-for-agent";
const CLAIMED_LABEL = "agent-claimed";
const MARKER = "<!-- msf:agent -->";

interface WriteRecord {
  method: string;
  path: string;
  status: number;
}

function guarded(inner: GitHubBoundary, allowed: Set<number>, writes: WriteRecord[]): GitHubBoundary {
  return {
    accountToken: (account) => inner.accountToken(account),
    async api(request: GitHubRequest, token: string): Promise<GitHubResponse> {
      const number = /\/issues\/(\d+)/.exec(request.path)?.[1];
      if (request.method !== "GET" && number !== undefined && !allowed.has(Number(number))) {
        throw new Error(`escrita recusada fora das issues descartáveis: #${number}`);
      }
      const response = await inner.api(request, token);
      if (request.method !== "GET") writes.push({ method: request.method, path: request.path, status: response.status });
      return response;
    },
  };
}

function ref(id: number): IssueRef {
  return { tracker: "github", project: REPO, id: String(id) };
}

async function createIssue(boundary: GitHubBoundary, token: string, title: string, labels: string[]): Promise<number> {
  const response = await boundary.api({
    method: "POST",
    path: `repos/${REPO}/issues`,
    body: { title, body: "Issue descartável do teste de conformidade do adapter GitHub (t04).", labels },
  }, token);
  if (response.status !== 201 || typeof response.body !== "object" || response.body === null) {
    throw new Error(`criação da issue descartável falhou (HTTP ${response.status})`);
  }
  return (response.body as { number: number }).number;
}

async function main(): Promise<void> {
  if (!process.argv.includes("--confirm")) {
    console.error("Recusado: o teste cria e fecha duas issues em " + REPO + ". Rode com --confirm.");
    process.exitCode = 2;
    return;
  }

  const date = new Date().toISOString().slice(0, 10);
  const allowed = new Set<number>();
  const writes: WriteRecord[] = [];
  const steps: Array<{ step: string; outcome: string }> = [];
  const boundary = guarded(createGhCliBoundary(), allowed, writes);
  const token = await boundary.accountToken(ACCOUNT);
  const tracker = new GitHubTracker({ account: ACCOUNT, claimedLabel: CLAIMED_LABEL, boundary });
  const scope = { project: REPO, readyLabel: READY_LABEL };
  const eligible = (issue: IssueSnapshot) =>
    evaluateEligibility({ project: { enabled: true, readyLabel: READY_LABEL, routing: { kind: "repository" } }, issue, tracked: new Set() }, coreRules);

  let subject = 0;
  let blocker = 0;
  let failure: unknown;
  try {
    subject = await createIssue(boundary, token, `[msf-test] conformance ${date}`, [READY_LABEL]);
    allowed.add(subject);
    blocker = await createIssue(boundary, token, `[msf-test] blocker ${date}`, []);
    allowed.add(blocker);
    steps.push({ step: "criar issues descartáveis", outcome: `#${subject} (conformance), #${blocker} (blocker)` });

    const found = await tracker.discoverCandidates(scope);
    steps.push({ step: "discoverCandidates", outcome: `inclui #${subject}: ${found.some((r) => r.id === String(subject))}; candidatos lidos: ${found.length}` });

    const fresh = await tracker.readIssue(ref(subject));
    steps.push({ step: "readIssue antes do claim", outcome: `claimed=${JSON.stringify(fresh.claimed)} elegível=${eligible(fresh).eligible}` });

    await tracker.addBlockedBy(ref(subject), ref(blocker));
    const blocked = await tracker.readIssue(ref(subject));
    steps.push({ step: "addBlockedBy (native blocked_by aberto)", outcome: `blockers=${JSON.stringify(blocked.blockers)} elegível=${eligible(blocked).eligible}` });

    await tracker.removeBlockedBy(ref(subject), ref(blocker));
    const unblocked = await tracker.readIssue(ref(subject));
    steps.push({ step: "removeBlockedBy", outcome: `blockers=${JSON.stringify(unblocked.blockers)} elegível=${eligible(unblocked).eligible}` });

    steps.push({ step: "claim", outcome: JSON.stringify(await tracker.claim(ref(subject))) });
    steps.push({ step: "claim repetido", outcome: JSON.stringify(await tracker.claim(ref(subject))) });
    const claimed = await tracker.readIssue(ref(subject));
    steps.push({ step: "readIssue após claim", outcome: `claimed=${JSON.stringify(claimed.claimed)} assignees=${JSON.stringify(claimed.assignees)} labels=${JSON.stringify(claimed.labels)}` });

    await tracker.releaseClaim(ref(subject));
    const released = await tracker.readIssue(ref(subject));
    steps.push({ step: "releaseClaim", outcome: `claimed=${JSON.stringify(released.claimed)} state=open assignees=${JSON.stringify(released.assignees)}` });

    steps.push({ step: "claim novamente", outcome: JSON.stringify(await tracker.claim(ref(subject))) });

    const commentId = await postFactoryComment(tracker, ref(subject), `conformidade t04 ${date}`);
    const comments = await tracker.readComments(ref(subject));
    const posted = comments.find((comment) => comment.id === commentId);
    steps.push({
      step: "postComment + readComments",
      outcome: `id=${commentId} autor=${posted?.author} isBot=${posted?.isBot} marcador=${posted?.body.includes(MARKER)} total=${comments.length}`,
    });

    steps.push({ step: "markDone", outcome: JSON.stringify(await tracker.markDone(ref(subject))) });
    steps.push({ step: "markDone repetido", outcome: JSON.stringify(await tracker.markDone(ref(subject))) });
    steps.push({ step: "markDone do bloqueador", outcome: JSON.stringify(await tracker.markDone(ref(blocker))) });
  } catch (error) {
    failure = error;
  } finally {
    for (const number of [subject, blocker]) {
      if (number === 0) continue;
      try {
        await tracker.markDone(ref(number));
      } catch (error) {
        failure ??= error;
      }
    }
  }

  const touched = [...new Set(writes.map((write) => /\/issues\/(\d+)/.exec(write.path)?.[1] ?? "create"))];
  const report = {
    repo: REPO,
    account: ACCOUNT,
    disposable: { conformance: subject || null, blocker: blocker || null },
    result: failure === undefined ? "passed" : "failed",
    failure: failure instanceof Error ? failure.message : failure ?? null,
    steps,
    writes,
    touchedIssues: touched,
  };
  console.log(JSON.stringify(report, null, 2));
  if (failure !== undefined) process.exitCode = 1;
}

await main();
