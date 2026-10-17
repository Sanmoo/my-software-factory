import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverConfigFile, discoverLocalFile } from "../src/config/files.js";

// The base directory holds one YAML file per role (ticket #72). `.yaml` and `.yml` are both
// accepted, the choice is independent between the two roles, and the old JSON files are a
// migration error rather than something to read or ignore.

const homeDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "msf-home-"));
  return dir;
};

test("config.yaml and config.yml are both found", async () => {
  for (const extension of [".yaml", ".yml"]) {
    const home = await homeDir();
    const path = join(home, `config${extension}`);
    await writeFile(path, "credentials: {}\n");
    assert.deepEqual(await discoverConfigFile(home), { ok: true, path });
  }
});

test("the extension choice is independent between config and local", async () => {
  const home = await homeDir();
  await writeFile(join(home, "config.yml"), "credentials: {}\n");
  await writeFile(join(home, "local.yaml"), "image: x\n");
  assert.deepEqual(await discoverConfigFile(home), { ok: true, path: join(home, "config.yml") });
  assert.deepEqual(await discoverLocalFile(home), { ok: true, path: join(home, "local.yaml") });
});

test("two files for the same role are refused, naming both paths", async () => {
  const home = await homeDir();
  const yaml = join(home, "config.yaml");
  const yml = join(home, "config.yml");
  await writeFile(yaml, "credentials: {}\n");
  await writeFile(yml, "credentials: {}\n");
  const discovery = await discoverConfigFile(home);
  assert.equal(discovery.ok, false);
  if (discovery.ok) return;
  assert.match(discovery.message, /config\.yaml e .*config\.yml/);
  assert.ok(discovery.message.includes(yaml));
  assert.ok(discovery.message.includes(yml));
});

test("a missing file names the candidates it looked for", async () => {
  const home = await homeDir();
  const discovery = await discoverLocalFile(home);
  assert.equal(discovery.ok, false);
  if (discovery.ok) return;
  assert.ok(discovery.message.includes(join(home, "local.yaml")));
  assert.ok(discovery.message.includes(join(home, "local.yml")));
  assert.match(discovery.message, /--home/);
});

test("the old JSON is a migration error, also when the YAML file already exists", async () => {
  const home = await homeDir();
  const legacy = join(home, "config.json");
  await writeFile(legacy, JSON.stringify({ credentials: {} }));
  for (const prepared of [false, true]) {
    if (prepared) await writeFile(join(home, "config.yaml"), "credentials: {}\n");
    const discovery = await discoverConfigFile(home);
    assert.equal(discovery.ok, false, "o JSON antigo não é lido nem ignorado");
    if (discovery.ok) return;
    assert.ok(discovery.message.includes(legacy));
    assert.match(discovery.message, /JSON não é mais aceito/);
    assert.match(discovery.message, /npm run config:migrate -- --home/);
  }
});

test("the legacy JSON of one role does not block the other, which is asked for on its own", async () => {
  const home = await homeDir();
  await writeFile(join(home, "config.yaml"), "credentials: {}\n");
  await writeFile(join(home, "local.json"), JSON.stringify({ image: "x" }));
  assert.equal((await discoverConfigFile(home)).ok, true);
  assert.equal((await discoverLocalFile(home)).ok, false);
});
