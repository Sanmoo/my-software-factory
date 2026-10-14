import { refKey, type IssueSnapshot, type Known } from "../tracker/port.js";

// Cumulative eligibility: every rule must hold, and every failing rule is reported.
// Unknown metadata rejects; it is never read as "absent" or "false".

export type Routing =
  | { kind: "repository" }
  | { kind: "label"; routingLabel: string; knownLabels: readonly string[] };

export interface EligibilityProject {
  enabled: boolean;
  readyLabel: string;
  routing: Routing;
}

export interface EligibilityInput {
  project: EligibilityProject;
  issue: IssueSnapshot;
  // Identity keys (see refKey) of issues already tracked by the script.
  tracked: ReadonlySet<string>;
}

export type RuleOutcome = { ok: true } | { ok: false; reason: string };

export interface EligibilityRule {
  name: string;
  check(input: EligibilityInput): RuleOutcome;
}

export interface Rejection {
  rule: string;
  reason: string;
}

export type Verdict = { eligible: true } | { eligible: false; rejections: Rejection[] };

export type Route =
  | { status: "repository" }
  | { status: "routed"; label: string }
  | { status: "unrouted" }
  | { status: "ambiguous"; labels: string[] };

const OK: RuleOutcome = { ok: true };
const fail = (reason: string): RuleOutcome => ({ ok: false, reason });
// `X desconhecido: motivo`: unknown metadata rejects, it is never absence of X. Exported so the
// assisted rules say it the same way.
export const unknownReason = (what: string, value: Known<unknown>): string =>
  value.known ? "" : `${what} desconhecido: ${value.reason}`;

// Routing comes only from labels, never from the title. A label counts as a routing
// label when it is one of the knownLabels of the tracker scope.
export function resolveRouting(labels: readonly string[], routing: Routing): Route {
  if (routing.kind === "repository") return { status: "repository" };
  const matched = labels.filter((label) => routing.knownLabels.includes(label));
  if (matched.length === 0) return { status: "unrouted" };
  if (matched.length > 1) return { status: "ambiguous", labels: matched };
  return { status: "routed", label: matched[0] };
}

export const coreRules: readonly EligibilityRule[] = [
  {
    name: "enabled",
    check: ({ project }) => (project.enabled ? OK : fail("projeto desabilitado")),
  },
  {
    name: "ready",
    check: ({ issue, project }) => {
      if (!issue.labels.known) return fail(unknownReason("labels", issue.labels));
      return issue.labels.value.includes(project.readyLabel)
        ? OK
        : fail(`sem label ${project.readyLabel}`);
    },
  },
  {
    name: "routing",
    check: ({ issue, project }) => {
      // A repository-routed project (GitHub) has nothing to resolve from labels.
      if (project.routing.kind === "repository") return OK;
      if (!issue.labels.known) return fail(unknownReason("labels", issue.labels));
      const route = resolveRouting(issue.labels.value, project.routing);
      if (route.status === "unrouted") return fail("sem roteamento");
      if (route.status === "ambiguous") return fail(`roteamento ambíguo (${route.labels.join(", ")})`);
      if (route.status === "routed" && route.label !== project.routing.routingLabel) {
        return fail(`roteada a outro projeto (${route.label})`);
      }
      return OK;
    },
  },
  {
    name: "not-claimed",
    check: ({ issue }) => {
      if (!issue.claimed.known) return fail(unknownReason("claim", issue.claimed));
      return issue.claimed.value ? fail("já claimed") : OK;
    },
  },
  {
    name: "no-blockers",
    check: ({ issue }) => {
      if (!issue.blockers.known) return fail(unknownReason("bloqueadores", issue.blockers));
      const problems = issue.blockers.value.flatMap(({ ref, terminal }) => {
        const label = `#${ref.id}`;
        if (!terminal.known) return [`estado de ${label} desconhecido: ${terminal.reason}`];
        return terminal.value ? [] : [`bloqueada por ${label} (não terminal)`];
      });
      return problems.length === 0 ? OK : fail(problems.join("; "));
    },
  },
  {
    name: "not-terminal",
    check: ({ issue }) => {
      if (!issue.statusCategory.known) return fail(unknownReason("status", issue.statusCategory));
      return issue.statusCategory.value === "done" ? fail("issue terminal (done)") : OK;
    },
  },
  {
    name: "not-tracked",
    check: ({ issue, tracked }) =>
      tracked.has(refKey(issue.ref)) ? fail("já acompanhada pelo script") : OK,
  },
];

export function evaluateEligibility(
  input: EligibilityInput,
  rules: readonly EligibilityRule[] = coreRules,
): Verdict {
  const rejections: Rejection[] = [];
  for (const rule of rules) {
    const outcome = rule.check(input);
    if (!outcome.ok) rejections.push({ rule: rule.name, reason: outcome.reason });
  }
  return rejections.length === 0 ? { eligible: true } : { eligible: false, rejections };
}
