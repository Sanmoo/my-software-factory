import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RuntimeProfileConfig } from "../config/types.js";
import {
  assistContainerName, assistExecCommand, assistExitRecordPath, parseAssistExecExitRecord, runtimeImageDirOf,
} from "../runtime/assist-exec.js";
import { describePlan, planSnapshot, writeSnapshot } from "../runtime/profile-snapshot.js";
import { herdrBoundary } from "../runtime/herdr.js";
import { assistPrompt } from "../core/assist-prompts.js";
import { recognizeAssistResult } from "../core/assist-result.js";

// Real-runtime demonstration of the opening of one assisted session (ticket #54), against the
// runtime the technical proof (#52) validated: a Herdr tab opened without stealing focus, the
// interactive pi inside Docker launched by the production command builder
// (src/runtime/assist-exec.ts), the container-written exit record as the only accepted end of
// the exec, and a session left pending — never concluded, never closed. It uses a disposable
// fixture and clone; the structured result channel is the session JSONL the container writes
// into the host mount.
//
//   npm run smoke:assist-session
//
// Run INSIDE a Herdr pane (HERDR_ENV=1) and never part of `npm test`: the metal it needs (herdr
// server, docker daemon, operator profile) cannot run headless-safe in the CI suite. The demo
// cleans up after itself: container (by name from the record), tab, demo dirs.

const MODEL = "opencode-go/gpt-6-luna"; // the explicit assist model, one per demo (#48 item 3)
const IMAGE = "msf-docker-runner:local";
const PROFILE_SOURCE = join(homedir(), ".pi", "agent");
const ALLOWED_ROOTS = [join(homedir(), ".agents"), join(homedir(), "dev")];
const PROFILE_DECLARATION: RuntimeProfileConfig = {
  required: { files: ["settings.json", "auth.json"], packages: [], skills: [], agents: [] },
  excludePackages: ["npm:pi-lens"],
};
// The demo waits the model's turn out; a slow provider is a documented limitation, not a
// failure of the metal (the #52 proof measured ~100 s of pi cold start alone).
const WAIT_MS = 420_000;
const PROMISE = "<promise>MSF-RESULT</promise>";

const slug = randomUUID().slice(0, 8);
const demoDir = resolve(".smoke", "assist-session-demo", slug);
const fixtureDir = join(demoDir, "fixture");
const cloneDir = join(demoDir, "clone");
const sessionsDir = join(demoDir, "sessions");
const execStateDir = join(demoDir, "state");
const profileDir = join(demoDir, "profile");
const containerName = assistContainerName("demo", new Date().toISOString());

const execFileP = (command: string, args: readonly string[], timeoutMs = 120_000): Promise<string> =>
  new Promise((ok, fail) => execFile(command, [...args],
    { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 << 20 },
    (error, stdout, stderr) => error == null
      ? ok(stdout)
      : fail(new Error(`${command} ${args.join(" ")}: ${stderr || String(error)}`, { cause: error }))));

const herdr = (args: readonly string[], timeoutMs = 60_000): Promise<string> => execFileP("herdr", args, timeoutMs);

const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

const saveJson = (name: string, value: unknown): Promise<void> =>
  writeFile(join(demoDir, name), JSON.stringify(value, null, 2) + "\n");

const openedTabs: string[] = [];

async function cleanup(): Promise<void> {
  // MSF_DEMO_KEEP=1 keeps the container, tabs and dirs for post-mortem on a failed run.
  if (process.env.MSF_DEMO_KEEP === "1") return;
  await execFileP("docker", ["rm", "-f", containerName], 15_000).catch(() => undefined);
  for (const tabId of openedTabs.splice(0)) {
    await herdr(["tab", "close", tabId]).catch(() => undefined);
  }
}

// The pi sessions the container wrote into the mounted host dir, recursively: the structured
// surface that survives the exec's death, unlike pane text.
async function sessionTexts(dir: string): Promise<string[]> {
  const walk = async (path: string): Promise<string[]> => {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) files.push(...await walk(join(path, entry.name)));
      else if (entry.name.endsWith(".jsonl")) files.push(join(path, entry.name));
    }
    return files.sort();
  };
  const files = await walk(dir);
  return Promise.all(files.map(async (file) => readFile(file, "utf8")));
}

async function waitAssistantMarker(token: string): Promise<string> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    for (const text of await sessionTexts(sessionsDir)) {
      if (text.includes(token) && text.includes(PROMISE)) return text;
    }
    // A container that died before answering says so by the record; waiting out the full
    // window would only hide the real cause.
    const ended = await readFile(assistExitRecordPath(execStateDir), "utf8").catch(() => undefined);
    if (ended !== undefined) {
      const { exitCode } = parseAssistExecExitRecord(ended);
      throw new Error(`o container encerrou (exit ${exitCode}) antes de guardar a resposta com ${token}; registro: ${ended.trim()}`);
    }
    await sleep(2_000);
  }
  throw new Error(`a sessão do container não guardou a resposta do modelo com ${token} em ${WAIT_MS} ms`);
}

// The operator's own input channel solicits the end of the exec; the exit record is what ends
// the wait. No docker stop, no timeout kill — exactly what the proof validated.
async function endPiByInput(paneId: string): Promise<number> {
  const exitPath = assistExitRecordPath(execStateDir);
  for (const keys of [["ctrl+c"], ["esc", "ctrl+c"], ["ctrl+d"], ["ctrl+d"], ["ctrl+c"], ["ctrl+c"]]) {
    const written = await readFile(exitPath, "utf8").catch(() => undefined);
    if (written !== undefined) break;
    await herdr(["pane", "send-keys", paneId, ...keys]).catch(() => undefined);
    for (let waited = 0; waited < 12_000; waited += 1_000) {
      const text = await readFile(exitPath, "utf8").catch(() => undefined);
      if (text !== undefined) return parseAssistExecExitRecord(text.trim()).exitCode;
      await sleep(1_000);
    }
  }
  throw new Error("nenhum encerramento por entrada encerrou o pi; veja o estado em .smoke/assist-session-demo");
}

async function main(): Promise<void> {
  if (process.env.HERDR_ENV !== "1") {
    throw new Error("a demonstração roda dentro de uma pane do Herdr (HERDR_ENV=1); nunca é parte de npm test");
  }
  for (const dir of [demoDir, join(fixtureDir, "src"), cloneDir, sessionsDir, execStateDir, profileDir]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(join(fixtureDir, "README.md"), "Fixture descartável da demonstração da Assistência (#54).\n");
  await writeFile(join(fixtureDir, "src", "demo.ts"), "export const demo = 'assist-session';\n");
  const gitFixture = (args: readonly string[]) => execFileP("git", ["-C", fixtureDir, ...args], 30_000);
  await gitFixture(["init", "-q", "-b", "main"]);
  await gitFixture(["config", "user.name", "Demonstração Assistência"]);
  await gitFixture(["config", "user.email", "demo@example.invalid"]);
  await gitFixture(["add", "."]);
  await gitFixture(["commit", "-q", "-m", "Fixture descartável da demonstração"]);
  await execFileP("git", ["clone", "-q", fixtureDir, cloneDir], 60_000);

  await saveJson("environment.json", {
    slug, tabLabel: `msf-demo-${slug}`, image: IMAGE, model: MODEL, containerName,
    note: "dispositivo: o prodimento de abertura é o mesmo do run; este demo mostra o metal real",
  });

  // ---- ADR 0002: the snapshot resolves on the host before anything starts, real files only. ----
  const plan = await planSnapshot({ dir: PROFILE_SOURCE, allowedRoots: ALLOWED_ROOTS }, PROFILE_DECLARATION);
  assert.ok(plan.blockers.length === 0, `retrato do perfil bloqueado: ${plan.blockers.join("; ")}`);
  await writeSnapshot(plan, profileDir);
  await saveJson("snapshot-plan.json", describePlan(plan));

  // ---- Own tab without focus (the boundary refuses a focus steal). ----
  const herdrBoundaryForDemo = herdrBoundary();
  await herdrBoundaryForDemo.available();
  const workspace = await herdrBoundaryForDemo.currentWorkspace();
  const opening = await herdrBoundaryForDemo.createTab({ workspace, cwd: cloneDir, label: `msf-demo-${slug}` });
  openedTabs.push(opening.tab.tabId);
  assert.equal(opening.focusedBefore, opening.focusedAfter, "abrir a aba não roubou o foco");

  // ---- The production exec command, launched through the pane's docker client. ----
  const token = `DEMO_${randomUUID().slice(0, 8).toUpperCase()}`;
  const command = assistExecCommand({
    name: containerName, image: IMAGE, model: MODEL,
    agentUidGid: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    startedAt: new Date().toISOString(),
    cloneHostDir: cloneDir, sessionsHostDir: sessionsDir, stateHostDir: execStateDir,
    snapshotHostDir: profileDir, runtimeHostDir: runtimeImageDirOf(),
    // The demo's user turn names the scan token, so the model's answer is findable in the
    // session files the demonstration scans; without it the marker check can never pass.
    prompt: `${assistPrompt({ kind: "needs-triage", ref: { tracker: "memory", project: "demo", id: "1" }, title: `demonstração ${slug}` })}\n\n`
      + `Primeira mensagem do operador (demonstração de ${slug}): registre os passos desta triagem pautada pelo operador, `
      + `mencione o token ${token} e termine com a linha <promise>MSF-RESULT</promise>.`,
  });
  await saveJson("command.json", { command, containerName, tabId: opening.tab.tabId, paneId: opening.tab.paneId });
  await herdrBoundaryForDemo.paneRun(opening.tab.paneId, command);

  // ---- The model's first turn (proof by the session JSONL the container wrote), then the end. ----
  const response = await waitAssistantMarker(token);
  await saveJson("first-response.json", { token, containsStructuredResult: response.includes(PROMISE) });
  const exitCode = await endPiByInput(opening.tab.paneId);
  // The production recognition over the real session files: the same contract the flow polls
  // after the exit record (ticket #55). The demo's operator never asks to conclude, so an
  // absent proposal is the expected, legal outcome; a recognized one is recorded regardless.
  const recognized = recognizeAssistResult(await sessionTexts(sessionsDir));
  await saveJson("result-recognition.json", recognized);
  // --rm removes the container after the real end; the record said the code, never success.
  let containerGone = false;
  try {
    await execFileP("docker", ["inspect", containerName], 15_000);
  } catch {
    containerGone = true;
  }
  assert.ok(containerGone, "o container encerrou de verdade (docker inspect falha após o fim)");
  await saveJson("ended.json", { exitCode, containerGone, note: "código de fim registrado; nunca interpretado como sucesso do atendimento" });
  process.stdout.write(`Demonstração: aba ${opening.tab.tabId}, container ${containerName}, exit ${exitCode}. Sessão deixada pendente, contexto em ${demoDir}\n`);

  // ---- #56: the manual resume of the same session and area. ----
  // The old exit record is removed BEFORE the relaunch (the supervision would read the old end
  // as the new one), the same sessions dir and clone are re-mounted, pi -c continues the same
  // conversation, and the resumed exec gets its own new tab — the first one keeps its history
  // (the pi end never auto-closes a tab with history).
  await rm(assistExitRecordPath(execStateDir));
  const resumeToken = `RESUME_${randomUUID().slice(0, 8).toUpperCase()}`;
  const resumedTab = await herdrBoundaryForDemo.createTab({ workspace, cwd: cloneDir, label: `msf-demo-${slug}-r` });
  openedTabs.push(resumedTab.tab.tabId);
  assert.equal(resumedTab.focusedBefore, resumedTab.focusedAfter, "abrir a aba de retomada não roubou o foco");
  const resumeCommand = assistExecCommand({
    name: containerName, image: IMAGE, model: MODEL,
    agentUidGid: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    startedAt: new Date().toISOString(),
    cloneHostDir: cloneDir, sessionsHostDir: sessionsDir, stateHostDir: execStateDir,
    snapshotHostDir: profileDir, runtimeHostDir: runtimeImageDirOf(),
    resume: true,
    prompt: `continuação de demonstração: responda mencionando o token ${resumeToken}`,
  });
  await saveJson("resume-command.json", { command: resumeCommand, tabId: resumedTab.tab.tabId, note: "pi -c na mesma sessão; sem conversa nova" });
  await herdrBoundaryForDemo.paneRun(resumedTab.tab.paneId, resumeCommand);
  await waitAssistantMarker(resumeToken);
  const resumeGone = await readFile(assistExitRecordPath(execStateDir), "utf8").catch(() => undefined);
  assert.ok(resumeGone === undefined, "nenhum registro de fim antigo sobreviveu à retomada");
  const resumeExit = await endPiByInput(resumedTab.tab.paneId);
  await saveJson("resumed.json", { resumeExit, note: "retomada comprovada: mesma área, mesma conversa, nova aba" });
  process.stdout.write(`Retomada: aba ${resumedTab.tab.tabId} na mesma sessão (pi -c), exit ${resumeExit}` +
    ". A aba anterior segue com histórico\n");
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`demonstração falhou: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void cleanup().then(() => {
      if (process.env.MSF_DEMO_KEEP === "1") return;
      return rm(demoDir, { recursive: true, force: true }).catch(() => undefined);
    });
  });
