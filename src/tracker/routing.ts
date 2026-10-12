import type { IssueRef, TrackerPort, TrackerScope } from "./port.js";

// One instance can mix trackers (GitHub repositories and Jira projects). The admission talks to
// a single TrackerPort; this router sends each call to the adapter configured for the scope of
// the issue. An unconfigured scope is an error: the router never falls back to another tracker.

export interface TrackerRoute {
  tracker: IssueRef["tracker"];
  // GitHub repository or Jira project key, as it appears in IssueRef.project.
  project: string;
  port: TrackerPort;
}

const scopeKey = (tracker: string, project: string): string => `${tracker}:${project}`;

export function routeTrackers(routes: readonly TrackerRoute[]): TrackerPort {
  const byScope = new Map<string, TrackerPort>();
  for (const route of routes) {
    const key = scopeKey(route.tracker, route.project);
    if (byScope.has(key)) throw new Error(`tracker duplicado para ${key}`);
    byScope.set(key, route.port);
  }
  const forRef = (ref: IssueRef): TrackerPort => {
    const port = byScope.get(scopeKey(ref.tracker, ref.project));
    if (!port) throw new Error(`nenhum tracker configurado para ${scopeKey(ref.tracker, ref.project)}`);
    return port;
  };
  // A discovery scope names only the project: a GitHub repository (owner/repo) and a Jira key never collide.
  const forScope = (scope: TrackerScope): TrackerPort => {
    const matches = [...byScope.entries()].filter(([key]) => key.slice(key.indexOf(":") + 1) === scope.project);
    if (matches.length !== 1) throw new Error(`nenhum tracker configurado para o escopo ${scope.project}`);
    return matches[0]![1];
  };
  return {
    claimMarkOf: (ref) => forRef(ref).claimMarkOf(ref),
    discoverCandidates: async (scope) => forScope(scope).discoverCandidates(scope),
    readIssue: async (ref) => forRef(ref).readIssue(ref),
    claim: async (ref) => forRef(ref).claim(ref),
    releaseClaim: async (ref) => forRef(ref).releaseClaim(ref),
    readComments: async (ref) => forRef(ref).readComments(ref),
    postComment: async (ref, body) => forRef(ref).postComment(ref, body),
    markDone: async (ref) => forRef(ref).markDone(ref),
  };
}
