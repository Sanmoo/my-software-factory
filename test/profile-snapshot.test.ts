import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import type { RuntimeProfileConfig } from "../src/config/types.js";
import { checkRequired, describePlan, planSnapshot, writeSnapshot } from "../src/runtime/profile-snapshot.js";

// The resolver is tested on real directories and real links: the behavior is what the file system does
// with chains, cycles and broken links, so a fake of it would only repeat the implementation.

const SETTINGS = { packages: [{ source: "npm:pi-subagents", prompts: [] }, "npm:pi-lens", "npm:other"] };

interface World {
  base: string;
  profile: string; // the profile directory, itself reached by links
  roots: string[]; // allowed roots
  put(path: string, text?: string): Promise<void>;
  link(path: string, target: string): Promise<void>;
}

async function world(): Promise<World> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "msf-profile-")));
  const put = async (path: string, text = "x\n") => {
    await mkdir(dirname(join(base, path)), { recursive: true });
    await writeFile(join(base, path), text);
  };
  const link = async (path: string, target: string) => {
    await mkdir(dirname(join(base, path)), { recursive: true });
    await symlink(target, join(base, path));
  };
  return {
    base, put, link,
    profile: join(base, "deere/agent"),
    roots: [join(base, "pi/agent"), join(base, "agents"), join(base, "dotfiles")],
  };
}

const requirements = (over: Partial<RuntimeProfileConfig["required"]> = {}, excludePackages: string[] = ["npm:pi-lens"]): RuntimeProfileConfig => ({
  required: { files: ["settings.json"], packages: ["npm:pi-subagents"], skills: [], agents: [], tools: [], ...over },
  excludePackages,
});

// ~/.pi-deere/agent/skills -> ~/.pi/agent/skills -> ~/.agents/skills/tdd -> dotfiles/tdd: four levels.
async function layered(w: World) {
  await w.put("dotfiles/settings.json", JSON.stringify(SETTINGS));
  await w.put("dotfiles/tdd/SKILL.md", "tdd\n");
  await w.put("dotfiles/agents/implementer.md", "agent\n");
  await w.link("deere/agent/settings.json", "../../dotfiles/settings.json");
  await w.link("deere/agent/skills", "../../pi/agent/skills");
  await w.link("pi/agent/skills/tdd", "../../../agents/skills/tdd");
  await w.link("agents/skills/tdd", "../../dotfiles/tdd");
  await w.link("deere/agent/agents", "../../dotfiles/agents");
}

const paths = (items: Array<{ path: string }>) => items.map((item) => item.path).sort();

test("links are resolved at every level, from the profile down to the real file", async () => {
  const w = await world();
  await layered(w);
  const plan = await planSnapshot({ dir: w.profile, allowedRoots: w.roots }, requirements({ skills: ["tdd"], agents: ["implementer"] }));
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(paths(plan.included), ["agents/implementer.md", "settings.json", "skills/tdd/SKILL.md"]);
  const skill = plan.included.find((item) => item.path === "skills/tdd/SKILL.md")!;
  assert.equal(skill.source, join(w.base, "dotfiles/tdd/SKILL.md"));
});

test("the snapshot holds real files only and a copy of settings.json without the excluded packages", async () => {
  const w = await world();
  await layered(w);
  const plan = await planSnapshot({ dir: w.profile, allowedRoots: w.roots }, requirements({ skills: ["tdd"] }));
  const out = join(w.base, "snapshot");
  await writeSnapshot(plan, out);

  const entries: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      assert.equal((await lstat(path)).isSymbolicLink(), false, `${path} must not be a link`);
      if (entry.isDirectory()) await walk(path);
      else entries.push(relative(out, path));
    }
  };
  await walk(out);
  assert.deepEqual(entries.sort(), ["agents/implementer.md", "settings.json", "skills/tdd/SKILL.md"]);
  assert.equal(await readFile(join(out, "skills/tdd/SKILL.md"), "utf8"), "tdd\n");
  const settings = JSON.parse(await readFile(join(out, "settings.json"), "utf8"));
  assert.deepEqual(settings.packages, [{ source: "npm:pi-subagents", prompts: [] }, "npm:other"]);
  assert.deepEqual(plan.excluded, ["npm:pi-lens"]);
  // The host's own settings.json is untouched.
  assert.match(await readFile(join(w.base, "dotfiles/settings.json"), "utf8"), /pi-lens/);
});

test("a link cycle inside a required skill skips that item, lists it and does not block", async () => {
  const w = await world();
  await layered(w);
  // ~/.agents/skills/gh-address-comments/gh-address-comments -> .   (the cycle seen in the operator's profile)
  await w.put("dotfiles/gh/SKILL.md", "gh\n");
  await w.link("dotfiles/gh/gh-address-comments", ".");
  await w.link("agents/skills/gh-address-comments", "../../dotfiles/gh");
  await w.link("pi/agent/skills/gh-address-comments", "../../../agents/skills/gh-address-comments");
  const plan = await planSnapshot({ dir: w.profile, allowedRoots: w.roots }, requirements({ skills: ["gh-address-comments"] }));
  assert.deepEqual(plan.blockers, []);
  assert.ok(plan.included.some((item) => item.path === "skills/gh-address-comments/SKILL.md"));
  const skipped = plan.skipped.find((item) => item.path === "skills/gh-address-comments/gh-address-comments");
  assert.ok(skipped, JSON.stringify(plan.skipped));
  assert.match(skipped.reason, /cíclico/);
});

test("two links pointing at each other are cyclic, a broken one is broken: both are skipped when not required", async () => {
  const w = await world();
  await layered(w);
  await w.link("pi/agent/skills/ping", "pong");
  await w.link("pi/agent/skills/pong", "ping");
  await w.link("pi/agent/skills/gone", "../../../agents/skills/nowhere");
  const plan = await planSnapshot({ dir: w.profile, allowedRoots: w.roots }, requirements({ skills: ["tdd"] }));
  assert.deepEqual(plan.blockers, []);
  const reasons = Object.fromEntries(plan.skipped.map((item) => [item.path, item.reason]));
  assert.match(reasons["skills/ping"] ?? "", /cíclico/);
  assert.match(reasons["skills/gone"] ?? "", /quebrado/);
  assert.match(reasons["skills/gone"] ?? "", /nowhere/, "the reason names the destination");
});

test("a destination outside the allowed roots is not followed: skipped when optional, a block when required", async () => {
  const w = await world();
  await layered(w);
  await w.put("work-repo/secret/SKILL.md", "work\n");
  await w.link("pi/agent/skills/workonly", "../../../work-repo/secret");
  const optional = await planSnapshot({ dir: w.profile, allowedRoots: w.roots }, requirements({ skills: ["tdd"] }));
  assert.deepEqual(optional.blockers, []);
  assert.ok(!optional.included.some((item) => item.path.startsWith("skills/workonly")));
  const skipped = optional.skipped.find((item) => item.path === "skills/workonly");
  assert.match(skipped?.reason ?? "", /fora das raízes permitidas/);

  const required = await planSnapshot({ dir: w.profile, allowedRoots: w.roots }, requirements({ skills: ["tdd", "workonly"] }));
  assert.equal(required.blockers.length, 1);
  const [blocker] = required.blockers;
  assert.match(blocker!, /skills\/workonly\/SKILL\.md/, "names the item");
  assert.match(blocker!, /deere\/agent\/skills\/workonly ->/, "names the link");
  assert.match(blocker!, /work-repo\/secret/, "names the destination");
});

test("a missing required item blocks and says which; settings.json without a required package blocks too", async () => {
  const w = await world();
  await layered(w);
  const blockers = await checkRequired(
    { dir: w.profile, allowedRoots: w.roots },
    requirements({ files: ["settings.json", "auth.json"], skills: ["tdd", "absent"], agents: ["reviewer"], packages: ["npm:pi-subagents", "npm:missing-pkg"] }),
  );
  const text = blockers.join("\n");
  assert.match(text, /auth\.json/);
  assert.match(text, /skills\/absent\/SKILL\.md/);
  assert.match(text, /agents\/reviewer\.md/);
  assert.match(text, /npm:missing-pkg/);
  assert.doesNotMatch(text, /tdd/);
  assert.doesNotMatch(text, /npm:pi-subagents/);
});

test("an optional item that is absent is not an error and nothing is invented for it", async () => {
  const w = await world();
  await layered(w);
  const plan = await planSnapshot({ dir: w.profile, allowedRoots: w.roots }, requirements({ skills: ["tdd"] }));
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.skipped, []);
});

test("the profile directory itself is always an allowed root and an unreadable profile blocks", async () => {
  const w = await world();
  await w.put("deere/agent/settings.json", JSON.stringify(SETTINGS));
  const plan = await planSnapshot({ dir: w.profile, allowedRoots: [] }, requirements());
  assert.deepEqual(plan.blockers, []);
  const missing = await checkRequired({ dir: join(w.base, "nope"), allowedRoots: [] }, requirements());
  assert.match(missing.join("\n"), /perfil .*nope/);
});

test("an invalid settings.json blocks: the packages cannot be known", async () => {
  const w = await world();
  await w.put("deere/agent/settings.json", "{not json");
  const blockers = await checkRequired({ dir: w.profile, allowedRoots: [] }, requirements());
  assert.match(blockers.join("\n"), /settings\.json.*JSON inválido/);
});

test("the plan is described for the log: what went in, what stayed out and why", async () => {
  const w = await world();
  await layered(w);
  await w.link("pi/agent/skills/gone", "../../../agents/skills/nowhere");
  const plan = await planSnapshot({ dir: w.profile, allowedRoots: w.roots }, requirements({ skills: ["tdd"] }));
  const lines = describePlan(plan);
  assert.ok(lines.includes("incluído: settings.json"));
  assert.ok(lines.includes("incluído: skills/tdd/SKILL.md"));
  assert.ok(lines.some((line) => line.startsWith("fora: skills/gone") && /quebrado/.test(line)));
  assert.ok(lines.includes("pacote excluído do settings.json do container: npm:pi-lens"));
});

test("file modes survive the copy so auth.json stays private", async () => {
  const w = await world();
  await w.put("deere/agent/settings.json", JSON.stringify(SETTINGS));
  await w.put("deere/agent/auth.json", "{}");
  await chmod(join(w.profile, "auth.json"), 0o600);
  const plan = await planSnapshot({ dir: w.profile, allowedRoots: [] }, requirements({ files: ["settings.json", "auth.json"] }));
  const out = join(w.base, "snap");
  await writeSnapshot(plan, out);
  assert.equal((await stat(join(out, "auth.json"))).mode & 0o777, 0o600);
});

// The toolchain converges from the operator's own declaration (ADR 0004): the snapshot carries the
// package declaration and its lock, and the mise declaration, as real files.
test("the snapshot carries the lock and the mise declaration as real files and never walks node_modules", async () => {
  const w = await world();
  await layered(w);
  await w.put("dotfiles/npm/package.json", '{"name":"profile"}\n');
  await w.put("dotfiles/npm/package-lock.json", '{"lockfileVersion":3}\n');
  await w.put("dotfiles/npm/node_modules/pi-subagents/index.js", "x\n");
  await w.link("pi/agent/npm", "../../dotfiles/npm");
  await w.link("deere/agent/npm", "../../pi/agent/npm");
  await w.put("dotfiles/mise/config.toml", '[tools]\nrtk = "latest"\n');
  const mise = join(w.base, "dotfiles/mise/config.toml");
  const plan = await planSnapshot(
    { dir: w.profile, allowedRoots: w.roots, mise },
    requirements({ skills: ["tdd"], tools: ["rtk"] }),
  );
  assert.deepEqual(plan.blockers, []);
  const sources = Object.fromEntries(plan.included.map((item) => [item.path, item.source]));
  assert.equal(sources["npm/package.json"], join(w.base, "dotfiles/npm/package.json"));
  assert.equal(sources["npm/package-lock.json"], join(w.base, "dotfiles/npm/package-lock.json"));
  assert.equal(sources["mise/config.toml"], mise);
  assert.ok(!plan.included.some((item) => item.path.startsWith("npm/node_modules")), "the host's own tree is never carried");

  const out = join(w.base, "snapshot");
  await writeSnapshot(plan, out);
  assert.equal(await readFile(join(out, "npm", "package-lock.json"), "utf8"), '{"lockfileVersion":3}\n');
  assert.match(await readFile(join(out, "mise", "config.toml"), "utf8"), /rtk/);
  const lines = describePlan(plan);
  assert.ok(lines.includes("incluído: npm/package-lock.json"));
  assert.ok(lines.includes("incluído: mise/config.toml"));
});

test("a required tool needs the operator's mise declaration; without it the job is blocked with the reason", async () => {
  const w = await world();
  await layered(w);
  const blocked = await checkRequired({ dir: w.profile, allowedRoots: w.roots }, requirements({ tools: ["rtk"] }));
  assert.match(blocked.join("\n"), /ferramentas obrigatórias \(rtk\): .*local\.yaml/);

  // Declared, but the file is not there: the reason names the declaration, and the optional case only skips it.
  const absent = join(w.base, "dotfiles/mise/config.toml");
  const missingRequired = await checkRequired({ dir: w.profile, allowedRoots: w.roots, mise: absent }, requirements({ tools: ["rtk"] }));
  assert.match(missingRequired.join("\n"), /ferramentas obrigatórias \(rtk\): declaração de mise .*ausente/);
  const optional = await planSnapshot({ dir: w.profile, allowedRoots: w.roots, mise: absent }, requirements());
  assert.deepEqual(optional.blockers, []);
  assert.match(optional.skipped.map((item) => `${item.path} ${item.reason}`).join("\n"), /mise\/config\.toml .*ausente/);
});
