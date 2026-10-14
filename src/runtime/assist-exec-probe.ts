import { execFile } from "node:child_process";
import { promisify } from "node:util";

// The real-execution probe of one assisted exec (ticket #58 / spec #48 item 5): `docker inspect`
// on the exact container NAME the session registry stored, with the daemon's reachability judged
// in the SAME step. The proof (#52) and the spec rule out every cheaper substitute — a PID
// alone, the pane's presence or absence, terminal text — so the reconciler asks Docker itself:
// an "absent" verdict is only proven when the daemon itself answered (named lookup), never when
// Docker could not be asked (that is the reconciler's "unknown", capacity reserved).

const execFileAsync = promisify(execFile);

// One observation of `docker inspect` over a session registry's container name. The invocation
// is part of the evidence: the detail carries what Docker actually responded, and the reconciler
// records it in the session registry so the operator sees why a session was decided.
export interface AssistExecObservation {
  containerName: string;
  // running  — the identity is executing right now;
  // stopped  — the identity exists and is not executing (`created`/`exited` leftovers included);
  // absent   — the daemon itself answered there is NO container with that name;
  // unknown  — Docker could not be asked (daemon unreachable, error, empty name).
  verdict: "running" | "stopped" | "absent" | "unknown";
  detail: string;
}

export interface AssistExecProbe {
  observe(containerName: string): Promise<AssistExecObservation>;
}

// The daemon's own not-found response. Match is case-insensitive: the observed 29.7.2 forms are
// "Error: No such object: <name>" and "error: no such object: <name>" on the same version.
const ABSENT_MARKERS = ["no such object", "erro: nenhum objeto"];

// A failure of `docker inspect` that IS the daemon's answer "there is no container with this
// name" (proven absence). Any other failure is the daemon being unaskable: unknown.
export function isAbsentResponse(errorText: string): boolean {
  const text = errorText.toLowerCase();
  return ABSENT_MARKERS.some((marker) => text.includes(marker));
}

// The identity reclaim of one assisted exec (ticket #56, spec #48 item 5): closing the Herdr
// tab does NOT stop the exec (the #52 proof measured the container alive after `herdr tab
// close`), so the supervision's compensating action is to request the stop itself, by the exact
// container NAME the session registry recorded — `docker rm -f`: force-stops a running exec AND
// cleans up a leftover that never got to run, the same reavenge command the proof used.
export interface AssistExecStopResult {
  // requested      — Docker answered and the removal was carried out (the daemon's verdict of
  //                  whether the container was alive then is not needed here; the verification
  //                  goes through the probe afterwards).
  // already-absent — the daemon itself answered there is no container with that name: proven
  //                  absence, the same evidence the probe interprets.
  // failed         — the stop could not be requested (daemon unaskable or refused); the caller
  //                  keeps the intervention pending and the capacity reserved.
  kind: "requested" | "already-absent" | "failed";
  detail: string;
}

export interface AssistExecStop {
  stop(containerName: string): Promise<AssistExecStopResult>;
}

export function dockerExecStop(dockerCli = "docker"): AssistExecStop {
  return {
    async stop(containerName: string): Promise<AssistExecStopResult> {
      if (containerName.trim() === "") {
        return { kind: "failed", detail: "remote stop not requested: the container name is not registered in the session" };
      }
      try {
        const { stdout } = await execFileAsync(dockerCli, ["rm", "-f", containerName], {
          encoding: "utf8", timeout: 30_000,
        });
        return { kind: "requested", detail: `docker rm -f ${containerName} executed (${stdout.trim() || "daemon answered without output"})` };
      } catch (error) {
        const cause = error as { stdout?: string; stderr?: string };
        const text = `${cause.stdout ?? ""} ${cause.stderr ?? ""} ${error instanceof Error ? error.message : String(error)}`.trim();
        if (isAbsentResponse(text)) {
          return { kind: "already-absent", detail: `the daemon itself answered: no container named as ${containerName} (proven absence by identity)` };
        }
        return { kind: "failed", detail: `remote stop could not be requested: ${text.slice(0, 200)}` };
      }
    },
  };
}

export function dockerExecProbe(dockerCli = "docker"): AssistExecProbe {
  return {
    async observe(containerName: string): Promise<AssistExecObservation> {
      const judged = (verdict: AssistExecObservation["verdict"], detail: string): AssistExecObservation =>
        ({ containerName, verdict, detail });
      if (containerName.trim() === "") {
        return judged("unknown", "o nome do container não está registrado na sessão");
      }
      let text: string;
      try {
        const { stdout } = await execFileAsync(dockerCli, ["inspect", "--format", "{{.State.Running}}|{{.State.Status}}", containerName], {
          encoding: "utf8", timeout: 30_000,
        });
        const [running, status] = stdout.trim().split("|");
        return running === "true"
          ? judged("running", `container ${containerName} em execução (status ${status ?? "?"})`)
          : judged("stopped", `container ${containerName} existe e não está em execução (status ${status ?? "?"})`);
      } catch (error) {
        const cause = error as { stdout?: string; stderr?: string };
        text = `${cause.stdout ?? ""} ${cause.stderr ?? ""} ${error instanceof Error ? error.message : String(error)}`;
      }
      if (isAbsentResponse(text)) {
        return judged("absent",
          `o próprio daemon respondeu: nenhum container com o nome ${containerName} (prova de ausência por identidade)`);
      }
      return judged("unknown", `o Docker não pôde ser perguntado: ${text.trim().slice(0, 200)}`);
    },
  };
}
