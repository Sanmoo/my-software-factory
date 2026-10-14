import { coreRules, unknownReason, type EligibilityRule } from "./eligibility.js";

// Rules of the human-assisted attendance (spec #48). The extra authorization is the
// `human-assisted` label combined with exactly one human state; the human states alone do
// not authorize attendance. The applicable admission conditions stay: project enabled,
// unambiguous routing, no existing claim, no known blockers or dependencies, not terminal
// and not concurrently tracked by the factory. The autonomous ready rule is replaced and
// the Jira sprint/assignee rules do not apply: a human assignee never blocks attendance.

// The label that authorizes the human-assisted flow, and the states it attends.
export const HUMAN_ASSISTED_LABEL = "human-assisted";
export const HUMAN_STATES = ["needs-triage", "needs-info", "ready-for-human"] as const;
export type HumanState = (typeof HUMAN_STATES)[number];

// The human states an issue currently carries, in the vocabulary's order. More than one is
// a contradiction the authorization rule reports; the caller shows what it sees.
export function humanStatesIn(labels: readonly string[]): HumanState[] {
  return HUMAN_STATES.filter((state) => labels.includes(state));
}

// The authorized combination: `human-assisted` present, exactly one human state, and no
// autonomous ready label on the same issue. Every contradiction found is reported, so the
// operator sees the whole mixed state; unknown labels are never absence of contradiction.
export const authorizationRule: EligibilityRule = {
  name: "authorization",
  check: ({ issue, project }) => {
    if (!issue.labels.known) {
      return { ok: false, reason: unknownReason("labels", issue.labels) };
    }
    const labels = issue.labels.value;
    const reasons: string[] = [];
    if (!labels.includes(HUMAN_ASSISTED_LABEL)) {
      reasons.push(`sem autorização (label ${HUMAN_ASSISTED_LABEL} ausente)`);
    }
    const states = humanStatesIn(labels);
    if (states.length === 0) {
      reasons.push(`sem estado humano (nenhum de ${HUMAN_STATES.join(", ")})`);
    } else if (states.length > 1) {
      reasons.push(`estados humanos contraditórios (${states.join(", ")})`);
    }
    if (labels.includes(project.readyLabel)) {
      reasons.push(`mistura com o fluxo autônomo (${project.readyLabel})`);
    }
    return reasons.length === 0 ? { ok: true } : { ok: false, reason: reasons.join("; ") };
  },
};

// The rules of the assisted diagnosis: the core conditions the assisted flow keeps, plus the
// assisted authorization in the place of the autonomous ready rule. Jira-specific rules are
// never inserted here: attendance is not implementation, so sprint and operator do not gate it.
export const assistedRules: readonly EligibilityRule[] = [
  ...coreRules.filter((rule) => rule.name === "enabled"),
  authorizationRule,
  ...coreRules.filter((rule) => ["routing", "not-claimed", "no-blockers", "not-terminal", "not-tracked"].includes(rule.name)),
];
