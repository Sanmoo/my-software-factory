import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { AGENT_MARKER } from "../tracker/port.js";
import { DEFAULT_LABELS } from "../config.js";
import { DESFECHO_FILENAME } from "../state/outcome.js";
import { buildWorkerPrompt, WORK_MOUNT } from "./prompt.js";
import type { WorkRequest } from "./port.js";

/**
 * The worker prompt (ticket 17): the issue, the PR and its comments when a
 * round exists, the diff of the work branch — and the worker's THREE
 * obligations (the worker's ruler; the factory's ruler reads only the
 * structured facts these obligations produce).
 */

const baseRequest = (overrides: Partial<WorkRequest> = {}): WorkRequest => ({
  ref: { repo: "Sanmoo/my-tasks", number: 42 },
  workDir: "/ws/trabalhos/Sanmoo/my-tasks#42",
  branch: "agent-issue-42",
  repoDir: "/ws/repos/Sanmoo#my-tasks",
  baseBranch: "main",
  attempt: 1,
  material: {
    issue: { title: "Add the greeting endpoint", body: "Add a `greet` endpoint to the API." },
    diff: "diff --git a/x b/x\n+hello",
  },
  ...overrides,
});

describe("worker prompt — the material the session starts from", () => {
  test("carries the issue title and body", () => {
    const prompt = buildWorkerPrompt(baseRequest(), { blockedLabel: DEFAULT_LABELS.blocked });
    assert.match(prompt, /Sanmoo\/my-tasks#42/);
    assert.match(prompt, /Add the greeting endpoint/);
    assert.match(prompt, /Add a `greet` endpoint to the API\./);
  });

  test("carries the branch facts: branch, base, attempt", () => {
    const prompt = buildWorkerPrompt(
      baseRequest({ attempt: 3 }),
      { blockedLabel: DEFAULT_LABELS.blocked },
    );
    assert.match(prompt, /agent-issue-42/);
    assert.match(prompt, /born from main/);
    assert.match(prompt, /attempt 3/);
  });

  test("carries the diff of the work branch", () => {
    const prompt = buildWorkerPrompt(baseRequest(), { blockedLabel: DEFAULT_LABELS.blocked });
    assert.match(prompt, /\+hello/);
  });

  test("with no open PR: instructs opening one against the base with Closes linkage", () => {
    const prompt = buildWorkerPrompt(baseRequest(), { blockedLabel: DEFAULT_LABELS.blocked });
    assert.match(prompt, /gh pr create/);
    assert.match(prompt, /Closes #42/);
    assert.match(prompt, /--base main/);
  });

  test("with an open PR: the round's conversation is in the prompt, opening a new PR is forbidden", () => {
    const request = baseRequest({
      material: {
        issue: { title: "t", body: "b" },
        pr: {
          number: 7,
          comments: [
            { id: "1", author: "human", body: "Please split the module.", createdAt: "2026-02-14T00:00:00Z" },
            { id: "2", author: "bot-do-samuca", body: "Done earlier.", createdAt: "2026-02-14T01:00:00Z" },
          ],
        },
        diff: "diff --git a/y b/y",
      },
    });
    const prompt = buildWorkerPrompt(request, { blockedLabel: DEFAULT_LABELS.blocked });
    assert.match(prompt, /PR #7/);
    assert.match(prompt, /Please split the module\./);
    assert.match(prompt, /human/);
    assert.doesNotMatch(prompt, /gh pr create/);
  });
});

describe("worker prompt — the three obligations (the worker's ruler)", () => {
  const prompt = buildWorkerPrompt(baseRequest(), { blockedLabel: DEFAULT_LABELS.blocked });

  test("obligation 1: the structured outcome record, always, before ending — with the schema", () => {
    assert.match(prompt, new RegExp(`${WORK_MOUNT}/${DESFECHO_FILENAME}`));
    assert.match(prompt, /pr-open/);
    assert.match(prompt, /blocked-self-report/);
    assert.match(prompt, /clean-without-pr/);
    assert.match(prompt, /"attempt": 1/);
    assert.match(prompt, /"pr".*"repo".*"number".*"branch"/s);
  });

  test("obligation 1: the schema example shows the optional `paths` — the record's artifact trail (story 19)", () => {
    // The record carries classe, tentativa, PR, caminhos — the schema example
    // must teach `paths`, or the worker never learns the field exists.
    assert.match(prompt, /"paths": \{"<artifact name>": "<path, relative to the work dir>"\}/);
    assert.match(prompt, /"paths" is optional: the paths of the artifacts this session wrote/);
    assert.match(prompt, /"paths" optional\)/, "the example marks paths as the optional member it is");
  });

  test("obligation 2: every feedback round ends with a marked comment on the PR", () => {
    assert.match(prompt, /comment on the PR/i);
    assert.match(prompt, new RegExp(`comment MUST start with[\\s\\S]*${AGENT_MARKER}`));
  });

  test("obligation 3: blocked self-report — marker + label + exit", () => {
    assert.match(prompt, new RegExp(AGENT_MARKER));
    assert.match(prompt, /--add-label agent-blocked/);
    assert.match(prompt, /blocked-self-report/);
  });

  test("the blocked label is the factory's configured one, not a hardcode", () => {
    const prompt = buildWorkerPrompt(baseRequest(), { blockedLabel: "parado" });
    assert.match(prompt, /--add-label parado/);
  });

  test("the prompt ends with the completion signal the runtime listens for", () => {
    assert.match(prompt, /MSF-RESULT/);
  });
});
