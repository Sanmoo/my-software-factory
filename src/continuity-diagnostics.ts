import { join } from "node:path";
import type { PauseReason, PauseRecord } from "./work-record/continuity.js";

const summaries: Record<PauseReason, string> = {
  "effect-unsupported": "command outcome unknown; operator decision needed",
  "effect-ambiguous": "external effect not confirmed; reconciliation needed",
  "tool-evidence-missing": "tool execution evidence missing",
  "link-missing": "attempt has no recorded session association",
  "session-missing": "recorded session is missing",
  "session-unreadable": "recorded session cannot be read safely",
  "session-identity": "session identity cannot be established",
  "journal-unreadable": "effect or recovery journal cannot be read safely",
  "record-unreadable": "pause record cannot be read safely",
};

/** Only diagnostic memory: evidence is always rechecked by the caller. A
 * restart reports each current pause once; steady ticks remain silent. */
export class ContinuityDiagnostics {
  private readonly last = new Map<string, string>();

  paused(key: string, workDir: string, pause: PauseRecord): string | null {
    const signature = JSON.stringify([pause.id, pause.attempt, pause.sessionId, pause.reason, pause.detail]);
    if (this.last.get(key) === signature) return null;
    const changed = this.last.has(key);
    this.last.set(key, signature);
    const inspect = pause.reason === "effect-unsupported" ? `msf recover '${key}'` : "msf status --all";
    return `continuity of ${key} paused (${pause.reason}) — ${summaries[pause.reason]}; nothing relaunched${changed ? "; diagnosis changed" : ""}; inspect: ${inspect}; details: ${join(workDir, "pausa.json")}`;
  }

  resolved(key: string): void {
    this.last.delete(key);
  }
}
