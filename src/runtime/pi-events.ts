// Minimal shape of the Pi JSON event stream (print mode), as observed in the Docker spike
// (ticket #1). Only the fields the runner reads are typed; everything else is ignored.
export interface PiMessage {
  role?: string;
  customType?: string;
  content?: string | Array<{ type?: string; text?: string }>;
}

export interface PiEvent {
  type: string;
  toolName?: string;
  toolCallId?: string;
  args?: { agent?: unknown; async?: unknown; model?: unknown };
  aborted?: boolean;
  message?: PiMessage;
}

export function parseEvent(line: string): PiEvent | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string") {
      return value as PiEvent;
    }
  } catch {
    // Not JSON: a plain stdout line, not an event.
  }
  return undefined;
}
