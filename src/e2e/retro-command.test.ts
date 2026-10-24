import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installGhShim, runCli, type GhShim } from "./cli-harness.js";
import { acquireRunLock } from "../run-lock.js";
import { RETRO_IN_FLIGHT_FILENAME, RETRO_STATE_FILENAME } from "../retro/marker.js";

/**
 * The command surface of the retrospective, end-to-end through the
 * built CLI and the hermetic `gh` shim: config validation at boot, the
 * disabled job, the manual trigger's window (including a window of one) and
 * the empty-window notice. The round's behavior inside the sweep is driven
 * through the fake ports in retro-rounds.test.ts; the real Sandcastle proof
 * belongs to the RUNBOOK.
 */

const REPO = "Sanmoo/my-tasks";

describe("e2e: `msf retro` — the manual trigger and the config validation", () => {
  let dir: string;
  let workspace: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "msf-e2e-retro-cli-"));
    workspace = join(dir, "ws");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(extra: string[] = []): void {
    writeFileSync(
      join(dir, "msf.yaml"),
      [
        "worker-gh-account: bot-do-samuca",
        "worker-model: opencode-go/glm-5.3-flash",
        "repos: []",
        `workspace: ${workspace}`,
        "notifications: false",
        ...extra,
      ].join("\n"),
      "utf8",
    );
  }

  /** The shim's Docker shim: unreachable, so the manual trigger's liveness read
   *  answers "unknown" instead of querying the host daemon. */
  function installUnreachableDocker(binDir: string): void {
    const docker = join(binDir, "docker");
    writeFileSync(docker, "#!/bin/sh\necho 'Cannot connect to the Docker daemon' >&2\nexit 1\n", "utf8");
    chmodSync(docker, 0o755);
  }

  function shim(): GhShim {
    const installed = installGhShim(dir);
    installUnreachableDocker(installed.binDir);
    return installed;
  }

  function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
    return runCli(dir, args, shim().env());
  }

  test("retro disabled in the config refuses the manual round with a clear message", () => {
    writeConfig();
    const result = run(["retro"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /retro is disabled in msf\.yaml/);
    assert.equal(existsSync(workspace), false, "nothing was created before the refusal");
  });

  test("enabling retro without a factory-items destination fails at boot, before any workspace write", () => {
    writeConfig(["retro:", "  enabled: true"]);
    const result = run(["retro"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /retro\.factory-items-destination.*required/);
    assert.equal(existsSync(workspace), false);
  });

  test("a well-formed retro block with an empty workspace is a notice, never a report", () => {
    writeConfig(["retro:", "  enabled: true", "  factory-items-destination: Sanmoo/my-software-factory"]);
    const result = run(["retro"]);

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /no finished work to analyze/);
    assert.match(result.stdout, /nothing was launched and no report was written/);
    assert.equal(existsSync(join(workspace, "retros", RETRO_STATE_FILENAME)), false, "no marker moved");
    assert.deepEqual(
      readdirSync(join(workspace, "retros")).filter((name) => name.endsWith(".md")),
      [],
      "no report artifact accumulated",
    );
    assert.match(result.stdout, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\]/);
  });

  test("an unknown work key is refused before any work is read", () => {
    writeConfig(["retro:", "  enabled: true", "  factory-items-destination: Sanmoo/my-software-factory"]);

    const notAKey = run(["retro", "job-42"]);
    assert.equal(notAKey.status, 1);
    assert.match(notAKey.stderr, /is not a work key/);

    const unknownWork = run(["retro", `${REPO}#99`]);
    assert.equal(unknownWork.status, 1);
    assert.match(unknownWork.stderr, /not a finished work/);
  });

  test("a window with works waits for Docker: the premise (no live worker) cannot be confirmed", () => {
    writeConfig(["retro:", "  enabled: true", "  factory-items-destination: Sanmoo/my-software-factory"]);
    // One finished work on disk: the archive layout the factory writes, with
    // the attempt's log and its outcome record.
    const archived = join(workspace, "arquivo", `${REPO}#1-2026-02-01`);
    mkdirSync(archived, { recursive: true });
    writeFileSync(join(archived, "log-1.jsonl"), "{}\n", "utf8");
    writeFileSync(join(archived, "desfecho.json"), JSON.stringify({ class: "pr-open", attempt: 1 }), "utf8");

    const result = run(["retro"]);

    assert.equal(result.status, 1, `stdout: ${result.stdout}`);
    assert.match(result.stderr, /Docker did not answer/);
    assert.match(result.stderr, /cannot confirm that no live worker carries its works/);
    assert.equal(existsSync(join(workspace, "retros", RETRO_STATE_FILENAME)), false, "nothing was consumed");
    assert.deepEqual(
      readdirSync(join(workspace, "retros")).filter((name) => name.endsWith("-retro.md")),
      [],
      "no report was written on an unverifiable window",
    );
  });

  test("nothing new since the last report is a notice, even when Docker does not answer", () => {
    writeConfig(["retro:", "  enabled: true", "  factory-items-destination: Sanmoo/my-software-factory"]);
    const archived = join(workspace, "arquivo", `${REPO}#1-2026-02-01`);
    mkdirSync(archived, { recursive: true });
    writeFileSync(join(archived, "log-1.jsonl"), "{}\n", "utf8");
    writeFileSync(join(archived, "desfecho.json"), JSON.stringify({ class: "pr-open", attempt: 1 }), "utf8");
    // The last report already covered every finished work: the window is empty
    // whichever answer Docker gives, so the notice needs no Docker.
    mkdirSync(join(workspace, "retros"), { recursive: true });
    writeFileSync(
      join(workspace, "retros", RETRO_STATE_FILENAME),
      JSON.stringify({
        lastReport: "2026-03-01T00-00-00-000Z-retro.md",
        boundaryAt: 9e15,
        analyzed: [],
        lastFiled: 0,
      }),
      "utf8",
    );

    const result = run(["retro"]);

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /nothing new since the last report/);
    assert.doesNotMatch(result.stderr, /Docker did not answer/);
  });

  test("--language belongs to the retro command only", () => {
    const result = run(["status", "--language", "pt-BR"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown flag "--language"/);
  });

  test("a round another live process owns keeps the lane: the manual trigger refuses", () => {
    writeConfig(["retro:", "  enabled: true", "  factory-items-destination: Sanmoo/my-software-factory"]);
    mkdirSync(join(workspace, "retros"), { recursive: true });
    writeFileSync(
      join(workspace, "retros", RETRO_IN_FLIGHT_FILENAME),
      JSON.stringify({ round: "2026-03-01T00-00-00-000Z", startedAt: 0, window: [], manual: false, pid: process.pid }),
      "utf8",
    );

    const result = run(["retro"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /a retrospective round is already in flight/);
    assert.equal(
      existsSync(join(workspace, "retros", RETRO_IN_FLIGHT_FILENAME)),
      true,
      "the live owner's record is never wiped",
    );
  });

  test("a manual round never waits for the factory to stop: the lane's marker is the exclusivity", async () => {
    writeConfig(["retro:", "  enabled: true", "  factory-items-destination: Sanmoo/my-software-factory"]);
    mkdirSync(join(workspace, "retros"), { recursive: true });
    // This process holds the `msf run` exclusivity, exactly as a sweeping
    // factory does: the manual trigger must still answer.
    const lock = await acquireRunLock(join(dir, "msf.yaml"));
    try {
      const result = run(["retro", "--language", "pt-BR"]);

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /no finished work to analyze/);
      assert.doesNotMatch(result.stderr, /active msf run/);
    } finally {
      await lock.close();
    }
    assert.equal(existsSync(join(workspace, "retros", RETRO_IN_FLIGHT_FILENAME)), false);
  });
});
