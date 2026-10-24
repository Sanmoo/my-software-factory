import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { waitFor } from "../e2e/cli-harness.js";
import { clearWorkerStop, requestWorkerStop, STOP_REQUEST_FILENAME, watchWorkerStop, workerStopRequested } from "./stop-request.js";

test("the stop reaches only its owning session and aborts once, without killing the process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msf-stop-request-"));
  let aborted = 0;
  requestWorkerStop(dir, "previous-session");
  const dispose = watchWorkerStop(dir, "current-session", () => { aborted += 1; });
  try {
    assert.equal(workerStopRequested(dir, "current-session"), false);
    assert.equal(aborted, 0);
    requestWorkerStop(dir, "current-session");
    await waitFor("Pi to receive the cooperative stop", () => aborted === 1);
    assert.equal(workerStopRequested(dir, "current-session"), true);
    clearWorkerStop(dir);
    assert.equal(workerStopRequested(dir, "current-session"), false);
    requestWorkerStop(dir, "current-session");
    assert.equal(aborted, 1, "a settled stop never becomes a heartbeat or another abort");
  } finally { dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test("a malformed stop request cannot authorize another mutation", () => {
  const dir = mkdtempSync(join(tmpdir(), "msf-stop-invalid-"));
  try {
    writeFileSync(join(dir, STOP_REQUEST_FILENAME), "{partial");
    assert.equal(workerStopRequested(dir, "session"), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
