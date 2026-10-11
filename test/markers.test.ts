import assert from "node:assert/strict";
import test from "node:test";
import { postFactoryComment, withFactoryMarker } from "../src/core/markers.js";
import { createObserver } from "../src/core/observability.js";
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

test("an observed comment announces the attempt and the id, without the body, and failure is uncertain, not posted twice", async () => {
  const lines: string[] = [];
  const observer = createObserver({ instance: "i", console: (line) => lines.push(line) });
  let calls = 0;
  const port = {
    postComment: async () => {
      calls += 1;
      if (calls === 2) throw new Error("timeout");
      return "c-9";
    },
  } as unknown as TrackerPort;
  const ref: IssueRef = { tracker: "jira", project: "VAN", id: "VAN-7" };
  const observed = { observer, job: "jira:VAN#VAN-7", reason: "ajuda" };

  assert.equal(await postFactoryComment(port, ref, "texto secreto do corpo", observed), "c-9");
  await assert.rejects(postFactoryComment(port, ref, "outro", observed), /timeout/);

  assert.match(lines[0]!, /tentativa de alteração na issue.*operação=comentar motivo=ajuda/);
  assert.match(lines[1]!, /alteração confirmada.*comentário=c-9 conteúdo="22 caracteres"/);
  assert.match(lines[3]!, /resultado da alteração incerto.*erro=timeout/);
  assert.ok(lines.every((line) => !line.includes("texto secreto")));
  assert.equal(calls, 2, "observing never repeats the write");
});
