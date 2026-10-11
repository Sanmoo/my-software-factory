import assert from "node:assert/strict";
import test from "node:test";
import { directedReply, judgePrFeedback } from "../src/core/feedback.js";
import type { PrCheck, PrComment, PrFeedback } from "../src/pr/port.js";
import type { Comment } from "../src/tracker/port.js";

// Feedback rules (R10, CA11, CA12): what counts as directed input in an issue and on a PR.

const CREATED = "2026-05-01T10:00:00Z";
const human = (body: string, id = "c1"): Comment => ({ id, author: "ana", isBot: false, body, createdAt: CREATED });
const known = <T>(value: T) => ({ known: true as const, value });
const unknown = (reason: string) => ({ known: false as const, reason });

const reviewBy = (author: string, body: string, overrides: Partial<PrComment> = {}): PrComment => ({
  id: `review-${author}`,
  kind: "review",
  author,
  isBot: false,
  body,
  createdAt: CREATED,
  ...overrides,
});

const checkOf = (id: string, state: PrCheck["state"], required: PrCheck["required"]): PrCheck => ({
  id,
  name: `check ${id}`,
  state,
  required,
});

const feedback = (parts: Partial<PrFeedback>): PrFeedback => ({ comments: [], checks: [], ...parts });

// ---- CA11: directed replies in issues ------------------------------------------------------

test("in GitHub only a human comment without marker that starts with agent: is a directed reply", () => {
  assert.equal(directedReply("github", human("agent: use o seam v2"))?.message, "use o seam v2");
  assert.equal(directedReply("github", human("  agent:\nuse o seam v2 "))?.message, "use o seam v2");
  assert.equal(directedReply("github", human("concordo, pode seguir"))?.message, undefined);
  assert.equal(directedReply("github", human("nota: agent: não é para o agente"))?.message, undefined);
  assert.equal(directedReply("github", human("agent:   "))?.message, undefined, "an empty directed reply is not feedback");
  assert.equal(directedReply("github", { ...human("agent: use o seam v2"), isBot: true }), undefined, "bots never direct the job");
  assert.equal(directedReply("github", human("<!-- msf:agent -->\nagent: relato próprio")), undefined, "factory comments never direct the job");
});

test("in Jira the factory marker is the [msf] prefix, and only human directed comments count", () => {
  assert.equal(directedReply("jira", human("agent: use o seam v2"))?.message, "use o seam v2");
  assert.equal(directedReply("jira", human("[msf] agent: relato próprio")), undefined);
  assert.equal(directedReply("jira", { ...human("agent: x"), isBot: true }), undefined);
});

test("a directed reply is keyed by comment id and revision, so an edited comment is new feedback", () => {
  const first = directedReply("github", human("agent: use o seam v2"));
  const again = directedReply("github", human("agent: use o seam v2"));
  const edited = directedReply("github", human("agent: use o seam v3"));
  assert.ok(first?.key);
  assert.equal(first?.key, again?.key, "the same comment and text keep the same key");
  assert.notEqual(first?.key, edited?.key, "a new revision of the same comment is a new event");
});

// ---- CA12: PR feedback and checks --------------------------------------------------------

test("a human review or comment on the PR is feedback; bot and factory-marked ones are not", () => {
  const judged = judgePrFeedback(feedback({
    comments: [
      reviewBy("ana", "troque o nome da função"),
      reviewBy("ci-bot", "relatório automático", { isBot: true }),
      reviewBy("ana", "<!-- msf:agent -->\nresumo do agente", { id: "own" }),
    ],
  }), new Set());

  assert.deepEqual(judged.inputs.map((input) => input.message), ["revisão de ana: troque o nome da função"]);
  assert.equal(judged.undecidable, undefined);
});

test("feedback already consumed by its id and revision is not offered again", () => {
  const comments = [reviewBy("ana", "troque o nome da função")];
  const first = judgePrFeedback(feedback({ comments }), new Set());
  const key = first.inputs[0]?.key;
  assert.ok(key);

  assert.deepEqual(judgePrFeedback(feedback({ comments }), new Set([key])).inputs, []);
  const edited = judgePrFeedback(feedback({ comments: [reviewBy("ana", "troque o nome da função, por favor")] }), new Set([key]));
  assert.equal(edited.inputs.length, 1, "an edited review is a new revision");
});

test("when some check is required, only failing required checks call for correction", () => {
  const judged = judgePrFeedback(feedback({
    checks: [
      checkOf("lint", known("failing"), known(false)),
      checkOf("test", known("failing"), known(true)),
      checkOf("build", known("passing"), known(true)),
    ],
  }), new Set());

  assert.deepEqual(judged.inputs.map((input) => input.message), ["check com falha: check test"]);
});

test("without any required check, any failing check calls for correction", () => {
  const judged = judgePrFeedback(feedback({
    checks: [checkOf("lint", known("failing"), known(false)), checkOf("build", known("passing"), known(false))],
  }), new Set());

  assert.deepEqual(judged.inputs.map((input) => input.message), ["check com falha: check lint"]);
});

test("a failing check whose required status is unknown is undecidable and goes to the human", () => {
  const judged = judgePrFeedback(feedback({
    checks: [checkOf("deploy", known("failing"), unknown("branch protection não legível"))],
  }), new Set());

  assert.ok(judged.undecidable, "the verdict says a human must decide");
  assert.match(judged.undecidable ?? "", /obrigatoriedade|decidir/);
  assert.equal(judged.inputs.length, 1, "the undecided check is still listed for the human");
});

test("green checks and checks that are still running call for nothing", () => {
  const judged = judgePrFeedback(feedback({
    checks: [checkOf("test", known("passing"), known(true)), checkOf("e2e", known("pending"), known(true))],
  }), new Set());

  assert.deepEqual(judged.inputs, []);
});
