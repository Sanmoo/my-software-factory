// Secret scan shared by the docker experiments: a token value must not reach logs or reports.

/** Fails if a secret value appears in text that would be written to logs or reports. `where` names that text. */
export function assertNoSecret(text: string, secret: string, where = "text"): void {
  if (secret.length > 0 && text.includes(secret)) {
    throw new Error(`secret value found in ${where} that would be persisted`);
  }
}
