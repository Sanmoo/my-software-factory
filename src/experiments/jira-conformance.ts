import { coreRules, evaluateEligibility, type Rejection } from "../core/eligibility.js";
import { jiraEligibilityRules } from "../tracker/jira-rules.js";
import {
  JiraTracker,
  jiraConnectionFromEnv,
  jiraRequest,
  type JiraConnection,
  type JiraTrackerSettings,
} from "../tracker/jira.js";
import type { IssueRef, IssueSnapshot } from "../tracker/port.js";
import { postFactoryComment } from "../core/markers.js";

// Live conformance of the Jira TrackerPort adapter (ticket #5), against the VAN project.
//
//   npm run conformance:jira            read-only checks on real VAN issues; zero writes
//   npm run conformance:jira -- --write write checks on two [msf-test] issues created
//                                        outside any sprint (the only writes allowed)
//
// Optional: --done NAME (done transition, otherwise the single done transition found),
// --doing NAME (default "Em andamento"), --link-type NAME (default "Blocks"),
// --test-issues BLOCKED:BLOCKER (reuse two existing [msf-test] issues instead of creating them).
// Credentials come only from JIRA_URL, JIRA_USERNAME and JIRA_API_TOKEN and are never printed.

const PROJECT = "VAN";
const READY = "ready-for-agent";
const CLAIMED = "agent-claimed";
const TEST_PREFIX = "[msf-test]";
const TEST_LABEL = "playbooks";

// VAN routing labels and the repository each one maps to.
const ROUTING: Record<string, string> = {
  monolith: "bancojohndeere/revolving-credit-monolith-backend",
  "dealer-services": "bancojohndeere/revolving-credit-dealer-services",
  mfe: "bancojohndeere/revolving-credit-mfe",
  fdm: "bancojohndeere/revolving-credit-fiscal-document-management",
  "common-infra": "bancojohndeere/revolving-credit-products-common-infra",
  "lambda-auth": "bancojohndeere/revolving-credit-multi-issuer-lambda-authorizer",
  playbooks: "bancojohndeere/revolving-credit-playbooks",
};
const ROUTING_LABELS = Object.keys(ROUTING);

const SEARCH_PATH = "/rest/api/3/search/jql";
const WRITE_MODE = process.argv.includes("--write");

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

// Writes are checked before they leave the process: read mode allows none, write mode
// allows creating issues, linking two of them, and writing to issues created in this run.
const writes: string[] = [];
const createdKeys = new Set<string>();

function allowedWrite(method: string, path: string, body: unknown): boolean {
  if (!WRITE_MODE) return false;
  if (method === "POST" && path === "/rest/api/3/issue") return true;
  if (method === "POST" && path === "/rest/api/3/issueLink") {
    const link = body as { inwardIssue?: { key?: string }; outwardIssue?: { key?: string } };
    return [link.inwardIssue?.key, link.outwardIssue?.key].every((key) => key !== undefined && createdKeys.has(key));
  }
  const issuePath = /^\/rest\/api\/3\/issue\/([^/]+)(\/transitions|\/comment)?$/.exec(path);
  return issuePath !== null && createdKeys.has(issuePath[1]) && (method === "PUT" || method === "POST");
}

function installWriteGuard(): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const isRead = method === "GET" || (method === "POST" && url.pathname === SEARCH_PATH);
    if (!isRead) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (!allowedWrite(method, url.pathname, body)) {
        throw new Error(`escrita fora do escopo autorizado: ${method} ${url.pathname}`);
      }
      writes.push(`${method} ${url.pathname}`);
    }
    return original(input, init);
  }) as typeof fetch;
}

function log(step: string, detail: unknown): void {
  console.log(`[${step}] ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`conformidade falhou: ${message}`);
}

const reference = (id: string): IssueRef => ({ tracker: "jira", project: PROJECT, id });

function settingsFor(doing: string, done: string, linkType: string): JiraTrackerSettings {
  return { claimedLabel: CLAIMED, doingTransition: doing, doneTransition: done, blockingLinkTypes: [linkType] };
}

function describeBlockers(snapshot: IssueSnapshot): string {
  if (!snapshot.blockers.known) return `desconhecido (${snapshot.blockers.reason})`;
  return snapshot.blockers.value
    .map((blocker) => `${blocker.ref.id}:${blocker.terminal.known ? (blocker.terminal.value ? "terminal" : "não terminal") : "desconhecido"}`)
    .join(", ") || "nenhum";
}

function routeOf(snapshot: IssueSnapshot): { label: string | null; repository: string | null; matched: string[] } {
  const labels = snapshot.labels.known ? snapshot.labels.value : [];
  const matched = labels.filter((label) => ROUTING_LABELS.includes(label));
  const label = matched.length === 1 ? matched[0] : null;
  return { label, repository: label ? ROUTING[label] : null, matched };
}

// Eligibility of one VAN issue under the core rules plus the Jira rules of the operator.
function verdictOf(snapshot: IssueSnapshot, operator: string): Rejection[] {
  const route = routeOf(snapshot);
  const verdict = evaluateEligibility(
    {
      project: {
        enabled: true,
        readyLabel: READY,
        routing: { kind: "label", routingLabel: route.label ?? "", knownLabels: ROUTING_LABELS },
      },
      issue: snapshot,
      tracked: new Set(),
    },
    [...coreRules, ...jiraEligibilityRules(operator)],
  );
  return verdict.eligible ? [] : verdict.rejections;
}

async function operatorAccount(connection: JiraConnection): Promise<string> {
  const me = await jiraRequest<{ accountId: string }>(connection, "GET", "/rest/api/3/myself");
  check(me !== undefined, "conta do operador não resolvida por JIRA_USERNAME");
  return me?.accountId ?? "";
}

async function readOnly(connection: JiraConnection, settings: JiraTrackerSettings): Promise<void> {
  const operator = await operatorAccount(connection);
  log("operador", "conta de JIRA_USERNAME resolvida via /myself (accountId não impresso)");
  const tracker = new JiraTracker(connection, settings);
  const candidates = await tracker.discoverCandidates({ project: PROJECT, readyLabel: READY });
  log("candidatos", `${candidates.length} issues ${READY} em ${PROJECT}: ${candidates.map((ref) => ref.id).join(", ")}`);
  for (const label of ROUTING_LABELS) {
    const labelled = await tracker.discoverCandidates({ project: PROJECT, readyLabel: label });
    log("roteamento", `label ${label}: ${labelled.length} issues em ${PROJECT} (${ROUTING[label]})`);
  }
  for (const ref of candidates) {
    const snapshot = await tracker.readIssue(ref);
    const route = routeOf(snapshot);
    const rejections = verdictOf(snapshot, operator);
    log("issue", {
      key: ref.id,
      title: snapshot.title,
      labels: snapshot.labels.known ? snapshot.labels.value : snapshot.labels.reason,
      status: snapshot.statusCategory,
      claimed: snapshot.claimed,
      assignee: snapshot.assignee?.known ? (snapshot.assignee.value === operator ? "operador" : "outro/nenhum") : snapshot.assignee,
      openSprint: snapshot.openSprint,
      blockers: describeBlockers(snapshot),
      route: route.repository ?? `sem roteamento único (${route.matched.join(",") || "nenhum"})`,
      priority: snapshot.priority,
      eligible: rejections.length === 0,
      rejections: rejections.map((rejection) => `${rejection.rule}: ${rejection.reason}`),
    });
  }
  if (candidates.length > 0) {
    const transitions = await jiraRequest<{ transitions: Array<{ name: string; to: { statusCategory: { key: string } } }> }>(
      connection,
      "GET",
      `/rest/api/3/issue/${candidates[0].id}/transitions`,
    );
    log("transicoes", transitions?.transitions.map((t) => `${t.name} -> ${t.to.statusCategory.key}`) ?? []);
  }
  const linkTypes = await jiraRequest<{ issueLinkTypes: Array<{ name: string }> }>(connection, "GET", "/rest/api/3/issueLinkType");
  log("tipos de link", linkTypes?.issueLinkTypes.map((type) => type.name) ?? []);
}

async function issueTypeId(connection: JiraConnection): Promise<{ id: string; name: string }> {
  const project = await jiraRequest<{ issueTypes: Array<{ id: string; name: string; subtask: boolean }> }>(
    connection,
    "GET",
    `/rest/api/3/project/${PROJECT}`,
  );
  const types = (project?.issueTypes ?? []).filter((type) => !type.subtask);
  const chosen = types.find((type) => type.name === "Task" || type.name === "Tarefa") ?? types[0];
  check(chosen !== undefined, "nenhum tipo de issue não-subtarefa no projeto VAN");
  return chosen ?? { id: "", name: "" };
}

async function createTestIssue(connection: JiraConnection, operator: string, typeId: string, role: string): Promise<string> {
  const created = await jiraRequest<{ key: string }>(connection, "POST", "/rest/api/3/issue", {
    fields: {
      project: { key: PROJECT },
      issuetype: { id: typeId },
      summary: `${TEST_PREFIX} conformidade Jira (${role})`,
      labels: [TEST_LABEL, READY],
    },
  });
  check(created !== undefined, "criação da issue de teste sem resposta");
  const key = created?.key ?? "";
  createdKeys.add(key);
  await jiraRequest(connection, "PUT", `/rest/api/3/issue/${key}`, { fields: { assignee: { accountId: operator } } });
  return key;
}

async function writeChecks(
  connection: JiraConnection,
  linkType: string,
  doingName: string,
  doneOption: string | undefined,
  existing: { blocked: string; blocker: string } | undefined,
): Promise<void> {
  const operator = await operatorAccount(connection);
  const probe = new JiraTracker(connection, settingsFor(doingName, doneOption ?? "", linkType));

  let blocked: string;
  let blocker: string;
  if (existing) {
    ({ blocked, blocker } = existing);
    log("reutilizadas", { blocked, blocker });
  } else {
    const type = await issueTypeId(connection);
    log("tipo de issue", type.name);
    blocked = await createTestIssue(connection, operator, type.id, "bloqueada");
    blocker = await createTestIssue(connection, operator, type.id, "bloqueadora");
    log("criadas", { blocked, blocker });
  }
  // Only [msf-test] issues outside any sprint are written to; the guard allows nothing else.
  for (const key of [blocked, blocker]) {
    const snapshot = await probe.readIssue(reference(key));
    check(snapshot.title.startsWith(TEST_PREFIX), `${key} não é issue de teste`);
    check(snapshot.openSprint?.known === true && snapshot.openSprint.value === false, `${key} não está fora de sprint`);
    createdKeys.add(key);
  }
  log("fora de sprint", "ambas as issues de teste lidas com openSprint = false");

  const linked = await probe.readIssue(reference(blocked));
  if (!(linked.blockers.known && linked.blockers.value.some((b) => b.ref.id === blocker))) {
    // Payload: inwardIssue is the blocker (origin of "blocks"), outwardIssue the blocked issue.
    await jiraRequest(connection, "POST", "/rest/api/3/issueLink", {
      type: { name: linkType },
      inwardIssue: { key: blocker },
      outwardIssue: { key: blocked },
    });
    log("link", "criado com inwardIssue = bloqueadora, outwardIssue = bloqueada");
  } else {
    log("link", "já existente na direção bloqueada/bloqueadora");
  }
  const afterLink = await probe.readIssue(reference(blocked));
  check(afterLink.blockers.known && afterLink.blockers.value.some((b) => b.ref.id === blocker), "bloqueio não lido na issue bloqueada");
  const reverse = await probe.readIssue(reference(blocker));
  check(reverse.blockers.known && reverse.blockers.value.length === 0, "bloqueadora não deveria ser bloqueada");
  log("link", `${blocked} is blocked by ${blocker} (lido de ambos os lados)`);
  log("elegibilidade bloqueada antes", verdictOf(afterLink, operator).map((r) => `${r.rule}: ${r.reason}`));

  // The blocker goes first: claim, a second claim that must be refused, [msf] comment, done.
  check((await probe.claim(reference(blocker))).status === "accepted", "claim da bloqueadora não aceito");
  log("claim bloqueadora", "accepted; label agent-claimed e transição doing confirmadas por reread");
  const again = await probe.claim(reference(blocker));
  log("segundo claim bloqueadora", again);
  const transitionsAfterClaim = await jiraRequest<{ transitions: Array<{ name: string; to: { statusCategory: { key: string } } }> }>(
    connection,
    "GET",
    `/rest/api/3/issue/${blocker}/transitions`,
  );
  const doneCandidates = (transitionsAfterClaim?.transitions ?? []).filter((t) => t.to.statusCategory.key === "done").map((t) => t.name);
  log("transicoes done disponíveis", doneCandidates);
  const doneName = doneOption ?? (doneCandidates.length === 1 ? doneCandidates[0] : undefined);
  check(doneName !== undefined && doneCandidates.includes(doneName), "nome da transição done não confirmado");
  const tracker = new JiraTracker(connection, settingsFor(doingName, doneName ?? "", linkType));

  const commentId = await postFactoryComment(tracker, reference(blocker), "teste de conformidade do adapter Jira");
  const comments = await tracker.readComments(reference(blocker));
  const posted = comments.find((comment) => comment.id === commentId);
  check(posted !== undefined && posted.body.startsWith("[msf]"), "comentário [msf] não lido de volta");
  log("comentario", { id: commentId, prefixOk: true, readBack: true });

  log("done bloqueadora", await tracker.markDone(reference(blocker)));
  log("done bloqueadora (repetido)", await tracker.markDone(reference(blocker)));

  const unblocked = await tracker.readIssue(reference(blocked));
  check(unblocked.blockers.known && unblocked.blockers.value.every((b) => b.terminal.known && b.terminal.value), "bloqueio não ficou terminal");
  log("elegibilidade bloqueada depois", verdictOf(unblocked, operator).map((r) => `${r.rule}: ${r.reason}`));

  check((await tracker.claim(reference(blocked))).status === "accepted", "claim da bloqueada não aceito");
  log("claim bloqueada", "accepted");
  await postFactoryComment(tracker, reference(blocked), "teste de conformidade do adapter Jira");
  log("done bloqueada", await tracker.markDone(reference(blocked)));
  log("done bloqueada (repetido)", await tracker.markDone(reference(blocked)));

  const finalStates = await Promise.all([blocked, blocker].map((key) => tracker.readIssue(reference(key))));
  log("estados finais", finalStates.map((s) => ({ key: s.ref.id, status: s.statusCategory, claimed: s.claimed })));
  log("escritas realizadas", writes);
}

async function main(): Promise<void> {
  const connection = jiraConnectionFromEnv();
  installWriteGuard();
  const linkType = option("--link-type") ?? "Blocks";
  const doing = option("--doing") ?? "Em andamento";
  log("modo", WRITE_MODE ? "write" : "read");
  if (WRITE_MODE) {
    const pair = option("--test-issues")?.split(":");
    const existing = pair?.length === 2 ? { blocked: pair[0], blocker: pair[1] } : undefined;
    await writeChecks(connection, linkType, doing, option("--done"), existing);
  } else {
    await readOnly(connection, settingsFor(doing, option("--done") ?? "", linkType));
    log("escritas realizadas", writes.length);
  }
}

main().catch((error: unknown) => {
  console.error(`falha: ${(error as Error).message}`);
  process.exitCode = 1;
});
