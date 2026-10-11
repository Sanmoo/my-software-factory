import type { InstanceConfig, ProjectConfig } from "../config/types.js";
import type { TrackerScope } from "../tracker/port.js";
import { coreRules, type EligibilityProject, type EligibilityRule, type Routing } from "./eligibility.js";
import { jiraEligibilityRules } from "../tracker/jira-rules.js";

// Eligibility setup for one configured project: the tracker scope it is discovered in,
// its routing and the rules that apply. Shared by `status` and the admission.
export interface ProjectEligibility {
  scope: TrackerScope;
  project: EligibilityProject;
  rules: readonly EligibilityRule[];
}

// Routing labels are the ones configured for the same Jira project key in this instance.
function routingFor(instance: InstanceConfig, project: ProjectConfig): Routing {
  if (project.adapter === "github") return { kind: "repository" };
  const knownLabels = instance.projects.flatMap((other) =>
    other.adapter === "jira" && other.jira.projectKey === project.jira.projectKey ? [other.jira.routingLabel] : []);
  return { kind: "label", routingLabel: project.jira.routingLabel, knownLabels };
}

export function projectEligibility(instance: InstanceConfig, project: ProjectConfig): ProjectEligibility {
  const rules = project.adapter === "jira"
    ? [...coreRules, ...jiraEligibilityRules(project.jira.operator)]
    : coreRules;
  return {
    scope: {
      project: project.adapter === "github" ? project.repository : project.jira.projectKey,
      readyLabel: project.labels.ready,
    },
    project: { enabled: project.enabled, readyLabel: project.labels.ready, routing: routingFor(instance, project) },
    rules,
  };
}
