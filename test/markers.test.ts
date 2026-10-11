import assert from "node:assert/strict";
import test from "node:test";
import { postFactoryComment, withFactoryMarker } from "../src/core/markers.js";
import type { IssueRef, TrackerPort } from "../src/tracker/port.js";

// The factory marker is part of the tracker port contract (R10): the core adds it to every
// comment the factory publishes, once. Adapters never add or strip it.

test("a GitHub factory comment starts with the invisible agent marker, added once", () => {
  const marked = withFactoryMarker("github", "resultado parcial");
  assert.equal(marked, "<!-- msf:agent -->\nresultado parcial");
  assert.equal(withFactoryMarker("github", marked), marked);
});

test("a Jira factory comment starts with the [msf] prefix, added once", () => {
  assert.equal(withFactoryMarker("jira", "resultado parcial"), "[msf] resultado parcial");
  assert.equal(withFactoryMarker("jira", "[msf] já marcado"), "[msf] já marcado");
});

test("postFactoryComment publishes the marked body through the port and returns the comment id", async () => {
  const posted: Array<{ ref: IssueRef; body: string }> = [];
  const port = {
    postComment: async (ref: IssueRef, body: string) => {
      posted.push({ ref, body });
      return "c-1";
    },
  } as unknown as TrackerPort;
  const ref: IssueRef = { tracker: "jira", project: "VAN", id: "VAN-7" };

  assert.equal(await postFactoryComment(port, ref, "pedido de ajuda"), "c-1");
  assert.deepEqual(posted, [{ ref, body: "[msf] pedido de ajuda" }]);
});
