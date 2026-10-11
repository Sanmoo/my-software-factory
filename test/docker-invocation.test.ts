import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPLETION_SIGNAL,
  effectiveIterationLimit,
  sandcastleRequest,
} from "../src/runtime/docker-invocation.js";

test("a new invocation may use the configured Sandcastle iterations, and the effective limit is visible", () => {
  assert.equal(effectiveIterationLimit("new", 5), 5);
  assert.equal(effectiveIterationLimit("new", 3), 3);
});

test("resume and correction are always one iteration, whatever the configured limit", () => {
  assert.equal(effectiveIterationLimit("resume", 5), 1);
  assert.equal(effectiveIterationLimit("correction", 5), 1);
});

test("a limit must be a positive integer", () => {
  assert.throws(() => effectiveIterationLimit("new", 0), RangeError);
  assert.throws(() => effectiveIterationLimit("new", 1.5), RangeError);
});

test("a resume request keeps the session with exactly one iteration, as Sandcastle 0.12.0 requires", () => {
  const request = sandcastleRequest({ kind: "resume", prompt: "continue", configuredLimit: 5, sessionId: "s-1" });
  assert.equal(request.resumeSession, "s-1");
  assert.equal(request.maxIterations, 1);
  assert.equal(request.completionSignal, COMPLETION_SIGNAL);
});

test("a new request has no session and uses the configured limit", () => {
  const request = sandcastleRequest({ kind: "new", prompt: "implement", configuredLimit: 5 });
  assert.equal(request.resumeSession, undefined);
  assert.equal(request.maxIterations, 5);
});

test("a continuation without a recorded session is refused rather than starting a new conversation", () => {
  assert.throws(
    () => sandcastleRequest({ kind: "resume", prompt: "continue", configuredLimit: 5 }),
    /sem sessão Pi/,
  );
});

test("a new invocation never resumes an old session", () => {
  assert.throws(
    () => sandcastleRequest({ kind: "new", prompt: "implement", configuredLimit: 5, sessionId: "old" }),
    /não retoma sessão/,
  );
});
