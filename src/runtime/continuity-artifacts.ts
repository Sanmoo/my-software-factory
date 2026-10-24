/**
 * The continuity parts of a Work's record now live in the Work record module
 * (issue 187, `src/work-record/`), which owns their files, schemas and
 * cross-references. This module stays as the compatibility seam the host, the
 * guardrail and the existing tests import: every name and signature is the one
 * they already use, and the migration of consumers happens in later tickets.
 */
export * from "../work-record/continuity.js";
