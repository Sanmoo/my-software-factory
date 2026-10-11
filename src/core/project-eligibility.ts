import type { TrackerScope } from "../tracker/port.js";
import type { EligibilityProject, EligibilityRule } from "./eligibility.js";

// The eligibility setup of one configured project, as the core receives it: the tracker scope
// it is discovered in, its routing and the rules that apply. The core does not decide which
// rules a project gets; the configuration layer builds this (see config/project-eligibility.ts).
export interface ProjectEligibility {
  scope: TrackerScope;
  project: EligibilityProject;
  rules: readonly EligibilityRule[];
}
