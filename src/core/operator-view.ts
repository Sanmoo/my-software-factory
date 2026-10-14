import { createFileJobStore } from "../state/file-job-store.js";
import { createFileAssistSessionStore } from "../state/file-assist-session-store.js";
import { createFileAttentionStore } from "../state/file-attention-store.js";
import { createFileCommandQueue } from "../state/command-queue.js";
import { createFileInstanceControl } from "../state/instance-control.js";
import { readFailures, type RecordedFailure } from "../state/history.js";
import { holdsSlot, type Job } from "./job.js";
import { holdsCapacity, unconsumedResume, type AssistSession } from "./assist-session.js";
import type { AttentionPending } from "./attention.js";
import { refKey, type IssueRef, type TrackerPort } from "../tracker/port.js";
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

export interface OperatorWork {
  // The full key (same key space as the flows); the TUI shortens autonomous refs like `status` does.
  key: string;
  repository: string;
  fluxo: Fluxo;
  estadoVivo: EstadoVivo;
  // Display reference: `project#id` for autonomous jobs (status's short form), full key for
  // assisted sessions (their keys never shorten, mirroring the approve command).
  issueRef: string;
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

const estadoVivoOfJob = (job: Job): EstadoVivo => {
  // The authorized continuation wins over the base state: the decision was already given and
  // only a slot is missing (spec #60 user story 17: first place in the queue).
  if (job.pending === "resume") return "retomada-autorizada";
  if (job.pending === "correction") return "fila";
  switch (job.state) {
    case "running": return "em-invocacao";
    case "waiting-for-help": return "pedido-de-ajuda";
    // Both are the "stopped without valid outcome, operator decides" bucket.
    case "interrupted":
    case "intervention-required": return "interrompido";
    // Registered deviation: an external wait is real tracked work the operator must see;
    // it holds no slot, so the meter stays honest.
    case "waiting-for-pr": return "espera-externa";
    // done/released leave the tracked list before this function is called.
    case "done":
    case "released": return "fila";
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
    createFileAssistSessionStore(`${stateDir}/assist-sessions`.replace("//", "/")).load().then(
      (value) => ({ value, degraded: undefined as string | undefined }),
      (error: unknown) => ({ value: { sessions: [], unreadable: [] as string[] }, degraded: error instanceof Error ? error.message : String(error) }),
    ),
    createFileAttentionStore(`${stateDir}/pendencias`.replace("//", "/")).load().then(
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

  const autonomous = jobs.jobs
    .filter((job) => job.state !== "done" && job.state !== "released")
    .map((job): OperatorWork => ({
      key: job.key,
      repository: job.repository,
      fluxo: "implementacao-autonoma",
      estadoVivo: estadoVivoOfJob(job),
      issueRef: `${job.ref.project}#${job.ref.id}`,
      ocupaVaga: holdsSlot(job.state),
      issue: { status: "" },
    }));
  const assisted = sessions.sessions.map((session): OperatorWork => ({
    key: session.key,
    repository: session.repository,
    fluxo: "humano-assistido",
    estadoVivo: estadoVivoOfSession(session),
    // A session key never shortens (mirrors approve/assist, which print the full key).
    issueRef: session.key,
    ocupaVaga: holdsCapacity(session),
    issue: { status: "" },
  }));
  const works = [...autonomous, ...assisted];

  // The issue status is the only per-work tracker read, and it is optional: with no port (the
  // common local run, or an unavailable tracker) the column reads "indisponível" and nothing else
  // changes. Failures degrade per work; they never lose the work.
  await Promise.all(works.map(async (work) => {
    const ref = autonomous.some((candidate) => candidate.key === work.key)
      ? jobs.jobs.find((job) => job.key === work.key)!.ref
      : sessions.sessions.find((session) => session.key === work.key)!.ref;
    work.issue = await trackerStatus(deps.tracker, ref);
  }));

  works.sort((a, b) => {
    const byState = ORDER[a.estadoVivo] - ORDER[b.estadoVivo];
    if (byState !== 0) return byState;
    // Tie: ascending ref id (the prototype's issue-number order).
    const idOf = (work: OperatorWork): string => refKey({ tracker: "memory", project: work.repository, id: work.issueRef.split("#").at(-1) ?? "" });
    return idOf(a).localeCompare(idOf(b), "en", { numeric: true });
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
