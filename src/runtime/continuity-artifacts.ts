/**
 * The continuity artifacts are part of the Work record (work-record/continuity.ts,
 * issue #186); this module is the thin re-export the runtime's existing imports
 * keep, so the migration lands without touching every caller at once.
 */
export * from "../work-record/continuity.js";
