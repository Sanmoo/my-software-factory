import { createFileJobStore } from "../state/file-job-store.js";
import { createFileAssistSessionStore } from "../state/file-assist-session-store.js";
import { createFileAttentionStore } from "../state/file-attention-store.js";
import { createFileCommandQueue } from "../state/command-queue.js";
import { createFileInstanceControl } from "../state/instance-control.js";
import { holdsSlot, type Job } from "./job.js";
import { holdsCapacity, unconsumedResume, type AssistSession } from "./assist-session.js";
import type { AttentionPending } from "./attention.js";
import { refKey, type IssueRef, type TrackerPort } from "../tracker/port.js";
import type { InstanceConfig } from "../config/types.js";

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
  // The persistent pendings (spec #62 displays them with age; this slice only carries them).
  pendings: AttentionPending[];
  footer: {
    jobsDone: number;
    jobsReleased: number;
    pendings: number;
    pendingCommands: number;
    pause: { paused: boolean; pending: boolean };
  };
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
}

// Loads the recorded state of ONE instance and derives the reading model. Pure read: no store
// save/remove, no queue enqueue, no control write, no tracker write (verified by the tests that
// re-read every raw store after a build).
export async function buildOperatorView(deps: OperatorViewDeps): Promise<OperatorView> {
  const { stateDir, instance } = deps;
  const [jobs, sessions, attention, queued, appliedPause] = await Promise.all([
    createFileJobStore(stateDir).load(),
    createFileAssistSessionStore(`${stateDir}/assist-sessions`.replace("//", "/")).load(),
    createFileAttentionStore(`${stateDir}/pendencias`.replace("//", "/")).load(),
    createFileCommandQueue(stateDir).pending(),
    createFileInstanceControl(stateDir).isPaused(),
  ]);

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
    pendings: attention.pendings,
    footer: {
      jobsDone: jobs.jobs.filter((job) => job.state === "done").length,
      jobsReleased: jobs.jobs.filter((job) => job.state === "released").length,
      pendings: attention.pendings.length,
      pendingCommands: queued.commands.length + queued.unreadable.length,
      pause: { paused, pending: lastPause !== undefined && (lastPause.type === "pause") !== appliedPause },
    },
  };
}
