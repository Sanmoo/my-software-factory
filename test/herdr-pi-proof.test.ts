import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantTexts,
  classifyExec,
  containerCommand,
  containerName,
  lastAssistantText,
  parseExecExitRecord,
  piRunArgs,
  writeExecExitRecord,
  type ExecObservation,
  type ExecSupervisionRecord,
} from "../src/experiments/herdr-pi-proof/proof-logic.js";

const record = (over: Partial<ExecSupervisionRecord> = {}): ExecSupervisionRecord => ({
  slug: "run1", phase: "a", label: "msf-proof-run1",
  workspaceId: "w8", tabId: "w8:t7", paneId: "w8:p7",
  containerName: "msf-proof-run1-a", containerId: "cid_a", image: "msf-docker-runner:local",
  model: "opencode-go/gpt-6-luna", clientPid: 3126777, clientCmdline: "docker run --rm -it",
  sessionsDir: "/run/sessions", cloneDir: "/run/clone", exitFileHostPath: "/run/state/a.exit.json",
  startedAt: "2026-01-01T00:00:00Z", ...over,
});
const alive = (over: Partial<ExecObservation> = {}): ExecObservation => ({
  tabExists: true, paneExists: true, containerRunning: true, containerIdMatches: true,
  piInsideContainer: true, dockerClientInPane: true, ...over,
});

test("container names are disposable, prefixed, docker-safe and phase-bound", () => {
  assert.equal(containerName({ slug: "run1", phase: "a" }), "msf-proof-run1-a");
  assert.equal(containerName({ slug: "run-1", phase: "rediscover" }), "msf-proof-run-1-rediscover");
  assert.throws(() => containerName({ slug: "bad/slug", phase: "a" }), /slug/);
  assert.throws(() => containerName({ slug: "BadSlug", phase: "a" }), /slug/);
  assert.throws(() => containerName({ slug: "run1", phase: "" }), /fase/);
});

test("pi launches interactive with one explicit model and no host fallback", () => {
  const args = piRunArgs({ model: "opencode-go/gpt-6-luna", sessionDir: "/msf-sessions", name: "proof", prompt: "Responda PROOF_A1" });
  const options = args.filter((part) => part.startsWith("-"));
  assert.deepEqual(options, [
    "--model", "--session-dir", "--name", "--tui-mode", "--no-tools", "--no-context-files",
    "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-extensions",
  ]);
  assert.equal(args.filter((part) => part === "--model").length, 1, "one explicit provider/model per run");
  assert.ok(!args.includes("--print") && !args.includes("-p"),
    "the proof needs the interactive pi, not a non-interactive invocation");
  assert.equal(args.at(-1), "Responda PROOF_A1", "the first turn rides the argv with the flags");
  assert.ok(piRunArgs({ model: "m", sessionDir: "/s", name: "b", resume: true }).includes("-c"),
    "a retomada continues the same session with -c");
});

test("the launch command is a docker run with TTY, named container and the ADR 0002 profile recipe", () => {
  const command = containerCommand({
    name: "msf-proof-run1-a", image: "msf-docker-runner:local", model: "opencode-go/gpt-6-luna",
    agentUidGid: "1000:1000", phase: "a", now: "2026-01-01T00:00:00Z",
    cloneHostDir: "/run/clone", sessionsHostDir: "/run/sessions", stateHostDir: "/run/state",
    snapshotHostDir: "/run/snapshot", runtimeHostDir: "/image-scripts", prompt: "Responda, então, PROOF_A1",
  });
  assert.match(command, /^docker run --rm -it --entrypoint sh --name msf-proof-run1-a --workdir \/work /,
    "the pane's foreground client is the docker CLI, never the host pi");
  assert.match(command, / --entrypoint sh /, "the image's sleep-infinity entrypoint is overridden for the proof");
  assert.match(command, /msf-docker-runner:local -c /, "the proof script is the container command");
  assert.match(command, /--user 1000:1000 /, "the container runs as the host user that owns the mounted artifacts");
  assert.match(command, /msf-docker-runner:local /);
  assert.match(command, /-v \/run\/clone:\/work /, "the disposable clone is bind-mounted writable");
  assert.match(command, /-v \/run\/sessions:\/msf-sessions /, "the Pi session dir is writable from inside");
  assert.match(command, /-v \/run\/state:\/msf-state /, "the exec's own exit record lands on the host");
  assert.match(command, /-v \/run\/snapshot:\/msf-profile:ro /, "the profile snapshot is read-only (ADR 0002)");
  assert.match(command, /-v \/image-scripts:\/msf-runtime:ro /, "image scripts stay host-authored");
  assert.match(command, /trap '\\'''\\'' INT;/, "the wrapper ignores SIGINT so the exit record survives pi's exit");
  assert.match(command, /sh \/msf-runtime\/prepare-profile\.sh \/msf-profile/,
    "the container-local Pi dir is built from the snapshot");
  assert.match(command, /sh \/msf-runtime\/check-profile\.sh/);
  assert.match(command, / pi --model opencode-go\/gpt-6-luna /, "the provider/model is explicit in the container argv");
  assert.match(command, /msf-exit-a\.json/, "only the container writes the real exit of the exec");
  assert.match(command, /PI_ENDED_a /, "the wrapper announces the end of the exec without claiming any outcome");
  assert.doesNotMatch(command, /--print|-p /, "interactive pi, not a non-interactive invocation");
  assert.doesNotMatch(command.toLowerCase(), /herdr pane run/, "the wrapper never piggybacks on the pane's shell for pi");
});

test("the exec exit record is container-authored JSON, and a bare exit code is not a proof", () => {
  assert.deepEqual(
    parseExecExitRecord(writeExecExitRecord({ phase: "a", exitCode: 130, at: "2026-01-01T00:01:00Z" })),
    { phase: "a", exitCode: 130, at: "2026-01-01T00:01:00Z" });
  assert.deepEqual(parseExecExitRecord(writeExecExitRecord({ phase: "b", exitCode: 0, at: "t" })),
    { phase: "b", exitCode: 0, at: "t" }, "a real zero exit is representable but carries by itself nothing");
  for (const garbage of ["", "0", "ok", "{}",
    writeExecExitRecord({ phase: "", exitCode: 1, at: "t" }),
    writeExecExitRecord({ phase: "a", exitCode: 1.5, at: "t" })]) {
    assert.throws(() => parseExecExitRecord(garbage), /registro de fim de execução/,
      "noise or malformed records must not pass as the end-of-exec proof");
  }
});

test("only the container's state shows the end of the exec; a closed pane never does", () => {
  const verdict = classifyExec(record(), alive({ containerRunning: false }));
  assert.equal(verdict.state, "exec-ended");
  assert.match(verdict.reasons.join("\n"), /pane/,
    "the reason must state that pane topology or terminal text proved nothing");
  assert.equal(classifyExec(record(), alive({ tabExists: false, paneExists: false, containerRunning: false })).state,
    "exec-ended");
});

test("a live exec is rediscovered from the record after supervision is lost", () => {
  const verdict = classifyExec(record(), alive({ tabExists: false, paneExists: false, dockerClientInPane: null }));
  assert.equal(verdict.state, "live-exec", "the record alone re-anchors the exec");
  assert.equal(verdict.orphaned, true, "without the pane, the exec would have been forgotten");
});

test("an exec alive while its pane is gone is live and orphaned, never concluded", () => {
  const verdict = classifyExec(record(), alive({ paneExists: false }));
  assert.equal(verdict.state, "live-exec");
  assert.equal(verdict.orphaned, true);
});

test("a running container the record cannot prove asks for intervention, not a result", () => {
  assert.equal(classifyExec(record(), alive({ containerIdMatches: false })).state, "supervision-mismatch");
  assert.equal(classifyExec(record(), alive({ piInsideContainer: false })).state, "exec-ended");
  assert.equal(classifyExec(record(), alive({ piInsideContainer: null })).state, "supervision-mismatch");
  assert.equal(classifyExec(record({ containerId: undefined }), alive()).state, "supervision-mismatch");
});

test("every assistant message is addressable: later operator turns do not hide the earlier result", () => {
  const jsonl = [
    JSON.stringify({ type: "message", id: "a1", timestamp: "t",
      message: { role: "assistant", content: [{ type: "text", text: "first<token>A</token>\n<promise>MSF-RESULT</promise>" }] } }),
    JSON.stringify({ type: "message", id: "u1", timestamp: "t",
      message: { role: "user", content: [{ type: "text", text: "next turn" }] } }),
    JSON.stringify({ type: "message", id: "a2", timestamp: "t",
      message: { role: "assistant", content: [{ type: "text", text: "second reply, no promise line" }] } }),
    "",
  ].join("\n");
  const texts = assistantTexts(jsonl);
  assert.equal(texts.length, 2);
  assert.ok(texts[0].includes("<token>A</token>"));
  assert.equal(texts[1], "second reply, no promise line");
  assert.equal(lastAssistantText(jsonl), "second reply, no promise line",
    "the last assistant message alone is not the whole surface");
});

test("the structured result surface is the last assistant message of the Pi session on the host", () => {
  const jsonl = [
    JSON.stringify({ type: "session", id: "s1", cwd: "/x", timestamp: "t", version: "1.2.0" }),
    JSON.stringify({ type: "model_change", id: "m1", modelId: "opencode-go/gpt-6-luna", parentId: "s1", timestamp: "t" }),
    JSON.stringify({ type: "message", id: "a1", parentId: "m1", timestamp: "t",
      message: { role: "assistant", content: [{ type: "text", text: "first reply" }], stopReason: "stop" } }),
    JSON.stringify({ type: "message", id: "u1", parentId: "a1", timestamp: "t",
      message: { role: "user", content: [{ type: "text", text: "PROOF_ECHOED? never" }] } }),
    JSON.stringify({ type: "message", id: "a2", parentId: "u1", timestamp: "t",
      message: { role: "assistant", content: [
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "<smoke-result>{\"status\":\"done\"}</smoke-result>\n<promise>MSF-RESULT</promise>" },
      ], stopReason: "stop" } }),
    "",
  ].join("\n");
  assert.equal(lastAssistantText(jsonl), "<smoke-result>{\"status\":\"done\"}</smoke-result>\n<promise>MSF-RESULT</promise>");
  assert.equal(lastAssistantText(""), "");
  assert.equal(lastAssistantText("not json\n"), "");
});
