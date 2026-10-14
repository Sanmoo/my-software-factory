import { refKey, type IssueRef } from "../tracker/port.js";
import type { HumanState } from "./assist-eligibility.js";
import type { AssistResult } from "./assist-result.js";

// The record of one human-assisted attendance (spec #48, #54). Identity of the session/exec and
// its area is persisted the moment it is available, so supervision never depends on the pane and
// reclaiming (later slices) can go by container identity, never by pane presence (ticket #52).
//
// States:
//   opening — the flow reserved its capacity and confirmed the claim, but the exec is not open.
//             A failure before or during opening lands here when the claim must be preserved.
//   open    — the assisted exec (pi in the container, own tab) is running. It occupies its
//             capacity limit even while it only waits for the human.
//   pending — attendance with no recognized result and no live exec: kept with context for
//             operator intervention (resume/release are #56). The capacity is freed only here,
//             because the execution has really stopped (exit-record channel). A recognized
//             interruption lands here too: it does not conclude the attendance, and it asks the
//             operator the continuity question once (persisted in the record).
//   proposed — the exec really stopped and a structured result was recognized, but the
//             operator has not approved it yet (ticket #55). Capacity is already freed; the
//             approval is the next step and nothing is written to the tracker before it.
//   concluding — the operator approved and the approved actions are being executed with
//             confirmation by rereading; every partial failure keeps the session here with its
//             reason, so the remaining steps retry on the following polls and nothing is
//             concluded unconfirmed, never re-admitted mid-cleanup.
// The record is removed only when every confirmed action of its flow is confirmed — an approved
// conclusion (#55) or a confirmed release (#56): the tracked key then leaves the store with the
// claim and the human-assisted label confirmed absent, never re-admitted mid-cleanup.
export type AssistSessionState = "opening" | "open" | "pending" | "proposed" | "concluding";

// The operator decision the interruption asks for (spec #48, item 5): asked once per
// interruption and stored with the session, so the local commands show the pending question
// and the record never has to ask again. Preserving the session alone never authorizes an
// execution; the answer is kept verbatim, and its semantics are a later slice (#57).
export interface ContinuityDecision {
  question: string;
  askedAt: string;
  answeredAt?: string;
  answer?: string;
}

export const askContinuity = (session: AssistSession, question: string, at: string): AssistSession =>
  ({ ...session, continuity: { question, askedAt: at } });

export const answerContinuity = (session: AssistSession, answer: string, at: string): AssistSession =>
  session.continuity === undefined ? session : {
    ...session,
    continuity: { ...session.continuity, answeredAt: at, answer },
  };

// The verdict of one operator answer to the interruption's continuity question (spec #48, item
// 5): only an explicit affirmative is an authorization; an explicit negative refuses; whatever
// is doubtful authorizes nothing, so preserving the session alone never starts an execution.
export type ContinuityVerdict = "authorized" | "declined" | "doubtful";

// Word-level match over the diacritics-stripped answer: a negative never becomes a
// authorization because it is checked first, and the ambiguous default is "no authorization".
const NEGATIVE_ANSWERS = ["nao", "n", "no", "nunca", "nego", "declino", "recuso", "recusa", "cancela", "pare", "parar", "not", "dont"];
const AFFIRMATIVE_ANSWERS = ["sim", "s", "ok", "yes", "y", "autorizo", "autoriza", "autorizado", "autorizada", "autorizar", "pode", "podera", "retome", "retomar", "recomeca", "go"];

const answerWords = (answer: string): readonly string[] =>
  answer.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

export const interpretContinuityAnswer = (answer: string): ContinuityVerdict => {
  const words = answerWords(answer);
  if (words.some((word) => NEGATIVE_ANSWERS.includes(word))) return "declined";
  return words.some((word) => AFFIRMATIVE_ANSWERS.includes(word)) ? "authorized" : "doubtful";
};

// The authorization the operator's affirmative interruption answer leaves (ticket #57): it is
// valid for EXACTLY ONE next opening of this same session. A new interruption demands a new
// decision; a question already answered is never asked again before that opening.
export interface ScheduledResume {
  at: string;
  command: string;
  answer: string;
  // Consumed once: persisted TOGETHER with the identity of the opening attempt that used it,
  // so concurrent polling cycles or retries cannot ever start two executions — the attempt
  // that finds the recorded attempt different from its own aborts without launching.
  consumed?: ConsumedResume;
}

export interface ConsumedResume {
  at: string;
  attempt: string;
}

// `(session, info)` when the affirmative answer authorizes: the answer is kept (again, verbatim
// as evidence) with the command that registered it.
export const scheduleResume =
  (session: AssistSession, info: { at: string; command: string; answer: string }): AssistSession =>
    ({ ...session, scheduledResume: { at: info.at, command: info.command, answer: info.answer } });

// The scheduled resume the flow may still use: pending AND an authorization no attempt consumed.
export const unconsumedResume = (session: AssistSession): ScheduledResume | undefined =>
  session.scheduledResume !== undefined && session.scheduledResume.consumed === undefined
    ? session.scheduledResume
    : undefined;

// The consumption (once): writes the attempt identity so the reread decides whose attempt won.
export const consumeResume = (session: AssistSession, attempt: string, at: string): AssistSession =>
  session.scheduledResume === undefined || session.scheduledResume.consumed !== undefined
    ? session
    : { ...session, scheduledResume: { ...session.scheduledResume, consumed: { at, attempt } } };

export interface AssistSession {
  key: string; // identity: tracker + project + issue id (see refKey), same key space as jobs
  ref: IssueRef;
  repository: string;
  state: AssistSessionState;
  // The human state the issue was attended in, so the initial prompt is documented.
  promptKind: HumanState;
  // The explicit assist provider/model (instance config); never inherited from implementation.
  model: string;
  image: string;
  // The operator's configured local clone, mounted writable in the container; no factory worktree.
  cloneDir: string;
  // Identity of the opening and of the exec, persisted as soon as available. The tab is the
  // Herdr tab, the container is the exec: they are separate identities on purpose.
  label?: string;
  tabId?: string;
  paneId?: string;
  containerName?: string;
  containerId?: string;
  // Host directories of this session: the snapshot mount of the container, the pi sessions the
  // container writes (the structured result channel) and the exec's own exit-record channel.
  profileDir?: string;
  sessionsDir?: string;
  execStateDir?: string;
  startedAt: string;
  claimedAt?: string;
  endedAt?: string;
  // Why the attendance has no live execution: failure after claim, without a recognized result,
  // or an unfinished conclusion (concluding).
  reason?: string;
  // The operator decision an interruption asked for, present with the pending interruption
  // (question persisted once; the answer is recorded verbatim when the operator gives it).
  continuity?: ContinuityDecision;
  // The single-use resume authorization an affirmative answer schedules (ticket #57), consumed
  // by exactly one opening attempt. Only an explicit affirmative schedules; a new interruption
  // replaces the authorization demand (a new question, a new answer, a new decision).
  scheduledResume?: ScheduledResume;
  // How many times the area's exec was launched: the first opening is 0 and each resume adds
  // one; the tab label carries the count so two tabs of the same session never have the same
  // label while the old one keeps its history open (the pi end never closes that tab).
  resumes?: number;
  // The proposal the agent made (recognized by the structured result channel, #55), its raw
  // payload (the registration repeats the exact bytes, so the dedup digest matches) and its
  // digest, which identifies the registration on the tracker for the dedup by reread.
  result?: AssistResult;
  resultPayload?: string;
  resultDigest?: string;
  resultCommentId?: string;
  // The operator's explicit approval: the command id and the moment it was applied.
  approval?: { at: string; command: string };
  log: string[];
}

export interface LoadedAssistSessions {
  sessions: AssistSession[];
  // Files that could not be read or validated; they never hide the other sessions.
  unreadable: string[];
}

export interface AssistSessionStore {
  load(): Promise<LoadedAssistSessions>;
  save(session: AssistSession): Promise<void>;
  remove(key: string): Promise<void>;
}

const SESSION_STATES: readonly AssistSessionState[] = ["opening", "open", "pending", "proposed", "concluding"];

const isContinuity = (value: unknown): ContinuityDecision | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const question = value as Record<string, unknown>;
  if (typeof question.question !== "string" || question.question === ""
    || typeof question.askedAt !== "string" || question.askedAt === "") return undefined;
  const answeredAt = question.answeredAt;
  const answer = question.answer;
  if (answeredAt !== undefined && (typeof answeredAt !== "string" || answeredAt === "")) return undefined;
  if (answer !== undefined && typeof answer !== "string") return undefined;
  return { question: question.question, askedAt: question.askedAt,
    ...(answeredAt === undefined ? {} : { answeredAt }), ...(answer === undefined ? {} : { answer }) };
}

const isResumes = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
  return value;
};

export function isSession(value: unknown): value is AssistSession {
  if (typeof value !== "object" || value === null) return false;
  const session = value as Record<string, unknown>;
  const ref = session.ref as Record<string, unknown> | undefined;
  const continuity = isContinuity(session.continuity);
  const scheduledResume = isScheduledResume(session.scheduledResume);
  const resumes = isResumes(session.resumes);
  return typeof session.key === "string"
    && typeof session.repository === "string"
    && typeof session.state === "string"
    && (SESSION_STATES as readonly string[]).includes(session.state)
    && typeof session.promptKind === "string"
    && typeof session.model === "string"
    && typeof session.image === "string"
    && typeof session.cloneDir === "string"
    && typeof session.startedAt === "string"
    && (session.continuity === undefined || continuity !== undefined)
    && (session.scheduledResume === undefined || scheduledResume !== undefined)
    && (session.resumes === undefined || resumes !== undefined)
    && typeof ref === "object" && ref !== null
    && typeof ref.tracker === "string" && typeof ref.project === "string" && typeof ref.id === "string"
    && Array.isArray(session.log) && session.log.every((line: unknown) => typeof line === "string");
}

const isScheduledResume = (value: unknown): ScheduledResume | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const resume = value as Record<string, unknown>;
  const consumed = resume.consumed as Record<string, unknown> | undefined;
  if (typeof resume.at !== "string" || resume.at === ""
    || typeof resume.command !== "string" || resume.command === ""
    || typeof resume.answer !== "string") return undefined;
  if (consumed === undefined) {
    return { at: resume.at, command: resume.command, answer: resume.answer };
  }
  if (typeof consumed.at !== "string" || consumed.at === ""
    || typeof consumed.attempt !== "string" || consumed.attempt === "") return undefined;
  return {
    at: resume.at, command: resume.command, answer: resume.answer,
    consumed: { at: consumed.at, attempt: consumed.attempt },
  };
};

export const appendSessionLog = (session: AssistSession, line: string): AssistSession => ({
  ...session,
  log: [...session.log, `${new Date().toISOString()} ${line}`],
});

export const refKeyOf = (session: AssistSession): string => refKey(session.ref);

// Two independent N limits (spec #48 item 2): implementation slots (held by jobs in states that
// hold one) and open assisted sessions. Each flow counts only its own limit; neither frees the
// other's, and a session waiting for the human keeps counting until the execution really stopped.
export const holdsCapacity = (session: AssistSession): boolean => session.state === "opening" || session.state === "open";

export const openCount = (loaded: LoadedAssistSessions): number => loaded.sessions.filter(holdsCapacity).length;

// The threads the factory already tracks, across both flows: implementation jobs and assisted
// sessions form the set no second ticket of the same issue may enter. Every state in the store
// keeps tracking: a confirmed conclusion or release removes the record instead, and a cleanup
// still incomplete must not let a second ticket of the same issue in.
export const sessionTrackedKeys = (loaded: LoadedAssistSessions): ReadonlySet<string> =>
  new Set([...loaded.sessions.map(refKeyOf), ...loaded.unreadable.flatMap(unreadableKey)]);

// Session files are named after their key (see the file store), so an unreadable file still
// names its issue; the issue stays protected from a second opening.
const unreadableKey = (name: string): string => {
  try {
    return decodeURIComponent(name.replace(/\.json$/, ""));
  } catch {
    return "";
  }
};
