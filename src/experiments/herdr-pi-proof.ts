import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RuntimeProfileConfig } from "../config/types.js";
import { describePlan, planSnapshot, writeSnapshot } from "../runtime/profile-snapshot.js";
import {
  assistantTexts,
  classifyExec,
  containerCommand,
  containerName,
  exitFileHostPath,
  parseExecExitRecord,
  type ExecExitRecord,
  type ExecObservation,
  type ExecSupervisionRecord,
  type ExecVerdict,
} from "./herdr-pi-proof/proof-logic.js";

// Disposable proof of the full lifecycle of one assisted session (ticket #52): a Herdr tab
// opened without stealing focus; the interactive pi running inside Docker (never the host pi);
// operator input and a resize attempt; the real end of one exec distinguished from pane text
// and exit codes; rediscovery of a live exec after losing supervision; the tab close that
// solicits the stop of that exec; and the structured result recorded on the host. Spec
// decisions live in #48 (item 7): this is a technical proof, not production code. Evidence
// artifacts stay under .smoke/herdr-pi-proof/<slug>/; the disposable chrome it created
// (containers, tab, panes, clone) is the only thing the proof cleans up.
//
//   npm run smoke:herdr-pi
//
// Run INSIDE a Herdr pane (HERDR_ENV=1). The provider/model is explicit, one per proof, and
// auth-backed by the very profile the container uses — never a host pi step, no fallback
// anywhere: the pane only ever sees `docker run` clients. The docker-runner-demo's constant
// (github-copilot/gpt-6-luna) predates the operator's current auth set, which holds no
// github-copilot credentials (observed 2026-10-13: "No API key found for github-copilot" in the
// container), so the proof pins the same model under the provider the profile actually
// authorizes. #48 item 3: provider/model of assistance are configured per instance.

const MODEL = "opencode-go/gpt-6-luna";
const IMAGE = "msf-docker-runner:local";
const PROFILE_SOURCE = join(homedir(), ".pi", "agent");
const ALLOWED_ROOTS = [join(homedir(), ".agents"), join(homedir(), "dev")];
const IMAGE_DIR = resolve("src/runtime/docker-image");
// npm:pi-lens crashed marksman in earlier containers (2026-10-11 evidence); excluded from the
// container copy of settings.json only, as ADR 0002 prescribes for the sandbox profile.
const PROFILE_DECLARATION: RuntimeProfileConfig = {
  required: { files: ["settings.json", "auth.json"], packages: [], skills: [], agents: [], tools: [] },
  excludePackages: ["npm:pi-lens"],
};
const WAIT_MS = 240_000;
const PROMISE = "<promise>MSF-RESULT</promise>";

type Json = Record<string, unknown>;

const slug = randomUUID().slice(0, 8);
const runDir = resolve(".smoke", "herdr-pi-proof", slug);
const sessionsDir = join(runDir, "sessions");
const stateDir = join(runDir, "state");
const snapshotDir = join(runDir, "snapshot");
const cloneDir = join(runDir, "clone");
const fixtureDir = join(runDir, "fixture");
const tabLabel = `msf-proof-${slug}`;
const agentUidGid = `${process.getuid?.() ?? ""}:${process.getgid?.() ?? ""}`;

const execFileP = (command: string, args: readonly string[], timeoutMs = 120_000): Promise<string> =>
  new Promise((ok, fail) => execFile(command, [...args],
    { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 << 20 },
    (error, stdout, stderr) => error == null
      ? ok(stdout)
      : fail(new Error(`${command} ${args.join(" ")}: ${stderr || String(error)}`, { cause: error }))));

const herdr = (args: readonly string[], timeoutMs = 60_000): Promise<string> => execFileP("herdr", args, timeoutMs);

async function herdrJson(args: readonly string[], timeoutMs = 60_000): Promise<Json> {
  try {
    const out = await herdr(args, timeoutMs);
    const start = out.indexOf("{");
    if (start < 0) throw new Error(`resposta sem JSON: ${out.slice(0, 400)}`);
    return JSON.parse(out.slice(start)) as Json;
  } catch (error) {
    throw new Error(`herdr ${args.join(" ")}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

// `herdr pane run` confirms by its exit code only; success prints no JSON (observed on 0.9.3).
async function paneRun(paneId: string, command: string): Promise<void> {
  await herdr(["pane", "run", paneId, command], 30_000);
}

const sttyCommand = "printf 'STTY=%s\\n' \"$(stty size)\"";

const saveJson = (name: string, value: unknown): Promise<void> =>
  writeFile(join(runDir, name), JSON.stringify(value, null, 2) + "\n");

interface ContainerObserved { id: string; running: boolean; status: string }

async function inspectContainer(name: string): Promise<ContainerObserved | undefined> {
  const raw = await execFileP("docker", ["inspect",
    "--format", "{{.Id}}|{{.State.Running}}|{{.State.Status}}", name], 15_000).catch(() => undefined);
  if (raw === undefined) return undefined;
  const [id, running, status] = raw.trim().split("|");
  return { id: id ?? "", running: running === "true", status: status ?? "" };
}

async function piInsideContainer(name: string): Promise<boolean | null> {
  // `-o args` alone fails on this docker ("Couldn't find PID field in ps output"); pid,args works.
  const raw = await execFileP("docker", ["top", name, "-o", "pid,args"], 15_000).catch(() => undefined);
  if (raw === undefined) return null;
  // The pi argv appears as its own row ("pi"), after a pid column; the wrapper's argv merely
  // mentions pi and never counts.
  return raw.split("\n").map((line) => line.trim()).filter(Boolean)
    .filter((line) => !line.startsWith("sh -c "))
    .some((line) => line.split(/\s+/)
      .filter((tok) => !/^[0-9]+$/.test(tok))
      .some((tok) => tok === "pi" || tok.endsWith("/pi")));
}

async function dockerClientInPane(paneId: string): Promise<boolean | null> {
  try {
    const info = await herdrJson(["pane", "process-info", "--pane", paneId]);
    const foreground = ((info.result as Json).process_info as Json).foreground_processes as Array<{ cmdline?: string }>;
    return foreground.some((p) => typeof p.cmdline === "string" && p.cmdline.trim().split(" ").at(-1)?.startsWith("docker")
      || (typeof p.cmdline === "string" && /^\s*docker\b/.test(p.cmdline)));
  } catch {
    return null;
  }
}

const containersTouched: string[] = [];
const evidenceFiles: string[] = [];
const limitations: string[] = [];
const notes: string[] = [];
let tabId: string | undefined;
let records: ExecSupervisionRecord[] = [];

async function cleanup(): Promise<void> {
  for (const name of containersTouched) {
    await execFileP("docker", ["rm", "-f", name], 15_000).catch(() => undefined);
  }
  if (tabId !== undefined) {
    await herdr(["tab", "close", tabId]).catch(() => undefined);
  }
}

async function observe(record: ExecSupervisionRecord): Promise<ExecObservation> {
  const container = await inspectContainer(record.containerName);
  return {
    tabExists: (await herdrJson(["tab", "list"]).catch(() => undefined)) !== undefined
      ? JSON.stringify(await herdrJson(["tab", "list"])).includes(`"${record.tabId}"`)
      : false,
    paneExists: (await herdrJson(["pane", "get", record.paneId]).catch(() => undefined)) !== undefined,
    containerRunning: container?.running ?? false,
    containerIdMatches: container === undefined ? false : container.id === record.containerId,
    piInsideContainer: container?.running === true ? await piInsideContainer(record.containerName) : false,
    dockerClientInPane: await dockerClientInPane(record.paneId),
  };
}

async function waitOutputMatch(paneId: string, match: string, when: string): Promise<void> {
  try {
    await herdrJson(["pane", "wait-output", "--match", match, "--timeout", String(WAIT_MS), paneId], WAIT_MS + 30_000);
  } catch (error) {
    const snapshot = await herdr(["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "120"]).catch(() => "sem leitura");
    await writeFile(join(runDir, `${when}-timeout.txt`), `${error instanceof Error ? error.message : error}\n\n${snapshot}`);
    throw new Error(`${when}: sem ${match} na pane em ${WAIT_MS} ms`);
  }
  const snapshot = await herdr(["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "200"]);
  await writeFile(join(runDir, `${when}.txt`), snapshot);
  evidenceFiles.push(`${when}.txt`);
}

// The operator turn observed in the Pi session file on the host mount — the pane echo of the
// prompt contains the same marker, so pane text alone never proves a model turn (observed:
// the 79a848f4 run matched its own echoed prompt). Assistant text in the session JSONL is the
// proof; the pane read afterwards is only illustrative.
async function waitAssistantMarker(token: string, when: string, expectPromise: boolean): Promise<{ file: string; text: string }> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const candidates = (await sessionTexts()).filter((s) => assistantTexts(s.text).some((t) => t.includes(token)));
    if (candidates.length >= 1) {
      const text = (assistantTexts(candidates[0].text).find((t) => t.includes(token))) ?? "";
      await saveJson(`${when}.json`, { sessionFile: candidates[0].file, assistant: text, paneEchoExcluded: true });
      evidenceFiles.push(`${when}.json`);
      const snapshot = await herdr(["pane", "read", execPaneId, "--source", "recent-unwrapped", "--lines", "200"])
        .catch(() => "sem leitura da pane");
      await writeFile(join(runDir, `${when}-pane.txt`), snapshot);
      assert.ok(!expectPromise || text.includes(PROMISE), `${when}: o resultado estruturado (${PROMISE}) ausente na resposta do modelo`);
      return { file: candidates[0].file, text };
    }
    await sleep(2_000);
  }
  const snapshot = await herdr(["pane", "read", execPaneId, "--source", "recent-unwrapped", "--lines", "200"])
    .catch(() => "sem leitura da pane");
  await writeFile(join(runDir, `${when}-timeout.txt`), `${when}: ${markerTimeoutNote(token)}\n\n${snapshot}`);
  throw new Error(`${when}: a sessão do container não guardou a resposta do modelo com ${token} em ${WAIT_MS} ms`);
}

const markerTimeoutNote = (token: string): string =>
  `sem resposta do modelo com ${token}: verifique a auth do provider dentro do container ` +
  `(diagnóstico: pi --print no container mostra "No API key found" quando o perfil não tem credenciais)`;

// Up to nine input attempts to quit the pi TUI. Nothing else terminates the exec: no timeout kill,
// no docker stop — the operator's own input channel must solicit the end of the pi process.
async function endPiByInput(record: ExecSupervisionRecord, phase: string): Promise<ExecExitRecord> {
  const attempts: string[] = [];
  const sequences: string[][] = [
    ["ctrl+c"], ["ctrl+c"], ["ctrl+c"], ["esc", "ctrl+c"], ["ctrl+c"],
    ["ctrl+d"], ["ctrl+d"], ["ctrl+c"], ["ctrl+c"],
  ];
  const exitPath = exitFileHostPath(stateDir, phase);
  const deadline = Date.now() + 240_000;
  for (const keys of sequences) {
    if (Date.now() > deadline) break;
    const before = await readFile(exitPath, "utf8").catch(() => undefined);
    if (before !== undefined) break;
    await herdr(["pane", "send-keys", record.paneId, ...keys]).catch((error) => attempts.push(String(error)));
    attempts.push(keys.join("+"));
    for (let waited = 0; waited < 8_000; waited += 1_000) {
      const text = await readFile(exitPath, "utf8").catch(() => undefined);
      if (text === undefined) { await sleep(1_000); continue; }
      await saveJson(`end-${phase}.json`, { attempts, keys, exit: text.trim() });
      return parseExecExitRecord(text.trim());
    }
  }
  await saveJson(`end-${phase}.json`, { attempts, keys: "exhausted" });
  throw new Error(`${phase}: nenhum encerramento por entrada encerrou o pi em ${sequences.length} tentativas`);
}

async function identityOf(record: ExecSupervisionRecord, phase: string): Promise<void> {
  // The docker client is only the pane's foreground process once the container runs: the pane's
  // zsh owns the TTY in the container-create window, and the operator task widget can race for
  // the first foreground_processes reading.
  let container: ContainerObserved | undefined;
  let clientSeen: { cmdline?: string; pid?: number } | undefined;
  for (let waited = 0; waited < 45_000; waited += 1_000) {
    container = await inspectContainer(record.containerName);
    const processInfoJson = await herdrJson(["pane", "process-info", "--pane", record.paneId]).catch(() => undefined);
    if (processInfoJson !== undefined) {
      const info = (processInfoJson.result as Json).process_info as Json;
      const foreground = info.foreground_processes as Array<{ cmdline?: string; pid?: number }>;
      clientSeen = foreground.find((p) => typeof p.cmdline === "string" && p.cmdline.trim().startsWith("docker"));
      if (container?.running === true && clientSeen !== undefined) break;
    }
    await sleep(1_000);
  }
  assert.ok(container !== undefined && container.running, `${phase}: container ${record.containerName} deveria existir e rodar`);
  assert.ok(clientSeen !== undefined, `${phase}: o cliente em primeiro plano na pane deve ser o docker, nunca o pi do host`);
  record.clientPid = clientSeen.pid;
  record.clientCmdline = clientSeen.cmdline;
  record.containerId = container.id;
  const top = await execFileP("docker", ["top", record.containerName, "-o", "pid,args"], 15_000);
  const herdrPane = await herdrJson(["pane", "get", record.paneId]);
  const envInside = await execFileP("docker", ["exec", record.containerName,
    "sh", "-c", "printf 'HERDR_PANE_ID=%s' \"${HERDR_PANE_ID:-missing}\""], 15_000);
  await saveJson(`identity-${phase}.json`, {
    dockerState: container, dockerClient: clientSeen, dockerTop: top,
    herdrPane: herdrPane.result, envInsideContainer: envInside.trim(),
  });
  evidenceFiles.push(`identity-${phase}.json`);
  assert.ok(envInside.includes("HERDR_PANE_ID=missing"),
    `${phase}: o exec no container precisa se manter sem a identidade da pane`);
  assert.notEqual(record.containerId, record.paneId, `${phase}: identidade do exec != identidade da pane`);
  assert.notEqual(record.containerId, record.tabId, `${phase}: identidade do exec != identidade da aba`);
}

// Finds the Pi session JSONLs the container wrote into the mounted host dir, recursively.
async function sessionTexts(): Promise<Array<{ file: string; text: string }>> {
  const walk = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) files.push(...await walk(join(dir, entry.name)));
      else if (entry.name.endsWith(".jsonl")) files.push(join(dir, entry.name));
    }
    return files.sort();
  };
  const files = await walk(sessionsDir);
  return Promise.all(files.map(async (file) => ({ file, text: await readFile(file, "utf8") })));
}

// ---------------------------------------------------------------- main flow
const startedAt = new Date().toISOString();
let controlPaneId = "";
let execPaneId = "";
let workspaceId = "";
try {
  if (process.env.HERDR_ENV !== "1") throw new Error("a prova roda dentro de uma pane do Herdr (HERDR_ENV=1)");
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  // ---- Preflight: versions and availability; a missing piece is a visible interruption. ----
  const serverVersion = (await execFileP("docker", ["info", "--format", "{{.ServerVersion}}"], 20_000)).trim();
  const herdrStatus = await herdr(["status"], 15_000);
  if (!/^  status: running/m.test(herdrStatus)) throw new Error(`servidor Herdr indisponivel:\n${herdrStatus}`);
  const herdrVersions = [...herdrStatus.matchAll(/version: ([0-9.]+)/g)].map((m) => m[1]);
  const imagePiVersion = (await execFileP("docker", ["run", "--rm", "--entrypoint", "pi", IMAGE, "--version"], 60_000)).trim();
  await execFileP("docker", ["image", "inspect", IMAGE], 20_000);
  const hostPiVersion = (await execFileP("pi", ["--version"], 20_000)).trim();
  const dockerClientVersion = (await execFileP("docker", ["--version"], 15_000)).trim();
  const profileFiles = await readdir(PROFILE_SOURCE);
  if (!profileFiles.includes("settings.json") || !profileFiles.includes("auth.json")) {
    throw new Error(`perfil do operador incompleto em ${PROFILE_SOURCE}; recusando rodar sem o retrato aprovado`);
  }
  process.stdout.write(`Preflight: docker servidor ${serverVersion}; docker cliente ${dockerClientVersion}\n`);
  process.stdout.write(`herdr ${herdrVersions.join(",")}; pi no container ${imagePiVersion}; pi no host ${hostPiVersion} (registrado, nunca usado)\n`);

  // ---- Disposable profile snapshot per ADR 0002, resolved on the host. ----
  const plan = await planSnapshot({ dir: PROFILE_SOURCE, allowedRoots: ALLOWED_ROOTS }, PROFILE_DECLARATION);
  assert.ok(plan.blockers.length === 0, `retrato do perfil bloqueado: ${plan.blockers.join("; ")}`);
  await writeSnapshot(plan, snapshotDir);
  await writeFile(join(runDir, "snapshot-plan.txt"), describePlan(plan).join("\n") + "\n");
  evidenceFiles.push("snapshot-plan.txt");

  // ---- Disposable test clone of a throwaway fixture (never a real project or operator clone). ----
  await mkdir(join(fixtureDir, "src"), { recursive: true });
  await writeFile(join(fixtureDir, "README.md"), "Fixture descartavel da prova da Assistencia (#52).\n");
  await writeFile(join(fixtureDir, "src", "fixture.ts"), "export const fixture = 'msf-proof';\n");
  const gitFixture = (args: readonly string[]) => execFileP("git", ["-C", fixtureDir, ...args], 30_000);
  await gitFixture(["init", "-q", "-b", "main"]);
  await gitFixture(["config", "user.name", "Prova Assistencia"]);
  await gitFixture(["config", "user.email", "proof@example.invalid"]);
  await gitFixture(["add", "."]);
  await gitFixture(["commit", "-q", "-m", "Fixture descartavel da prova"]);
  await execFileP("git", ["clone", "-q", fixtureDir, cloneDir], 60_000);

  // ---- Own tab, without focus theft, inside the caller's workspace. ----
  const current = (await herdrJson(["pane", "current", "--current"])).result as Json;
  workspaceId = ((current.pane) as Json).workspace_id as string;
  const tabsBefore = (((await herdrJson(["tab", "list"])).result as Json).tabs) as Array<Json>;
  const focusedBefore = tabsBefore.find((tab) => tab.focused === true)?.tab_id ?? "";
  const created = await herdrJson(["tab", "create", "--workspace", workspaceId,
    "--cwd", cloneDir, "--label", tabLabel, "--no-focus"]);
  const createdRoot = ((created.result as Json).root_pane) as Json;
  const createdTab = ((created.result as Json).tab) as Json;
  tabId = createdTab.tab_id as string;
  execPaneId = createdRoot.pane_id as string;
  assert.equal(createdTab.focused, false, "a aba criada nao deve nascer focada");
  const tabsAfter = (((await herdrJson(["tab", "list"])).result as Json).tabs) as Array<Json>;
  const focusedAfter = tabsAfter.find((tab) => tab.focused === true)?.tab_id ?? "";
  assert.equal(focusedBefore, focusedAfter, "abrir a aba nao roubou o foco");
  assert.ok(tabsAfter.some((tab) => tab.tab_id === tabId), "a aba criada esta listada");
  process.stdout.write(`Aba descartavel ${tabId} aberta sem roubar foco no workspace ${workspaceId}; pane de execucao ${execPaneId}\n`);

  // A sibling pane keeps the control shell for geometry evidence.
  const splitResult = await herdrJson(["pane", "split", "--pane", execPaneId,
    "--direction", "right", "--cwd", cloneDir, "--no-focus"]);
  controlPaneId = (((splitResult.result as Json).pane) as Json).pane_id as string;

  await saveJson("setup.json", {
    workspaceId, tabLabel, tab: createdTab, execPane: createdRoot, focusedBefore, focusedAfter,
    model: MODEL, image: IMAGE, agentUidGid,
  });
  evidenceFiles.push("setup.json");

  // ---- Exec A: interactive pi inside the container, first turn launched at startup. ----
  const token = `PROOF_${randomUUID().slice(0, 8).toUpperCase()}`;
  const promptA = `Prova tecnica descartavel de Assistencia (#52), dentro de um container Docker via Herdr. `
    + `Nao use ferramentas. Responda somente com o marcador ${token}, uma linha, `
    + `e termine a mensagem com a linha exata: ${PROMISE}`;
  const nowA = new Date().toISOString();
  const commandA = containerCommand({
    name: containerName({ slug, phase: "a" }), image: IMAGE, model: MODEL, agentUidGid,
    phase: "a", now: nowA, cloneHostDir: cloneDir, sessionsHostDir: sessionsDir,
    stateHostDir: stateDir, snapshotHostDir: snapshotDir, runtimeHostDir: IMAGE_DIR, prompt: promptA,
  });
  const recordA: ExecSupervisionRecord = {
    slug, phase: "a", label: tabLabel, workspaceId, tabId: tabId as string, paneId: execPaneId,
    containerName: containerName({ slug, phase: "a" }), image: IMAGE, model: MODEL,
    sessionsDir, cloneDir, exitFileHostPath: exitFileHostPath(stateDir, "a"), startedAt: nowA,
  };
  containersTouched.push(recordA.containerName);
  await saveJson("command-a.txt.json", { phase: "a", command: commandA, prompt: promptA });
  evidenceFiles.push("command-a.txt.json");
  process.stdout.write(`Exec A: lancando pi interativo no container ${recordA.containerName}.\n`);
  await paneRun(execPaneId, commandA);
  await saveJson("launch-a.json", { phase: "a", typedIntoPane: execPaneId });
  await identityOf(recordA, "a");
  records.push(recordA);
  const sessionAFile = (await waitAssistantMarker(token, "a-response", true)).file;
  await waitOutputMatch(execPaneId, token, "a-response-pane");
  process.stdout.write(`Exec A: primeira resposta do modelo visto na sessão do container (${token}); a pane a reflete\n`);

  // ---- Operator input in the running pi: deterministic probe, then a real model turn. ----
  await herdr(["pane", "send-text", execPaneId, "/help"]);
  const helpInput = await herdr(["pane", "send-keys", execPaneId, "enter"]);
  await sleep(2_000);
  const helpRead = await herdr(["pane", "read", execPaneId, "--source", "recent-unwrapped", "--lines", "80"]);
  await writeFile(join(runDir, "input-help.txt"), `send-keys: ${helpInput.trim()}\n\n${helpRead}`);
  evidenceFiles.push("input-help.txt");
  const token2 = `PROOF2_${randomUUID().slice(0, 8).toUpperCase()}`;
  await herdr(["pane", "send-text", execPaneId, `Nao use ferramentas. Responda somente com o marcador ${token2}, uma linha, e nada mais.`]);
  await herdr(["pane", "send-keys", execPaneId, "enter"]);
  await waitAssistantMarker(token2, "a-response-2", false);
  process.stdout.write(`Exec A: entrada do operador aceita pelo pi em execucao (${token2})\n`);

  // ---- Resize attempt while pi is live. Geometry changes are compared with the pty the processes see. ----
  const sttyRead = async (paneId: string, when: string): Promise<string> => {
    await paneRun(paneId, sttyCommand);
    await sleep(1_200);
    const raw = await herdr(["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "40"]);
    await writeFile(join(runDir, `stty-${when}.txt`), raw);
    return (raw.match(/STTY=[0-9]+ [0-9]+/) ?? [`sem leitura ${when}`]).join(",");
  };
  const sttyBefore = await sttyRead(controlPaneId, "antes");
  const resizeLeft = await herdrJson(["pane", "resize", "--pane", execPaneId, "--direction", "left", "--amount", "12"]);
  await sleep(1_500);
  const sttyAfter = await sttyRead(controlPaneId, "depois");
  const resizeBack = await herdrJson(["pane", "resize", "--pane", execPaneId, "--direction", "right", "--amount", "12"]);
  await saveJson("resize.json", {
    resizeLeft: (resizeLeft.result as Json).resize, resizeBack: (resizeBack.result as Json).resize,
    sttyBefore, sttyAfter,
  });
  evidenceFiles.push("resize.json", "stty-antes.txt", "stty-depois.txt");
  if (sttyBefore === sttyAfter) {
    limitations.push(`resize: herdr pane resize mudou a geometria do layout mas o tamanho do pty visto pelos processos nao mudou (${sttyBefore} -> ${sttyAfter}); ` +
      `o resize do terminal dos processos da pane nao foi comprovado nesta versao`);
  } else {
    notes.push(`resize: o pty visto pelos processos mudou: ${sttyBefore} -> ${sttyAfter}`);
  }

  // ---- Real end of exec A: only the container's own exit record counts. ----
  const exitA = await endPiByInput(recordA, "a");
  await saveJson("stopped-a.json", { exit: exitA });
  evidenceFiles.push("stopped-a.json");
  const verdictAfterA = classifyExec(recordA, await observe(recordA));
  assert.equal(verdictAfterA.state, "exec-ended", `exec A encerrado: observacao de docker, não de pane ou texto: ${verdictAfterA.reasons.join(" | ")}`);
  const containerAfterA = await inspectContainer(recordA.containerName);
  assert.ok(containerAfterA === undefined, "--rm remove o container apos o fim real do exec A");
  const paneAlive = await herdrJson(["pane", "get", execPaneId]);
  const tabAlive = (((await herdrJson(["tab", "list"])).result as Json).tabs as Array<Json>).some((tab) => tab.tab_id === tabId);
  assert.ok(paneAlive !== undefined && tabAlive, "encerrar o pi deve deixar a aba e a pane ativas");
  const historyAfterStop = await herdr(["pane", "read", execPaneId, "--source", "recent-unwrapped", "--lines", "200"]);
  assert.ok(historyAfterStop.includes(token), "o historico da aba guarda as respostas do pi apos o fim");
  await saveJson("tab-kept-after-stop.json", { pane: paneAlive, tab: tabAlive, historyKept: true });
  evidenceFiles.push("tab-kept-after-stop.json");
  process.stdout.write(`Exec A: fim real observado (exit ${exitA.exitCode}); aba e historico intactos\n`);

  // ---- Structured result: the last assistant message of the Pi session file on the host mount. ----
  // pi appends every turn to the file while the TUI is alive (observed 2026-10-13, t=60s), and the
  // file outlives the exec, unlike pane text. The result channel survives the exec's death.
  // The turn that carries the structured result is not necessarily the last assistant message
  // (operator turns continue after it): any assistant message of the session file counts.
  const structuredResult = assistantTexts(
    (await sessionTexts()).find((s) => s.file === sessionAFile)?.text ?? "")
    .find((t) => t.includes(token) && t.includes(PROMISE)) ?? "";
  assert.ok(structuredResult.includes(token) && structuredResult.includes(PROMISE),
    "a sessão pi do host guarda o resultado estruturado da exec A mesmo após o fim do exec");
  await saveJson("structured-result-a.json", {
    sessionFile: sessionAFile, result: structuredResult,
    note: "canal estruturado: Pi session JSONL no mount do host; o texto da pane nunca e a prova",
  });
  evidenceFiles.push("structured-result-a.json");
  process.stdout.write("Exec A: resultado estruturado presente na sessao pi persistida no host\n");

  // ---- Exec B: resume the same Pi session and the same area. ----
  const recordB: ExecSupervisionRecord = { ...recordA, phase: "b", containerName: containerName({ slug, phase: "b" }) };
  containersTouched.push(recordB.containerName);
  // A fresh marker proves the resume produced a NEW model turn; continuity is proven by the same
  // session file (past turns of phase A plus this turn) and the same clone/area.
  const tokenB = `RETAKE_${randomUUID().slice(0, 8).toUpperCase()}`;
  const promptB = `Retomada autorizada da mesma sessao (#52). Nao use ferramentas. `
    + `Responda somente com o marcador ${tokenB}, uma linha, e nada mais.`;
  recordB.startedAt = new Date().toISOString();
  const commandB = containerCommand({
    name: recordB.containerName, image: IMAGE, model: MODEL, agentUidGid,
    phase: "b", now: recordB.startedAt, cloneHostDir: cloneDir, sessionsHostDir: sessionsDir,
    stateHostDir: stateDir, snapshotHostDir: snapshotDir, runtimeHostDir: IMAGE_DIR,
    prompt: promptB, resume: true,
  });
  await saveJson("command-b.txt.json", { phase: "b", command: commandB, prompt: promptB, resume: true });
  await paneRun(execPaneId, commandB);
  await identityOf(recordB, "b");
  records.push(recordB);
  await waitAssistantMarker(tokenB, "b-response", false);
  const sessionBFile = (await waitAssistantMarker(tokenB, "b-response", false)).file;
  assert.equal(sessionBFile, sessionAFile, "a retomada continua o MESMO arquivo de sessao da fase A, mesmas área e clone");
  const resumedText = assistantTexts((await sessionTexts()).find((s) => s.file === sessionAFile)?.text ?? "")
    .find((t) => t.includes(tokenB)) ?? "";
  assert.ok(resumedText !== "", "a sessão retomada mantém o histórico e respondeu como turno novo");
  await saveJson("structured-retomada-b.json", { sessionFile: sessionBFile, sameSessionFileAsA: true });
  const exitB = await endPiByInput(recordB, "b");
  await saveJson("stopped-b.json", { exit: exitB });
  process.stdout.write(`Exec B: mesma sessao retomada e terminada (exit ${exitB.exitCode})\n`);

  // ---- Exec C: an idle live exec to prove rediscovery and the tab-close stop. ----
  const recordC: ExecSupervisionRecord = { ...recordA, phase: "c", containerName: containerName({ slug, phase: "c" }) };
  containersTouched.push(recordC.containerName);
  recordC.startedAt = new Date().toISOString();
  const commandC = containerCommand({
    name: recordC.containerName, image: IMAGE, model: MODEL, agentUidGid, phase: "c",
    now: recordC.startedAt, cloneHostDir: cloneDir, sessionsHostDir: sessionsDir,
    stateHostDir: stateDir, snapshotHostDir: snapshotDir, runtimeHostDir: IMAGE_DIR,
  });
  await saveJson("command-c.txt.json", { phase: "c", command: commandC, idle: true });
  await paneRun(execPaneId, commandC);
  let piLive = false;
  // The container spends its first minute installing the profile packages before pi appears.
  let topAtTimeout = "";
  for (let waited = 0; waited < 240_000; waited += 3_000) {
    const running = (await inspectContainer(recordC.containerName))?.running === true;
    piLive = running && (await piInsideContainer(recordC.containerName)) === true;
    if (piLive) break;
    topAtTimeout = await execFileP("docker", ["top", recordC.containerName], 15_000).catch(() => "sem top");
    await sleep(3_000);
  }
  if (!piLive) {
    await writeFile(join(runDir, "exec-c-top.txt"), topAtTimeout);
    evidenceFiles.push("exec-c-top.txt");
  }
  assert.ok(piLive, "exec C deve ter um pi vivo dentro do container");
  await identityOf(recordC, "c");
  await saveJson("supervision-c.json", recordC);
  records.push(recordC);

  // ---- Losing supervision: the only surviving thing is the record on disk. ----
  const rediscovered = await rediscover(JSON.parse(await readFile(join(runDir, "supervision-c.json"), "utf8")) as ExecSupervisionRecord);
  assert.equal((rediscovered.verdict as ExecVerdict).state, "live-exec", `exec C deve ser reencontrado vivo: ${(rediscovered.verdict as ExecVerdict).reasons.join(" | ")}`);
  assert.equal((rediscovered.verdict as ExecVerdict).orphaned, false, "exec C ainda tem sua pane e cliente");
  await saveJson("rediscover-c.json", rediscovered);
  evidenceFiles.push("rediscover-c.json");
  process.stdout.write("Rediscovery: exec C reencontrado vivo a partir do registro em disco\n");

  // ---- Closing the tab must solicit the stop of that exec. ----
  const closeStart = new Date().toISOString();
  const closeTimeline: Array<{ at: string; container: ContainerObserved | undefined }> = [];
  await herdrJson(["tab", "close", tabId as string]);
  const closedTabId = tabId;
  for (const delay of [1, 2, 4, 9]) {
    await sleep(delay * 1_000);
    closeTimeline.push({ at: new Date().toISOString(), container: await inspectContainer(recordC.containerName) });
  }
  const finalC = closeTimeline.at(-1)?.container;
  const stillRunning = finalC !== undefined && finalC.running;
  const closeEvidence = {
    closedTabId, closeStart, timeline: closeTimeline,
    solicitationHonored: !stillRunning,
    note: stillRunning
      ? "fechar a aba NAO parou o container: execução órfã observada; o orquestrador terá de reaver por identidade"
      : "fechar a aba parou a execução: o container saiu após o fechamento",
  };
  if (stillRunning) limitations.push(closeEvidence.note);
  await saveJson("tab-close-stop.json", closeEvidence);
  evidenceFiles.push("tab-close-stop.json");
  if (stillRunning) {
    await execFileP("docker", ["rm", "-f", recordC.containerName], 15_000);
    limitations.push("reaver execução órfã: docker rm -f por nome do registro da prova (unico recurso da prova)");
  }
  assert.equal(await inspectContainer(recordC.containerName), undefined, "nada do pi sobrevive ao fechamento");
  const leftovers = (await execFileP("docker", ["ps", "-a", "--filter", "name=^msf-proof-", "--format", "{{.Names}}"], 15_000)).trim();
  assert.equal(leftovers, "", `nenhuma execução órfã: nenhuma container da prova restante (${leftovers || "nenhum"})`);
  process.stdout.write(`Fechamento da aba: exec parada (${!stillRunning}); sem ófãs\n`);

  // ---- Desktop notification: best-effort delivery evidence. ----
  const notif: { attempts: Array<{ argv: string; out: string; err: string }>; note?: string } = { attempts: [] };
  for (const argv of [
    ["show", "PROVA-DESCARTAVEL", "t52"] as string[],
    ["show", "--body=prova-t52"] as string[],
    ["show", "--sound=request", "--body=prova-t52", "Prova t52 terminada"] as string[],
  ]) {
    let out = "";
    let err = "";
    try { out = (await herdr(argv, 20_000)).trim(); } catch (error) { err = String(error); }
    notif.attempts.push({ argv: argv.join(" "), out, err });
  }
  notif.note = "a CLI responde shown:true sem confirmar a entrega na mesa; --body/--sound com titulo foram recusados pelo parser";
  await saveJson("notification.json", notif);
  evidenceFiles.push("notification.json");

  // ---- Report with versions, evidence and the recorded limitations. ----
  const report = {
    ticket: 52, spec: 48, startedAt, finishedAt: new Date().toISOString(),
    versions: {
      dockerServer: serverVersion, dockerClient: dockerClientVersion,
      herdr: herdrVersions[0] ?? "", herdrServer: herdrVersions[1] ?? "",
      piContainer: imagePiVersion, piHost: hostPiVersion,
      model: MODEL, image: IMAGE, node: process.version, agentUidGid,
    },
    proven: {
      tabOpenedWithoutFocus: true, operatorInputAccepted: true,
      structuredResultOnSessionHostMount: true, realExecEndFromContainerExitRecord: true,
      identityDistinction: true, resumeSameSessionAndArea: true,
      rediscoveryAfterSupervisionLoss: true, tabCloseStopsExec: !stillRunning,
      desktopNotificationDelivery: false, resizeOfProcessPty: sttyBefore !== sttyAfter,
      noOrphanedExec: true,
    },
    linux: { limitations, notes, evidenceFiles, execRecords: records, artifacts: runDir },
  };
  await saveJson("report.json", report);
  process.stdout.write(`Prova concluida. Relatorio: ${join(runDir, "report.json")}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await saveJson("failure.json", { failure: message, limitations }).catch(() => undefined);
  await cleanup();
  process.stdout.write(`PROVA FALHOU: ${message}\n`);
  process.stdout.write(`Limitacoes acumuladas ate a falha: ${limitations.join(" ; ") || "nenhuma"}\n`);
  throw error;
}
async function rediscover(record: ExecSupervisionRecord): Promise<Json> {
  const tabList = (((await herdrJson(["tab", "list"])).result as Json).tabs) as Array<Json>;
  const tabExists = tabList.some((tab) => tab.tab_id === record.tabId);
  let paneOk = true;
  try { await herdrJson(["pane", "get", record.paneId]); } catch { paneOk = false; }
  const dockerClientInPaneF = await dockerClientInPane(record.paneId);
  const containerC = await inspectContainer(record.containerName);
  const verdict = classifyExec(record, {
    tabExists, paneExists: paneOk, containerRunning: containerC?.running ?? false,
    containerIdMatches: containerC === undefined ? false : containerC.id === record.containerId,
    piInsideContainer: containerC?.running === true ? await piInsideContainer(record.containerName) : false,
    dockerClientInPane: dockerClientInPaneF,
  });
  return { verdict, observation: { tabExists, paneOk, containerC, dockerClientInPaneF } };
}
