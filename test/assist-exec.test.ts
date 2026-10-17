import assert from "node:assert/strict";
import test from "node:test";
import {
  assistContainerName, assistExecCommand, assistExitRecordPath, assistPiArgs, parseAssistExecExitRecord,
} from "../src/runtime/assist-exec.js";
import { isAbsentResponse } from "../src/runtime/assist-exec-probe.js";

// The container recipe of one assisted exec under TDD: what the proof (ticket #52) validated as
// the runtime recipe is now the contract of the production command — the pane only hosts the
// docker client, pi runs inside the container with the explicit assist model, the profile
// snapshot is read-only, the operator's clone is writable, and the container itself records the
// real end of the exec in the state mount.

test("assistContainerName derives a safe container name from the session's identity", () => {
  const name = assistContainerName("github:acme/app#7", "2026-10-14T00:31:07.890Z");
  assert.match(name, /^msf-assist-[a-z0-9-]+$/);
  assert.ok(name.includes("7"));
  // Different sessions get different names: separate exec identities, from the record.
  assert.notEqual(name, assistContainerName("github:acme/app#8", "2026-10-14T00:31:07.890Z"));
  assert.throws(() => assistContainerName("", "2026-10-14T00:31:07.890Z"));
});

test("assistPiArgs runs interactive pi with the explicit model, never the non-interactive mode", () => {
  const args = assistPiArgs({ model: "opencode-go/gpt-6-luna", sessionDir: "/msf-sessions", name: "sess-1", prompt: "ajuda com a triagem" });
  assert.deepEqual(args.slice(0, 2), ["--model", "opencode-go/gpt-6-luna"]);
  assert.deepEqual(args.slice(2, 6), ["--session-dir", "/msf-sessions", "--name", "sess-1"]);
  assert.deepEqual(args.slice(6, 8), ["--tui-mode", "regular"]);
  assert.ok(args.includes("ajuda com a triagem"));
  // A resume continues the same pi session (#56 uses it; the initial opening does not).
  assert.ok(assistPiArgs({ model: "m/p", sessionDir: "/x", name: "n", resume: true }).includes("-c"));
  assert.ok(!assistPiArgs({ model: "m/p", sessionDir: "/x", name: "n" }).includes("-c"));
});

const commandOf = (extra: Partial<Parameters<typeof assistExecCommand>[0]> = {}): string => assistExecCommand({
  name: "msf-assist-github-acme-app-7-2026-10-14",
  image: "msf-docker-runner:local",
  model: "opencode-go/gpt-6-luna",
  agentUidGid: "1000:1000",
  startedAt: "2026-10-14T00:31:07.890Z",
  cloneHostDir: "/home/op/dev/acme/app",
  sessionsHostDir: "/tmp/msf/state/assist/sessions",
  stateHostDir: "/tmp/msf/state/assist/state",
  snapshotHostDir: "/tmp/msf/state/assist/profile",
  runtimeHostDir: "/msf-repo/src/runtime/docker-image",
  npmHostDir: "/home/op/.msf/toolchains/personal/npm",
  miseHostDir: "/home/op/.msf/toolchains/personal/mise",
  requiredPackages: ["npm:pi-subagents"],
  requiredTools: ["rtk"],
  prompt: "apoiar a triagem da issue #7",
  ...extra,
});

test("assistExecCommand reproduces the validated recipe: pi inside the container, no host execution", () => {
  const command = commandOf();
  // The host docker client is the pane's foreground process; the exec is a run container.
  assert.match(command, /^docker run --rm -it --entrypoint sh --name msf-assist-/);
  assert.match(command, /--user 1000:1000/);
  // The profile snapshot is read-only (ADR 0002); the clone is writable; the profile's persistent
  // toolchain is writable so the convergence installs once (ADR 0004).
  assert.match(command, /-v \/tmp\/msf\/state\/assist\/profile:\/msf-profile:ro\b/);
  assert.match(command, /-v \/home\/op\/dev\/acme\/app:\/work\b(?!:)/);
  assert.match(command, /-v \/tmp\/msf\/state\/assist\/sessions:\/msf-sessions\b/);
  assert.match(command, /-v \/tmp\/msf\/state\/assist\/state:\/msf-state\b/);
  assert.match(command, /-v \/msf-repo\/src\/runtime\/docker-image:\/msf-runtime:ro\b/);
  assert.match(command, /-v \/home\/op\/\.msf\/toolchains\/personal\/npm:\/home\/agent\/\.pi\/agent\/npm\b(?!:)/);
  assert.match(command, /-v \/home\/op\/\.msf\/toolchains\/personal\/mise:\/home\/agent\/\.local\/share\/mise\b(?!:)/);
  // The wrapper traps INT so a Ctrl+C of the pane group still lets the container write the
  // exit record (the quoting is the one the proof validated, on the pane's shell).
  assert.match(command, /trap .*INT;/);
  // The preparation is strict: every step chained with &&, so a convergence failure stops the
  // invocation with its reason instead of starting the agent without what the profile declared.
  assert.match(command, /sh \/msf-runtime\/prepare-profile\.sh \/msf-profile && sh \/msf-runtime\/converge-profile\.sh \/msf-profile rtk/);
  assert.match(command, /converge-profile\.sh \/msf-profile rtk && sh \/msf-runtime\/check-profile\.sh npm:pi-subagents/);
  assert.match(command, /check-profile\.sh npm:pi-subagents && pi --model opencode-go\/gpt-6-luna/);
  assert.match(command, / > \/msf-state\/msf-exit\.json/);
  // The explicit model is in the pi argv: never a silent inheritance of the implementation model.
  assert.ok(!command.includes("gpt-6-luna --approve"));
});

test("assistExitRecordPath and the record output agree", () => {
  assert.equal(assistExitRecordPath("/tmp/msf/state/assist/state"), "/tmp/msf/state/assist/state/msf-exit.json");
});

test("parseAssistExecExitRecord accepts only a well-formed exit record", () => {
  assert.deepEqual(parseAssistExecExitRecord('{"exitCode":0,"at":"2026-10-14T00:33:01.000Z"}'), {
    exitCode: 0, at: "2026-10-14T00:33:01.000Z",
  });
  assert.deepEqual(parseAssistExecExitRecord('{"exitCode":130,"at":"2026-10-14T00:33:09.000Z"}'), {
    exitCode: 130, at: "2026-10-14T00:33:09.000Z",
  });
  for (const bad of ["", "plain text", "{}", '{"exitCode":"0","at":"x"}', '{"exitCode":-1,"at":"x"}', '{"exitCode":999,"at":"x"}', '{"exitCode":0}']) {
    assert.throws(() => parseAssistExecExitRecord(bad), Error, `deveria recusar: ${JSON.stringify(bad)}`);
  }
  // The message says what it rejects: the suporte do operador lê a pane e o comando.
  assert.throws(() => parseAssistExecExitRecord("não é JSON"), /não é JSON/);
});

// The reconciliation probe's absent verdict (ticket #58) rests on the daemon's own not-found
// answer; any other failure is the daemon being unaskable. Both observed spellings of the same
// docker 29.7.2 respond and the localized rejoinder are absolute proof, never a partial case.
test("isAbsentResponse proves absence only by the daemon's own not-found answer, in both observed spellings", () => {
  assert.ok(isAbsentResponse("Error: No such object: msf-assist-x"), "forma observada da prova t52");
  assert.ok(isAbsentResponse("error: no such object: msf-assist-x"), "forma observada da demo #58");
  assert.ok(isAbsentResponse("Erro: Nenhum objeto: msf-assist-x"), "resposta localizada reconhecida");
  for (const notAbsent of [
    "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
    "permission denied",
    "",
    "the socket died before answering",
  ]) {
    assert.equal(isAbsentResponse(notAbsent), false, `não é ausência: ${notAbsent}`);
  }
});
