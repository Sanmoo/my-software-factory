import type { EligibilityRule } from "../core/eligibility.js";

// Jira-only eligibility rules: the issue must be in the open sprint and assigned to
// the operator. They are a pluggable set added on top of the core rules for Jira
// projects; GitHub projects do not use them. Unknown values reject.
export function jiraEligibilityRules(operator: string): EligibilityRule[] {
  return [
    {
      name: "sprint-atual",
      check: ({ issue }) => {
        if (issue.openSprint === undefined) return { ok: false, reason: "sprint não lida" };
        if (!issue.openSprint.known) return { ok: false, reason: `sprint desconhecida: ${issue.openSprint.reason}` };
        return issue.openSprint.value ? { ok: true } : { ok: false, reason: "fora da sprint atual" };
      },
    },
    {
      name: "assignee-operador",
      check: ({ issue }) => {
        if (issue.assignee === undefined) return { ok: false, reason: "atribuição não lida" };
        if (!issue.assignee.known) return { ok: false, reason: `atribuição desconhecida: ${issue.assignee.reason}` };
        return issue.assignee.value === operator
          ? { ok: true }
          : { ok: false, reason: "não atribuída ao operador" };
      },
    },
  ];
}
