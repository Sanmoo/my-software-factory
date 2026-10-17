import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readOutcomeRecord, DESFECHO_FILENAME } from "./outcome.js";

describe("outcome — the factory's ruler reads only structured facts", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "msf-outcome-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("the artifact contract is desfecho.json, in PT-BR on disk", () => {
    assert.equal(DESFECHO_FILENAME, "desfecho.json");
  });

  test("an outcome record on disk parses into the structured schema", async () => {
    writeFileSync(
      join(workDir, DESFECHO_FILENAME),
      JSON.stringify({
        class: "pr-open",
        attempt: 1,
        pr: { repo: "Sanmoo/a", number: 12, branch: "agent-issue-3" },
      }),
      "utf8",
    );

    const record = await readOutcomeRecord(workDir);

    assert.ok(record);
    assert.equal(record.class, "pr-open");
    assert.equal(record.attempt, 1);
  });

  test("the absence of the record is itself the class 'abrupt fall' (null, no error)", async () => {
    const record = await readOutcomeRecord(workDir);
    assert.equal(record, null);
  });

  test("a record that breaks the schema is invalid — never interpreted as prose", async () => {
    writeFileSync(join(workDir, DESFECHO_FILENAME), JSON.stringify({ class: "whatever" }), "utf8");
    const record = await readOutcomeRecord(workDir);
    assert.equal(record, null);
  });

  test("a corrupt record is treated as absent (abrupt fall), not a crash", async () => {
    writeFileSync(join(workDir, DESFECHO_FILENAME), "{not json", "utf8");
    const record = await readOutcomeRecord(workDir);
    assert.equal(record, null);
  });
});
