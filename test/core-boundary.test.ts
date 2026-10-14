import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Layout rule (see the shared conventions): src/core/ is domain logic with no vendor concepts.
// Adapter-specific rules and scopes are chosen by the configuration layer and handed to the core.
const coreDir = fileURLToPath(new URL("../src/core/", import.meta.url));

test("core modules import no tracker adapter", async () => {
  const forbidden = /from "\.\.\/tracker\/(github|jira|jira-rules|memory)\.js"/;
  for (const name of (await readdir(coreDir)).filter((file) => file.endsWith(".ts"))) {
    const text = await readFile(`${coreDir}${name}`, "utf8");
    assert.doesNotMatch(text, forbidden, `src/core/${name} imports a tracker adapter`);
  }
});

test("core modules branch on no adapter name", async () => {
  const branch = /adapter\s*[!=]==?\s*["'](github|jira)["']/;
  for (const name of (await readdir(coreDir)).filter((file) => file.endsWith(".ts"))) {
    const text = await readFile(`${coreDir}${name}`, "utf8");
    assert.doesNotMatch(text, branch, `src/core/${name} branches on the adapter`);
  }
});

// The assisted flow's fs persistence (spec #48): every host-file operation of the session areas
// rides the `AssistAreaFs` port (src/state/file-assist-area-fs.ts holds the real one), so the
// core file imports no node runtime module at all.
test("src/core/assist-flow.ts imports no node:* runtime module", async () => {
  const text = await readFile(`${coreDir}assist-flow.ts`, "utf8");
  const nodeRuntime = /from "node:[^"]+"/;
  assert.doesNotMatch(text, nodeRuntime, "src/core/assist-flow.ts imports a node runtime module");
});
