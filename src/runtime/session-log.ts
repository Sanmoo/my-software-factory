/**
 * Reading a persisted Pi session now lives in the Work record module (issue
 * 187, `src/work-record/`), which owns the sessions of a Work. Kept as the
 * compatibility seam the runtime already imports.
 */
export * from "../work-record/sessions.js";
