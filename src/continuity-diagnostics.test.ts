import assert from "node:assert/strict";
import { test } from "node:test";
import { ContinuityDiagnostics } from "./continuity-diagnostics.js";
import type { PauseRecord } from "./work-record/continuity.js";

const pause: PauseRecord = {
  version: 1, attempt: 5, id: "occurrence", sessionId: "session",
  reason: "effect-unsupported", detail: "cat > /tmp/probe <<'EOF'\nprivate-script\nEOF",
  at: "2026-01-01T00:00:00Z", announced: true,
};

test("pause diagnostics are single-line, actionable and omit the entire raw command", () => {
  const diagnostics = new ContinuityDiagnostics();
  const line = diagnostics.paused("Sanmoo/repo#7", "/ws/work", pause)!;
  assert.match(line, /Sanmoo\/repo#7.*effect-unsupported.*operator decision/);
  assert.match(line, /msf recover 'Sanmoo\/repo#7'/);
  assert.match(line, /\/ws\/work\/pausa\.json/);
  assert.doesNotMatch(line, /\n|private-script|cat >|\/tmp\/probe/);
  assert.equal(diagnostics.paused("Sanmoo/repo#7", "/ws/work", { ...pause, at: "2026-02-01", announced: false }), null, "tick timestamps and announcement bookkeeping are not changes of cause");
});

test("changed evidence, changed occurrence, resolution and a restart are each reported once", () => {
  const diagnostics = new ContinuityDiagnostics();
  const report = (value: PauseRecord) => diagnostics.paused("repo#7", "/ws/work", value);
  assert.ok(report(pause));
  assert.equal(report(pause), null);
  assert.match(report({ ...pause, detail: "new evidence\nprivate" })!, /diagnosis changed/);
  assert.equal(report({ ...pause, detail: "new evidence\nprivate" }), null);
  assert.ok(report({ ...pause, id: "new occurrence" }));
  diagnostics.resolved("repo#7");
  assert.ok(report(pause));
  assert.ok(new ContinuityDiagnostics().paused("repo#7", "/ws/work", pause));
  assert.ok(diagnostics.paused("repo#8", "/ws/other", pause), "another work has independent diagnostic memory");
});
