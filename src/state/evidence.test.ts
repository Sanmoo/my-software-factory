import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readWorkEvidence, renderWorkEvidence } from "./evidence.js";

/**
 * The evidence the blocked comment points at (issue 103): three locations of
 * the attempt under the factory workspace, probed on the real filesystem. The
 * relative path is derived from the ref alone — the base of every shown path
 * is the workspace, never the host's absolute dir.
 */
describe("evidence — the three locations of a fell attempt, probed on disk", () => {
  let dir: string;
  const ref = { repo: "Sanmoo/a", number: 1 };
  const relativeDir = "trabalhos/Sanmoo/a#1";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-evidence-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeEvidence(attempt: number): void {
    writeFileSync(join(dir, `log-${attempt}.jsonl`), "{}\n", "utf8");
    mkdirSync(join(dir, "sessao"), { recursive: true });
    writeFileSync(join(dir, "sessao", `sandcastle-${attempt}.log`), "session output\n", "utf8");
  }

  test("the three locations use the attempt's number and the workspace-relative base", async () => {
    writeEvidence(2);

    const evidence = await readWorkEvidence(ref, 2, dir);

    assert.deepEqual(evidence.workDir, { path: `${relativeDir}/`, presence: "present" });
    assert.deepEqual(evidence.eventLog, { path: `${relativeDir}/log-2.jsonl`, presence: "present" });
    assert.deepEqual(evidence.sandcastleLog, {
      path: `${relativeDir}/sessao/sandcastle-2.log`,
      presence: "present",
    });
    for (const location of Object.values(evidence)) {
      assert.ok(!location.path.startsWith("/"), "no host absolute path is ever shown");
      assert.ok(!location.path.includes(dir), "the absolute work dir never leaks into a shown path");
    }
  });

  test("a location that does not exist is absent — never omitted", async () => {
    const evidence = await readWorkEvidence(ref, 3, dir);

    assert.equal(evidence.workDir.presence, "present", "the dir itself exists");
    assert.equal(evidence.eventLog.presence, "absent");
    assert.equal(evidence.eventLog.path, `${relativeDir}/log-3.jsonl`);
    assert.equal(evidence.sandcastleLog.presence, "absent", "the sandcastle log was never created");
    assert.equal(evidence.sandcastleLog.path, `${relativeDir}/sessao/sandcastle-3.log`);
  });

  test("a failed query is 'could not be verified', never absent (issue 103)", async () => {
    // A self-referential symlink makes the query fail with ELOOP: the answer
    // is unknown, and unknown is never absence.
    symlinkSync("sessao", join(dir, "sessao"));

    const broken = await readWorkEvidence(ref, 1, dir);
    assert.equal(broken.workDir.presence, "present");
    assert.equal(broken.eventLog.presence, "absent");
    assert.equal(broken.sandcastleLog.presence, "could not be verified");
  });

  test("the rendering names the workspace as the base and shows every location with its state", async () => {
    writeEvidence(2);

    const rendered = renderWorkEvidence(await readWorkEvidence(ref, 2, dir));

    assert.match(rendered, /relative to the factory workspace on the host/i);
    assert.match(rendered, /not the repository, the work dir or the container/i);
    assert.match(rendered, /work dir:\s+trabalhos\/Sanmoo\/a#1\/ — present/);
    assert.match(rendered, /event log:\s+trabalhos\/Sanmoo\/a#1\/log-2\.jsonl — present/);
    assert.match(rendered, /sandcastle log:\s+trabalhos\/Sanmoo\/a#1\/sessao\/sandcastle-2\.log — present/);
  });
});
