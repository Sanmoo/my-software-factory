import type { CommandBody } from "./commands.js";
import type { OperatorView, OperatorWork } from "./operator-view.js";

// The four operator actions the TUI offers (issue #63, spec #60), mapped to the REAL command
// bodies the supervision CLI enqueues. The map is pure and derives every decision from the
// reading model (fluxo + estado vivo + the core's own capacity semantics, already computed as
// `ocupaVaga`): it is a CLIENT-side pre-check so nothing wrong enters the queue — the core
// still revalidates every command at APPLY time (the deliberate asymmetry of ticket #63:
// `msf` keeps enqueueing without these pre-checks, and the refusal reasons here reuse the
// core's own PT wording where the core has one).

export type OperatorAction = "responder" | "aprovar-resultado" | "autorizar-retomada" | "liberar";

export type OperatorCommandOutcome =
  | { ok: true; command: CommandBody }
  | { ok: false; reason: string };

export function operatorCommand(
  action: OperatorAction,
  work: OperatorWork,
  view: OperatorView,
  message?: string,
): OperatorCommandOutcome {
  switch (action) {
    case "responder": {
      // The core refuses an empty reply at apply time ("resposta vazia", supervision and
      // admission alike); the pre-check keeps it out of the queue entirely.
      if (message === undefined || message.trim() === "") return { ok: false, reason: "resposta vazia" };
      return { ok: true, command: { type: "reply", job: work.key, message } };
    }
    case "aprovar-resultado": {
      // The approval is of an ASSISTED attendance whose recognized result awaits the operator:
      // session state `proposed` ⇔ estado vivo `aguardando-aprovacao`. Anything else has no
      // proposed result to approve — including an autonomous work, which never has one.
      const session = view.sessions.find((candidate) => candidate.key === work.key);
      if (work.fluxo === "humano-assistido" && session?.state === "concluding") {
        // Core wording (assist-flow): an approval already running registers nothing twice.
        return { ok: false, reason: "aprovação já em andamento: a conclusão continua sendo tentada; nada é registrado duas vezes" };
      }
      if (work.fluxo !== "humano-assistido") {
        return { ok: false, reason: "aprovação se aplica apenas a atendimento assistido" };
      }
      if (work.estadoVivo !== "aguardando-aprovacao") {
        return { ok: false, reason: "aprovar sem resultado proposto" };
      }
      return { ok: true, command: { type: "approve", job: work.key } };
    }
    case "autorizar-retomada": {
      // A retomada is single-use: an already authorized work (job.pending === "resume", or an
      // assisted pending with an unconsumed scheduled resume) must not be authorized again.
      if (work.estadoVivo === "retomada-autorizada") return { ok: false, reason: "retomada já autorizada" };
      // Only a stopped-without-valid-outcome work takes an authorization; anything else has
      // nothing to resume (an open session needs no reopening, a proposed result needs a
      // decision, not a resume).
      if (work.estadoVivo !== "interrompido") {
        return {
          ok: false,
          reason: work.fluxo === "humano-assistido" ? "sessão sem autorização para reabrir" : "trabalho não interrompido",
        };
      }
      return { ok: true, command: { type: "resume", job: work.key } };
    }
    case "liberar": {
      // "Liberação só quando parado": neither an invocation (autonomous, `holdsSlot`) nor an
      // open assisted session (`holdsCapacity`, aguardando o humano incluído) may be released.
      // `ocupaVaga` is exactly the core's own capacity semantics, derived by the reading model.
      if (work.ocupaVaga) {
        return {
          ok: false,
          reason: work.fluxo === "humano-assistido" ? "liberação só quando parado" : "liberar trabalho em execução",
        };
      }
      return { ok: true, command: { type: "release", job: work.key } };
    }
  }
}
