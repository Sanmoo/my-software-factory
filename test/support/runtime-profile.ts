import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RuntimeProfileConfig } from "../../src/config/types.js";

// A runtime profile declaration like the pilot's, shared by the tests that build a runner.
export const DECLARATION: RuntimeProfileConfig = {
  required: { files: ["settings.json", "auth.json"], packages: ["npm:pi-subagents"], skills: [], agents: [] },
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

// The two runner options that carry the declaration of one profile name.
export const runtimeOptions = (name: string, declaration: RuntimeProfileConfig = DECLARATION) => ({
  runtimeProfiles: { [name]: declaration },
  allowedRoots: { [name]: [] as string[] },
});
