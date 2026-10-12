import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

// The two setup scripts run inside the container. Here they run on this machine against a throwaway HOME and a
// stand-in `pi` that behaves like Pi 1.1.0 where it matters: `pi list` prints the installed path of a package
// on the line below it, and prints nothing below a package that is only declared in settings.json.

const run = promisify(execFile);
const IMAGE_DIR = join(import.meta.dirname, "..", "src", "runtime", "docker-image");

async function home(settings: unknown) {
  const root = await mkdtemp(join(tmpdir(), "msf-scripts-"));
  const agent = join(root, ".pi", "agent");
  await mkdir(agent, { recursive: true });
  await writeFile(join(agent, "settings.json"), JSON.stringify(settings));
  const bin = join(root, "bin");
  await mkdir(bin);
  return { root, agent, bin };
}

// installable: sources `pi install` accepts. Everything accepted is then listed with a path.
async function fakePi(bin: string, root: string, installable: string[], preinstalled: string[] = []) {
  const script = `#!/bin/sh
state="${root}/installed"
touch "$state"
case "$1" in
  install)
    case " ${installable.join(" ")} " in
      *" $2 "*) echo "$2" >> "$state"; echo "Installed $2" ;;
      *) echo "install failed: $2" >&2; exit 1 ;;
    esac ;;
  list)
    echo "User packages:"
    for p in $(node -e 'for (const e of JSON.parse(require("fs").readFileSync(process.env.PI_CODING_AGENT_DIR + "/settings.json","utf8")).packages || []) console.log(typeof e === "string" ? e : e.source)'); do
      echo "  $p (filtered)"
      if grep -qx "$p" "$state"; then echo "    /home/agent/.pi/agent/npm/node_modules/$p"; fi
    done ;;
esac
`;
  await writeFile(join(bin, "pi"), script);
  await chmod(join(bin, "pi"), 0o755);
  await writeFile(join(root, "installed"), preinstalled.map((p) => `${p}\n`).join(""));
}

async function check(h: { root: string; bin: string }, ...required: string[]) {
  try {
    const { stderr } = await run("sh", [join(IMAGE_DIR, "check-profile.sh"), ...required], {
      env: { ...process.env, HOME: h.root, PATH: `${h.bin}:${process.env.PATH}` },
    });
    return { code: 0, stderr };
  } catch (error) {
    const failure = error as { code: number; stderr: string };
    return { code: failure.code, stderr: failure.stderr };
  }
}

test("the check installs the packages of settings.json and passes when the required ones are installed", async () => {
  const h = await home({ packages: [{ source: "npm:pi-subagents", prompts: [] }, "npm:other"] });
  await fakePi(h.bin, h.root, ["npm:pi-subagents", "npm:other"]);
  const result = await check(h, "npm:pi-subagents");
  assert.equal(result.code, 0, result.stderr);
  assert.match(await readFile(join(h.root, "installed"), "utf8"), /npm:pi-subagents/);
});

test("a required package that only appears in settings.json, not installed, stops the invocation with its name", async () => {
  const h = await home({ packages: ["npm:pi-subagents"] });
  await fakePi(h.bin, h.root, []); // the install fails
  const result = await check(h, "npm:pi-subagents");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /required package not installed: npm:pi-subagents/);
});

test("a package that is not required may fail to install without stopping the job; it is reported", async () => {
  const h = await home({ packages: ["npm:pi-subagents", "npm:flaky"] });
  await fakePi(h.bin, h.root, ["npm:pi-subagents"]);
  const result = await check(h, "npm:pi-subagents");
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /could not install package npm:flaky/);
});

test("with nothing required the check only installs", async () => {
  const h = await home({ packages: [] });
  await fakePi(h.bin, h.root, []);
  assert.equal((await check(h)).code, 0);
});

test("the prepare script copies the snapshot into the writable Pi directory and keeps auth.json private", async () => {
  const root = await mkdtemp(join(tmpdir(), "msf-prepare-"));
  const snapshot = join(root, "snapshot");
  await mkdir(join(snapshot, "skills", "tdd"), { recursive: true });
  await writeFile(join(snapshot, "settings.json"), "{}");
  await writeFile(join(snapshot, "auth.json"), "{}");
  await chmod(join(snapshot, "auth.json"), 0o644);
  await writeFile(join(snapshot, "skills", "tdd", "SKILL.md"), "tdd\n");
  await run("sh", [join(IMAGE_DIR, "prepare-profile.sh"), snapshot], { env: { ...process.env, HOME: join(root, "home") } });
  const agent = join(root, "home", ".pi", "agent");
  assert.equal(await readFile(join(agent, "skills", "tdd", "SKILL.md"), "utf8"), "tdd\n");
  assert.equal((await stat(join(agent, "auth.json"))).mode & 0o777, 0o600);
});
