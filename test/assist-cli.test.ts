import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runMsf, type MsfDeps } from "../src/cli/msf.js";
import { runAssist, type AssistOptions } from "../src/cli/assist.js";
import { loadInstance, type CliRun } from "../src/cli/instance.js";
import type { LocalSettings } from "../src/cli/local-settings.js";
import { newJob, transitionJob, type Job } from "../src/core/job.js";
import { createFileAssistSessionStore } from "../src/state/file-assist-session-store.js";
import { createFileJobStore } from "../src/state/file-job-store.js";
import { loadMemoryTracker } from "../src/tracker/memory.js";
import type { TrackerPort } from "../src/tracker/port.js";
import type { SandboxBoundary } from "../src/runtime/docker-runner.js";

// `./msf <instância> assist`: diagnóstico local do atendimento assistido. Lê os trackers e o
// estado gravado, avalia a elegibilidade assistida e verifica o ambiente sem iniciar execução:
// nenhuma escrita no tracker, nenhuma sessão, pane ou container aberto (a costura é runAssist,
// com tracker, sandbox e Herdr injetáveis; o diretório de estado é temporário).

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const memoryTracker = async (): Promise<TrackerPort> => loadMemoryTracker(JSON.parse(await readFile(fixture("assist-tracker.json"), "utf8")));

// Sandbox de teste: o preflight prova Docker sem container; `run` jamais pode ser chamado.
const sandboxOf = (preflight: SandboxBoundary["preflight"] = async () => ({ token: "token-falso" })): SandboxBoundary => ({
  preflight,
  imageHas: async () => true,
  run: async () => {
    throw new Error("o diagnóstico não inicia container");
  },
});

const herdrOk = async () => ({ status: "ok" as const, detail: "herdr 0.9.3" });

async function localOf(root: string, options: { profile?: boolean; checkout?: boolean; checkoutPath?: string } = {}): Promise<LocalSettings> {
  const profileDir = join(root, "perfil");
  await mkdir(profileDir, { recursive: true });
  if (options.profile !== false) await writeFile(join(profileDir, "settings.json"), "{}\n");
  if (options.checkout !== false) {
    const checkout = options.checkoutPath ?? join(root, "clone-app");
    await mkdir(checkout, { recursive: true });
    await mkdir(join(root, "clone-mono"), { recursive: true });
  }
  return {
    image: "msf-docker-runner:local",
    profiles: { copilot: profileDir, "docker-default": profileDir, "docker-vazio": join(root, "vazio") },
    allowedRoots: { "docker-default": [root], "docker-vazio": [root] },
    checkouts: options.checkout === false ? {} : { "acme/app": options.checkoutPath ?? join(root, "clone-app"), "acme/mono": join(root, "clone-mono") },
  };
}

async function assist(instanceName: string, extra: Partial<AssistOptions> = {}): Promise<CliRun> {
  const loaded = await loadInstance(fixture("assist-instances.json"), instanceName);
  assert.ok(loaded.ok, loaded.ok ? "" : loaded.run.stderr);
  const root = await mkdtemp(join(tmpdir(), "msf-assist-"));
  const local = extra.local ?? await localOf(root);
  const stateDir = extra.stateDir ?? join(root, "state");
  return runAssist({
    config: loaded.config,
    instance: loaded.instance,
    local,
    stateDir,
    env: {},
    sandbox: sandboxOf(),
    tracker: await memoryTracker(),
    ...extra,
  });
}


const linesFor = (stdout: string, token: string) =>
  stdout.split("\n").filter((line: string) => line.trimStart().startsWith(`${token} `));
const firstLine = (stdout: string, token: string): string => {
  const [line] = linesFor(stdout, token);
  assert.ok(line, `linha esperada para ${token}`);
  return line;
};

const jobOf = (id: string, repository = "acme/app"): Job =>
  newJob({ ref: { tracker: "memory", project: repository, id }, repository });

async function withJobs(jobs: Job[]): Promise<string> {
  const stateDir = join(await mkdtemp(join(tmpdir(), "msf-assist-")), "state");
  const store = createFileJobStore(stateDir);
  for (const job of jobs) await store.save(job);
  return stateDir;
}

// ── plumbagem do comando ──────────────────────────────────────────────────────────────────────

test("msf --help lista o comando assist", async () => {
  const root = await mkdtemp(join(tmpdir(), "msf-assist-"));
  const run = await runMsf(["--help"], { root, env: {} });
  assert.match(run.stdout, /assist/);
});

test("assist --help mostra o uso; assist não recebe trabalho nem --check/--once", async () => {
  const root = await mkdtemp(join(tmpdir(), "msf-assist-"));
  const home = join(root, ".msf");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "config.json"), JSON.stringify({ credentials: {}, runtimeProfiles: {}, instances: [] }));
  const deps: MsfDeps = { root, env: {} };
  assert.match((await runMsf(["assistida", "assist", "--help"], deps)).stdout, /uso: \.\/msf \[--home DIR\] <instância> assist/);
  assert.equal((await runMsf(["assistida", "assist", "#13"], deps)).exitCode, 2);
  assert.equal((await runMsf(["assistida", "assist", "--check"], deps)).exitCode, 2);
});

test("assist exige local.json e nomeia o caminho procurado", async () => {
  const root = await mkdtemp(join(tmpdir(), "msf-assist-"));
  const home = join(root, ".msf");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "config.json"), JSON.stringify({
    credentials: { copilot: { kind: "pi-auth", ref: "copilot" } },
    runtimeProfiles: { "docker-vazio": { required: { files: [] } } },
    instances: [{
      name: "i", maxConcurrent: 1, pollIntervalSeconds: 60, maxIterations: 1, modelAuth: "copilot",
      projects: [{
        name: "p", enabled: true, adapter: "github", repository: "acme/p", targetBranch: "main", prIntegration: "github.com",
        runtimeProfile: "docker-vazio", githubAccount: "acme", labels: { ready: "ready-for-agent", claimed: "agent-claimed" },
        models: {
          implementer: "a/b", "reviewer-standards": "a/b", "reviewer-spec": "a/b", default: "a/b",
        },
      }],
    }],
  }));
  const run = await runMsf(["i", "assist"], { root, env: {} });
  assert.equal(run.exitCode, 1);
  assert.match(run.stderr, new RegExp(`local\\.json não encontrado em ${join(home, "local.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

// ── capacidade e parâmetros de assistência ────────────────────────────────────────────────────

test("o diagnóstico apresenta os dois limites N independentes e a assistModel configurada", async () => {
  const stateDir = await withJobs([jobOf("1"), transitionJob(jobOf("9"), "interrupted", { message: "x", reason: "y" })]);
  const { stdout } = await assist("assistida", { stateDir });
  assert.match(stdout, /implementação autônoma: N=2 \(vagas em uso agora: 1\)/);
  assert.match(stdout, /sessões assistidas: N=3 \(abertas agora: 0\)/);
  assert.match(stdout, /modelo de assistência: github-copilot\/claude-haiku-5\.5/);
});

test("maxAssisted e assistModel ausentes aparecem como não configurados, sem inventar limite nem herdar o modelo", async () => {
  const { stdout } = await assist("sem-config");
  assert.match(stdout, /sessões assistidas: não configurado \(maxAssisted ausente no config\.json\)/);
  assert.match(stdout, /modelo de assistência: não configurado \(assistModel ausente no config\.json; não herda o modelo de implementação\)/);
});

// ── ambiente, sem iniciar execução ────────────────────────────────────────────────────────────

test("Herdr não pode ser comprovado nesta fatia e aparece como desconhecido, nunca como ok", async () => {
  const { stdout } = await assist("assistida");
  assert.match(stdout, /Herdr: desconhecido —[^\n]*(#52|prova técnica)/);
  assert.doesNotMatch(stdout, /Herdr: ok/);
});

test("o Herdr injetado é exibido quando comprovado; Docker vem do preflight do sandbox", async () => {
  const { stdout } = await assist("assistida", { herdr: herdrOk });
  assert.match(stdout, /Herdr: ok — herdr 0\.9\.3/);
  assert.match(stdout, /Docker: ok —[^\n]*msf-docker-runner:local/);
});

test("Docker indisponível é impedimento visível; nada é iniciado nem executado", async () => {
  const run = await assist("assistida", {
    sandbox: sandboxOf(async () => {
      throw new Error("docker daemon não alcançado");
    }),
  });
  assert.match(run.stdout, /Docker: impedimento — docker daemon não alcançado/);
  assert.equal(run.exitCode, 0, run.stderr);
});

// ── candidatos e impedimentos ─────────────────────────────────────────────────────────────────

test("candidatos válidos aparecem com o estado humano único; assignee humano é mostrado e não é claim", async () => {
  const { stdout } = await assist("assistida");
  assert.match(stdout, /elegíveis para atendimento assistido \(3\):\n {4}acme\/app#1 Precisa triagem — needs-triage\n {4}acme\/app#2 Com assignee humano — ready-for-human; assignees: alice \(atribuição não é claim\)\n {4}acme\/app#11 /);
});

test("claim existente continua bloqueando; claim desconhecido não é ausência de claim", async () => {
  const { stdout } = await assist("assistida");
  assert.match(firstLine(stdout, "acme/app#3"), /já claimed/);
  assert.match(firstLine(stdout, "acme/app#12"), /claim desconhecido: claim API timeout/);
});

test("estados contraditórios ficam visíveis: mistura com o fluxo autônomo, dois estados humanos, nenhum estado", async () => {
  const { stdout } = await assist("assistida");
  assert.match(firstLine(stdout, "acme/app#4"), /mistura com o fluxo autônomo \(ready-for-agent\)/);
  assert.match(firstLine(stdout, "acme/app#5"), /estados humanos contraditórios \(needs-triage, ready-for-human\)/);
  assert.match(firstLine(stdout, "acme/app#6"), /sem estado humano \(nenhum de needs-triage, needs-info, ready-for-human\)/);
});

test("labels desconhecidos não contam como ausência de impedimento", async () => {
  const { stdout } = await assist("assistida");
  assert.match(firstLine(stdout, "acme/app#7"), /labels desconhecido: labels API timeout/);
});

test("issue terminal e impedimentos/dependências bloqueiam; bloqueadores desconhecidos aparecem como desconhecidos", async () => {
  const { stdout } = await assist("assistida");
  assert.match(firstLine(stdout, "acme/app#8"), /issue terminal \(done\)/);
  assert.match(firstLine(stdout, "acme/app#9"), /bloqueada por #10 \(não terminal\)/);
  assert.match(firstLine(stdout, "acme/app#13"), /bloqueadores desconhecido: dependency API timeout/);
});

test("roteamento inequívoco continua condição: sem roteamento e roteamento ambíguo são impedimentos", async () => {
  const { stdout } = await assist("assistida");
  assert.match(firstLine(stdout, "VAN-11"), /sem roteamento/);
  assert.match(firstLine(stdout, "VAN-12"), /roteamento ambíguo/);
});

test("assignee humano diferente do operador e sprint não são condições do atendimento assistido", async () => {
  const { stdout } = await assist("assistida");
  assert.match(stdout, /VAN-10 Assignee de outra pessoa — needs-info/);
  assert.match(stdout, /VAN-13 Fora da sprint — ready-for-human/);
});

test("acompanhamento concorrente da mesma issue é impedimento, e a issue continua listada", async () => {
  const stateDir = await withJobs([jobOf("11")]);
  const { stdout } = await assist("assistida", { stateDir });
  assert.match(firstLine(stdout, "acme/app#11"), /já acompanhada pelo script/);
});

test("projeto desabilitado não é consultado", async () => {
  const { stdout } = await assist("sem-config");
  assert.match(stdout, /\[mono-off\] jira MON\n {2}projeto desabilitado: não consultado/);
});

// ── clone assistido e perfil de runtime, por projeto ──────────────────────────────────────────

test("clone assistido configurado aparece como gerenciado pelo operador, sem worktree nem proibição de escrita", async () => {
  const root = await mkdtemp(join(tmpdir(), "msf-assist-"));
  const clone = join(root, "clone-app");
  const { stdout } = await assist("assistida", { local: await localOf(root, { checkoutPath: clone }) });
  assert.match(stdout, /clone assistido: ok — .+clone-app \(gerenciado pelo operador; sem worktree da factory\)/);
  assert.match(stdout, /a factory não cria worktree nem impõe proibição de escrita/);
});

test("clone assistido ausente do local.json é impedimento; o texto afirma quem gerencia o clone", async () => {
  const root = await mkdtemp(join(tmpdir(), "msf-assist-"));
  const { stdout } = await assist("assistida", { local: await localOf(root, { checkout: false }) });
  assert.match(stdout, /clone assistido: impedimento — clone local de acme\/app não configurado \(checkouts do local\.json\)/);
  assert.match(stdout, /o clone assistido é gerenciado pelo operador: a factory não cria worktree nem impõe proibição de escrita/);
});

test("perfil de runtime: obrigatórios resolvendo no host aparece como ok (ADR 0002); faltando obrigatório é impedimento", async () => {
  const okRun = await assist("assistida");
  assert.match(okRun.stdout, /perfil de runtime docker-default: ok — obrigatórios resolvem no host/);
  const root = await mkdtemp(join(tmpdir(), "msf-assist-"));
  const semArquivo = await localOf(root, { profile: false });
  const blocked = await assist("assistida", { local: semArquivo });
  assert.match(blocked.stdout, /perfil de runtime docker-default: impedimento — obrigatório settings\.json: ausente/);
});

test("perfil não configurado no local.json aparece como impedimento nomeado", async () => {
  const root = await mkdtemp(join(tmpdir(), "msf-assist-"));
  const local = await localOf(root);
  delete local.profiles["docker-default"];
  const { stdout } = await assist("assistida", { local });
  assert.match(stdout, /perfil de runtime docker-default: impedimento — perfil docker-default não configurado no runner/);
});

// ── falhas de leitura e a promessa de não escrever ────────────────────────────────────────────

// O tracker de memória mantém os métodos no prototype: um wrapper precisa nomeá-los.
const delegating = (inner: TrackerPort): TrackerPort => ({
  claimMarkOf: (ref) => inner.claimMarkOf(ref),
  discoverCandidates: (scope) => inner.discoverCandidates(scope),
  readIssue: (ref) => inner.readIssue(ref),
  claim: (ref) => inner.claim(ref),
  releaseClaim: (ref) => inner.releaseClaim(ref),
  updateLabels: (ref, changes) => inner.updateLabels(ref, changes),
  readComments: (ref) => inner.readComments(ref),
  postComment: (ref, body) => inner.postComment(ref, body),
  markDone: (ref) => inner.markDone(ref),
});

test("tracker indisponível é reportado por projeto, os outros continuam e a saída é 1", async () => {
  const inner = await memoryTracker();
  const failing: TrackerPort = {
    ...delegating(inner),
    discoverCandidates: async (scope) => {
      if (scope.project === "acme/app") throw new Error("GitHub API 503");
      return inner.discoverCandidates(scope);
    },
  };
  const run = await assist("assistida", { tracker: failing });
  assert.equal(run.exitCode, 1);
  assert.match(run.stdout, /\[app\][^[]*tracker indisponível: GitHub API 503/);
  assert.match(run.stdout, /\[monolith\][^[]*elegíveis para atendimento assistido \(2\)/);
});

test("o diagnóstico nunca escreve no tracker, nunca inicia container e nunca abre sessão", async () => {
  const inner = await memoryTracker();
  const writes: string[] = [];
  const guarded: TrackerPort = {
    ...delegating(inner),
    claim: async (ref) => { writes.push("claim"); return inner.claim(ref); },
    releaseClaim: async (ref) => { writes.push("release"); return inner.releaseClaim(ref); },
    postComment: async (ref, body) => { writes.push("comment"); return inner.postComment(ref, body); },
    markDone: async (ref) => { writes.push("done"); return inner.markDone(ref); },
  };
  const container: string[] = [];
  const sandbox: SandboxBoundary = {
    ...sandboxOf(),
    preflight: async (input) => { container.push(`preflight ${input.image}`); return { token: "t" }; },
    run: async () => { container.push("run"); throw new Error("nunca"); },
  };
  const run = await assist("assistida", { tracker: guarded, sandbox, herdr: herdrOk });
  assert.equal(run.exitCode, 0, run.stderr);
  assert.deepEqual(writes, []);
  assert.deepEqual(container, ["preflight msf-docker-runner:local"]);
});

test("segredo do ambiente não chega à saída através de falha do tracker", async () => {
  const leaky: TrackerPort = { ...delegating(await memoryTracker()), discoverCandidates: async () => { throw new Error("401 for token super-secret-token-123"); } };
  const run = await assist("assistida", { tracker: leaky, env: { GH_TOKEN: "super-secret-token-123" } });
  assert.equal(run.exitCode, 1);
  assert.doesNotMatch(run.stdout, /super-secret-token-123/);
  assert.match(run.stdout, /tracker indisponível: 401 for token \[redacted\]/);
});

// ── Interrupções consultáveis (ticket #56) ───────────────────────────────────────────────────

test("o diagnóstico mostra as interrupções gravadas com a decisão de continuidade persistida", async () => {
  const stateDir = join(await mkdtemp(join(tmpdir(), "msf-assist-")), "state");
  const store = createFileAssistSessionStore(join(stateDir, "assist-sessions"));
  const record: Parameters<typeof store.save>[0] = {
    key: "memory:acme/app#1", ref: { tracker: "memory", project: "acme/app", id: "1" },
    repository: "acme/app", state: "pending", promptKind: "needs-triage", model: "p/m",
    image: "img", cloneDir: "/c", startedAt: "2026-10-14T12:00:00.000Z",
    reason: "execução encerrada (exit 0) sem resultado de atendimento reconhecido",
    continuity: {
      question: "autoriza uma retomada futura desta mesma sessão?",
      askedAt: "2026-10-14T12:05:00.000Z",
    },
    log: [],
  } as Parameters<typeof store.save>[0];
  await store.save(record as never);

  const asked = await assist("assistida", { stateDir });
  assert.match(asked.stdout, /memory:acme\/app#1 — pending, modelo p\/m/);
  assert.match(asked.stdout, /motivo: execução encerrada \(exit 0\) sem resultado de atendimento reconhecido/);
  assert.match(asked.stdout, /decisão: pergunta de continuidade pendente/);

  await store.save({ ...record, continuity: { ...record.continuity!, answeredAt: "2026-10-14T12:06:00.000Z", answer: "não autorizo retomada automática" } } as never);
  const answered = await assist("assistida", { stateDir });
  assert.match(answered.stdout, /decisão: respondida \(não autorizo retomada automática\)/);
});

// ── Retomada autorizada de uso único consultável (ticket #57) ─────────────────────────────────

test("o diagnóstico mostra a retomada agendada pela resposta e seu consumo pelo uso único", async () => {
  const stateDir = join(await mkdtemp(join(tmpdir(), "msf-assist-")), "state");
  const store = createFileAssistSessionStore(join(stateDir, "assist-sessions"));
  const record: Parameters<typeof store.save>[0] = {
    key: "memory:acme/app#1", ref: { tracker: "memory", project: "acme/app", id: "1" },
    repository: "acme/app", state: "pending", promptKind: "needs-triage", model: "p/m",
    image: "img", cloneDir: "/c", startedAt: "2026-10-14T12:00:00.000Z",
    reason: "execução encerrada (exit 0) sem resultado de atendimento reconhecido",
    continuity: {
      question: "autoriza uma retomada futura desta mesma sessão?",
      askedAt: "2026-10-14T12:05:00.000Z",
      answeredAt: "2026-10-14T12:06:00.000Z",
      answer: "sim, pode retomar",
    },
    scheduledResume: { at: "2026-10-14T12:06:00.000Z", command: "cmd-1", answer: "sim, pode retomar" },
    log: [],
  } as Parameters<typeof store.save>[0];
  await store.save(record as never);

  const scheduled = await assist("assistida", { stateDir });
  assert.match(scheduled.stdout, /decisão: respondida \(sim, pode retomar\), retomada agendada \(uso único\)/);
  await store.save({
    ...record,
    scheduledResume: { at: record.scheduledResume!.at, command: record.scheduledResume!.command,
      answer: record.scheduledResume!.answer, consumed: { at: "2026-10-14T12:07:00.000Z", attempt: "msf-assist-memory-2d-acme-app...#abc12345" } },
  } as never);
  const consumed = await assist("assistida", { stateDir });
  assert.match(consumed.stdout, /retomada agendada consumida pela tentativa msf-assist-memory-2d-acme-app\.\.\.#abc12345 \(em 2026-10-14T12:07:00.000Z\)/);
});
