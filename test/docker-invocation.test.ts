import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  COMPLETION_SIGNAL,
  effectiveIterationLimit,
  profilePreparationSteps,
  profileSetupCommand,
  profileToolchain,
  sandboxMounts,
  sandcastleRequest,
  SHARED_MISE_DIR,
} from "../src/runtime/docker-invocation.js";

test("a new invocation may use the configured Sandcastle iterations, and the effective limit is visible", () => {
  assert.equal(effectiveIterationLimit("new", 5), 5);
  assert.equal(effectiveIterationLimit("new", 3), 3);
});

test("resume and correction are always one iteration, whatever the configured limit", () => {
  assert.equal(effectiveIterationLimit("resume", 5), 1);
  assert.equal(effectiveIterationLimit("correction", 5), 1);
});

test("a limit must be a positive integer", () => {
  assert.throws(() => effectiveIterationLimit("new", 0), RangeError);
  assert.throws(() => effectiveIterationLimit("new", 1.5), RangeError);
});

test("a resume request keeps the session with exactly one iteration, as Sandcastle 0.12.0 requires", () => {
  const request = sandcastleRequest({ kind: "resume", prompt: "continue", configuredLimit: 5, sessionId: "s-1" });
  assert.equal(request.resumeSession, "s-1");
  assert.equal(request.maxIterations, 1);
  assert.equal(request.completionSignal, COMPLETION_SIGNAL);
});

test("a new request has no session and uses the configured limit", () => {
  const request = sandcastleRequest({ kind: "new", prompt: "implement", configuredLimit: 5 });
  assert.equal(request.resumeSession, undefined);
  assert.equal(request.maxIterations, 5);
});

test("a continuation without a recorded session is refused rather than starting a new conversation", () => {
  assert.throws(
    () => sandcastleRequest({ kind: "resume", prompt: "continue", configuredLimit: 5 }),
    /sem sessão Pi/,
  );
});

test("a new invocation never resumes an old session", () => {
  assert.throws(
    () => sandcastleRequest({ kind: "new", prompt: "implement", configuredLimit: 5, sessionId: "old" }),
    /não retoma sessão/,
  );
});

test("the container mounts the profile snapshot, the image scripts, the session directory and the profile's persistent toolchain, and nothing of the operator's profile", () => {
  const mounts = sandboxMounts({
    snapshotDir: "/state/areas/job/profile",
    sessionsDir: "/state/sessions/job",
    npmDir: "/home/op/.msf/toolchains/personal/npm",
    miseDir: "/home/op/.msf/toolchains/mise",
  }, "/repo/src/runtime/docker-image");
  assert.deepEqual(mounts, [
    { hostPath: "/state/areas/job/profile", sandboxPath: "/msf-profile", readonly: true },
    { hostPath: "/repo/src/runtime/docker-image", sandboxPath: "/msf-runtime", readonly: true },
    { hostPath: "/state/sessions/job", sandboxPath: "/home/agent/.pi/agent/sessions", readonly: false },
    { hostPath: "/home/op/.msf/toolchains/personal/npm", sandboxPath: "/home/agent/.pi/agent/npm", readonly: false },
    { hostPath: "/home/op/.msf/toolchains/mise", sandboxPath: "/home/agent/.local/share/mise", readonly: false },
  ]);
});

test("the persistent toolchain of a profile lives under the factory home: packages per profile, mise data shared", () => {
  assert.deepEqual(profileToolchain("/home/op/.msf/toolchains", "personal"), {
    base: "/home/op/.msf/toolchains/personal",
    npm: "/home/op/.msf/toolchains/personal/npm",
    // Spec #74: instalações, downloads, cache e estado num diretório persistente por `--home`,
    // COMPARTILHADO pelos perfis (o mesmo flock serializa a convergência de todos).
    mise: "/home/op/.msf/toolchains/mise",
  });
  // Dois perfis nunca dividem a árvore de pacotes, e um nome que subiria de diretório é codificado,
  // não seguido.
  assert.notEqual(profileToolchain("/t", "personal").base, profileToolchain("/t", "work").base);
  assert.notEqual(profileToolchain("/t", "personal").npm, profileToolchain("/t", "work").npm);
  assert.equal(profileToolchain("/t", "../work").base, "/t/..%2Fwork");
  // ...mas o diretório de dados do mise é o MESMO para os dois: uma convergência serve os dois perfis.
  assert.equal(profileToolchain("/t", "personal").mise, profileToolchain("/t", "work").mise);
  assert.equal(profileToolchain("/t", "personal").mise, join("/t", SHARED_MISE_DIR));
  assert.equal(dirname(profileToolchain("/t", "personal").npm), profileToolchain("/t", "personal").base,
    "a árvore de pacotes fica DENTRO do diretório do perfil");
  assert.notEqual(dirname(profileToolchain("/t", "personal").mise), profileToolchain("/t", "personal").base,
    "e o mise fica FORA dele");
});

test("the setup copies the snapshot, converges the toolchain once and checks the required packages and tools before the agent gets its prompt", () => {
  assert.equal(
    profileSetupCommand({ requiredPackages: ["npm:pi-subagents", "npm:two words"], requiredTools: ["rtk"] }),
    "sh /msf-runtime/prepare-profile.sh /msf-profile"
    + " && sh /msf-runtime/converge-profile.sh /msf-profile rtk"
    + " && sh /msf-runtime/check-profile.sh npm:pi-subagents 'npm:two words'",
  );
  assert.equal(
    profileSetupCommand({ requiredPackages: [], requiredTools: [] }),
    "sh /msf-runtime/prepare-profile.sh /msf-profile && sh /msf-runtime/converge-profile.sh /msf-profile && sh /msf-runtime/check-profile.sh",
  );
});

// O encadeamento prepare -> converge -> check vive num construtor só, usado pelo preparo autônomo e
// pelo exec assistido (que só acrescenta o `pi`): renomear um passo é editar um lugar.
test("the preparation steps are one ordered chain, and the setup command is exactly that chain joined", () => {
  assert.deepEqual(profilePreparationSteps({ requiredPackages: ["npm:pi-subagents"], requiredTools: ["rtk"] }), [
    "sh /msf-runtime/prepare-profile.sh /msf-profile",
    "sh /msf-runtime/converge-profile.sh /msf-profile rtk",
    "sh /msf-runtime/check-profile.sh npm:pi-subagents",
  ]);
  const input = { requiredPackages: ["npm:two words"], requiredTools: ["rtk", "jq"] };
  assert.equal(profileSetupCommand(input), profilePreparationSteps(input).join(" && "));
});
