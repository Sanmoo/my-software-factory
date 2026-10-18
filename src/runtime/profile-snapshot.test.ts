import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { snapshotProfile, ProfileSnapshotError, DEFAULT_SNAPSHOT_SKIP } from "./profile-snapshot.js";

/**
 * The profile snapshot (ticket 17, ADR 0002's proven pattern from the v1):
 * the host resolves the operator's Pi profile into a portrait of real files
 * that the container mounts READ-ONLY. The operator's real profile is never
 * mounted and never written — the container copies the portrait into its own
 * writable agent dir. Fail fast: a link the snapshot cannot resolve honestly
 * stops the launch with its reason, never silently drops context.
 */

describe("profile snapshot — a portrait of real files", () => {
  let root: string;
  let profile: string;
  let destination: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "msf-snap-"));
    profile = join(root, "pi", "agent");
    mkdirSync(profile, { recursive: true });
    destination = join(root, "snapshot");
    mkdirSync(destination);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("copies real files and directories verbatim", async () => {
    writeFileSync(join(profile, "auth.json"), '{"tokens":{}}', "utf8");
    writeFileSync(join(profile, "settings.json"), "{}", "utf8");
    mkdirSync(join(profile, "skills", "my-skill"), { recursive: true });
    writeFileSync(join(profile, "skills", "my-skill", "SKILL.md"), "# skill\n", "utf8");

    await snapshotProfile(profile, destination);

    assert.equal(readFileSync(join(destination, "auth.json"), "utf8"), '{"tokens":{}}');
    assert.equal(readFileSync(join(destination, "skills", "my-skill", "SKILL.md"), "utf8"), "# skill\n");
  });

  test("a symlink inside the profile is dereferenced — real content at the link's path", async () => {
    mkdirSync(join(profile, "shared"));
    writeFileSync(join(profile, "shared", "AGENTS.md"), "# instructions\n", "utf8");
    symlinkSync(join(profile, "shared", "AGENTS.md"), join(profile, "AGENTS.md"));

    await snapshotProfile(profile, destination);

    assert.equal(
      readFileSync(join(destination, "AGENTS.md"), "utf8"),
      "# instructions\n",
      "the link's target content is copied, never the link",
    );
  });

  test("a symlink escaping the profile fails fast, naming the link — never silent context loss", async () => {
    mkdirSync(join(root, "elsewhere"), { recursive: true });
    mkdirSync(join(profile, "skills"), { recursive: true });
    writeFileSync(join(root, "elsewhere", "skill.md"), "secret\n", "utf8");
    symlinkSync(join(root, "elsewhere", "skill.md"), join(profile, "skills", "my-skill"));
    symlinkSync(join(profile, "skills"), join(profile, "skills-link"));

    await assert.rejects(
      snapshotProfile(profile, destination),
      (error: unknown) => error instanceof ProfileSnapshotError && error.message.includes("skills/my-skill"),
    );
  });

  test("an escaping link into a declared allowed root is dereferenced like any real file", async () => {
    mkdirSync(join(profile, "skills"), { recursive: true });
    mkdirSync(join(root, "agents", "skills", "matt"), { recursive: true });
    writeFileSync(join(root, "agents", "skills", "matt", "SKILL.md"), "# matt\n", "utf8");
    symlinkSync(join(root, "agents", "skills", "matt"), join(profile, "skills", "matt"));

    await snapshotProfile(profile, destination, { allowedRoots: [join(root, "agents")] });

    assert.equal(readFileSync(join(destination, "skills", "matt", "SKILL.md"), "utf8"), "# matt\n");
  });

  test("sessions and npm are skipped by default — they have their own mounts", async () => {
    mkdirSync(join(profile, "sessions", "proj"), { recursive: true });
    writeFileSync(join(profile, "sessions", "proj", "s.jsonl"), "{}\n", "utf8");
    mkdirSync(join(profile, "npm"));
    writeFileSync(join(profile, "npm", "tree.txt"), "x", "utf8");
    writeFileSync(join(profile, "auth.json"), "{}", "utf8");

    await snapshotProfile(profile, destination);

    assert.ok(!existsSync(join(destination, "sessions")));
    assert.ok(!existsSync(join(destination, "npm")));
    assert.equal(DEFAULT_SNAPSHOT_SKIP.join(","), "sessions,npm");
    assert.ok(existsSync(join(destination, "auth.json")));
  });

  test("a broken symlink fails fast — the admission blocks on it (fail-closed)", async () => {
    symlinkSync(join(profile, "does-not-exist"), join(profile, "dangling"));

    await assert.rejects(snapshotProfile(profile, destination), ProfileSnapshotError);
  });

  test("stale links may be explicitly skipped — named in the warnings, never silent", async () => {
    symlinkSync(join(profile, "does-not-exist"), join(profile, "stale-link.ts"));
    writeFileSync(join(profile, "auth.json"), "{}", "utf8");

    const { warnings } = await snapshotProfile(profile, destination, { skipDanglingLinks: true });

    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /stale-link\.ts/);
    assert.ok(!existsSync(join(destination, "stale-link.ts")));
    assert.ok(existsSync(join(destination, "auth.json")));
  });

  test("a symlink cycle fails instead of hanging or exploding", async () => {
    symlinkSync(".", join(profile, "self"));

    await assert.rejects(snapshotProfile(profile, destination), ProfileSnapshotError);
  });

  test("non-file entries (sockets, pipes) are skipped and named — runtime state, not context", async () => {
    writeFileSync(join(profile, "auth.json"), "{}", "utf8");

    // A real socket is awkward to fixture; a fifo behaves like one to stat.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("mkfifo", [join(profile, "pipe")]);

    const { warnings } = await snapshotProfile(profile, destination);

    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /pipe/);
    assert.ok(!existsSync(join(destination, "pipe")));
    assert.ok(existsSync(join(destination, "auth.json")));
  });

  test("the destination is created when missing", async () => {
    writeFileSync(join(profile, "auth.json"), "{}", "utf8");
    const nested = join(root, "new", "snapshot");
    await snapshotProfile(profile, nested);
    assert.ok(existsSync(join(nested, "auth.json")));
  });

  test("an empty profile snapshots empty — the container still boots on it", async () => {
    await snapshotProfile(profile, destination);
    assert.deepEqual(readdirSync(destination), []);
  });
});
