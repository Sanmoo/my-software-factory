import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pi } from "@ai-hero/sandcastle";

test("Sandcastle locates Pi sessions under a project directory, not a flat root", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-session-"));
  const id = "01a12bb1-a780-7316-b5ea-b9aa7186b013";
  const filename = `2026-10-11T16-00-25-472Z_${id}.jsonl`;
  const content = JSON.stringify({ type: "session", version: 3, id }) + "\n";
  try {
    const provider = pi("github-copilot/gpt-6-luna",
      { sessionStorage: { hostSessionsDir: root } });
    await writeFile(join(root, filename), content);
    assert.equal((await provider.sessionStorage.findByIdOnHost(id)).path, undefined);
    const project = join(root, "project");
    await mkdir(project);
    await writeFile(join(project, filename), content);
    assert.equal((await provider.sessionStorage.findByIdOnHost(id)).path,
      join(project, filename));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
