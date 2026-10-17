import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { PROFILE_NPM_STAMP } from "../src/runtime/docker-invocation.js";

// The setup scripts run inside the container; here they run on this machine against a throwaway HOME and
// stand-in `pi`, `npm`, `mise` and `flock` binaries. The scripts themselves are the ones the image ships:
// nothing is copied, and the externals are what a container has (a fake that models the real one where
// the contract is observable: npm installs from the lock, mise installs the declared tools and answers a
// probe, flock serializes).

const run = promisify(execFile);
const IMAGE_DIR = join(import.meta.dirname, "..", "src", "runtime", "docker-image");

interface Home {
  root: string;
  agent: string;
  bin: string;
  log: string; // every stand-in appends its invocation here
  mise: string; // the persistent mise data dir (the container's, here under the throwaway HOME)
}

async function home(settings: unknown): Promise<Home> {
  const root = await mkdtemp(join(tmpdir(), "msf-scripts-"));
  const agent = join(root, ".pi", "agent");
  await mkdir(agent, { recursive: true });
  await writeFile(join(agent, "settings.json"), JSON.stringify(settings));
  const bin = join(root, "bin");
  await mkdir(bin);
  return { root, agent, bin, log: join(root, "calls.log"), mise: join(root, ".local", "share", "mise") };
}

// The env the container gives the scripts, made deterministic: no host mise variable or host shim leaks
// in (the operator's own rtk shim is not the container's), and node is the one running this test.
const envOf = (h: Home, over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  HOME: h.root,
  PATH: [h.bin, dirname(process.execPath), "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"].join(":"),
  MISE_DATA_DIR: h.mise,
  ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
  ...over,
});

const write = async (path: string, text: string, mode = 0o644): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  await chmod(path, mode);
};

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function script(name: string, args: string[], env: NodeJS.ProcessEnv): Promise<Result> {
  try {
    const { stdout, stderr } = await run("sh", [join(IMAGE_DIR, name), ...args], { env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

// installable: sources `pi install` accepts; preinstalled: what `pi list` reports as installed.
async function fakePi(h: Home, preinstalled: string[] = []) {
  await write(join(h.bin, "pi"), `#!/bin/sh
state="${h.root}/installed"
touch "$state"
echo "User packages:"
for p in $(node -e 'for (const e of JSON.parse(require("fs").readFileSync(process.env.PI_CODING_AGENT_DIR + "/settings.json","utf8")).packages || []) console.log(typeof e === "string" ? e : e.source)'); do
  echo "  $p (filtered)"
  if grep -qx "$p" "$state"; then echo "    /home/agent/.pi/agent/npm/node_modules/$p"; fi
done
`, 0o755);
  await writeFile(join(h.root, "installed"), preinstalled.map((p) => `${p}\n`).join(""));
}

// npm honours the tree the script installs: success creates node_modules, failure leaves only the lock.
async function fakeNpm(h: Home, options: { fail?: boolean } = {}) {
  await write(join(h.bin, "npm"), `#!/bin/sh
echo "npm $*" >> "${h.log}"
${options.fail ? 'echo "npm: simulated failure" >&2; exit 1' : 'mkdir -p node_modules; exit 0'}
`, 0o755);
}

// mise models the declaration: the probe exits 0 only when every declared tool is installed, and the
// install creates the tool and its shim. A declaration with no tools converges nothing.
async function fakeMise(h: Home) {
  await write(join(h.bin, "mise"), `#!/bin/sh
echo "mise $*" >> "${h.log}"
case "$1" in
  install)
    dry=0
    for a in "$@"; do [ "$a" = "--dry-run-code" ] && dry=1; done
    tools=$(awk '/^\\[tools\\]/{f=1;next} /^\\[/{f=0} f && /^[A-Za-z0-9_-]+ *=/{sub(/ *=.*/,"");print}' "$MISE_CONFIG_DIR/config.toml" 2>/dev/null || true)
    if [ "$dry" = 1 ]; then
      for t in $tools; do [ -e "${h.mise}/installs/$t" ] || exit 1; done
      exit 0
    fi
    for t in $tools; do
      mkdir -p "${h.mise}/installs/$t" "${h.mise}/shims"
      printf '#!/bin/sh\\necho "%s"\\n' "$t" > "${h.mise}/shims/$t"
      chmod +x "${h.mise}/shims/$t"
    done
    exit 0 ;;
esac
exit 0
`, 0o755);
}

// busy: the non-blocking attempt fails, so the script waits for the blocking one.
async function fakeFlock(h: Home, options: { busy?: boolean } = {}) {
  await write(join(h.bin, "flock"), `#!/bin/sh
echo "flock $*" >> "${h.log}"
${options.busy ? 'case "$1" in -n) exit 1 ;; *) sleep 0.2; exit 0 ;; esac' : "exit 0"}
`, 0o755);
}

// A snapshot like writeSnapshot leaves it: the profile files, the operator's lock and mise declaration.
async function snapshot(h: Home, options: { tools?: string[] } = {}): Promise<string> {
  const dir = join(h.root, "snapshot");
  await write(join(dir, "settings.json"), JSON.stringify({ packages: [{ source: "npm:pi-subagents", prompts: [] }, "npm:other"] }));
  await write(join(dir, "npm", "package.json"), JSON.stringify({ name: "profile", dependencies: { "pi-subagents": "1.0.0" } }));
  await write(join(dir, "npm", "package-lock.json"), JSON.stringify({ name: "profile", lockfileVersion: 3, packages: {} }));
  const tools = options.tools ?? ["rtk"];
  await write(join(dir, "mise", "config.toml"), `[tools]\n${tools.map((tool) => `${tool} = "latest"`).join("\n")}\n`);
  return dir;
}

const calls = async (h: Home): Promise<string[]> =>
  (await readFile(h.log, "utf8").catch(() => "")).split("\n").filter((line) => line !== "");

const converge = (h: Home, snapshotDir: string, tools: string[] = [], over: NodeJS.ProcessEnv = {}) =>
  script("converge-profile.sh", [snapshotDir, ...tools], envOf(h, over));

const check = (h: Home, required: string[] = []) => script("check-profile.sh", required, envOf(h));

test("the prepare script copies the profile into the writable Pi directory, keeps auth.json private and leaves the converged trees alone", async () => {
  const h = await home({});
  const snap = await snapshot(h);
  await write(join(snap, "auth.json"), "{}", 0o644);
  await write(join(snap, "skills", "tdd", "SKILL.md"), "tdd\n");
  const result = await script("prepare-profile.sh", [snap], envOf(h));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(join(h.agent, "skills", "tdd", "SKILL.md"), "utf8"), "tdd\n");
  assert.equal((await stat(join(h.agent, "auth.json"))).mode & 0o777, 0o600);
  // The lock and the declaration are NOT copied into the agent directory: converge-profile.sh installs
  // the tree from them and reads the declaration from the snapshot itself.
  await assert.rejects(() => stat(join(h.agent, "npm", "package.json")));
  await assert.rejects(() => stat(join(h.agent, "mise")));
});

test("the first run installs the Pi packages from the lock and the declared tools, and the required tool answers", async () => {
  const h = await home({});
  const snap = await snapshot(h);
  await fakeNpm(h);
  await fakeMise(h);
  await fakeFlock(h);
  const result = await converge(h, snap, ["rtk"]);
  assert.equal(result.code, 0, result.stderr);
  const logged = await calls(h);
  assert.ok(logged.some((line) => line.startsWith("npm ci ")), JSON.stringify(logged));
  assert.ok(logged.some((line) => line === "mise install --yes"), JSON.stringify(logged));
  assert.ok(logged.some((line) => line.startsWith("flock ")), "the convergence is serialized");
  // The stamp proves the tree came from this lock, and the shim proves the tool answers.
  assert.match(await readFile(join(h.agent, "npm", PROFILE_NPM_STAMP), "utf8"), /^[0-9a-f]{64}$/);
  assert.equal((await stat(join(h.mise, "shims", "rtk"))).isFile(), true);
});

test("a second run installs nothing, prints nothing and needs no network", async () => {
  const h = await home({});
  const snap = await snapshot(h);
  await fakeNpm(h);
  await fakeMise(h);
  await fakeFlock(h);
  assert.equal((await converge(h, snap, ["rtk"])).code, 0);
  const before = await calls(h);
  // Network off: any install attempt fails hard. Only the probe may run.
  await fakeNpm(h, { fail: true });
  const second = await converge(h, snap, ["rtk"]);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual({ stdout: second.stdout, stderr: second.stderr }, { stdout: "", stderr: "" });
  const after = (await calls(h)).slice(before.length);
  assert.ok(!after.some((line) => line.startsWith("npm ")), JSON.stringify(after));
  assert.ok(!after.some((line) => line === "mise install --yes"), JSON.stringify(after));
  assert.ok(after.some((line) => line === "mise install --dry-run-code"), "the fast probe runs");
});

test("a changed lock reinstalls, and an interrupted install is redone on the next start", async () => {
  const h = await home({});
  const snap = await snapshot(h);
  await fakeNpm(h, { fail: true });
  await fakeMise(h);
  await fakeFlock(h);
  const interrupted = await converge(h, snap, []);
  assert.equal(interrupted.code, 1);
  assert.match(interrupted.stderr, /Pi packages could not be converged/);
  await assert.rejects(() => stat(join(h.agent, "npm", PROFILE_NPM_STAMP)), "an interrupted install leaves no stamp");

  await fakeNpm(h);
  assert.equal((await converge(h, snap, [])).code, 0);
  assert.match(await readFile(join(h.agent, "npm", PROFILE_NPM_STAMP), "utf8"), /^[0-9a-f]{64}$/);

  // The lock changed: the stamp no longer matches, so the tree is installed again.
  const before = (await calls(h)).length;
  await write(join(snap, "npm", "package-lock.json"), JSON.stringify({ name: "profile", lockfileVersion: 3, packages: { "": { version: "2.0.0" } } }));
  const changed = await converge(h, snap, []);
  assert.equal(changed.code, 0, changed.stderr);
  assert.ok((await calls(h)).slice(before).some((line) => line.startsWith("npm ci ")), "a changed lock reinstalls");
});

test("two invocations do not install over each other: the second waits and finds the tree converged", async () => {
  const h = await home({});
  const snap = await snapshot(h);
  await fakeNpm(h);
  await fakeMise(h);
  await fakeFlock(h);
  assert.equal((await converge(h, snap, ["rtk"])).code, 0);
  // Contention, with an npm that fails if it is ever reached: the waiting run must not install.
  await fakeNpm(h, { fail: true });
  await fakeFlock(h, { busy: true });
  const second = await converge(h, snap, ["rtk"]);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stderr, /waiting for another invocation/);
  const logged = await calls(h);
  assert.ok(logged.includes("flock -n 9"), JSON.stringify(logged));
  assert.ok(logged.includes("flock 9"), JSON.stringify(logged));
  assert.equal(logged.filter((line) => line.startsWith("npm ci ")).length, 1, "only the first run installed");
});

test("a required tool the declaration does not provide stops the invocation with its name", async () => {
  const h = await home({});
  const snap = await snapshot(h, { tools: [] });
  await fakeNpm(h);
  await fakeMise(h);
  await fakeFlock(h);
  const result = await converge(h, snap, ["rtk"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /required tool not found on PATH: rtk/);
});

test("a declaration that cannot be converged stops the invocation with its reason", async () => {
  const h = await home({});
  const snap = await snapshot(h);
  await fakeNpm(h);
  await fakeFlock(h);
  await write(join(h.bin, "mise"), `#!/bin/sh
echo "mise $*" >> "${h.log}"
case "$1" in
  install)
    for a in "$@"; do [ "$a" = "--dry-run-code" ] && exit 1; done
    echo "mise: simulated failure" >&2; exit 1 ;;
esac
exit 0
`, 0o755);
  const result = await converge(h, snap, []);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /mise toolchain could not be converged/);
});

test("with no host lock there is nothing to converge, and the run keeps working", async () => {
  const h = await home({});
  const snap = join(h.root, "snapshot");
  await write(join(snap, "settings.json"), "{}");
  await write(join(snap, "mise", "config.toml"), "");
  await fakeNpm(h);
  await fakeMise(h);
  await fakeFlock(h);
  const result = await converge(h, snap, []);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual({ stdout: result.stdout, stderr: result.stderr }, { stdout: "", stderr: "" });
  const logged = await calls(h);
  assert.ok(!logged.some((line) => line.startsWith("npm ")), JSON.stringify(logged));
  assert.ok(!logged.some((line) => line === "mise install --yes"), JSON.stringify(logged));
});

test("the check confirms the required packages of the converged tree and installs nothing", async () => {
  const h = await home({ packages: [{ source: "npm:pi-subagents", prompts: [] }, "npm:other"] });
  await fakePi(h, ["npm:pi-subagents"]);
  const result = await check(h, ["npm:pi-subagents"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "", "a confirmed check prints nothing");
});

test("a required package that is not in the converged tree stops the invocation with its name", async () => {
  const h = await home({ packages: ["npm:pi-subagents"] });
  await fakePi(h, []);
  const result = await check(h, ["npm:pi-subagents"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /required package not installed: npm:pi-subagents/);
});

test("a package of the settings that is not required and not installed does not stop the job", async () => {
  const h = await home({ packages: ["npm:pi-subagents", "npm:other"] });
  await fakePi(h, ["npm:pi-subagents"]);
  const result = await check(h, ["npm:pi-subagents"]);
  assert.equal(result.code, 0, result.stderr);
});

test("with nothing required the check only reads the tree", async () => {
  const h = await home({ packages: [] });
  await fakePi(h, []);
  assert.equal((await check(h)).code, 0);
});
