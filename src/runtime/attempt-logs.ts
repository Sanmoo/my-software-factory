/**
 * The per-attempt log names and the event-log writer now live in the Work
 * record module (issue 187, `src/work-record/`). Kept as the compatibility
 * seam the runtime and the registry already import.
 */
export * from "../work-record/logs.js";
