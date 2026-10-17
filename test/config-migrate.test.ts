import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runConfigMigration } from "../src/cli/migrate.js";
import { parseYamlDocument } from "../src/config/yaml.js";
import { parseLocalSettings } from "../src/cli/local-settings.js";
import { parseConfig } from "../src/config/validate.js";

// `npm run config:migrate -- --home DIR` (ticket #72): one explicit command converts the old JSON
// files, keeps their data, preserves the originals as backups and never prints a configured value.

const CONFIG = {
  credentials: { copilot: { kind: "pi-auth", ref: "copilot" } },
  runtimeProfiles: { "docker-default": { required: { files: ["settings.json"], packages: ["npm:pi-subagents"] }, excludePackages: [] } },
  instances: [{
    name: "pessoal", maxConcurrent: 1, pollIntervalSeconds: 300, maxIterations: 3, modelAuth: "copilot",
    projects: [{
      name: "app", enabled: true, adapter: "github", repository: "acme/app", targetBranch: "main",
      prIntegration: "github.com", runtimeProfile: "docker-default", githubAccount: "acme",
      labels: { ready: "ready-for-agent", claimed: "agent-claimed" },
      models: { implementer: "acme/um", "reviewer-standards": "acme/um", "reviewer-spec": "acme/um", default: "acme/um" },
    }],
  }],
};

const localWith = (root: string) => ({
  image: "msf-docker-runner:local",
  profiles: { copilot: join(root, "perfil") },
  allowedRoots: { "docker-default": [join(root, "raizes")] },
  checkouts: { "acme/app": join(root, "clone") },
});

interface Prepared { root: string; home: string }

async function prepared(): Promise<Prepared> {
  const root = await mkdtemp(join(tmpdir(), "msf-migrate-"));
  const home = join(root, ".msf");
  await mkdir(home, { recursive: true });
  return { root, home };
}

const writeJson = (path: string, value: unknown): Promise<void> => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

async function converted(home: string, role: "config" | "local"): Promise<unknown> {
  const parsed = parseYamlDocument(await readFile(join(home, `${role}.yaml`), "utf8"));
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.message);
  return parsed.ok ? parsed.value : undefined;
}

test("converts config.json and local.json, keeps the same data and preserves the originals as .bak", async () => {
  const { root, home } = await prepared();
  const config = { ...CONFIG, instances: CONFIG.instances.map((instance) => ({ ...instance, name: "pessoal" })) };
  const local = localWith(root);
  await writeJson(join(home, "config.json"), config);
  await writeJson(join(home, "local.json"), local);

  const run = await runConfigMigration(["--home", home], root);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.match(run.stdout, /config\.json → .*config\.yaml/);
  assert.match(run.stdout, /local\.json → .*local\.yaml/);

  // The YAML files are the configuration the validators already accept, with the same meaning.
  const parsedConfig = parseConfig(await converted(home, "config"));
  assert.equal(parsedConfig.ok, true, JSON.stringify(parsedConfig.ok ? [] : parsedConfig.issues));
  const parsedLocal = parseLocalSettings(await converted(home, "local"));
  assert.deepEqual(parsedLocal, local);

  // The old names no longer block startup; the data stays in the backups.
  await assert.rejects(lstat(join(home, "config.json")));
  await assert.rejects(lstat(join(home, "local.json")));
  assert.deepEqual(JSON.parse(await readFile(join(home, "config.json.bak"), "utf8")), config);
  assert.deepEqual(JSON.parse(await readFile(join(home, "local.json.bak"), "utf8")), local);

  // The produced files are not readable by others.
  for (const name of ["config.yaml", "local.yaml"]) {
    const mode = (await stat(join(home, name))).mode & 0o777;
    assert.equal(mode, 0o600, `${name} tem permissões ${mode.toString(8)}`);
  }
});

test("a missing local.json is not required", async () => {
  const { root, home } = await prepared();
  await writeJson(join(home, "config.json"), CONFIG);
  const run = await runConfigMigration(["--home", home], root);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /local/);
  assert.equal((await converted(home, "config") !== undefined), true);
});

test("an existing YAML destination of either extension refuses the migration", async () => {
  for (const extension of ["yaml", "yml"]) {
    const { root, home } = await prepared();
    await writeJson(join(home, "config.json"), CONFIG);
    await writeJson(join(home, "local.json"), localWith(root));
    await writeFile(join(home, `local.${extension}`), "image: outra\n");
    const run = await runConfigMigration(["--home", home], root);
    assert.equal(run.exitCode, 1);
    assert.match(run.stderr, new RegExp(`destino YAML já existe: .*local\\.${extension}`));
    // Nothing moved: no YAML for config, both originals untouched, no backup.
    await assert.rejects(lstat(join(home, "config.yaml")));
    await assert.rejects(lstat(join(home, "config.json.bak")));
    assert.equal((await readFile(join(home, "local.json"), "utf8")).length > 0, true);
  }
});

test("an existing backup refuses the migration", async () => {
  const { root, home } = await prepared();
  await writeJson(join(home, "config.json"), CONFIG);
  await writeFile(join(home, "config.json.bak"), "{}");
  const run = await runConfigMigration(["--home", home], root);
  assert.equal(run.exitCode, 1);
  assert.match(run.stderr, /backup já existe: .*config\.json\.bak/);
  await assert.rejects(lstat(join(home, "config.yaml")));
});

test("a symlink among the involved files refuses the migration", async () => {
  const { root, home } = await prepared();
  const target = join(root, "fora.json");
  await writeJson(target, CONFIG);
  await symlink(target, join(home, "config.json"));
  const run = await runConfigMigration(["--home", home], root);
  assert.equal(run.exitCode, 1);
  assert.match(run.stderr, /link simbólico/);
  await assert.rejects(lstat(join(home, "config.yaml")));

  // The same for a destination or a backup that is a link.
  for (const linked of ["config.yaml", "config.json.bak"]) {
    const other = await prepared();
    await writeJson(join(other.home, "config.json"), CONFIG);
    await symlink(join(other.root, "fora.yaml"), join(other.home, linked));
    const refused = await runConfigMigration(["--home", other.home], other.root);
    assert.equal(refused.exitCode, 1);
    assert.match(refused.stderr, new RegExp(`${linked.replace(".", "\\.")} é um link simbólico`));
    await assert.rejects(lstat(join(other.root, "fora.yaml")), "nada é escrito através do link");
  }
});

test("an invalid JSON or a document the validators refuse is not converted", async () => {
  const { root, home } = await prepared();
  await writeFile(join(home, "config.json"), "{ isto não é json");
  const invalidJson = await runConfigMigration(["--home", home], root);
  assert.equal(invalidJson.exitCode, 1);
  assert.match(invalidJson.stderr, /não é JSON válido/);

  const second = await prepared();
  await writeJson(join(second.home, "config.json"), { ...CONFIG, instances: [{ ...CONFIG.instances[0], maxConcurrent: 0 }] });
  const invalidData = await runConfigMigration(["--home", second.home], second.root);
  assert.equal(invalidData.exitCode, 1);
  assert.match(invalidData.stderr, /não passa nas validações atuais/);
  await assert.rejects(lstat(join(second.home, "config.yaml")));
});

test("nothing to convert is an error, not an empty success", async () => {
  const { root, home } = await prepared();
  const run = await runConfigMigration(["--home", home], root);
  assert.equal(run.exitCode, 1);
  assert.match(run.stderr, /nenhum config\.json ou local\.json encontrado/);
});

test("the default base directory is .msf at the repository root", async () => {
  const root = await mkdtemp(join(tmpdir(), "msf-migrate-"));
  await mkdir(join(root, ".msf"), { recursive: true });
  await writeJson(join(root, ".msf", "config.json"), CONFIG);
  const run = await runConfigMigration([], root);
  assert.equal(run.exitCode, 0, run.stderr);
  assert.equal((await converted(join(root, ".msf"), "config") !== undefined), true);
});

test("no value of the configuration is printed", async () => {
  const { root, home } = await prepared();
  const secret = "VALOR-QUE-NAO-PODE-VAZAR";
  await writeJson(join(home, "config.json"), {
    ...CONFIG,
    credentials: { copilot: { kind: "pi-auth", ref: secret } },
  });
  const success = await runConfigMigration(["--home", home], root);
  assert.equal(success.exitCode, 0, success.stderr);
  assert.ok(!(success.stdout + success.stderr).includes(secret), "a saída de sucesso não imprime valores");
  const failureHome = await prepared();
  await writeJson(join(failureHome.home, "config.json"), {
    ...CONFIG,
    credentials: { copilot: { kind: "pi-auth", ref: secret } },
    instances: [{ ...CONFIG.instances[0], maxConcurrent: 0 }],
  });
  const failure = await runConfigMigration(["--home", failureHome.home], failureHome.root);
  assert.equal(failure.exitCode, 1);
  assert.ok(!(failure.stdout + failure.stderr).includes(secret), "a saída de falha não imprime valores");
});

test("a failure while writing removes what the run created and keeps the originals", async () => {
  const { root, home } = await prepared();
  await writeJson(join(home, "config.json"), CONFIG);
  await writeJson(join(home, "local.json"), localWith(root));
  let writes = 0;
  const run = await runConfigMigration(["--home", home], root, {
    writeRestricted: async (path, text) => {
      writes += 1;
      if (writes === 2) throw new Error("disco cheio");
      await writeFile(path, text, { mode: 0o600 });
    },
  });
  assert.equal(run.exitCode, 1);
  assert.match(run.stderr, /migração interrompida.*disco cheio/);
  assert.match(run.stderr, /não é atômica entre config e local/);
  assert.match(run.stderr, /o que esta execução criou foi revertido/);
  // Both originals are in place and no YAML is left behind.
  await assert.rejects(lstat(join(home, "config.yaml")));
  await assert.rejects(lstat(join(home, "local.yaml")));
  assert.deepEqual(JSON.parse(await readFile(join(home, "config.json"), "utf8")), CONFIG);
});

test("a failure while renaming brings the already renamed original back", async () => {
  const { root, home } = await prepared();
  await writeJson(join(home, "config.json"), CONFIG);
  await writeJson(join(home, "local.json"), localWith(root));
  let renames = 0;
  const run = await runConfigMigration(["--home", home], root, {
    rename: async (from, to) => {
      renames += 1;
      if (renames === 2) throw new Error("permissão negada");
      const { rename } = await import("node:fs/promises");
      await rename(from, to);
    },
  });
  assert.equal(run.exitCode, 1);
  // The first rename was undone and the created YAML removed: the base directory is as it was.
  assert.equal(JSON.parse(await readFile(join(home, "config.json"), "utf8")).instances[0].name, "pessoal");
  await assert.rejects(lstat(join(home, "config.json.bak")));
  await assert.rejects(lstat(join(home, "config.yaml")));
  await assert.rejects(lstat(join(home, "local.yaml")));
});

test("a failure that cannot be fully reverted names what stayed where", async () => {
  const { root, home } = await prepared();
  await writeJson(join(home, "config.json"), CONFIG);
  await writeJson(join(home, "local.json"), localWith(root));
  let renames = 0;
  const run = await runConfigMigration(["--home", home], root, {
    rename: async (from, to) => {
      renames += 1;
      const { rename } = await import("node:fs/promises");
      if (renames === 2) throw new Error("permissão negada");
      if (renames === 3) throw new Error("disco somente leitura");
      await rename(from, to);
    },
  });
  assert.equal(run.exitCode, 1);
  assert.match(run.stderr, /reversão incompleta/);
  assert.match(run.stderr, /config\.json não foi restaurado; os dados originais estão em .*config\.json\.bak/);
  // The data is still reachable in the backup, as the message says.
  assert.deepEqual(JSON.parse(await readFile(join(home, "config.json.bak"), "utf8")), CONFIG);
});
