import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureWorkspace, workDir, type WorkspaceLayout } from "../layout.js";
import { readWorkEvidence, renderWorkEvidence } from "./evidence.js";

/**
 * The evidence the blocked comment points at: three locations of
 * the attempt under the factory workspace, probed on the real filesystem.
 * Each shown path is the probed dir's workspace-relative form, so the comment
 * can only name what it consulted.
 */
describe("evidence — the three locations of a fell attempt, probed on disk", () => {
  let root: string;
  let layout: WorkspaceLayout;
  const ref = { repo: "Sanmoo/a", number: 1 };
  const relativeDir = "trabalhos/Sanmoo/a#1";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "msf-evidence-"));
    layout = ensureWorkspace(join(root, "ws"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** The attempt's real dir in the workspace — the shown path names it. */
  function workDirOf(): string {
    const dir = workDir(layout, ref.repo, ref.number);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function writeEvidence(attempt: number): void {
    const dir = workDirOf();
    writeFileSync(join(dir, `log-${attempt}.jsonl`), "{}\n", "utf8");
    mkdirSync(join(dir, "sessao"), { recursive: true });
    writeFileSync(join(dir, "sessao", `sandcastle-${attempt}.log`), "session output\n", "utf8");
  }

  test("the shown paths name exactly the dir and files that were probed", async () => {
    writeEvidence(2);

    const evidence = await readWorkEvidence(layout, workDirOf(), 2);

    assert.deepEqual(evidence.workDir, { path: `${relativeDir}/`, presence: "present" });
    assert.deepEqual(evidence.eventLog, { path: `${relativeDir}/log-2.jsonl`, presence: "present" });
    assert.deepEqual(evidence.sandcastleLog, {
      path: `${relativeDir}/sessao/sandcastle-2.log`,
      presence: "present",
    });
    for (const location of Object.values(evidence)) {
      assert.ok(!location.path.startsWith("/"), "no host absolute path is ever shown");
      assert.ok(!location.path.includes(root), "the absolute workspace path never leaks into a shown path");
    }
  });

  test("a location that does not exist is absent — never omitted", async () => {
    const dir = workDirOf(); // the work dir exists; attempt 3 left no files behind

    const evidence = await readWorkEvidence(layout, dir, 3);

    assert.equal(evidence.workDir.presence, "present");
    assert.equal(evidence.eventLog.presence, "absent");
    assert.equal(evidence.eventLog.path, `${relativeDir}/log-3.jsonl`);
    assert.equal(evidence.sandcastleLog.presence, "absent", "the sandcastle log was never created");
    assert.equal(evidence.sandcastleLog.path, `${relativeDir}/sessao/sandcastle-3.log`);
  });

  test("an absent work dir is reported absent — never invented", async () => {
    const evidence = await readWorkEvidence(layout, workDir(layout, "Sanmoo/b", 7), 1);

    assert.deepEqual(evidence.workDir, { path: "trabalhos/Sanmoo/b#7/", presence: "absent" });
    assert.equal(evidence.eventLog.presence, "absent");
    assert.equal(evidence.sandcastleLog.presence, "absent");
  });

  test("a failed query is 'could not be verified', never absent", async () => {
    // A self-referential symlink makes the query fail with ELOOP: the answer
    // is unknown, and unknown is never absence.
    symlinkSync("sessao", join(workDirOf(), "sessao"));

    const broken = await readWorkEvidence(layout, workDirOf(), 1);

    assert.equal(broken.workDir.presence, "present");
    assert.equal(broken.eventLog.presence, "absent");
    assert.equal(broken.sandcastleLog.presence, "could not be verified");
  });

  test("the rendering names the workspace as the base and shows every location with its state", async () => {
    writeEvidence(2);

    const rendered = renderWorkEvidence(await readWorkEvidence(layout, workDirOf(), 2));

    assert.match(rendered, /relative to the factory workspace on the host/i);
    assert.match(rendered, /not the repository, the work dir or the container/i);
    assert.match(rendered, /reservation:\s+trabalhos\/Sanmoo\/a#1\/ — present/);
    assert.match(rendered, /event log:\s+trabalhos\/Sanmoo\/a#1\/log-2\.jsonl — present/);
    assert.match(rendered, /sandcastle log:\s+trabalhos\/Sanmoo\/a#1\/sessao\/sandcastle-2\.log — present/);
  });
});
