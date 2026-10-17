import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { RuntimeProfileConfig } from "../../src/config/types.js";

// A runtime profile declaration like the pilot's, shared by the tests that build a runner.
export const DECLARATION: RuntimeProfileConfig = {
  required: { files: ["settings.json", "auth.json"], packages: ["npm:pi-subagents"], skills: [], agents: [], tools: [] },
  excludePackages: ["npm:pi-lens"],
};

export const SETTINGS = { packages: [{ source: "npm:pi-subagents", prompts: [] }, "npm:pi-lens"] };

// Writes the files a profile directory needs to satisfy DECLARATION (plus any extras, by relative path).
export async function populateProfile(dir: string, extras: Record<string, string> = {}): Promise<void> {
  const files = { "settings.json": JSON.stringify(SETTINGS), "auth.json": "{}", ...extras };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
}

// The two runner options that carry the declaration of one profile name, plus the persistent
// toolchain root the runner creates the directories under (ADR 0004): the per-profile package tree
// and the mise data dir shared by every profile (`runtimeOptionsRoot/mise`).
export const runtimeOptions = (name: string, declaration: RuntimeProfileConfig = DECLARATION) => ({
  runtimeProfiles: { [name]: declaration },
  allowedRoots: { [name]: [] as string[] },
  toolchainsDir: runtimeOptionsRoot,
});

// Tests are not about where the toolchains live: a directory under the test's own tmpdir is enough.
// The path is only a name to the pure constructors; the runner creates it under this root.
export const runtimeOptionsRoot = join(tmpdir(), "msf-test-toolchains");
