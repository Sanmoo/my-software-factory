/**
 * The evidence locations of an attempt now live in the Work record module
 * (issue 187, `src/work-record/`), which owns the record's files. Kept as the
 * compatibility seam the state module already imports.
 */
export * from "../work-record/evidence.js";
