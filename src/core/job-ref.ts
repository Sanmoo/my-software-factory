import { shortJob } from "./main-log.js";

// How the operator names a job: the full key (`github:owner/repo#13`) or the short reference the
// main log shows (`#13`, `PAY-7`). The short one is resolved against the jobs of the instance and
// never guessed: more than one match is refused, and the full keys are listed.

export type JobRefResolution =
  | { status: "found"; key: string }
  | { status: "none" }
  | { status: "ambiguous"; keys: string[] };

export function resolveJobRef(ref: string, keys: readonly string[]): JobRefResolution {
  if (keys.includes(ref)) return { status: "found", key: ref };
  const matches = keys.filter((key) => shortJob(key) === ref);
  if (matches.length === 1) return { status: "found", key: matches[0]! };
  return matches.length === 0 ? { status: "none" } : { status: "ambiguous", keys: matches };
}

// What a printed command names the job by: the short reference when the command will accept it
// for exactly this job, the full key otherwise.
export function refForCommand(key: string, keys: readonly string[]): string {
  const resolved = resolveJobRef(shortJob(key), keys.includes(key) ? keys : [...keys, key]);
  return resolved.status === "found" && resolved.key === key ? shortJob(key) : key;
}
