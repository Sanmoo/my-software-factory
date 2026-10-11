import assert from "node:assert/strict";
import test from "node:test";
import type { IssueRef, TrackerPort } from "../src/tracker/port.js";
import { routeTrackers } from "../src/tracker/routing.js";

// A tracker that only says which one answered.
const stub = (name: string): TrackerPort => {
  const answer = async (ref: IssueRef) => `${name}:${ref.id}`;
  return {
    discoverCandidates: async (scope) => [{ tracker: "memory", project: scope.project, id: name }],
    readIssue: async (ref) => ({ title: await answer(ref) }) as never,
    claim: async (ref) => ({ status: "rejected", reason: await answer(ref) }),
    releaseClaim: async () => undefined,
    readComments: async () => [],
    postComment: async (ref) => answer(ref),
    markDone: async (ref) => ({ status: "not-confirmed", reason: await answer(ref) }),
  };
};

const gh: IssueRef = { tracker: "github", project: "acme/app", id: "1" };
const jira: IssueRef = { tracker: "jira", project: "VAN", id: "9" };

test("each call goes to the tracker configured for the issue's scope", async () => {
  const router = routeTrackers([
    { tracker: "github", project: "acme/app", port: stub("gh-app") },
    { tracker: "github", project: "acme/other", port: stub("gh-other") },
    { tracker: "jira", project: "VAN", port: stub("jira-van") },
  ]);
  assert.equal((await router.readIssue(gh)).title, "gh-app:1");
  assert.equal((await router.readIssue(jira)).title, "jira-van:9");
  assert.equal(await router.postComment(jira, "x"), "jira-van:9");
  assert.deepEqual(await router.claim(gh), { status: "rejected", reason: "gh-app:1" });
  assert.deepEqual(await router.markDone(jira), { status: "not-confirmed", reason: "jira-van:9" });
  assert.deepEqual(await router.discoverCandidates({ project: "acme/other", readyLabel: "r" }), [
    { tracker: "memory", project: "acme/other", id: "gh-other" },
  ]);
});

test("a scope or issue without a configured tracker is a visible error, never a guess", async () => {
  const router = routeTrackers([{ tracker: "github", project: "acme/app", port: stub("gh-app") }]);
  await assert.rejects(() => router.readIssue(jira), /nenhum tracker configurado para jira:VAN/);
  await assert.rejects(() => router.discoverCandidates({ project: "VAN", readyLabel: "r" }), /nenhum tracker configurado/);
});

test("two trackers for the same scope are refused when the router is built", () => {
  assert.throws(
    () => routeTrackers([
      { tracker: "jira", project: "VAN", port: stub("a") },
      { tracker: "jira", project: "VAN", port: stub("b") },
    ]),
    /duplicado.*jira:VAN/,
  );
});
