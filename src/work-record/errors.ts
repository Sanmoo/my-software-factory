/**
 * The one error a write of the Work record raises: a record that would break a
 * cross-reference is refused before the disk is touched, and the caller sees
 * which fact is missing instead of a file it cannot trust.
 */
export class WorkRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkRecordError";
  }
}
