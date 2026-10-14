import type { IssueRef } from "../tracker/port.js";
import { noopObserver, type Level, type Observer } from "./observability.js";
import { messageOf } from "./values.js";

// Operator attention (spec #48, ticket #59): decisions and failures that need a human are
// PERSISTENT pendings in operable state, never a passing log line, and the desktop notification
// is a best-effort channel alongside them. A delivery failure never removes a pending: the
// pending stays consultable through the local commands (a `pendências` section in `status`),
// and only a state change creates a new pending.
//
// The same signaling machinery is a seam for later flows (ticket #57's authorization-consumed
// and ticket #58's reconciliation events): any producer calls the pure pending constructors
// below and hands the result to `AttentionKeeper.raise` — no new interface per source. The
// merge of #57/#58 may hook their events exactly there.
//
// One channel caveat, from the technical proof (docs/operacao/prova-herdr-pi-docker.md and
// the t52 report): Herdr 0.9.3 has NO notification command (every attempt of `herdr show`
// returns `unknown command: show`). Presuming that a Herdr notification reaches the desktop
// is forbidden here: it neither sends through Herdr nor claims delivery. A successful attempt
// proves only that the configured OS command ran; `notification.ok` records exactly that.

// The kind tells how the operator reads the pending: a new session waiting for them
// ("abertura"), an operator decision ("decisão"), a required intervention ("intervenção")
// or an agent help request ("ajuda").
export type PendingKind = "abertura" | "decisão" | "intervenção" | "ajuda";

// The local actions available for the pending's key; a few kinds of pending have none, and
// the local commands render the paste-ready forms.
export type PendingAction = "reply" | "resume" | "release" | "approve" | "logs";

export interface AttentionPending {
  // Deterministic dedupe key `${kind}|${key}|${digest}`: the same occurrence (same kind, same
  // key, same reason digest, same interruption number) is raised once, never re-notified each
  // cycle nor across restarts. A NEW interruption changes the digest and raises again.
  id: string;
  kind: PendingKind;
  // The work the pending is about: the same key space the flows use (a session key or a job
  // key), so the local commands already know how to act on it.
  key: string;
  // What the operator must know or do, one line.
  what: string;
  at: string;
  work?: { repository: string; ref: IssueRef; title?: string };
  reason?: string;
  question?: string;
  // The operator's answer, kept when the pending is a pending question that was answered.
  answer?: string;
  answeredAt?: string;
  // Identity references of the session/subject: model, tabs, container, clone, digest...
  context?: Record<string, string>;
  actions: readonly PendingAction[];
  // The proof of the delivery attempt, written by the keeper from what actually ran. Absent:
  // nothing was attempted. `ok: true` only says the channel command ran without error —
  // never that a desktop notification appeared (see the proof above).
  notification?: { at: string; channel: string; ok: boolean; error?: string };
}

export interface AttentionNotification {
  title: string;
  body: string;
}

// The notification channel behind an injectable port (tests never fire a real OS
// notification). It returns the channel name it actually used and throws when the channel
// fails or is absent; the outcome is true only of the attempt, never of what it shows.
export interface AttentionBoundary {
  notify(notification: AttentionNotification): Promise<string>;
}

export interface LoadedAttention {
  pendings: AttentionPending[];
  // Files that could not be read or validated; they never hide the other pendings.
  unreadable: string[];
}

export interface AttentionStore {
  load(): Promise<LoadedAttention>;
  save(pending: AttentionPending): Promise<void>;
  remove(id: string): Promise<void>;
}

// Guard for the persisted record fields: a non-empty string is what every validated field is.
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value !== "";

const isNotification = (value: unknown): AttentionPending["notification"] | false => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return isNonEmptyString(record.at) && isNonEmptyString(record.channel) && typeof record.ok === "boolean"
    && (record.error === undefined || typeof record.error === "string")
    ? { at: record.at, channel: record.channel, ok: record.ok, ...(record.error === undefined ? {} : { error: record.error as string }) }
    : false;
};

export function isPending(value: unknown): value is AttentionPending {
  if (typeof value !== "object" || value === null) return false;
  const pending = value as Record<string, unknown>;
  const work = pending.work as Record<string, unknown> | undefined;
  const ref = work?.ref as Record<string, unknown> | undefined;
  return isNonEmptyString(pending.id) && isNonEmptyString(pending.kind)
    && (["abertura", "decisão", "intervenção", "ajuda"] as readonly string[]).includes(pending.kind)
    && isNonEmptyString(pending.key) && isNonEmptyString(pending.what) && isNonEmptyString(pending.at)
    && Array.isArray(pending.actions) && pending.actions.every((action: unknown) => typeof action === "string")
    && (pending.reason === undefined || typeof pending.reason === "string")
    && (pending.question === undefined || typeof pending.question === "string")
    && (pending.answer === undefined || typeof pending.answer === "string")
    && (pending.answeredAt === undefined || typeof pending.answeredAt === "string")
    && (pending.context === undefined || typeof pending.context === "object")
    && (pending.work === undefined || (typeof work === "object" && work !== null
      && typeof work.repository === "string"
      && typeof ref === "object" && ref !== null
      && typeof ref.tracker === "string" && typeof ref.project === "string" && typeof ref.id === "string"))
    && (pending.notification === undefined || isNotification(pending.notification) !== false);
}

// One djb2-style digest of the reason parts: what makes the same occurrence unique (a new
// interruption number, a new question, a distinct failure reason) goes through here, so the
// pending id is stable AND strictly more specific than an existing one.
export function digestOf(parts: readonly (string | number | undefined)[]): string {
  const text = parts.filter((part) => part !== undefined).join("|");
  let hash = 5381;
  for (const character of text) hash = ((hash << 5) + hash + character.charCodeAt(0)) >>> 0;
  return hash.toString(36);
}

export const pendingId = (kind: PendingKind, key: string, digest: string): string => `${kind}|${key}|${digest}`;

// The text the notification channel carries. Pure: the pending itself stays the record.
export function describePending(pending: AttentionPending): AttentionNotification {
  const context = Object.entries(pending.context ?? {})
    .map(([name, value]) => `${name}=${value}`).join(", ");
  return {
    title: `msf: ${pending.what}`,
    body: [
      `trabalho: ${pending.key}${pending.work ? ` (${pending.work.repository}#${pending.work.ref.id})` : ""}`,
      ...(pending.question === undefined ? [] : [`pergunta: ${pending.question}`]),
      ...(pending.reason === undefined ? [] : [`motivo: ${pending.reason}`]),
      ...(context === "" ? [] : [context]),
    ].join("\n"),
  };
}

// Constructors of the pending occurrences the first slice raises (ticket #59). The open
// pending carries the waiting references, so the operator can locate both the work and the
// session (issue, session key, tab/pane id, model, clone path).
export function sessionOpenPending(session: {
  key: string; ref: IssueRef; repository: string; model: string; cloneDir: string;
  tabId?: string; paneId?: string; containerName?: string; label?: string; resumes?: number;
}, at: string): AttentionPending {
  const resumes = session.resumes ?? 0;
  const entries: Array<[string, string | undefined]> = [
    ["sessão", session.key], ["modelo", session.model],
    ...(session.tabId === undefined ? [] : [["aba", session.tabId] as [string, string]]),
    ...(session.paneId === undefined ? [] : [["pane", session.paneId] as [string, string]]),
    ...(session.containerName === undefined ? [] : [["container", session.containerName] as [string, string]]),
    ...(session.label === undefined ? [] : [["rótulo", session.label] as [string, string]]),
    ["clone", session.cloneDir], ["aberturas", `${resumes}`],
  ];
  return {
    id: pendingId("abertura", session.key, digestOf(["abertura", resumes])),
    kind: "abertura",
    key: session.key,
    what: "sessão assistida aberta aguardando o operador",
    at,
    work: { repository: session.repository, ref: session.ref },
    context: Object.fromEntries(entries.filter(([, value]) => value !== undefined) as Array<[string, string]>),
    // A session open has no local command to act on yet: what the operator needs first (context).
    actions: [],
  };
}

// The operator decision a pending interruption asks (a distinct ask per interruption; an
// answered question raises as an answered pending and then ends).
export function decisionPending(session: {
  key: string; ref: IssueRef; repository: string;
  question?: string; reason?: string; resultDigest?: string; resultStatus?: string;
}, at: string): AttentionPending {
  const digest = digestOf(["decisão", session.question, session.reason, session.resultDigest]);
  return {
    id: pendingId("decisão", session.key, digest),
    kind: "decisão",
    key: session.key,
    what: "decisão do operador pendente",
    at,
    work: { repository: session.repository, ref: session.ref },
    ...(session.question === undefined ? {} : { question: session.question }),
    ...(session.reason === undefined ? {} : { reason: session.reason }),
    ...(session.resultDigest === undefined ? {} : { context: { "digest do resultado": session.resultDigest } }),
    // The actions available on an assisted key, ready to paste in the local commands.
    actions: ["reply", "resume", "release", "approve"],
  };
}

// A failure/intervention the operator must handle (a pending that asks for an action, not a
// question): from opening failures to inconclusive conclusions — and later, for #57's
// authorization-consumed and #58's reconciliation events, which raise the same way.
export function interventionPending(subject: {
  key: string; ref?: IssueRef; repository?: string;
}, what: string, at: string, digest: string, extra: {
  reason?: string; context?: Record<string, string>; actions?: readonly PendingAction[];
} = {}): AttentionPending {
  return {
    id: pendingId("intervenção", subject.key, digest),
    kind: "intervenção",
    key: subject.key,
    what,
    at,
    ...(subject.repository === undefined || subject.ref === undefined
      ? {}
      : { work: { repository: subject.repository, ref: subject.ref } }),
    ...(extra.reason === undefined ? {} : { reason: extra.reason }),
    ...(extra.context === undefined ? {} : { context: extra.context }),
    actions: extra.actions ?? ["reply", "resume", "release"],
  };
}

// The agent's help request for an implementation job (status already consults it; this makes
// it a persisted pending with notification and dedupe by the asked question).
export function helpPending(job: {
  key: string; ref: IssueRef; repository: string; question?: string; context?: string;
}, at: string): AttentionPending {
  return {
    id: pendingId("ajuda", job.key, digestOf(["ajuda", job.question, job.context])),
    kind: "ajuda",
    key: job.key,
    what: "ajuda solicitada pelo agente",
    at,
    work: { repository: job.repository, ref: job.ref },
    ...(job.question === undefined ? {} : { question: job.question }),
    ...(job.context === undefined ? {} : { reason: job.context }),
    actions: ["reply", "resume", "release", "logs"],
  };
}

// The answer an operator gave, recorded on the pending when the question is answered in place
// (the pending of an answered decision ends with this; the registry keeps the verbatim answer).
export function answeredPending(pending: AttentionPending, answer: string, at: string): AttentionPending {
  return { ...pending, answer, answeredAt: at };
}

export function renderPendingNotification(pending: AttentionPending): string {
  if (pending.notification === undefined) return "sem canal tentado";
  const { ok, channel, error } = pending.notification;
  return ok ? `canal tentado: ${channel} (comando executado; entrega de notificação ao desktop não comprovada)`
    : `canal tentado: ${channel} — falhou: ${error ?? ""}`;
}

export interface AttentionKeeperDeps {
  store: AttentionStore;
  // The desktop notification channel, best-effort. Absent: configured/disallowed — the
  // pending stays and the absence is recorded as the attempted channel "nenhum".
  notify?: AttentionBoundary;
  observer?: Observer;
  now?: () => Date;
}

const EVENT_LEVEL: Record<string, Level> = { "pendência-raizada": "info", "pendência-notificação": "atenção", "pendência-resolvida": "info" };

// The keeper of the pendings: dedupe by id across cycles AND across restarts (the store is
// state, not memory), best-effort notification that never throws, and the resolution of the
// pendings whose work ended. Every failure lands in an event; nothing interrupts the flow
// that raises (ADR 0001: notification failures never touch core state).
export class AttentionKeeper {
  private readonly obs: Observer;
  private readonly now: () => Date;

  constructor(private readonly deps: AttentionKeeperDeps) {
    this.obs = deps.observer ?? noopObserver;
    this.now = deps.now ?? (() => new Date());
  }

  private emit(kind: string, text: string, fields: Record<string, string | number>, level?: Level): void {
    // Observing never changes what the keeper does; a broken observer must not stop a raise.
    try {
      this.obs.emit({ kind, text, level: level ?? EVENT_LEVEL[kind] ?? "info", fields });
    } catch {
      // The pendings store is the source that counts; the event losing a sink is reported there.
    }
  }

  // One pending occurrence: dedupe by id, persist FIRST, then attempt the notification once.
  // A second call with the same id (same cycle, or after a restart) is a no-op: the pending
  // and its attempt ceases to re-appear — a new interruption gets a new id from the fresh digest.
  async raise(pending: AttentionPending): Promise<void> {
    try {
      const loaded = await this.deps.store.load();
      const existing = loaded.pendings.find((candidate) => candidate.id === pending.id);
      if (existing !== undefined) return;
      await this.deps.store.save(pending);
      this.emit("pendência-raizada", pending.what, { pendência: pending.id, trabalho: pending.key });
    } catch (error) {
      this.emit("pendência-notificação", "pendência não pôde ser registrada", {
        pendência: pending.id, trabalho: pending.key, motivo: messageOf(error),
      });
      // The raise failed persisting: nothing was notified either. Next cycle retries the dedupe.
      return;
    }
    // Best-effort delivery after the pending is already durable. `notify` is optional when the
    // operator's configuration says the channel is off or the host has no command: THEN the
    // pending records the absent channel, proving what was tried, instead of staying silent
    // and pretending.
    const at = this.now().toISOString();
    const boundary = this.deps.notify;
    if (boundary === undefined) {
      try {
        await this.deps.store.save({ ...pending,
          notification: { at, channel: "nenhum", ok: false, error: "canal de notificação ausente ou desabilitado" } });
      } catch {
        // The pending (already saved) stays consultable; the attempt not recorded is logged above.
        this.emit("pendência-notificação", "tentativa de notificação não registrada", { pendência: pending.id });
      }
      return;
    }
    const notification = describePending(pending);
    try {
      const channel = await boundary.notify(notification);
      try {
        // The returned name is what actually ran (a configured command); it only proves the run.
        await this.deps.store.save({ ...pending, notification: { at, channel, ok: true } });
        this.emit("pendência-notificação", "tentativa de notificação executada", {
          pendência: pending.id, "canal tentado": channel, "execução": "comando executado sem falha",
        });
      } catch (error) {
        this.emit("pendência-notificação", "registro da tentativa de notificação falhou; pendência segue", {
          pendência: pending.id, motivo: messageOf(error),
        });
      }
    } catch (error) {
      try {
        await this.deps.store.save({ ...pending,
          notification: { at, channel: "tentado", ok: false, error: messageOf(error) } });
      } catch {
        // The pending (already saved) stays consultable, whatever became of the record.
      }
      this.emit("pendência-notificação", "tentativa de notificação falhou; pendência permanece", {
        pendência: pending.id, motivo: messageOf(error),
      });
    }
  }

  // Pendings of one work that no longer need the operator: the work was released/concluded,
  // or its state changed to one whose pending takes over. Returns how many discontinued.
  async resolve(key: string, kinds?: readonly PendingKind[]): Promise<number> {
    let removed: AttentionPending[];
    try {
      const loaded = await this.deps.store.load();
      removed = loaded.pendings
        .filter((pending) => pending.key === key && (kinds === undefined || kinds.includes(pending.kind)));
    } catch (error) {
      this.emit("pendência-notificação", "consulta de pendências falhou; nada resolvido", {
        trabalho: key, motivo: messageOf(error),
      });
      return 0;
    }
    if (removed.length === 0) return 0;
    for (const pending of removed) {
      try {
        await this.deps.store.remove(pending.id);
      } catch (error) {
        this.emit("pendência-notificação", "pendência não pôde sair do estado", {
          pendência: pending.id, motivo: messageOf(error),
        });
      }
    }
    // Every removal attempt was made: the successful ones are announced, the failures above.
    for (const pending of removed) {
      this.emit("pendência-resolvida", `pendência encerrada (${pending.what})`, {
        pendência: pending.id, trabalho: pending.key,
      });
    }
    return removed.length;
  }

  // Consultation: the active pendings as they are (the local commands render them).
  async consult(): Promise<{ pendings: AttentionPending[]; unreadable: string[] }> {
    return this.deps.store.load();
  }
}
