import { createFileJobStore } from "../state/file-job-store.js";
import { join } from "node:path";
import { createFileAssistSessionStore } from "../state/file-assist-session-store.js";
import { createFileAttentionStore } from "../state/file-attention-store.js";
import { createFileCommandQueue } from "../state/command-queue.js";
import { createFileInstanceControl } from "../state/instance-control.js";
import { readFailures, type RecordedFailure } from "../state/history.js";
import { holdsSlot, type Job, type JobState } from "./job.js";
import type { JobCommands } from "./observability.js";
import { holdsCapacity, unconsumedResume, type AssistSession } from "./assist-session.js";
import type { AssistAreaFs, ExitRecordVerdict } from "./assist-flow.js";
import { createFileAssistAreaFs } from "../state/file-assist-area-fs.js";
import { assistExitRecordPath } from "../runtime/assist-exec.js";
import type { AttentionPending } from "./attention.js";
import type { IssueRef, TrackerPort } from "../tracker/port.js";
import type { InstanceConfig } from "../config/types.js";
import type { OperatorCommand } from "./commands.js";

// The operator's reading model (issue #61, spec #60): a READ-ONLY builder over what the core
// already recorded. It renders nothing, writes nothing (no store save/remove, no tracker write)
// and recomputes neither admission nor eligibility: the EstadoVivo of each work is derived from
// the persisted job/session state plus the one continuation already announced (`job.pending`),
// and the meters are presentation arithmetic over the core's own capacity semantics
// (`holdsSlot` for implementation slots, `holdsCapacity` for assisted sessions).
//
// ── EstadoVivo mapping (the comment table the spec asks for) ────────────────────────────────
// ┌──────┬───────────────────────────────────────────────┬───────────────────────────────────────┐
// │ estado vivo          │ trabalho autônomo (Job)                       │ atendimento assistido (AssistSession)      │
// ├──────┼───────────────────────────────────────────────┼───────────────────────────────────────┤
// │ em-invocacao         │ job.state === "running" (holdsSlot)           │ —                                        │
// │ sessao-aberta        │ —                                             │ opening|open (holdsCapacity; aguardando  │
// │                      │                                               │ o humano incluído)                       │
// │ pedido-de-ajuda      │ job.state === "waiting-for-help"              │ —                                        │
// │ interrompido         │ interrupted|intervention-required             │ pending sem retomada não consumida       │
// │ retomada-autorizada  │ job.pending === "resume" (VENCE a base)       │ pending com unconsumedResume(session)    │
// │ fila                 │ job.pending === "correction" (continuação     │ —                                        │
// │                      │ aguardando vaga; candidatos não gravados NÃO  │                                          │
// │                      │ derivam fila: recomputar é proibido)          │                                          │
// │ espera-externa       │ waiting-for-pr — DESVIO registrado (fora dos  │ —                                        │
// │                      │ 7 estados da spec; não ocupa vaga)            │                                          │
// │ aguardando-aprovacao │ —                                             │ proposed — DESVIO registrado (fora dos 7 │
// │                      │                                               │ estados da spec; não ocupa capacidade)   │
// │ atendimento-concluido│ — (done é fim do trabalho, não do atendimento)│ concluding (aprovação aplicada em curso) │
// └──────┴───────────────────────────────────────────────┴───────────────────────────────────────┘
// done/released do trabalho autônomo saem da lista de trabalhos acompanhados, como `status` já
// trata; a sessão assistida concluída some do store no momento da conclusão confirmada.
//
// ── Decisões de glossário registradas (revisão de padrões da spec #60) ──────────────────────
// retomada-autorizada: o GLOSSARY.md precisa "Retomada manual" (pedido explícito do operador,
// nos DOIS fluxos) e "Retomada autorizada" (de uso único, agendada pela resposta à pergunta de
// continuidade do trabalho humano assistido — ticket #77); as histórias 16–17 da spec #60 aplicam
// o estado "retomada autorizada" aos DOIS fluxos (job.pending === "resume" no autônomo, a
// autorização de uso único no assistido), então aqui o estado vivo é lido no sentido amplo da
// spec — a diferença entre o que o operador pediu agora (manual) e o que ficou agendado segue
// sem ambiguidade nos termos do glossário.
// interrompido: o glossário trata "intervenção" como termo separado; o merge apaga essa
// separação DE PROPÓSITO — para o operador, intervention-required e interrompido são o mesmo
// balde ("execução parou sem desfecho válido — decisão pendente": mesmos conjuntos
// RELEASABLE/RESUMABLE no núcleo). Mapeamento documentado, não uma perda de vocabulário.

export type Fluxo = "implementacao-autonoma" | "humano-assistido";

export type EstadoVivo =
  | "fila"
  | "em-invocacao"
  | "sessao-aberta"
  | "pedido-de-ajuda"
  | "interrompido"
  | "retomada-autorizada"
  | "atendimento-concluido"
  // Deviations registered against spec #60's seven states (flagged to the orchestrator): both
  // come from a real recorded state the operator must see, and neither occupies a slot.
  | "espera-externa"        // autonomous waiting-for-pr: external wait (CI/review) — no slot
  | "aguardando-aprovacao"; // assisted proposed: result recognized, approval pending — no capacity

export interface IssueStatusView {
  // The tracker-side status category, or "indisponível" when no tracker port was injected or
  // the read failed: the estado vivo and the issue status stay separate, never conflated.
  status: string;
}

// A pending as the store holds it, plus the derived age the reading model computes (spec #62):
// the label is presentation arithmetic over `at` versus the reading's clock; the record itself
// stays untouched (the model never persists or alters the stored pending).
export type PendingWithAge = AttentionPending & { idade: string };

// The age label of one pending occurrence, from its creation instant versus now. Pure and
// coercing: a clock behind the record (clock skew, a test injecting a past now) is still a
// fresh pending, never a negative age.
export function idadeDe(at: string, now: Date): string {
  const opened = new Date(at).getTime();
  const elapsedMs = Math.max(0, now.getTime() - (Number.isNaN(opened) ? now.getTime() : opened));
  if (elapsedMs < 60_000) return "há segundos";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours}h`;
  const days = Math.floor(hours / 24);
  return `há ${days} ${days === 1 ? "dia" : "dias"}`;
}

// ── #77 — the end-of-execution record, per assisted session ─────────────────────────────────
// The reading model exposes whether the exec's end record (`msf-exit.json`, written by the
// container wrapper) already exists, WITHOUT re-deriving the verdict: it is the fs authority's
// own `readExitRecord` over `assistExitRecordPath(execStateDir)`. That is what lets the TUI
// pre-check accept a manual resume while the persisted state still says `open`: the record
// exists ⇔ the execution really ended. Three values, never a boolean: an unreadable/invalid
// record is `ilegível` (unknown), which is NOT the same as absent (a live exec) — the same
// distinction the flow itself makes. Read only for `opening`/`open` sessions, the only ones
// with an exec whose end can appear; every other work reports `ausente` (no channel to judge).
export type RegistroDeFim = "presente" | "ausente" | "ilegível";

export interface OperatorWork {
  // The full key (same key space as the flows); the TUI shortens autonomous refs like `status` does.
  key: string;
  repository: string;
  fluxo: Fluxo;
  estadoVivo: EstadoVivo;
  // Whether the exec's end record already exists (#77). `presente` on an `open` session means
  // the execution really stopped and the next supervision pass parks it; the manual resume
  // (`retomar`) is offered from this reading too, without a second key press.
  registroDeFim: RegistroDeFim;
  // Display reference: `project#id` for autonomous jobs (status's short form), full key for
  // assisted sessions (their keys never shorten, mirroring the approve command).
  issueRef: string;
  // The work's real tracker reference: `job.ref` for autonomous, `session.ref` for assisted —
  // the port the issue status is read through. `issueRef` above is the display form only.
  ref: IssueRef;
  // Whether the work occupies its flow's capacity right now (core semantics, presentation only).
  ocupaVaga: boolean;
  issue: IssueStatusView;
}

export interface CapacityMeter {
  used: number;
  // null: no limit configured (spec #48: without maxAssisted no session is ever opened; the
  // reading model does not invent a number).
  limit: number | null;
}

export interface OperatorView {
  works: OperatorWork[];
  meters: { implementation: CapacityMeter; assisted: CapacityMeter };
  // The persistent pendings, each carrying the derived age (spec #62): everything the store
  // returned is exposed unchanged — the queue is never filtered, hidden or reordered by
  // notification state, because resolution is REMOVAL by the store, so anything present is
  // unresolved by construction — plus `idade`, a human label derived from `at` versus the
  // injected now. `notification` is exposed as-is so the TUI can annotate a failed delivery;
  // a failed or absent notification never removes or hides an item.
  pendings: PendingWithAge[];
  footer: {
    jobsDone: number;
    jobsReleased: number;
    pendings: number;
    pendingCommands: number;
    pause: { paused: boolean; pending: boolean };
  };

  // The raw recorded entities the text CLIs consume (issue #65: one reading face, two faces).
  // This is exactly what the stores have — no derivation beyond estadoVivo above, no resizing
  // of the model beyond what `status`/`logs` need. `jobs` holds EVERY state, the done and
  // released included (the CLIs count and list them); `sessions` is the full assisted registry.
  jobs: Job[];
  sessions: AssistSession[];
  // Per-store unreadable lists (file names, as the store `load()` reports them) and the queue
  // snapshot, so `status` needs no second local read of its own.
  storeReads: {
    jobs: { unreadable: string[] };
    // `degraded`: the store's whole directory could not be read (no ENOENT-empty case): the
    // same degradation `status` always applied, said as a line, not thrown.
    sessions: { unreadable: string[]; degraded?: string };
    attention: { unreadable: string[]; degraded?: string };
    commands: { commands: OperatorCommand[]; unreadable: string[] };
  };
  // Observability failing right now (`observability/failures.json`): what the operator lost of
  // the visibility, not what the agent lost of the execution. The unreadability of the file
  // itself degrades to this line, said once, not hidden.
  observability: { failures: RecordedFailure[]; failuresUnreadable?: string };
  // The single loading seam the CLIs must use (issue #65): one state dir, one read of the
  // recorded state, honoring the same JobStore port the instance itself drives.
  loadJob(key: string): Job | undefined;
}

// The display priority the prototype encodes (spec #60: "retomada autorizada tem prioridade na
// fila"): authorization first, then everything that waits on the operator or the world, then the
// live execution, the concluding attendance and finally the plain queue. Ties break by ref id
// ascending (the prototype breaks by issue number).
const ORDER: Record<EstadoVivo, number> = {
  "retomada-autorizada": 0,
  "sessao-aberta": 1,
  "pedido-de-ajuda": 1,
  interrompido: 1,
  "aguardando-aprovacao": 1,
  "espera-externa": 1,
  "em-invocacao": 2,
  "atendimento-concluido": 3,
  fila: 4,
};

// The tracked job states this derivation sees: done/released leave the tracked list before the
// mapping runs (the builder filters them exactly like `status` does), so the parameter type says
// only reachable states exist here — a future unmapped state fails the build, not the operator.
type TrackedJob = Job & { state: Exclude<JobState, "done" | "released"> };

const estadoVivoOfJob = (job: TrackedJob): EstadoVivo => {
  // The authorized continuation wins over the base state: the decision was already given and
  // only a slot is missing (spec #60 user story 17: first place in the queue).
  if (job.pending === "resume") return "retomada-autorizada";
  if (job.pending === "correction") return "fila";
  switch (job.state) {
    case "running": return "em-invocacao";
    case "waiting-for-help": return "pedido-de-ajuda";
    // Both are the "stopped without valid outcome, operator decides" bucket (registered mapping
    // decision above: intervention-required folds into interrompido).
    case "interrupted":
    case "intervention-required": return "interrompido";
    // Registered deviation: an external wait is real tracked work the operator must see;
    // it holds no slot, so the meter stays honest.
    case "waiting-for-pr": return "espera-externa";
  }
};

const estadoVivoOfSession = (session: AssistSession): EstadoVivo => {
  if (session.state === "opening" || session.state === "open") return "sessao-aberta";
  if (session.state === "pending") return unconsumedResume(session) !== undefined ? "retomada-autorizada" : "interrompido";
  if (session.state === "proposed") {
    // Registered deviation: the recognized-but-unapproved result is a distinct operator decision.
    return "aguardando-aprovacao";
  }
  return "atendimento-concluido";
};

// The end-record verdict of one session, through the same fs authority the flow uses. Pure read
// (no save/remove): a live exec (ENOENT) is `ausente`, a real record is `presente`, an
// unreadable or invalid file is `ilegível`.
const registroDeFimOf = async (
  session: AssistSession, areaFs: Pick<AssistAreaFs, "readExitRecord">,
): Promise<RegistroDeFim> => {
  if (session.state !== "opening" && session.state !== "open") return "ausente";
  if (session.execStateDir === undefined) return "ausente";
  const verdict: ExitRecordVerdict = await areaFs.readExitRecord(assistExitRecordPath(session.execStateDir));
  if (verdict.kind === "ended") return "presente";
  return verdict.kind === "unknown" ? "ilegível" : "ausente";
};

const trackerStatus = async (tracker: TrackerPort | undefined, ref: IssueRef): Promise<IssueStatusView> => {
  if (tracker === undefined) return { status: "indisponível" };
  try {
    const issue = await tracker.readIssue(ref);
    // Unknown is never absence: an unknown category reports exactly that, not a guessed state.
    return { status: issue.statusCategory.known ? issue.statusCategory.value : `desconhecido: ${issue.statusCategory.reason}` };
  } catch {
    return { status: "indisponível" };
  }
};

export interface OperatorViewDeps {
  stateDir: string;
  instance: InstanceConfig;
  // Optional read-only tracker port for the issue status column; absent ⇒ "indisponível".
  // Never written through: the model has no path to a tracker write.
  tracker?: TrackerPort;
  // The clock of the reading, injectable so the tests are deterministic; defaults to `new Date()`.
  now?: () => Date;
}

// Loads the recorded state of ONE instance and derives the reading model. Pure read: no store
// save/remove, no queue enqueue, no control write, no tracker write (verified by the tests that
// re-read every raw store after a build).
export async function buildOperatorView(deps: OperatorViewDeps): Promise<OperatorView> {
  const { stateDir, instance } = deps;
  const now = deps.now ?? (() => new Date());
  // One parallel read of every local store — the SAME loads the CLIs used to compose by hand.
  // Job store, queue and control still throw (the reading cannot stand without the recorded
  // jobs and the queue head); the assisted/attention stores degrade like `status` always
  // degraded them: the store's data shows as a said unreadability line, the rest of the
  // reading keeps standing. The observability failures file degrades the same way.
  const [jobsResult, sessionsResult, attentionResult, queuedResult, appliedPause, failuresOnce] = await Promise.all([
    createFileJobStore(stateDir).load(),
    createFileAssistSessionStore(join(stateDir, "assist-sessions")).load().then(
      (value) => ({ value, degraded: undefined as string | undefined }),
      (error: unknown) => ({ value: { sessions: [], unreadable: [] as string[] }, degraded: error instanceof Error ? error.message : String(error) }),
    ),
    createFileAttentionStore(join(stateDir, "pendencias")).load().then(
      (value) => ({ value, degraded: undefined as string | undefined }),
      (error: unknown) => ({ value: { pendings: [], unreadable: [] as string[] }, degraded: error instanceof Error ? error.message : String(error) }),
    ),
    createFileCommandQueue(stateDir).pending(),
    createFileInstanceControl(stateDir).isPaused(),
    // The failures file itself unreadable degrades to a said line, never an error out.
    readFailures(stateDir)
      .then((failures) => ({ failures, failuresUnreadable: undefined as string | undefined }))
      .catch((error) => ({
        failures: [] as RecordedFailure[],
        failuresUnreadable: error instanceof Error ? error.message : String(error),
      })),
  ]);
  const jobs = jobsResult;
  const sessions = sessionsResult.value;
  const attention = attentionResult.value;
  const queued = queuedResult;

  // The one loading seam for a single work by key (issue #65, the `logs` path): the model's own
  // snapshot, not a fresh store interrogation. `status` already holds the whole list; `logs`
  // asks for one key and gets the same record `status` would have shown.
  const loaded = new Map(jobs.jobs.map((job) => [job.key, job]));

  // The end-record channel of the assisted sessions (#77): the same fs authority the flow owns,
  // built once per reading.
  const areaFs = createFileAssistAreaFs();

  const autonomous = jobs.jobs
    .filter((job): job is TrackedJob => job.state !== "done" && job.state !== "released")
    .map((job): OperatorWork => ({
      key: job.key,
      repository: job.repository,
      fluxo: "implementacao-autonoma",
      estadoVivo: estadoVivoOfJob(job),
      // An autonomous job has no assisted exec channel: there is no end record to judge.
      registroDeFim: "ausente",
      issueRef: `${job.ref.project}#${job.ref.id}`,
      ref: job.ref,
      ocupaVaga: holdsSlot(job.state),
      issue: { status: "" },
    }));
  const assisted = await Promise.all(sessions.sessions.map(async (session): Promise<OperatorWork> => ({
    key: session.key,
    repository: session.repository,
    fluxo: "humano-assistido",
    estadoVivo: estadoVivoOfSession(session),
    registroDeFim: await registroDeFimOf(session, areaFs),
    // A session key never shortens (mirrors approve/assist, which print the full key).
    issueRef: session.key,
    ref: session.ref,
    ocupaVaga: holdsCapacity(session),
    issue: { status: "" },
  })));
  const works = [...autonomous, ...assisted];

  // The issue status is the only per-work tracker read, and it is optional: with no port (the
  // common local run, or an unavailable tracker) the column reads "indisponível" and nothing else
  // changes. Failures degrade per work; they never lose the work.
  await Promise.all(works.map(async (work) => {
    work.issue = await trackerStatus(deps.tracker, work.ref);
  }));

  works.sort((a, b) => {
    const byState = ORDER[a.estadoVivo] - ORDER[b.estadoVivo];
    if (byState !== 0) return byState;
    // Tie: ascending ref id (the prototype's issue-number order), compared directly on the
    // work's real ref — no synthetic reference is built for the comparison.
    return a.ref.id.localeCompare(b.ref.id, "en", { numeric: true });
  });

  const lastPause = [...queued.commands].reverse().find((command) => command.type === "pause" || command.type === "unpause");
  const paused = lastPause !== undefined ? lastPause.type === "pause" : appliedPause;
  return {
    works,
    meters: {
      implementation: { used: jobs.jobs.filter((job) => holdsSlot(job.state)).length, limit: instance.maxConcurrent },
      assisted: { used: sessions.sessions.filter(holdsCapacity).length, limit: instance.maxAssisted ?? null },
    },
    pendings: attention.pendings.map((pending) => ({ ...pending, idade: idadeDe(pending.at, now()) })),

    footer: {
      jobsDone: jobs.jobs.filter((job) => job.state === "done").length,
      jobsReleased: jobs.jobs.filter((job) => job.state === "released").length,
      pendings: attention.pendings.length,
      pendingCommands: queued.commands.length + queued.unreadable.length,
      pause: { paused, pending: lastPause !== undefined && (lastPause.type === "pause") !== appliedPause },
    },
    jobs: jobs.jobs,
    sessions: sessions.sessions,
    storeReads: {
      jobs: { unreadable: [...jobs.unreadable] },
      sessions: { unreadable: [...sessions.unreadable], ...(sessionsResult.degraded === undefined ? {} : { degraded: sessionsResult.degraded }) },
      attention: { unreadable: [...attention.unreadable], ...(attentionResult.degraded === undefined ? {} : { degraded: attentionResult.degraded }) },
      commands: { commands: [...queued.commands], unreadable: [...queued.unreadable] },
    },
    observability: {
      failures: failuresOnce.failures,
      ...(failuresOnce.failuresUnreadable === undefined ? {} : { failuresUnreadable: failuresOnce.failuresUnreadable }),
    },
    loadJob: (key: string) => loaded.get(key),
  };
}

// ── #62 — a dica do próximo passo (adaptada do protótipo `dicaPorEstado`, com os comandos reais) ─

// The command texts the hint may embed, built by the TUI layer with the observability hints
// builder (`jobCommands`, like `status` prints them) and passed in so the model stays store-free
// and rendering-free. An embedded value means "this exact text belongs on screen", never
// "executed by the TUI": the screen is read-only, and copying/queueing is #63/#64.
export interface HintColor {
  // The reply command form, when the work is an agent help request.
  reply?: string;
  // The resume command form, when the work is stopped and the operator can authorize retaking.
  resume?: string;
  // The approve command form (`base approve ref`), when approval is the operator's next step.
  approve?: string;
}

// The next step for one focused work, derived ONLY by estado vivo + fluxo (spec #62: the hint
// names the next step; it is not a repeated warning). Portuguese, adapted from the prototype's
// per-state hint (`dicaPorEstado`) but naming the REAL operator commands of the local CLI
// (`reply`/`resume`/`release`/`approve`), with the paste-ready command text embedded when the
// TUI passed one. Command insertion is optional per field: the sentence names the step either way.
export function nextStepHint(work: OperatorWork, how: HintColor): string {
  switch (work.estadoVivo) {
    case "fila":
      return "aguardando capacidade para continuação — nada exige você agora";
    case "em-invocacao":
      return "executando agora — nada exige você neste momento";
    case "pedido-de-ajuda":
      // The answer leaves through the orchestrator's reply command (stated), and the pending
      // itself only ends when the agent resumes the work.
      return how.reply === undefined
        ? "a resposta vai pelo comando de reply do orquestrador — o ponto de atenção só termina quando o agente retomar o trabalho"
        : `a resposta vai pelo reply do orquestrador — para copiar: ${how.reply} — o ponto de atenção só termina quando o agente retomar o trabalho`;
    case "interrompido":
      // The paste-ready release is deliberately NOT offered at an interruption (a paste must
      // not end the follow-up by accident), so the sentence names it and embeds only the resume.
      return how.resume === undefined
        ? "parou sem desfecho válido — autorize retomada (resume) ou libere (release)"
        : `parou sem desfecho válido — autorize a retomada: ${how.resume} — ou libere o trabalho (release)`;
    case "retomada-autorizada":
      // A single continuity with queue priority, consumed once: autonomous reservation is
      // consumed by the next invocation, assisted by reopening the session.
      return work.fluxo === "implementacao-autonoma"
        ? "continuidade única já autorizada — primeiro da fila: a retomada se consome na próxima invocação"
        : "continuidade única autorizada — sessão e contexto preservados primeiro da fila: a retomada se consome ao reabrir a sessão";
    case "aguardando-aprovacao":
      return how.approve === undefined
        ? "resultado proposto aguardando sua decisão — aprove com approve quando ele for aceitável"
        : `resultado proposto aguardando sua decisão — aprove quando ele for aceitável: ${how.approve}`;
    case "atendimento-concluido":
      return "fim do acompanhamento — o atendimento se encerrou e a issue permanece aberta";
    case "sessao-aberta":
      return how.approve === undefined
        ? "você conduz o atendimento pelo Herdr — para concluir, aprove o resultado (a issue não fecha)"
        : `você conduz o atendimento pelo Herdr — para concluir, aprove o resultado (a issue não fecha): ${how.approve}`;
    case "espera-externa":
      return "aguardando CI/revisão — espera externa não ocupa vaga";
  }
}

// ── #64 — o comando copiável do "atender" (leitura pura; NADA é executado pela TUI) ───────────

// O contexto seguido do trabalho em foco, já produzido pelo núcleo: a TUI monta este objeto com
// os mesmos insumos de sempre (`jobCommands(cli, …)` com as CliHints do `status` para o
// autônomo; a sessão gravada da visão para o assistido) e a derivação aqui só escolhe o texto.
export interface AtenderContext {
  // Os comandos prontos para colar de UM trabalho autônomo — `commands.logs` e, quando o
  // núcleo registrou um, `commands.detail` (a forma do `Observer.commands`). Ausente ⇒ null.
  commands?: JobCommands;
  // A sessão assistida gravada cuja área o operador abre no Herdr. Ausente ⇒ null.
  session?: AssistSession;
}

// A linha de identidade da área no Herdr, no que o núcleo já imprime hoje: a assist-CLI lista
// `aba <tabId>` e `container <name>` (sessionLines), e os eventos de abertura/parada imprimem
// os campos `aba` (id, ou rótulo quando o id ainda não existe) e `container`. A mesma ordem e
// palavras valem aqui, mais o clone gravado na sessão. Sem identidade de área (nenhuma aba e
// nenhum container gravados — ex.: sessão em abertura ou um pendente que nunca abriu) NÃO há
// o que abrir: null, e a TUI mostra nada em vez de inventar. Não é um comando a executar: é a
// identidade que a exibição mostra para o operador navegar no Herdr (a navegação direta fica
// na prova do pré-requisito da #48; ADR 0002: nada é prometido executado pela TUI).
const areaHerdr = (session: AssistSession | undefined): string | null => {
  if (session === undefined) return null;
  const aba = session.tabId ?? session.label;
  const container = session.containerName ?? session.containerId;
  if (aba === undefined && container === undefined) return null;
  return [
    ...(aba === undefined ? [] : [`aba ${aba}`]),
    ...(container === undefined ? [] : [`container ${container}`]),
    `clone ${session.cloneDir}`,
  ].join(" · ");
};

// O texto que o "atender" mostra para o trabalho em foco (issue #64, spec #60): o comando
// copiável para abrir o contexto do trabalho, REUTILIZANDO os hints que o núcleo já produz —
// nada é re-formatado nem inventado aqui. Para o assistido é a linha de identidade do Herdr
// (exibição de contexto; a resolução do ponto vem do desfecho, nunca de copiar isto). Para o
// autônomo é o log principal (`commands.logs`) e, quando o núcleo registrou um, a linha
// `tail -f` do log detalhado (`commands.detail`), espelhando o que o log principal imprime
// num pedido de ajuda/interrupção. Devolve null quando nada é derivável (identidade de
// sessão ausente, comandos ausentes) — a TUI mostra nada em vez de inventar.
export function comandoAtender(work: OperatorWork, followedContext: AtenderContext): string | null {
  if (work.fluxo === "humano-assistido") return areaHerdr(followedContext.session);
  const commands = followedContext.commands;
  if (commands === undefined) return null;
  return commands.detail === undefined ? commands.logs : `${commands.logs}\n${commands.detail}`;
}
